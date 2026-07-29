import "dotenv/config";
import fs from "fs";
import path from "path";
import { uploadToStorage } from "./storage.js";

const API_BASE = "https://api.elevenlabs.io/v1";
const MODEL_ID = "eleven_multilingual_v2";

// ---------- Пулы голосов ----------
// Для ru/uk по умолчанию используется голос, который задал пользователь
// (один и тот же ID для муж/жен, если отдельные не заданы — ElevenLabs всё
// равно немного меняет подачу под контекст текста). Можно расширить пул,
// прописав НЕСКОЛЬКО ID через запятую в .env (см. .env.example) — тогда для
// разных персонажей будут браться разные голоса стабильно (по хэшу имени).
function parseIdList(envValue, fallback) {
  const raw = (envValue || "").split(",").map((s) => s.trim()).filter(Boolean);
  return raw.length > 0 ? raw : fallback;
}

const RU_FALLBACK = process.env.ELEVENLABS_VOICE_ID_RU || "85bJFRap3VIXOThFHxk3";
const RU_MALE_VOICES = parseIdList(process.env.ELEVENLABS_VOICE_ID_RU_MALE, [RU_FALLBACK]);
const RU_FEMALE_VOICES = parseIdList(process.env.ELEVENLABS_VOICE_ID_RU_FEMALE, [RU_FALLBACK]);

// Голоса для английского/прочих языков — стандартные premade-голоса ElevenLabs,
// доступные в любом аккаунте без клонирования (можно переопределить в .env).
const EN_MALE_VOICES = parseIdList(process.env.ELEVENLABS_VOICE_ID_EN_MALE, [
  "pNInz6obpgDQGcFmaJgB", // Adam
  "TxGEqnHWrfWFTfGW9XjX", // Josh
]);
const EN_FEMALE_VOICES = parseIdList(process.env.ELEVENLABS_VOICE_ID_EN_FEMALE, [
  "21m00Tcm4TlvDq8ikWAM", // Rachel
  "EXAVITQu4vr4xnSDxMaL", // Bella
]);

// ---------- Грубое автоопределение языка текста ----------
// Нужно, чтобы бот сам выбирал голос под язык реплики, не спрашивая пользователя.
export function detectLanguage(text) {
  const cyrillicMatches = (text.match(/[а-яёіїєґ]/gi) || []).length;
  const totalLetters = (text.match(/[a-zа-яёіїєґ]/gi) || []).length || 1;
  if (cyrillicMatches / totalLetters > 0.3) {
    return /[іїєґ]/i.test(text) ? "uk" : "ru";
  }
  return "en";
}

// Грубая эвристика пола по английскому description персонажа (его пишет Gemini
// при генерации сценария, см. lib/gemini.js) — как было в оригинальной логике
// на Qwen3-TTS, просто перенесено на пул голосов ElevenLabs.
function detectGender(description = "") {
  const desc = description.toLowerCase();
  const female = /\b(woman|girl|female|she|her)\b/.test(desc);
  const male = /\b(man|boy|male|he|his)\b/.test(desc);
  if (female && !male) return "female";
  if (male && !female) return "male";
  return null; // пол не определён — берём общий пул (муж+жен)
}

function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  return hash;
}

// Каждый персонаж стабильно получает СВОЙ голос (по хэшу имени) — не пересчитывается
// заново на каждую сцену или при /replay, поэтому один и тот же персонаж не "прыгает"
// между голосами по ходу эпизода, а РАЗНЫЕ персонажи звучат по-разному.
function pickVoiceId(lang, characterName = "", characterDescription = "") {
  const gender = detectGender(characterDescription);
  let pool;
  if (lang === "ru" || lang === "uk") {
    pool = gender === "female" ? RU_FEMALE_VOICES : gender === "male" ? RU_MALE_VOICES : [...RU_MALE_VOICES, ...RU_FEMALE_VOICES];
  } else {
    pool = gender === "female" ? EN_FEMALE_VOICES : gender === "male" ? EN_MALE_VOICES : [...EN_MALE_VOICES, ...EN_FEMALE_VOICES];
  }
  const key = characterName || characterDescription || "narrator";
  return pool[hashString(key) % pool.length];
}

// Встроенные (premade) голоса ElevenLabs — они есть в любом аккаунте и доступны
// через API даже на бесплатном тарифе. Используются как автоматический fallback,
// если основной голос (например, взятый из Voice Library) вернёт ошибку
// "paid_plan_required" — бесплатный тариф ElevenLabs не даёт дёргать библиотечные
// голоса через API, только через сайт. Подробности — в README.
const SAFE_MALE_VOICE = "pNInz6obpgDQGcFmaJgB"; // Adam (premade)
const SAFE_FEMALE_VOICE = "21m00Tcm4TlvDq8ikWAM"; // Rachel (premade)

function isPaidPlanRequiredError(err) {
  return err?.status === 402 || /paid_plan_required/i.test(err?.message || "");
}

async function ttsRequest(endpointSuffix, text, voice) {
  const res = await fetch(`${API_BASE}/text-to-speech/${voice}${endpointSuffix}`, {
    method: "POST",
    headers: {
      "xi-api-key": process.env.ELEVENLABS_API_KEY,
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    },
    body: JSON.stringify({
      text,
      model_id: MODEL_ID,
      voice_settings: { stability: 0.5, similarity_boost: 0.8, style: 0.3, use_speaker_boost: true },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    const err = new Error(`ElevenLabs TTS error (${voice}${endpointSuffix}): ${res.status} ${errText}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

// ---------- Обычная озвучка (без таймкодов) — используется для сериала ----------
// ИИ сам определяет язык реплики (по тексту) И голос (по имени/описанию
// персонажа, если переданы) — ничего не нужно задавать вручную. Если имя/описание
// не переданы, используется голос по умолчанию для определённого языка.
export async function generateVoiceover(text, characterName, characterDescription) {
  const lang = detectLanguage(text);
  const gender = detectGender(characterDescription);
  let voice = pickVoiceId(lang, characterName, characterDescription);

  let res;
  try {
    res = await ttsRequest("", text, voice);
  } catch (err) {
    if (!isPaidPlanRequiredError(err)) throw err;
    console.warn(
      `[ElevenLabs] Голос ${voice} недоступен на текущем тарифе (paid_plan_required), ` +
        `переключаюсь на встроенный голос.`
    );
    voice = gender === "female" ? SAFE_FEMALE_VOICE : SAFE_MALE_VOICE;
    res = await ttsRequest("", text, voice);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  const tmpPath = path.join("/tmp", `voiceover_${Date.now()}.mp3`);
  fs.writeFileSync(tmpPath, buffer);
  return await uploadToStorage(tmpPath, "voiceovers");
}

// ---------- Озвучка с посимвольными таймкодами — нужна для субтитров "слово за словом" ----------
// Используется генератором коротких видео (lib/shorts-assemble.js), где голос
// один на весь ролик (закадровый рассказчик), поэтому voiceId можно задать явно.
export async function generateVoiceoverWithTimestamps(text, { voiceId, characterName, characterDescription } = {}) {
  const lang = detectLanguage(text);
  let voice = voiceId || pickVoiceId(lang, characterName, characterDescription);

  async function requestWithTimestamps(v) {
    const res = await fetch(`${API_BASE}/text-to-speech/${v}/with-timestamps`, {
      method: "POST",
      headers: {
        "xi-api-key": process.env.ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        model_id: MODEL_ID,
        voice_settings: { stability: 0.5, similarity_boost: 0.8, style: 0.3, use_speaker_boost: true },
      }),
    });
    if (!res.ok) {
      const errText = await res.text();
      const err = new Error(`ElevenLabs TTS (with-timestamps) error: ${res.status} ${errText}`);
      err.status = res.status;
      throw err;
    }
    return res;
  }

  let res;
  try {
    res = await requestWithTimestamps(voice);
  } catch (err) {
    if (!isPaidPlanRequiredError(err)) throw err;
    console.warn(
      `[ElevenLabs] Голос ${voice} недоступен на текущем тарифе (paid_plan_required), ` +
        `переключаюсь на встроенный голос.`
    );
    voice = SAFE_FEMALE_VOICE;
    res = await requestWithTimestamps(voice);
  }

  const json = await res.json();
  if (!json.audio_base64) throw new Error("ElevenLabs: в ответе нет audio_base64");

  const buffer = Buffer.from(json.audio_base64, "base64");
  const tmpPath = path.join("/tmp", `tts_${Date.now()}_${Math.random().toString(36).slice(2)}.mp3`);
  fs.writeFileSync(tmpPath, buffer);

  const words = buildWordTimestamps(json.alignment);
  return { localPath: tmpPath, words, language: lang };
}

// Из посимвольных таймкодов ElevenLabs (alignment.characters +
// character_start/end_times_seconds) собираем таймкоды по словам —
// нужно для "слово за словом" субтитров в стиле TikTok.
function buildWordTimestamps(alignment) {
  if (!alignment || !alignment.characters) return [];
  const { characters, character_start_times_seconds, character_end_times_seconds } = alignment;

  const words = [];
  let current = "";
  let start = null;

  for (let i = 0; i < characters.length; i++) {
    const ch = characters[i];
    const isBoundary = /\s/.test(ch);
    if (isBoundary) {
      if (current) {
        words.push({ word: current, start, end: character_end_times_seconds[i - 1] });
        current = "";
        start = null;
      }
      continue;
    }
    if (start === null) start = character_start_times_seconds[i];
    current += ch;
  }
  if (current) {
    words.push({
      word: current,
      start,
      end: character_end_times_seconds[characters.length - 1],
    });
  }
  return words;
}
