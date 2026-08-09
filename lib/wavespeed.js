import "dotenv/config";
import fs from "fs";
import path from "path";
import { uploadToStorage } from "./storage.js";

const BASE = "https://api.wavespeed.ai/api/v3";

// ДИНАМИЧЕСКИЕ ЗАГОЛОВКИ: теперь всегда берется актуальный ключ из process.env
const getHeaders = () => ({
  Authorization: `Bearer ${process.env.WAVESPEED_API_KEY}`,
  "Content-Type": "application/json",
});

const RATE_LIMITS = {
  "wavespeed-ai/wan-2.2/i2v-720p": { max: 2, windowMs: 60_000 },
  "google/nano-banana-2/edit-fast": { max: 2, windowMs: 60_000 },
  "google/nano-banana-2/text-to-image-fast": { max: 2, windowMs: 60_000 },
};
const callTimestamps = new Map(); 

async function waitForRateLimitSlot(endpoint) {
  const limit = RATE_LIMITS[endpoint];
  if (!limit) return;
  const now = Date.now();
  const recent = (callTimestamps.get(endpoint) || []).filter((t) => now - t < limit.windowMs);
  if (recent.length >= limit.max) {
    const waitMs = limit.windowMs - (now - recent[0]) + 1000; 
    console.log(`WaveSpeed: троттлинг ${endpoint}, жду ${Math.ceil(waitMs / 1000)}с перед запросом...`);
    await new Promise((r) => setTimeout(r, waitMs));
    return waitForRateLimitSlot(endpoint);
  }
  recent.push(now);
  callTimestamps.set(endpoint, recent);
}

async function submit(endpoint, body, { retries = 3 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    await waitForRateLimitSlot(endpoint);

    const res = await fetch(`${BASE}/${endpoint}`, {
      method: "POST",
      headers: getHeaders(), // Используем функцию
      body: JSON.stringify(body),
    });

    if (res.status === 429 && attempt < retries) {
      const waitMs = 65_000; 
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

async function pollOnce(requestId) {
  const res = await fetch(`${BASE}/predictions/${requestId}/result`, { headers: getHeaders() }); // Используем функцию
  const json = await res.json();
  const data = json.data || json;
  return data;
}

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

export async function checkBalance() {
  const res = await fetch(`${BASE}/balance`, { headers: getHeaders() }); // Используем функцию
  if (!res.ok) throw new Error(`WaveSpeed balance check failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return json.data.balance;
}

export function estimateMaxScenes(budgetUsd = 1, { locationCount = 1, characterCount = 2, includeVoiceover = true } = {}) {
  const CHARACTER_IMAGE = 0.045;
  const LOCATION_IMAGE = 0.045;
  const COMPOSITE_IMAGE = 0.045;
  const VIDEO_CLIP = 0.1;
  const VOICEOVER = 0.02;

  const fixed = locationCount * LOCATION_IMAGE + characterCount * CHARACTER_IMAGE;
  const perScene = COMPOSITE_IMAGE + VIDEO_CLIP + (includeVoiceover ? VOICEOVER : 0);
  const remaining = Math.max(budgetUsd - fixed, 0);
  return Math.max(1, Math.floor(remaining / perScene));
}

export function estimateEpisodeCostUsd({ sceneCount, locationCount, voiceoverSceneCount, characterCount = 2 }) {
  const CHARACTER_IMAGE = 0.045; 
  const LOCATION_IMAGE = 0.045; 
  const COMPOSITE_IMAGE = 0.045; 
  const VIDEO_CLIP = 0.1; 
  const VOICEOVER = 0.02; 

  return (
    locationCount * LOCATION_IMAGE +
    characterCount * CHARACTER_IMAGE +
    sceneCount * (COMPOSITE_IMAGE + VIDEO_CLIP) +
    voiceoverSceneCount * VOICEOVER
  );
}

export async function generateCharacterImages(characters) {
  const results = [];
  for (const character of characters) {
    const prompt =
      `Cinematic portrait reference photo of a single character, photorealistic, shot on 85mm lens, ` +
      `sharp focus, natural skin texture, correct anatomy, both hands visible and undamaged if shown, ` +
      `symmetrical face, neutral standing pose facing camera, plain solid mid-gray seamless studio ` +
      `background with no texture, no gradient, no props, no shadows on the background, soft even lighting: ` +
      `${character.description}. ` +
      `Avoid: extra limbs, extra fingers, fused fingers, distorted hands, warped face, blurry, low detail, ` +
      `text, watermark, logo, frame border, multiple people, cropped body, patterned or textured background.`;
    const requestId = await submit("google/nano-banana-2/text-to-image-fast", {
      prompt,
      aspect_ratio: "3:4",
      resolution: "2k",
      output_format: "png",
      enable_sync_mode: false,
    });
    const outputUrl = await waitForCompletion(requestId);
    const publicUrl = await downloadAndStore(outputUrl, "characters");
    results.push({ name: character.name, source: "ai_generated", ref_image_url: publicUrl });
  }
  return results;
}

export async function generateLocationImage(locationDescription) {
  const prompt =
    `Empty establishing shot of a location, no people in frame, photorealistic, ` +
    `wide-angle cinematic composition, sharp focus, natural lighting matching the description: ` +
    `${locationDescription}. ` +
    `Avoid: people, characters, text, watermark, logo, blurry, low detail.`;
  const requestId = await submit("google/nano-banana-2/text-to-image-fast", {
    prompt,
    aspect_ratio: "9:16",
    resolution: "2k",
    output_format: "png",
    enable_sync_mode: false,
  });
  const outputUrl = await waitForCompletion(requestId);
  return await downloadAndStore(outputUrl, "locations");
}

export async function generateSceneReferenceImage(locationImageUrl, characterImageUrls, characterPosition) {
  const prompt =
    `Image 1 is the ONLY background you may use — the fixed location. Keep it EXACTLY as shown: ` +
    `same walls, floor, furniture positions, camera angle, and lighting, unchanged. ` +
    `The remaining image(s) are character reference photos — use ONLY their appearance (face, hair, ` +
    `outfit, build), and COMPLETELY IGNORE and DISCARD any background visible in those reference photos ` +
    `(studio backdrop, plain/gray/white background, etc.) — none of it should appear anywhere in the ` +
    `final image. The final image must have ONE background only: image 1's location, nothing else. ` +
    `Composite the character(s) from the reference photo(s) into this background. This MUST be the exact ` +
    `same individual(s) as in the reference photo(s) — preserve their precise facial structure, eye shape ` +
    `and color, exact hair color/length/style, skin tone, and outfit exactly as described in the reference. ` +
    `Do not generate a different-looking person, do not average or blend faces. ` +
    `Position: ${characterPosition}. ` +
    `Correct anatomy, natural proportions, lighting on the character matching the background's lighting ` +
    `direction and color temperature, photorealistic, sharp focus. ` +
    `Avoid: any trace of the reference photos' own background, changing the location background in any ` +
    `way, changing the character's face/hair/identity, extra limbs, extra fingers, distorted faces, text, ` +
    `watermark, logo, duplicated characters.`;

  const requestId = await submit("google/nano-banana-2/edit-fast", {
    prompt,
    images: [locationImageUrl, ...characterImageUrls],
    aspect_ratio: "9:16",
    resolution: "2k",
    output_format: "png",
    enable_sync_mode: false,
  });
  const outputUrl = await waitForCompletion(requestId);
  return await downloadAndStore(outputUrl, "scene-refs");
}

function pickVoiceDescription(characterDescription = "") {
  const desc = characterDescription.toLowerCase();
  const femaleHints = /\bwoman\b|\bgirl\b|\bfemale\b|\bshe\b|\bher\b/;
  const maleHints = /\bman\b|\bboy\b|\bmale\b|\bhe\b|\bhis\b/;
  const gender = femaleHints.test(desc) ? "female" : maleHints.test(desc) ? "male" : null;

  const oldHints = /\b(old|elderly|senior|60s|70s|80s)\b/;
  const youngHints = /\b(young|teen|20s|kid|child)\b/;
  const age = oldHints.test(desc) ? "elderly" : youngHints.test(desc) ? "young adult" : "middle-aged";

  return [gender, age].filter(Boolean).join(", ");
}

export async function generateVoiceoverWaveSpeed(text, characterDescription) {
  const voiceDescription = pickVoiceDescription(characterDescription);
  const requestId = await submit("wavespeed-ai/omnivoice/text-to-speech", {
    text,
    voice_description: voiceDescription,
    speed: 1,
  });
  const outputUrl = await waitForCompletion(requestId);
  return await downloadAndStore(outputUrl, "voiceovers");
}

export async function generateVideoScene({ referenceImageUrl, prompt, durationSec }) {
  const duration = 5;
  const negativePrompt =
    "blurry, low quality, distorted, static, frozen, jitter, jerky motion, " +
    "morphing face, warped face, character face changing, identity drift, different person, " +
    "extra limbs, extra fingers, fused fingers, " +
    "text, watermark, logo, subtitles, low resolution, artifacts";

  // РАНЬШЕ здесь была "i2v-480p-ultra-fast" — по документации WaveSpeed это
  // урезанная по качеству модель ("Ultra Fast prioritizes speed — for maximum
  // quality, consider standard Wan 2.2 variants"), именно она даёт "плывущие"
  // лица в движении на длинных сценах с людьми крупным планом. Переключил на
  // обычную "i2v-720p": медленнее и чуть дороже за генерацию, зато сильно
  // стабильнее держит лицо/личность персонажа и выше разрешение картинки.
  const requestId = await submit("wavespeed-ai/wan-2.2/i2v-720p", {
    prompt: `${prompt}. Smooth natural motion, cinematic camera work, keep the character's face and identity exactly unchanged throughout.`,
    negative_prompt: negativePrompt,
    image: referenceImageUrl,
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
