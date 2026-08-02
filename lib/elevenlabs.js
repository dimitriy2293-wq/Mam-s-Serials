import "dotenv/config";
import fs from "fs";
import path from "path";
import fetch from "node-fetch";

const API_BASE = "https://api.elevenlabs.io/v1";

// ---------- Forced Alignment: реальные тайминги слов по готовой озвучке ----------
// Платная функция ElevenLabs — сейчас нигде не вызывается (shorts используют
// AssemblyAI, эпизоды — WaveSpeed OmniVoice), но оставлена на будущее: если
// появится подписка ElevenLabs, можно будет снова использовать её тайминги.
//
// В отличие от "поделить длительность поровну на слова", здесь ElevenLabs реально
// анализирует аудио и сопоставляет каждое слово транскрипта с точным местом в
// записи — субтитры совпадают с настоящей речью (паузы, длинные/короткие слова
// учитываются), а не с усреднённой прикидкой.
export async function forceAlignAudio(audioPath, text) {
  const audioBuffer = fs.readFileSync(audioPath);
  const form = new FormData();
  form.append("file", new Blob([audioBuffer]), path.basename(audioPath));
  form.append("text", text);

  const res = await fetch(`${API_BASE}/forced-alignment`, {
    method: "POST",
    headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY },
    body: form,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`ElevenLabs Forced Alignment вернул ${res.status}: ${errText.slice(0, 500)}`);
  }

  const json = await res.json();
  const rawWords = json.words || [];

  // Отсекаем служебные "пробельные" токены (некоторые API отдают их отдельными
  // записями с type:"spacing") и пустые строки — субтитрам нужны только сами слова.
  return rawWords
    .filter((w) => (w.type ? w.type !== "spacing" : true))
    .map((w) => ({ word: (w.text ?? w.word ?? "").trim(), start: w.start, end: w.end }))
    .filter((w) => w.word.length > 0 && w.start != null && w.end != null);
}
