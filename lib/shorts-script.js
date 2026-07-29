import { GoogleGenAI } from "@google/genai";
import "dotenv/config";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function generateContentWithRetry(params, { retries = 3, baseDelayMs = 2000 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await ai.models.generateContent(params);
    } catch (err) {
      const isRetryable = err?.status === 503 || err?.message?.includes("UNAVAILABLE");
      if (!isRetryable || attempt === retries) throw err;
      const delay = baseDelayMs * 2 ** attempt;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

export function isUrl(text) {
  return /^https?:\/\/\S+$/i.test(text.trim());
}

// ---------- Грубая выжимка читаемого текста из HTML страницы, без внешних библиотек ----------
export function extractArticleText(html) {
  const withoutJunk = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");

  const withBreaks = withoutJunk.replace(/<\/(p|div|h1|h2|h3|h4|li|br|tr)>/gi, "\n");

  const text = withBreaks
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]*\n+/g, "\n")
    .trim();

  return text.slice(0, 9000); // ограничиваем размер, чтобы не раздувать промпт Gemini
}

// Достаём og:image из HTML — пригодится, только если пользователь ЯВНО захочет
// использовать фото прямо из статьи (см. предупреждение об авторских правах в
// lib/shorts-assemble.js и в README). По умолчанию в сборке роликов не используется.
export function extractOgImage(html) {
  const match = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
  return match ? match[1] : null;
}

export async function fetchArticle(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; ShortsBot/1.0)" },
  });
  if (!res.ok) throw new Error(`Не удалось загрузить страницу (${res.status})`);
  const html = await res.text();
  return {
    text: extractArticleText(html),
    ogImage: extractOgImage(html),
  };
}

// ---------- Сценарий короткого видео (30-40 сек) ----------
// input: текст статьи ИЛИ тема/идея от пользователя.
// Бот сам решает "новость" это или "выдуманная история" — на основе того,
// похож ли ввод на реальный факт/событие или на творческий запрос.
export async function generateShortScript({ input, isArticle }) {
  const sourceBlock = isArticle
    ? `Вот текст статьи. Перескажи её как реальную новость своими словами, кратко и по делу, ` +
      `не выдумывай факты, которых нет в статье:\n\n"""${input}"""`
    : `Вот запрос/тема/заметка от пользователя: "${input}".\n` +
      `Если это описание реального события, факта или тематики (например, "новости про космос", ` +
      `"что происходит с ценами на нефть") — сделай новостной/фактологический формат. ` +
      `Если это творческая идея, байка или сюжет ("история про призрака в общаге") — придумай короткую историю.`;

  const prompt = `Ты — сценарист коротких вертикальных видео в стиле TikTok/Reels, длительность 30-40 секунд.

${sourceBlock}

Раздели ролик на 6-9 коротких сегментов (каждый — примерно на 4-6 секунд озвучки). Для каждого сегмента дай:
- "narration": текст закадрового голоса НА ТОМ ЖЕ ЯЗЫКЕ, на котором был запрос/статья пользователя (не переводи на английский). Короткие, ударные, разговорные фразы, без markdown, без эмодзи, без указаний в скобках.
- "visual_query": 2-4 английских слова для поиска подходящего стокового видео/фото на Pexels/Pixabay — просто и предметно (например "city street night", "person counting money", "worried face closeup", "rocket launch sky").

Требования:
- Первый сегмент — цепляющий хук, который заставляет досмотреть до конца.
- Последний сегмент — короткий вывод/призыв (например "подписывайся", "а как думаешь ты?") или эффектная концовка истории.
- Суммарно текст должен звучать примерно 30-40 секунд (обычно это 70-110 слов на русском/украинском).

Верни ТОЛЬКО валидный JSON без markdown-обёртки и без пояснений, в формате:
{
  "title": "короткий заголовок ролика",
  "type": "news",
  "segments": [
    { "narration": "...", "visual_query": "..." }
  ]
}
Поле "type" — "news" если пересказ реального факта/события, иначе "story".`;

  const response = await generateContentWithRetry({
    model: "gemini-3.6-flash",
    contents: prompt,
  });

  const text = response.text.trim().replace(/^```json\n?|\n?```$/g, "");
  const parsed = JSON.parse(text);

  if (!Array.isArray(parsed.segments) || parsed.segments.length === 0) {
    throw new Error("Gemini вернул пустой список сегментов сценария");
  }
  return parsed;
}
