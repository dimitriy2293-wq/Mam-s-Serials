import "dotenv/config";
import fs from "fs";
import path from "path";
import { uploadToStorage } from "./storage.js";

const BASE = "https://api.wavespeed.ai/api/v3";
const headers = {
  Authorization: `Bearer ${process.env.WAVESPEED_API_KEY}`,
  "Content-Type": "application/json",
};

// ---------- Троттлинг + retry на 429 ----------
// У WaveSpeed жёсткие лимиты запросов в минуту на дешёвых планах (например,
// Wan 2.2 image-to-video — "2 predictions per 1 minute"). Раньше сцены эпизода
// отправлялись друг за другом без пауз, и на 3+ сценах это гарантированно
// упиралось в 429. Здесь заранее ждём, если лимит по конкретной модели уже
// исчерпан, а если 429 всё же прилетел (например, из-за concurrency-лимита на
// картинках) — ждём и повторяем, вместо того чтобы сразу ронять весь эпизод.
const RATE_LIMITS = {
  "wavespeed-ai/wan-2.2/image-to-video": { max: 2, windowMs: 60_000 },
  "google/nano-banana-2/edit": { max: 2, windowMs: 60_000 },
  "google/nano-banana-2/text-to-image": { max: 2, windowMs: 60_000 },
};
const callTimestamps = new Map(); // endpoint -> [timestamps]

async function waitForRateLimitSlot(endpoint) {
  const limit = RATE_LIMITS[endpoint];
  if (!limit) return;
  const now = Date.now();
  const recent = (callTimestamps.get(endpoint) || []).filter((t) => now - t < limit.windowMs);
  if (recent.length >= limit.max) {
    const waitMs = limit.windowMs - (now - recent[0]) + 1000; // +1с запас
    console.log(`WaveSpeed: троттлинг ${endpoint}, жду ${Math.ceil(waitMs / 1000)}с перед запросом...`);
    await new Promise((r) => setTimeout(r, waitMs));
    return waitForRateLimitSlot(endpoint);
  }
  recent.push(now);
  callTimestamps.set(endpoint, recent);
}

// ---------- Низкоуровневые помощники: submit + poll ----------
async function submit(endpoint, body, { retries = 3 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    await waitForRateLimitSlot(endpoint);

    const res = await fetch(`${BASE}/${endpoint}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (res.status === 429 && attempt < retries) {
      const waitMs = 65_000; // окно лимита у WaveSpeed — минута, ждём с запасом
      console.log(
        `WaveSpeed 429 на ${endpoint} (попытка ${attempt + 1}/${retries}), жду ${waitMs / 1000}с и повторяю...`
      );
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`WaveSpeed submit error (${endpoint}): ${res.status} ${err}`);
    }
    const json = await res.json();
    const requestId = json.data?.id || json.id || json.request_id;
    if (!requestId) throw new Error(`WaveSpeed: не нашёл id в ответе на ${endpoint}: ${JSON.stringify(json)}`);
    return requestId;
  }
}

// Один разовый опрос статуса — совместимо с интерфейсом checkVideoStatus, который
// раньше был у Magic Hour (bot.js вызывает его периодически сам, не блокируясь).
async function pollOnce(requestId) {
  const res = await fetch(`${BASE}/predictions/${requestId}/result`, { headers });
  const json = await res.json();
  const data = json.data || json;
  return data;
}

// Блокирующее ожидание — используется там, где раньше был синхронный await
// (генерация персонажей/композитных кадров), чтобы не переписывать логику bot.js.
async function waitForCompletion(requestId, { intervalMs = 3000, timeoutMs = 120_000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const data = await pollOnce(requestId);
    if (data.status === "completed") return data.outputs[0];
    if (data.status === "failed" || data.status === "cancelled") {
      throw new Error(`WaveSpeed generation ${data.status}: ${data.error || "unknown error"}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`WaveSpeed: timeout ожидания результата (${requestId})`);
}

async function downloadAndStore(url, folder) {
  const res = await fetch(url);
  const buffer = Buffer.from(await res.arrayBuffer());
  let ext = "png";
  if (url.includes(".mp4")) ext = "mp4";
  else if (url.includes(".mp3")) ext = "mp3";
  else if (url.includes(".wav")) ext = "wav";
  const tmpPath = path.join("/tmp", `${folder}_${Date.now()}.${ext}`);
  fs.writeFileSync(tmpPath, buffer);
  return await uploadToStorage(tmpPath, folder);
}

// ---------- Баланс аккаунта — проверяем ПЕРЕД тем, как тратить его на генерацию,
// а не узнаём о нехватке денег после того, как половина эпизода уже сгенерирована. ----------
export async function checkBalance() {
  const res = await fetch(`${BASE}/balance`, { headers });
  if (!res.ok) throw new Error(`WaveSpeed balance check failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return json.data.balance;
}

// Очень грубая оценка стоимости эпизода в долларах — чтобы предупредить,
// а не точный биллинг. Числа основаны на прайсинге моделей на wavespeed.ai.
export function estimateEpisodeCostUsd({ sceneCount, locationCount, voiceoverSceneCount }) {
  const CHARACTER_IMAGE = 0.04; // nano-banana-2 text-to-image, примерно
  const LOCATION_IMAGE = 0.04;
  const COMPOSITE_IMAGE = 0.05; // nano-banana-2 edit, примерно
  const VIDEO_CLIP = 0.25; // wan-2.2 image-to-video 480p 5-8с, примерно
  const VOICEOVER = 0.1; // eleven-v3, минимум $0.1 за вызов (до 1000 символов)

  return (
    locationCount * LOCATION_IMAGE +
    sceneCount * (COMPOSITE_IMAGE + VIDEO_CLIP) +
    voiceoverSceneCount * VOICEOVER +
    2 * CHARACTER_IMAGE // грубо на пару сгенерированных персонажей
  );
}

// ---------- Картинки персонажей (Nano Banana 2, text-to-image) ----------
export async function generateCharacterImages(characters) {
  const results = [];
  for (const character of characters) {
    const prompt =
      `Cinematic portrait reference photo of a single character, photorealistic, shot on 85mm lens, ` +
      `sharp focus, natural skin texture, correct anatomy, both hands visible and undamaged if shown, ` +
      `symmetrical face, neutral standing pose facing camera, plain seamless studio background, soft even lighting: ` +
      `${character.description}. ` +
      `Avoid: extra limbs, extra fingers, fused fingers, distorted hands, warped face, blurry, low detail, ` +
      `text, watermark, logo, frame border, multiple people, cropped body.`;
    const requestId = await submit("google/nano-banana-2/text-to-image", {
      prompt,
      aspect_ratio: "3:4",
      resolution: "1k",
      output_format: "png",
      enable_sync_mode: false,
    });
    const outputUrl = await waitForCompletion(requestId);
    const publicUrl = await downloadAndStore(outputUrl, "characters");
    results.push({ name: character.name, source: "ai_generated", ref_image_url: publicUrl });
  }
  return results;
}

// ---------- Фон локации (Nano Banana 2, text-to-image) — генерируется ОДИН РАЗ
// на локацию и переиспользуется во всех сценах, снятых в ней, чтобы бар (или
// любая другая локация) не "плавал" между сценами. ----------
export async function generateLocationImage(locationDescription) {
  const prompt =
    `Empty establishing shot of a location, no people in frame, photorealistic, ` +
    `wide-angle cinematic composition, sharp focus, natural lighting matching the description: ` +
    `${locationDescription}. ` +
    `Avoid: people, characters, text, watermark, logo, blurry, low detail.`;
  const requestId = await submit("google/nano-banana-2/text-to-image", {
    prompt,
    aspect_ratio: "16:9",
    resolution: "1k",
    output_format: "png",
    enable_sync_mode: false,
  });
  const outputUrl = await waitForCompletion(requestId);
  return await downloadAndStore(outputUrl, "locations");
}

// ---------- Композитный кадр сцены (Nano Banana 2, edit) ----------
// Монтирует персонажа(ей) В ГОТОВЫЙ фон локации на заданной позиции, вместо того
// чтобы каждый раз рисовать локацию заново текстом — так и фон, и расположение
// персонажа остаются согласованными от сцены к сцене.
export async function generateSceneReferenceImage(locationImageUrl, characterImageUrls, characterPosition) {
  const prompt =
    `The first image is the fixed background location — keep it EXACTLY as shown, unchanged, ` +
    `same camera angle, same furniture and lighting. Composite the character(s) from the following ` +
    `reference image(s) into this background. This MUST be the exact same individual(s) as in the ` +
    `reference photo(s) — preserve their precise facial structure, eye shape and color, skin tone, ` +
    `hair color and style, and outfit exactly. Do not generate a different-looking person. ` +
    `Position: ${characterPosition}. ` +
    `Correct anatomy, natural proportions, lighting on the character matching the background's lighting, ` +
    `photorealistic, sharp focus. ` +
    `Avoid: changing the background, changing the character's face or identity, extra limbs, extra fingers, ` +
    `distorted faces, text, watermark, logo, duplicated characters.`;

  const requestId = await submit("google/nano-banana-2/edit", {
    prompt,
    images: [locationImageUrl, ...characterImageUrls],
    resolution: "1k",
    output_format: "png",
    enable_sync_mode: false,
  });
  const outputUrl = await waitForCompletion(requestId);
  return await downloadAndStore(outputUrl, "scene-refs");
}

// ---------- Видео (Wan 2.2, image-to-video) ----------
// Возвращает job_id сразу (не блокируясь) — bot.js сам периодически опрашивает
// checkVideoStatus, как раньше было устроено с Magic Hour.
export async function generateVideoScene({ referenceImageUrl, prompt, durationSec }) {
  // WaveSpeed Wan 2.2 принимает только 5 или 8 секунд — округляем до ближайшего поддерживаемого
  const duration = durationSec >= 7 ? 8 : 5;

  // Раньше negative_prompt не передавался вообще, хотя Wan 2.2 его поддерживает —
  // это одна из причин "странных" видео (замороженные кадры, дёрганая камера,
  // морфинг лица, лишние конечности).
  const negativePrompt =
    "blurry, low quality, distorted, static, frozen, jitter, jerky motion, " +
    "morphing face, warped face, character face changing, identity drift, different person, " +
    "extra limbs, extra fingers, fused fingers, " +
    "text, watermark, logo, subtitles, low resolution, artifacts";

  const requestId = await submit("wavespeed-ai/wan-2.2/image-to-video", {
    prompt: `${prompt}. Smooth natural motion, cinematic camera work, keep the character's face and identity exactly unchanged throughout.`,
    negative_prompt: negativePrompt,
    image: referenceImageUrl,
    resolution: "480p", // дешевле для MVP, можно поднять до 720p позже
    duration,
    seed: -1,
  });
  return { job_id: requestId };
}

export async function checkVideoStatus(jobId) {
  const data = await pollOnce(jobId);
  if (data.status === "completed") {
    const permanentUrl = await downloadAndStore(data.outputs[0], "videos");
    return { done: true, video_url: permanentUrl };
  }
  if (data.status === "failed" || data.status === "cancelled") {
    return { done: false, error: true };
  }
  return { done: false, error: false };
}

// ---------- Озвучка (ElevenLabs Eleven v3 через WaveSpeed) ----------
// В отличие от Gemini TTS (жёсткий лимит запросов в день на free tier),
// здесь ограничение — деньги на балансе, а не число вызовов, так что этим
// можно озвучивать весь эпизод, не упираясь в дневную квоту.
const MALE_VOICES = [
  "Adam", "Antoni", "Arnold", "Brian", "Callum", "Charlie",
  "Chris", "Daniel", "Eric", "George", "Josh", "Liam", "Patrick",
];
const FEMALE_VOICES = [
  "Alice", "Aria", "Charlotte", "Dorothy", "Elli", "Freya",
  "Jessica", "Laura", "Lily", "Matilda", "Nicole", "Rachel",
];

function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  return hash;
}

// Каждый персонаж стабильно получает СВОЙ голос (по хэшу имени) — не пересчитывается
// заново на каждую сцену или при /replay, поэтому один и тот же персонаж не "прыгает"
// между голосами по ходу эпизода. Грубая эвристика по полу берётся из английского
// description персонажа (его пишет Gemini при генерации сценария).
function pickVoiceForCharacter(characterName, characterDescription = "") {
  const desc = characterDescription.toLowerCase();
  const female = /\b(woman|girl|female|she|her)\b/.test(desc);
  const male = /\b(man|boy|male|he|his)\b/.test(desc);
  const pool = female && !male ? FEMALE_VOICES : male && !female ? MALE_VOICES : MALE_VOICES.concat(FEMALE_VOICES);
  return pool[hashString(characterName) % pool.length];
}

export async function generateVoiceover(text, characterName, characterDescription, voiceStyle) {
  const voiceId = pickVoiceForCharacter(characterName, characterDescription);
  const styledText = voiceStyle ? `[${voiceStyle}] ${text}` : text;

  const requestId = await submit("elevenlabs/eleven-v3", {
    text: styledText,
    voice_id: voiceId,
    similarity: 0.75,
    stability: 0.5,
    use_speaker_boost: true,
  });
  const outputUrl = await waitForCompletion(requestId, { timeoutMs: 60_000 });
  return await downloadAndStore(outputUrl, "voiceovers");
}
