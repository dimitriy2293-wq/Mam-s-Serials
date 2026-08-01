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

// ---------- Сценарий короткого видео (адаптивная длина) ----------
// input: текст статьи ИЛИ тема/идея от пользователя.
// Бот сам решает "новость" это или "выдуманная история" — на основе того,
// похож ли ввод на реальный факт/событие или на творческий запрос.
// styleProfile — опциональный разбор референсного видео (см. lib/style-learning.js),
// подмешивается в промпт, чтобы новый сценарий перенял приёмы построения, а не сюжет.
export async function generateShortScript({ input, isArticle, styleProfiles = [] }) {
  const sourceBlock = isArticle
    ? `Вот текст статьи. Перескажи её как реальную новость своими словами, кратко и по делу, ` +
      `не выдумывай факты, которых нет в статье:\n\n"""${input}"""`
    : `Вот запрос/тема/заметка от пользователя: "${input}".\n` +
      `Если это описание реального события, факта или тематики (например, "новости про космос", ` +
      `"что происходит с ценами на нефть") — сделай новостной/фактологический формат. ` +
      `Если это творческая идея, байка или сюжет ("история про призрака в общаге") — придумай короткую историю.`;

  const styleBlock = styleProfiles.length > 0
    ? `\n\nПиши в СТИЛЕ, замеченном в ${styleProfiles.length} референсных роликах пользователя ` +
      `(перенимай ПРИЁМЫ построения, не сюжет и не факты — тема совершенно другая):\n` +
      styleProfiles.map((p, i) =>
        `${i + 1}) Хук: ${p.hook_style || "—"}; Темп: ${p.pacing || "—"}; Тон: ${p.narration_tone || "—"}; ` +
        `Структура: ${p.structure || "—"}; Концовка: ${p.cta_style || "—"}${p.notes ? `; Другое: ${p.notes}` : ""}`
      ).join("\n") +
      `\nЕсли примеры противоречат друг другу — выбери то, что чаще повторяется.`
    : "";

  const prompt = `Ты — сценарист коротких вертикальных видео в стиле TikTok/Reels.

${sourceBlock}${styleBlock}

Сначала САМ оцени, сколько времени нужно теме, чтобы раскрыться не скомкано:
- Простая тема / короткая история / один факт — 25-40 секунд.
- Тема средней глубины (несколько связанных фактов, нужен контекст) — 40-60 секунд.
- Глубокая/многослойная тема (нужна предыстория, несколько поворотов, детали) — 60-90 секунд.
Не растягивай простую тему искусственно и не сжимай сложную в 30 секунд — длина должна соответствовать содержанию.

Раздели ролик на сегменты по ~4-6 секунд озвучки каждый (то есть 6-9 сегментов для короткого ролика, 10-18 для длинного). Для каждого сегмента дай:
- "narration": текст закадрового голоса НА ТОМ ЖЕ ЯЗЫКЕ, на котором был запрос/статья пользователя (не переводи на английский). Короткие, ударные, разговорные фразы, без markdown, без эмодзи, без указаний в скобках.
- "visual_query": 2-4 английских слова для поиска подходящего стокового видео/фото на Pexels/Pixabay — просто и предметно (например "city street night", "person counting money", "worried face closeup", "rocket launch sky").

Требования:
- Первый сегмент — цепляющий хук, который заставляет досмотреть до конца.
- Последний сегмент — короткий вывод/призыв (например "подписывайся", "а как думаешь ты?") или эффектная концовка истории.
- Общая длительность (сумма озвучки всех сегментов) должна соответствовать оценке глубины темы выше, а не быть одинаковой для всех тем.

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
