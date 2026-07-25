import "dotenv/config";
import fs from "fs";
import path from "path";
import { uploadToStorage } from "./storage.js";

const BASE = "https://api.wavespeed.ai/api/v3";
const headers = {
  Authorization: `Bearer ${process.env.WAVESPEED_API_KEY}`,
  "Content-Type": "application/json",
};

// ---------- Низкоуровневые помощники: submit + poll ----------
async function submit(endpoint, body) {
  const res = await fetch(`${BASE}/${endpoint}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`WaveSpeed submit error (${endpoint}): ${res.status} ${err}`);
  }
  const json = await res.json();
  const requestId = json.data?.id || json.id || json.request_id;
  if (!requestId) throw new Error(`WaveSpeed: не нашёл id в ответе на ${endpoint}: ${JSON.stringify(json)}`);
  return requestId;
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
  const ext = url.includes(".mp4") ? "mp4" : "png";
  const tmpPath = path.join("/tmp", `${folder}_${Date.now()}.${ext}`);
  fs.writeFileSync(tmpPath, buffer);
  return await uploadToStorage(tmpPath, folder);
}

// ---------- Картинки персонажей (Nano Banana 2, text-to-image) ----------
export async function generateCharacterImages(characters) {
  const results = [];
  for (const character of characters) {
    const prompt = `Cinematic portrait reference photo of a character, photorealistic, neutral pose, plain studio background, consistent lighting: ${character.description}`;
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

// ---------- Композитный кадр сцены (Nano Banana 2, edit — несколько фото на входе) ----------
export async function generateSceneReferenceImage(characterImageUrls, sceneDescription) {
  const prompt =
    `Combine these reference characters into a single new photorealistic scene image ` +
    `matching this description, keeping each character's appearance consistent with their reference photo: ` +
    `${sceneDescription}`;

  const requestId = await submit("google/nano-banana-2/edit", {
    prompt,
    images: characterImageUrls,
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

  const requestId = await submit("wavespeed-ai/wan-2.2/image-to-video", {
    prompt,
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
