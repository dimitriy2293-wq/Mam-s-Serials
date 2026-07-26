import { GoogleGenAI } from "@google/genai";
import "dotenv/config";
import fs from "fs";
import path from "path";
import { uploadToStorage } from "./storage.js";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// ---------- Retry с backoff для временных сбоев (503 "high demand") ----------
async function generateContentWithRetry(params, { retries = 3, baseDelayMs = 2000 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await ai.models.generateContent(params);
    } catch (err) {
      const isRetryable = err?.status === 503 || err?.message?.includes("UNAVAILABLE");
      if (!isRetryable || attempt === retries) throw err;
      const delay = baseDelayMs * 2 ** attempt;
      console.log(`Gemini перегружен (попытка ${attempt + 1}/${retries}), жду ${delay}мс...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

// ---------- Сценарий (доработка черновика ИЛИ генерация с нуля) ----------
// Возвращает title, список персонажей (имя+описание) и сцены,
// каждая сцена ссылается на персонажей по имени (primary_character + secondary_characters)
export async function generateScript({ userInput, isDraft, maxScenes }) {
  const instruction = isDraft
    ? `Вот черновик сюжета от пользователя: "${userInput}"
Доработай его в полноценный сценарий для короткого видео, разбей на сцены по 5 секунд,
сохрани оригинальную идею и стиль, только дополни недостающие детали.`
    : `Придумай короткий сценарий по теме/жанру: "${userInput}", разбей на сцены по 5 секунд.`;

  const budgetInstruction = maxScenes
    ? `\n\nВАЖНОЕ ОГРАНИЧЕНИЕ БЮДЖЕТА: генерация каждой сцены стоит реальных денег, поэтому сценарий ` +
      `должен уместиться СТРОГО в ${maxScenes} сцен(ы) максимум (не больше, можно меньше, если сюжету ` +
      `хватает). Не растягивай историю искусственно — лучше короткая законченная сцена на ` +
      `${maxScenes * 5} секунд, чем обрезанная на середине из-за нехватки бюджета.`
    : "";

  const prompt = `${instruction}${budgetInstruction}

Определи все ЛОКАЦИИ, где происходит действие (например "Bar", "Street"), и опиши каждую
ОДИН РАЗ детально и фиксированно (стиль интерьера/экстерьера, цвета, ключевые предметы,
расположение мебели, освещение) — это описание будет использовано БУКВАЛЬНО одинаково
для генерации фона каждой сцены в этой локации, поэтому оно должно быть исчерпывающим
и не должно меняться от сцены к сцене.

Определи всех персонажей сюжета (может быть несколько). Имя персонажа ("name") пиши на ТОМ ЖЕ
ЯЗЫКЕ, на котором пользователь написал исходный запрос (например, обычные русские или украинские
имена для русского/украинского ввода) — а "description" всегда пиши на английском (это нужно
для качества генерации изображений).

Верни ТОЛЬКО валидный JSON без markdown-обёртки, в формате:
{
  "title": "...",
  "characters": [
    { "name": "Анна", "description": "young blonde woman in summer dress, English visual description for image generator" },
    { "name": "Босс", "description": "..." }
  ],
  "locations": [
    { "name": "Bar", "description": "detailed fixed English visual description of the location: interior style, wall/floor colors, key furniture and props with their positions, lighting setup, camera height — written so it renders identically every time" }
  ],
  "scenes": [
    {
      "scene_number": 1,
      "duration_sec": 5,
      "location": "Bar",
      "script_text": "описание сцены для видео-генератора на английском: одно чёткое действие субъекта + движение камеры (static/slow pan/dolly-in/handheld) + освещение/атмосфера, без диалогов и текста в кадре, 1-2 предложения",
      "character_position": "где именно в локации находится персонаж и как расположен (например 'sitting on the left barstool, facing the counter'), на английском",
      "primary_character": "Анна",
      "secondary_characters": ["Босс"],
      "voiceover_text": "текст реплики/закадра для этой сцены (на ТОМ ЖЕ ЯЗЫКЕ, на котором пользователь написал исходный запрос) или null",
      "voice_style": "краткое описание тона голоса (например 'раздражённый мужской голос') или null"
    }
  ]
}`;

  const response = await generateContentWithRetry({
    model: "gemini-3.6-flash",
    contents: prompt,
  });

  const text = response.text.trim().replace(/^```json\n?|\n?```$/g, "");
  return JSON.parse(text);
}

// ---------- Генерация референс-фото ДЛЯ КАЖДОГО персонажа сценария ----------
// Возвращает массив [{ name, source: "ai_generated", ref_image_url }]
export async function generateCharacterImages(characters) {
  const results = [];

  for (const character of characters) {
    const prompt = `Cinematic portrait reference photo of a character, photorealistic, neutral pose, plain studio background, consistent lighting: ${character.description}`;

    const response = await generateContentWithRetry({
      model: "gemini-2.5-flash-image",
      contents: prompt,
    });

    const imagePart = response.candidates[0].content.parts.find((p) => p.inlineData);
    const buffer = Buffer.from(imagePart.inlineData.data, "base64");

    const tmpPath = path.join("/tmp", `char_${character.name}_${Date.now()}.png`);
    fs.writeFileSync(tmpPath, buffer);

    const publicUrl = await uploadToStorage(tmpPath, "characters");
    results.push({ name: character.name, source: "ai_generated", ref_image_url: publicUrl });
  }

  return results;
}

// ---------- Композитное фото сцены из нескольких референсов персонажей ----------
// Используется, когда в сцене больше одного персонажа: Gemini объединяет их
// референс-фото в ОДНО новое изображение сцены, которое дальше отдаётся
// в Magic Hour как единственный референс для image-to-video.
export async function generateSceneReferenceImage(characterImageUrls, sceneDescription) {
  const imageParts = await Promise.all(
    characterImageUrls.map(async (url) => {
      const res = await fetch(url);
      const buffer = Buffer.from(await res.arrayBuffer());
      return {
        inlineData: {
          mimeType: "image/png",
          data: buffer.toString("base64"),
        },
      };
    })
  );

  const textPart = {
    text:
      `Combine these reference characters into a single new photorealistic scene image ` +
      `matching this description, keeping each character's appearance consistent with their reference photo: ` +
      `${sceneDescription}`,
  };

  const response = await generateContentWithRetry({
    model: "gemini-2.5-flash-image",
    contents: [{ parts: [...imageParts, textPart] }],
  });

  const imagePart = response.candidates[0].content.parts.find((p) => p.inlineData);
  const buffer = Buffer.from(imagePart.inlineData.data, "base64");

  const tmpPath = path.join("/tmp", `scene_ref_${Date.now()}.png`);
  fs.writeFileSync(tmpPath, buffer);

  return await uploadToStorage(tmpPath, "scene-refs");
}

// Озвучка (TTS) перенесена в lib/wavespeed.js (ElevenLabs Eleven v3) —
// у Gemini TTS free tier жёсткий лимит в 10 запросов/день, чего не хватает
// даже на один эпизод с несколькими сценами.
