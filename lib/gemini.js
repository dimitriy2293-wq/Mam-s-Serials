import { GoogleGenAI } from "@google/genai";
import "dotenv/config";
import fs from "fs";
import path from "path";
import { uploadToStorage } from "./storage.js";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// ---------- Сценарий (доработка черновика ИЛИ генерация с нуля) ----------
// Возвращает title, список персонажей (имя+описание) и сцены,
// каждая сцена ссылается на персонажей по имени (primary_character + secondary_characters)
export async function generateScript({ userInput, isDraft }) {
  const instruction = isDraft
    ? `Вот черновик сюжета от пользователя: "${userInput}"
Доработай его в полноценный сценарий для короткого видео, разбей на сцены по 5 секунд,
сохрани оригинальную идею и стиль, только дополни недостающие детали.`
    : `Придумай короткий сценарий по теме/жанру: "${userInput}", разбей на сцены по 5 секунд.`;

  const prompt = `${instruction}

Определи всех персонажей сюжета (может быть несколько).

Верни ТОЛЬКО валидный JSON без markdown-обёртки, в формате:
{
  "title": "...",
  "characters": [
    { "name": "Anna", "description": "young blonde woman in summer dress, English visual description for image generator" },
    { "name": "Boss", "description": "..." }
  ],
  "scenes": [
    {
      "scene_number": 1,
      "duration_sec": 5,
      "script_text": "описание сцены для видео-генератора (на английском, для лучшего качества генерации)",
      "primary_character": "Anna",
      "secondary_characters": ["Boss"],
      "voiceover_text": "текст реплики/закадра для этой сцены (на русском) или null",
      "voice_style": "краткое описание тона голоса (например 'раздражённый мужской голос') или null"
    }
  ]
}`;

  const response = await ai.models.generateContent({
    model: "gemini-3-flash",
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

    const response = await ai.models.generateContent({
      model: "gemini-3.1-flash-image-preview",
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

  const response = await ai.models.generateContent({
    model: "gemini-3.1-flash-image-preview",
    contents: [{ parts: [...imageParts, textPart] }],
  });

  const imagePart = response.candidates[0].content.parts.find((p) => p.inlineData);
  const buffer = Buffer.from(imagePart.inlineData.data, "base64");

  const tmpPath = path.join("/tmp", `scene_ref_${Date.now()}.png`);
  fs.writeFileSync(tmpPath, buffer);

  return await uploadToStorage(tmpPath, "scene-refs");
}

// ---------- Озвучка (TTS) ----------
export async function generateVoiceover(text, voiceStyle) {
  const styledPrompt = voiceStyle ? `Say in this style (${voiceStyle}): ${text}` : text;

  const response = await ai.models.generateContent({
    model: "gemini-3.1-flash-tts-preview",
    contents: styledPrompt,
    config: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } },
      },
    },
  });

  const audioPart = response.candidates[0].content.parts.find((p) => p.inlineData);
  const buffer = Buffer.from(audioPart.inlineData.data, "base64");

  const tmpPath = path.join("/tmp", `voice_${Date.now()}.wav`);
  fs.writeFileSync(tmpPath, buffer);

  const publicUrl = await uploadToStorage(tmpPath, "voiceovers");
  return publicUrl;
}
