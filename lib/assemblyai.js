import "dotenv/config";

const API_BASE = "https://api.assemblyai.com/v2";

// ---------- Реальные тайминги слов через AssemblyAI ----------
// Бесплатный тариф: $50 кредитов без привязки карты (~185 часов транскрибации) —
// для роликов по 30-90 сек этого хватит на тысячи сборок. В отличие от Forced
// Alignment (которая сопоставляет ИЗВЕСТНЫЙ текст с аудио), это обычная
// транскрибация — бот использует слова, которые AssemblyAI реально услышала,
// а не наш сценарий. Это даже надёжнее: субтитры будут совпадать с тем, что
// реально сказано в записи, даже если озвучка чуть отличается от сценария.
export async function transcribeWithWordTimestamps(audioUrl) {
  if (!process.env.ASSEMBLYAI_API_KEY) {
    throw new Error("Не задан ASSEMBLYAI_API_KEY.");
  }

  const createRes = await fetch(`${API_BASE}/transcript`, {
    method: "POST",
    headers: {
      Authorization: process.env.ASSEMBLYAI_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      audio_url: audioUrl,
      language_detection: true, // не хардкодим ru/uk — пусть определяет сама, надёжнее
    }),
  });

  if (!createRes.ok) {
    throw new Error(`AssemblyAI: не удалось создать транскрипцию (${createRes.status}): ${(await createRes.text()).slice(0, 500)}`);
  }
  const { id } = await createRes.json();

  // Транскрибация асинхронная — для короткого ролика обычно занимает секунды-минуту.
  const POLL_INTERVAL_MS = 3000;
  const MAX_WAIT_MS = 5 * 60_000;
  const startedAt = Date.now();

  while (Date.now() - startedAt < MAX_WAIT_MS) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    const pollRes = await fetch(`${API_BASE}/transcript/${id}`, {
      headers: { Authorization: process.env.ASSEMBLYAI_API_KEY },
    });
    if (!pollRes.ok) throw new Error(`AssemblyAI: ошибка опроса статуса (${pollRes.status})`);
    const data = await pollRes.json();

    if (data.status === "completed") {
      const words = (data.words || [])
        .map((w) => ({ word: (w.text || "").trim(), start: w.start / 1000, end: w.end / 1000 }))
        .filter((w) => w.word.length > 0);
      if (words.length === 0) throw new Error("AssemblyAI вернула пустую транскрипцию.");
      return words;
    }
    if (data.status === "error") {
      throw new Error(`AssemblyAI: транскрипция упала: ${data.error}`);
    }
    // status "queued" / "processing" — ждём дальше
  }

  throw new Error("AssemblyAI: транскрипция не завершилась за 5 минут.");
}
