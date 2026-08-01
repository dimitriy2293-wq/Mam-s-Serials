import { GoogleGenAI } from "@google/genai";
import fs from "fs";
import "dotenv/config";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Стандартный Telegram Bot API отдаёт файлы боту только до 20 MB — это ограничение
// самого Telegram, не наше. Проверяем заранее, чтобы дать понятную ошибку, а не
// невнятный обрыв скачивания.
export const MAX_STYLE_VIDEO_BYTES = 20 * 1024 * 1024;

// До января 2026 инлайн-лимит Gemini был 20MB, сейчас — 100MB. Наш потолок и так
// ниже (см. выше), так что укладываемся с большим запасом.
async function generateContentWithRetry(params, { retries = 3, baseDelayMs = 2000 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await ai.models.generateContent(params);
    } catch (err) {
      const isRetryable = err?.status === 503 || err?.message?.includes("UNAVAILABLE");
      if (!isRetryable || attempt === retries) throw err;
      await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** attempt));
    }
  }
}

// ---------- Разбор стиля референсного видео ----------
// Возвращает структурированное ОПИСАНИЕ приёмов монтажа/сценария — не пересказ
// сюжета и не дословный текст ролика (чтобы не тащить в промпты будущих
// генераций чужой конкретный контент, только приёмы построения).
export async function analyzeStyleFromVideo(localVideoPath) {
  const stats = fs.statSync(localVideoPath);
  if (stats.size > MAX_STYLE_VIDEO_BYTES) {
    throw new Error(
      `Файл слишком большой (${(stats.size / 1024 / 1024).toFixed(1)} MB). ` +
      `Telegram отдаёт боту файлы только до 20 MB — сожми видео или обрежь покороче.`
    );
  }

  const base64Video = fs.readFileSync(localVideoPath, { encoding: "base64" });

  const prompt = `Ты анализируешь короткое вертикальное видео (TikTok/Shorts/Reels), чтобы вытащить из него ` +
    `ПРИЁМЫ построения ролика — не пересказывай сюжет и не переписывай текст дословно, ` +
    `нас интересует только СТРУКТУРА и СТИЛЬ, которые потом применят к совершенно другой теме.\n\n` +
    `Разбери видео и верни ТОЛЬКО валидный JSON без markdown-обёртки, в формате:\n` +
    `{\n` +
    `  "hook_style": "как устроены первые 1-3 секунды, что цепляет внимание",\n` +
    `  "pacing": "темп повествования, средняя длина сегмента/кадра в секундах, как часто меняются кадры",\n` +
    `  "narration_tone": "тон и стиль закадрового текста: разговорный/официальный/дерзкий/эмоциональный и т.д.",\n` +
    `  "structure": "из каких смысловых частей состоит ролик и в каком порядке (хук, завязка, развитие, кульминация, вывод/CTA)",\n` +
    `  "visual_style": "стиль визуального ряда: динамичные кадры, статичные фото, архивные кадры и т.п.",\n` +
    `  "subtitle_style": "как оформлены субтитры: крупные/мелкие, слово-за-словом или блоками, положение на экране, есть ли акцентные слова",\n` +
    `  "music_style": "характер фоновой музыки и её громкость относительно голоса",\n` +
    `  "cta_style": "как заканчивается ролик — призыв к действию, вопрос зрителю, клиффхэнгер и т.д.",\n` +
    `  "estimated_duration_sec": число секунд длительности этого ролика,\n` +
    `  "notes": "ещё 1-2 приёма, которые стоит перенять, если они не попали в поля выше"\n` +
    `}`;

  const response = await generateContentWithRetry({
    model: "gemini-3.6-flash",
    contents: [
      { inlineData: { mimeType: "video/mp4", data: base64Video } },
      { text: prompt },
    ],
  });

  const text = response.text.trim().replace(/^```json\n?|\n?```$/g, "");
  return JSON.parse(text);
}
