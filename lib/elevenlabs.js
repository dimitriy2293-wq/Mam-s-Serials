import "dotenv/config";
import fs from "fs";
import path from "path";
import fetch from "node-fetch";
import { uploadToStorage } from "./storage.js";

// ДОБАВЛЕНО: Инструменты для браузерного обхода
import { chromium } from "playwright-extra";
import stealth from "puppeteer-extra-plugin-stealth";
chromium.use(stealth());

const API_BASE = "https://api.elevenlabs.io/v1";
const MODEL_ID = "eleven_multilingual_v2";

function parseIdList(envValue, fallback) {
  const raw = (envValue || "").split(",").map((s) => s.trim()).filter(Boolean);
  return raw.length > 0 ? raw : fallback;
}

const RU_FALLBACK = process.env.ELEVENLABS_VOICE_ID_RU || "85bJFRap3VIXOThFHxk3";
const RU_MALE_VOICES = parseIdList(process.env.ELEVENLABS_VOICE_ID_RU_MALE, [RU_FALLBACK]);
const RU_FEMALE_VOICES = parseIdList(process.env.ELEVENLABS_VOICE_ID_RU_FEMALE, [RU_FALLBACK]);
const EN_MALE_VOICES = parseIdList(process.env.ELEVENLABS_VOICE_ID_EN_MALE, ["pNInz6obpgDQGcFmaJgB", "TxGEqnHWrfWFTfGW9XjX"]);
const EN_FEMALE_VOICES = parseIdList(process.env.ELEVENLABS_VOICE_ID_EN_FEMALE, ["21m00Tcm4TlvDq8ikWAM", "EXAVITQu4vr4xnSDxMaL"]);

export function detectLanguage(text) {
  const cyrillicMatches = (text.match(/[а-яёіїєґ]/gi) || []).length;
  const totalLetters = (text.match(/[a-zа-яёіїєґ]/gi) || []).length || 1;
  if (cyrillicMatches / totalLetters > 0.3) return /[іїєґ]/i.test(text) ? "uk" : "ru";
  return "en";
}

function detectGender(description = "") {
  const desc = description.toLowerCase();
  const female = /\b(woman|girl|female|she|her)\b/.test(desc);
  const male = /\b(man|boy|male|he|his)\b/.test(desc);
  if (female && !male) return "female";
  if (male && !female) return "male";
  return null;
}

function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  return hash;
}

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

function isPaidPlanRequiredError(err) {
  return err?.status === 402 || /paid_plan_required/i.test(err?.message || "");
}

// ДОБАВЛЕНО: Браузерный обход для ElevenLabs
async function generateVoiceoverViaBrowser(text) {
  console.log("🚀 API недоступно. Запускаем браузерный обход ElevenLabs...");
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    const domainRes = await fetch('https://api.mail.tm/domains');
    const domainData = await domainRes.json();
    const domain = domainData['hydra:member'][0].domain;
    const address = `elbot${Date.now()}@${domain}`;
    const password = `Pass!${Date.now()}#99`;

    await fetch('https://api.mail.tm/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address, password })
    });
    const tokenRes = await fetch('https://api.mail.tm/token', {
       method: 'POST',
       headers: { 'Content-Type': 'application/json' },
       body: JSON.stringify({ address, password })
    });
    const { token } = await tokenRes.json();

    await page.goto('https://elevenlabs.io/app/sign-up', { waitUntil: "domcontentloaded" });
    await page.type('input[type="email"]', address);
    await page.type('input[type="password"]', password);
    await page.click('button[type="submit"]');

    console.log("Ждем письмо от ElevenLabs...");
    let verifyLink = null;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 4000));
      const res = await fetch(`https://api.mail.tm/messages`, { headers: { 'Authorization': `Bearer ${token}` } });
      const data = await res.json();
      if (data['hydra:member'] && data['hydra:member'].length > 0) {
        const msgId = data['hydra:member'][0].id;
        const msgRes = await fetch(`https://api.mail.tm/messages/${msgId}`, { headers: { 'Authorization': `Bearer ${token}` } });
        const msgData = await msgRes.json();
        const match = msgData.text.match(/https:\/\/elevenlabs\.io\/app\/verify-email\?token=[^\s'"]+/);
        if (match) {
           verifyLink = match[0];
           break;
        }
      }
    }
    if (!verifyLink) throw new Error("Не дождались письма от ElevenLabs");

    await page.goto(verifyLink, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(4000);
    
    try {
       const skipBtns = page.locator('button').filter({ hasText: 'Skip' });
       const count = await skipBtns.count();
       for(let i=0; i<count; i++) await skipBtns.nth(i).click();
    } catch(e) {}

    let audioBuffer = null;
    page.on('response', async (response) => {
        if (response.url().includes('/v1/text-to-speech/') && response.request().method() === 'POST') {
            audioBuffer = await response.body();
        }
    });

    await page.goto('https://elevenlabs.io/app/speech-synthesis/text-to-speech', { waitUntil: "domcontentloaded" });
    await page.waitForSelector('textarea');
    await page.fill('textarea', text);
    await page.click('button:has-text("Generate speech")');

    for(let i=0; i<30; i++) {
        if(audioBuffer) break;
        await page.waitForTimeout(1000);
    }
    if(!audioBuffer) throw new Error("Аудио не сгенерировалось в браузере");
    return audioBuffer;

  } finally {
    await browser.close();
  }
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
      text, model_id: MODEL_ID,
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

export async function generateVoiceover(text, characterName, characterDescription) {
  const lang = detectLanguage(text);
  const voice = pickVoiceId(lang, characterName, characterDescription);

  try {
    const res = await ttsRequest("", text, voice);
    const buffer = Buffer.from(await res.arrayBuffer());
    const tmpPath = path.join("/tmp", `voiceover_${Date.now()}.mp3`);
    fs.writeFileSync(tmpPath, buffer);
    return await uploadToStorage(tmpPath, "voiceovers");
  } catch (err) {
    // ВСТРАИВАЕМ ОБХОД СЮДА
    if (isPaidPlanRequiredError(err) || err.status === 401) {
      const buffer = await generateVoiceoverViaBrowser(text);
      const tmpPath = path.join("/tmp", `voiceover_${Date.now()}.mp3`);
      fs.writeFileSync(tmpPath, buffer);
      return await uploadToStorage(tmpPath, "voiceovers");
    }
    throw err;
  }
}

export async function generateVoiceoverWithTimestamps(text, { voiceId, characterName, characterDescription } = {}) {
  const lang = detectLanguage(text);
  let voice = voiceId || pickVoiceId(lang, characterName, characterDescription);

  async function requestWithTimestamps(v) {
    const res = await fetch(`${API_BASE}/text-to-speech/${v}/with-timestamps`, {
      method: "POST",
      headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ text, model_id: MODEL_ID, voice_settings: { stability: 0.5, similarity_boost: 0.8, style: 0.3, use_speaker_boost: true } }),
    });
    if (!res.ok) {
      const errText = await res.text();
      const err = new Error(`ElevenLabs TTS (with-timestamps) error: ${res.status} ${errText}`);
      err.status = res.status;
      throw err;
    }
    return res;
  }

  try {
    const res = await requestWithTimestamps(voice);
    const json = await res.json();
    if (!json.audio_base64) throw new Error("ElevenLabs: в ответе нет audio_base64");
    const buffer = Buffer.from(json.audio_base64, "base64");
    const tmpPath = path.join("/tmp", `tts_${Date.now()}_${Math.random().toString(36).slice(2)}.mp3`);
    fs.writeFileSync(tmpPath, buffer);
    const words = buildWordTimestamps(json.alignment);
    return { localPath: tmpPath, words, language: lang };
  } catch (err) {
    if (isPaidPlanRequiredError(err) || err.status === 401) {
      console.log("Fallback на браузер для шортсов (таймкоды будут эмулированы)...");
      const buffer = await generateVoiceoverViaBrowser(text);
      const tmpPath = path.join("/tmp", `tts_${Date.now()}_${Math.random().toString(36).slice(2)}.mp3`);
      fs.writeFileSync(tmpPath, buffer);
      
      // Эмулируем таймкоды (субтитры могут немного рассинхрониться, но видео соберется)
      const fakeWords = text.split(/\s+/).map((word, i) => ({ word, start: i * 0.4, end: (i + 1) * 0.4 }));
      return { localPath: tmpPath, words: fakeWords, language: lang };
    }
    throw err;
  }
}

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
        current = ""; start = null;
      }
      continue;
    }
    if (start === null) start = character_start_times_seconds[i];
    current += ch;
  }
  if (current) words.push({ word: current, start, end: character_end_times_seconds[characters.length - 1] });
  return words;
}
