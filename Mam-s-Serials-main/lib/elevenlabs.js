import "dotenv/config";
import fs from "fs";
import path from "path";
import { uploadToStorage } from "./storage.js";

const API_BASE = "https://api.elevenlabs.io/v1";

// Голос для русского/украинского текста — задан пользователем.
const RU_VOICE_ID = process.env.ELEVENLABS_VOICE_ID_RU || "85bJFRap3VIXOThFHxk3";
// Голос по умолчанию для остальных языков (можно задать свой в .env,
// иначе используется тот же голос — eleven_multilingual_v2 умеет говорить
// на разных языках одним и тем же голосом).
const DEFAULT_VOICE_ID = process.env.ELEVENLABS_VOICE_ID_DEFAULT || RU_VOICE_ID;
const MODEL_ID = "eleven_multilingual_v2";

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

function pickVoiceId(lang) {
  return lang === "ru" || lang === "uk" ? RU_VOICE_ID : DEFAULT_VOICE_ID;
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
    const err = await res.text();
    throw new Error(`ElevenLabs TTS error (${voice}${endpointSuffix}): ${res.status} ${err}`);
  }
  return res;
}

// ---------- Обычная озвучка (без таймкодов) — используется для сериала ----------
// ИИ сам определяет язык реплики и подбирает голос под него, ничего не нужно
// передавать вручную (ни пол персонажа, ни voice_style).
export async function generateVoiceover(text) {
  const lang = detectLanguage(text);
  const voice = pickVoiceId(lang);

  const res = await ttsRequest("", text, voice);
  const buffer = Buffer.from(await res.arrayBuffer());
  const tmpPath = path.join("/tmp", `voiceover_${Date.now()}.mp3`);
  fs.writeFileSync(tmpPath, buffer);
  return await uploadToStorage(tmpPath, "voiceovers");
}

// ---------- Озвучка с посимвольными таймкодами — нужна для субтитров "слово за словом" ----------
// Используется генератором коротких видео (lib/shorts-assemble.js).
// Возвращает локальный путь к mp3 + массив { word, start, end } в секундах.
export async function generateVoiceoverWithTimestamps(text, { voiceId } = {}) {
  const lang = detectLanguage(text);
  const voice = voiceId || pickVoiceId(lang);

  const res = await fetch(`${API_BASE}/text-to-speech/${voice}/with-timestamps`, {
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
    const err = await res.text();
    throw new Error(`ElevenLabs TTS (with-timestamps) error: ${res.status} ${err}`);
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
