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
      `${maxScenes * 5} секунд, чем обрезанная на середине из-за нехватки бюджета. Если сюжету и ` +
      `локации позволяет, можно уместить ДВА коротких связанных действия в одну 5-секундную сцену ` +
      `(например "персонаж достаёт телефон и тут же роняет его от неожиданности") вместо того, чтобы ` +
      `тратить на них две отдельные сцены — это экономит бюджет без потери смысла истории.`
    : "";

  const pacingInstruction =
    `\n\nВАЖНО ПРО ТАЙМИНГ РЕПЛИК: сцена длится РОВНО 5 секунд видео, но реплика (voiceover_text) ` +
    `почти всегда звучит короче — озвучка не подгоняется под длину видео. Если после конца реплики ` +
    `персонаж на видео визуально продолжает "говорить" в тишине — это выглядит криво. Поэтому: \n` +
    `1) Пиши voiceover_text такой длины, чтобы озвучка занимала БЛИЗКО к 5 секундам естественной речи ` +
    `(примерно 12-16 слов на среднем темпе) — не обрывай реплику искусственно короткой, если по смыслу ` +
    `персонаж мог бы сказать больше.\n` +
    `2) Если по сюжету реплика или действие короткие и естественно короче 5 секунд — ОБЪЕДИНЯЙ два ` +
    `связанных бита в одну сцену вместо того, чтобы растягивать один короткий момент на все 5 секунд ` +
    `(например: "говорит короткую фразу — затем пауза и реакция собеседника" или "быстро называет две ` +
    `детали подряд"), и явно распиши в script_text мини-таймлайн: что происходит в первые 1-2 секунды ` +
    `(во время реплики) и что происходит в оставшиеся секунды ПОСЛЕ реплики (не молчаливое "говорение", ` +
    `а конкретное молчаливое действие/реакция/жест — отвернулся, вздохнул, поставил стакан, ушёл кадра ` +
    `и т.п.), чтобы видео не выглядело как "рот двигается, а звука нет".`;

  const prompt = `${instruction}${budgetInstruction}${pacingInstruction}

Определи все ЛОКАЦИИ, где происходит действие (например "Bar", "Street"), и опиши каждую
ОДИН РАЗ ОЧЕНЬ детально и фиксированно на английском — этот текст будет использован
БУКВАЛЬНО одинаково для генерации фона каждой сцены в этой локации, поэтому в нём должны
быть конкретные, а не общие формулировки:
- точный тип помещения/места и его размер (small cramped kitchen / vast open hall и т.п.);
- цветовая палитра стен/пола/потолка конкретными названиями цветов;
- 4-6 конкретных предметов обстановки с их точным расположением в кадре (например
  "a worn wooden bar counter running along the left wall", "three round tables in the
  center", "a large arched window on the back wall");
- источник и характер освещения (например "warm amber light from hanging pendant
  lamps above the bar, dim corners");
- фиксированный ракурс и высота камеры (например "eye-level wide shot from the
  entrance looking toward the bar").
Не используй общие слова вроде "cozy", "nice", "modern" без конкретики — вместо
"cozy bar" пиши "small bar with dark wood paneling, six round copper-top tables,
string lights along the ceiling beams, eye-level shot from the doorway".
ВАЖНО: этот ракурс — только референс ДЛЯ ФОНА (чтобы визуально узнавать локацию),
а не обязательный план для всех сцен. В самих сценах камера почти всегда должна
быть СИЛЬНО ближе к персонажам (см. ниже про shot_type) — не привязывай мысленно
все сцены к этому широкому плану.

Определи всех персонажей сюжета (может быть несколько). Имя персонажа ("name") пиши на ТОМ ЖЕ
ЯЗЫКЕ, на котором пользователь написал исходный запрос (например, обычные русские или украинские
имена для русского/украинского ввода) — а "description" всегда пиши на английском, ОЧЕНЬ
детально, чтобы один и тот же персонаж узнавался в каждой сцене. Обязательно укажи в описании:
- возраст (примерный, например "mid-30s"), телосложение и рост (например "tall, lean build");
- ТОЧНЫЙ цвет и стиль волос (например "shoulder-length wavy dark brown hair, side part"),
  а не просто "brown hair";
- цвет глаз;
- КОНКРЕТНУЮ одежду с цветами и деталями (например "wearing a faded blue denim jacket
  over a white t-shirt, black jeans"), а не "casual clothes";
- минимум одну отличительную деталь (очки, шрам, татуировка, украшение, борода
  определённой формы и т.п.) — она сильно помогает генератору не "терять" персонажа
  между сценами.
Не используй общие формулировки вроде "attractive young woman" — нужны конкретные,
проверяемые визуальные детали, как в примере выше.

Верни ТОЛЬКО валидный JSON без markdown-обёртки, в формате:
{
  "title": "...",
  "characters": [
    { "name": "Анна", "description": "woman in her late 20s, petite build, shoulder-length straight platinum blonde hair with a blunt fringe, green eyes, wearing a red wool coat over a black turtleneck, small silver hoop earrings, English visual description for image generator" },
    { "name": "Босс", "description": "..." }
  ],
  "locations": [
    { "name": "Bar", "description": "detailed fixed English visual description of the location as specified above: exact room type/size, wall/floor/ceiling colors, 4-6 concrete furniture/prop items with positions, lighting source and character, fixed camera angle and height" }
  ],
  "scenes": [
    {
      "scene_number": 1,
      "duration_sec": 5,
      "location": "Bar",
      "shot_type": "close-up | medium close-up | medium shot | wide shot — ПОЧТИ ВСЕГДА выбирай 'close-up' или 'medium close-up' для диалоговых/эмоциональных моментов (лицо и плечи персонажа занимают бОльшую часть вертикального 9:16 кадра, как в корейских/китайских коротких дорамах на TikTok) — это стиль, который нужен по умолчанию. 'medium shot' используй только когда в кадре важно видеть жест всем телом. 'wide shot' — редкое исключение, только для establishing-момента (например, первый кадр новой локации) — не больше одной wide-сцены на весь эпизод.",
      "script_text": "детальное описание сцены для видео-генератора на английском: конкретное действие субъекта (не просто 'talking', а что именно делают руки/тело/лицо — мимика, взгляд, микро-движения), движение камеры (static/slow pan/dolly-in/handheld), освещение/атмосфера момента, без диалогов и текста в кадре. Пиши МАКСИМАЛЬНО подробно и конкретно, 3-4 предложения — чем детальнее описание, тем точнее видео-модель следует ему и тем меньше артефактов",
      "character_position": "где именно в локации находится персонаж и как расположен, с привязкой к конкретным предметам обстановки из описания локации (например 'sitting on the left barstool at the copper-top counter, facing the bartender'), на английском",
      "primary_character": "Анна",
      "secondary_characters": ["Босс"],
      "speaker": "Анна — ИМЯ ТОГО ПЕРСОНАЖА, кто именно произносит voiceover_text (может НЕ совпадать с primary_character — например, если в кадре крупным планом лицо слушающего, а говорит персонаж за кадром). Обязательно указывай точно, кто говорит, это определяет голос озвучки. null, если voiceover_text — это закадровый рассказчик, а не реплика персонажа.",
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
