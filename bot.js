import { Bot, session, InlineKeyboard, InputFile, webhookCallback } from "grammy";
import express from "express";
import "dotenv/config";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { supabase } from "./lib/supabase.js";
import { generateScript } from "./lib/gemini.js";
import {
  generateCharacterImages,
  generateSceneReferenceImage,
  generateLocationImage,
  generateVideoScene,
  checkVideoStatus,
  checkBalance,
  estimateEpisodeCostUsd,
  estimateMaxScenes,
} from "./lib/wavespeed.js";
import { generateVoiceover } from "./lib/elevenlabs.js";
import { assembleEpisode } from "./lib/ffmpeg-assemble.js";
import { ensureBucket, uploadToStorage } from "./lib/storage.js";
import { supabaseSessionStorage } from "./lib/session-storage.js";
import { isUrl, fetchArticle, generateShortScript } from "./lib/shorts-script.js";
import { assembleShort } from "./lib/shorts-assemble.js";

// ДОБАВЛЕНО: Импорт функций обхода WaveSpeed
import { step1_start, step2_finish } from "./lib/wavespeed-auth.js";

// Настройка путей
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);

async function safeAnswer(ctx) {
  await ctx.answerCallbackQuery().catch((err) => {
    console.log("answerCallbackQuery не прошёл (не критично):", err.message);
  });
}

function normalizeName(name) {
  return (name || "").trim().toLowerCase();
}

// ---------- Дедупликация Telegram update ----------
// Render может перезапустить процесс или не ответить Telegram вовремя (сборка видео
// занимает несколько минут) — тогда Telegram присылает ТОТ ЖЕ update повторно.
// Без защиты это приводило к тому, что один и тот же TikTok собирался несколько раз
// параллельно. Решение: атомарно фиксируем update_id в Supabase; если он уже есть —
// значит апдейт уже обрабатывается/обработан, второй раз ничего не делаем.
bot.use(async (ctx, next) => {
  const updateId = ctx.update?.update_id;
  if (updateId == null) return next();

  const { error } = await supabase.from("processed_updates").insert({ update_id: updateId });

  if (error) {
    if (error.code === "23505") {
      // unique_violation — это повторная доставка одного и того же update, игнорируем.
      console.log(`Дубликат update_id=${updateId}, пропускаю повторную обработку.`);
      return;
    }
    // Если таблицы ещё нет или Supabase недоступен — не блокируем бота, просто логируем.
    console.error("Дедупликация update не сработала (продолжаю без неё):", error.message);
  }

  return next();
});

// ---------- Build-lock для сборки Shorts ----------
// Один флаг в памяти процесса (let isBuilding = false) не спасает, потому что Render
// может держать/перезапускать несколько процессов. Поэтому лок хранится в Supabase и
// берётся ОДНИМ атомарным UPDATE: строка обновляется, только если лока ещё нет —
// Postgres гарантирует, что при двух одновременных запросах выиграет только один.
const BUILD_LOCK_STALE_MS = 10 * 60 * 1000; // если сборка "висит" дольше 10 минут — считаем её зависшей

async function acquireShortBuildLock(shortId) {
  const staleThreshold = new Date(Date.now() - BUILD_LOCK_STALE_MS).toISOString();

  await supabase
    .from("shorts")
    .update({
      status: "error",
      build_lock: false,
      error: "Сборка зависла (дольше 10 минут) и была сброшена автоматически. Нажми /replay.",
    })
    .eq("id", shortId)
    .eq("build_lock", true)
    .lt("build_started_at", staleThreshold);

  const { data, error } = await supabase
    .from("shorts")
    .update({
      status: "building",
      build_lock: true,
      build_started_at: new Date().toISOString(),
      error: null,
    })
    .eq("id", shortId)
    .or("build_lock.is.false,build_lock.is.null")
    .select()
    .maybeSingle();

  if (error) {
    console.error("Ошибка при попытке взять build_lock:", error);
    return false;
  }
  return Boolean(data);
}

async function releaseShortBuildLock(shortId, patch = {}) {
  const { error } = await supabase
    .from("shorts")
    .update({ build_lock: false, ...patch })
    .eq("id", shortId);
  if (error) console.error("Не удалось освободить build_lock:", error);
}

bot.use(session({
  initial: () => ({ step: null, draft: {} }),
  storage: supabaseSessionStorage,
  getSessionKey: (ctx) => ctx.from?.id.toString(),
}));

// ---------- /start ----------
bot.command("start", async (ctx) => {
  await ctx.reply(
    "Привет! Я создаю короткие AI-сериалы по твоему сюжету, а ещё умею делать короткие TikTok-style видео.\n\n" +
    "Нажми /new_episode чтобы начать новый эпизод сериала.\n" +
    "Нажми /new_short чтобы сделать короткое видео (30-40 сек) по ссылке на статью или по теме.\n" +
    "Команда `/update_key` — автоматическое обновление ключа WaveSpeed.\n" +
    "Команда `/update_key <ключ>` — ручное обновление.\n" +
    "Если генерация упадёт с ошибкой — команда /replay продолжит с того места, где остановилось.",
    { parse_mode: "Markdown" }
  );
});

// ---------- ОБНОВЛЕНИЕ КЛЮЧА ----------
bot.command("update_key", async (ctx) => {
  const newKey = ctx.match ? ctx.match.trim() : "";

  // Если ключ не передан вручную — запускаем автоматический обход (Playwright)
  if (!newKey) {
    return step1_start(bot, ctx.chat.id);
  }

  // Ручное обновление ключа через Render API
  const renderApiKey = process.env.RENDER_API_KEY;
  const serviceId = process.env.RENDER_SERVICE_ID; 

  if (!renderApiKey || !serviceId) {
    return ctx.reply(
      "❌ В `process.env` не найдены `RENDER_API_KEY` или `RENDER_SERVICE_ID`!"
    );
  }

  const statusMsg = await ctx.reply("⏳ Отправляю запрос в Render API для обновления `WAVESPEED_API_KEY`...");

  try {
    const response = await fetch(`https://api.render.com/v1/services/${serviceId}/env-vars/WAVESPEED_API_KEY`, {
      method: "PUT",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "Authorization": `Bearer ${renderApiKey}`
      },
      body: JSON.stringify({ value: newKey })
    });

    if (response.ok) {
      await ctx.api.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        "✅ **Ключ WAVESPEED_API_KEY успешно обновлен в Render!**\n\n🔄 Бот автоматически перезапускается с новым ключом (это займет около 1 минуты).",
        { parse_mode: "Markdown" }
      );
    } else {
      const errorData = await response.json().catch(() => ({ message: response.statusText }));
      await ctx.api.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        `❌ **Ошибка Render API (${response.status}):** ${errorData.message || response.statusText}`
      );
    }
  } catch (error) {
    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      "❌ Произошла ошибка при соединении с сервером Render."
    );
  }
});

// ---------- ЗАВЕРШЕНИЕ ОБНОВЛЕНИЯ ----------
bot.command("finish_key", async (ctx) => {
  // Вызываем второй шаг автоматизации (логин в WaveSpeed и извлечение ключа)
  await step2_finish(bot, ctx.chat.id);
});

// ---------- /replay ----------
// Универсальное продолжение последней незавершённой работы:
// 1) сначала пытаемся продолжить short;
// 2) если short нет — продолжаем сериал.
bot.command("replay", async (ctx) => {
  const telegramId = ctx.from.id;

  const { data: short, error: shortError } = await supabase
    .from("shorts")
    .select("*")
    .eq("telegram_id", telegramId)
    .in("status", ["error", "processing", "awaiting_voice", "voice_received", "building"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (shortError) console.error("Ошибка поиска short для /replay:", shortError);

  if (short) {
    await resumeShortFromReplay(ctx, short);
    return;
  }

  const { data: episode, error } = await supabase
    .from("episodes")
    .select("*")
    .eq("telegram_id", telegramId)
    .eq("status", "error")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !episode) {
    await ctx.reply("Не получилось найти незавершённую задачу для повтора. Попробуй /new_short или /new_episode.");
    return;
  }

  await ctx.reply(`Продолжаю эпизод «${episode.title}».`);
  await supabase.from("episodes").update({ status: "processing" }).eq("id", episode.id);

  processEpisode(ctx, episode).catch((err) => {
    console.error("Необработанная ошибка в processEpisode (replay):", err);
    ctx.reply("Опять что-то пошло не так. Нажми /replay ещё раз.").catch(() => {});
  });
});

async function resumeShortFromReplay(ctx, short) {
  try {
    if (short.status === "awaiting_voice" || !short.voiceover_audio_url) {
      ctx.session.shortDraft = { shortId: short.id, script: short.script };
      ctx.session.step = "awaiting_short_voice";
      await ctx.reply(
        `🔄 Продолжаю TikTok «${short.title || "без названия"}».\n\n` +
        `Озвучка ещё не получена. Пришли сюда готовый MP3, WAV, M4A, OGG или AAC — и я продолжу сборку с этого места.`
      );
      return;
    }

    // Важно: НЕ выходим здесь только потому, что status === "building". Сброс
    // зависшего лока (если сборка висит дольше 10 минут) происходит внутри
    // acquireShortBuildLock — если просто ответить "жди" и не вызвать её, лок
    // никогда не разблокируется через /replay, даже если процесс давно умер.
    ctx.session.shortDraft = { shortId: short.id, script: short.script };
    ctx.session.step = null;

    const gotLock = await acquireShortBuildLock(short.id);
    if (!gotLock) {
      await ctx.reply(
        `⏳ TikTok «${short.title || "без названия"}» уже собирается. Дождись завершения — второй раз запускать не буду.\n\n` +
        `Если сборка реально зависла дольше 10 минут, пришли /replay ещё раз — лок сбросится автоматически, и эта попытка запустит сборку заново.`
      );
      return;
    }

    await ctx.reply(`🔄 Возобновляю сборку TikTok «${short.title || "без названия"}» с сохранённой озвучкой...`);
    await assembleShortForTelegram(ctx, short.id, short.script, short.voiceover_audio_url);
  } catch (err) {
    console.error("Ошибка /replay для short:", err);
    await releaseShortBuildLock(short.id, { status: "error", error: err.message });
    await ctx.reply(`❌ Не удалось продолжить TikTok.\n\n${err.message}\n\nНажми /replay, чтобы попробовать ещё раз.`);
  }
}

async function assembleShortForTelegram(ctx, shortId, script, voiceoverUrl) {
  const { localPath: finalPath, publicUrl, totalDurationSec } = await assembleShort(script, {
    voiceoverUrl,
    onProgress: (msg) => bot.api.sendMessage(ctx.chat.id, msg),
  });

  const { error } = await supabase
    .from("shorts")
    .update({ status: "completed", final_video_url: publicUrl, error: null, build_lock: false })
    .eq("id", shortId);
  if (error) console.error("Не удалось обновить completed short:", error);

  ctx.session.step = null;
  ctx.session.shortDraft = {};

  await ctx.replyWithVideo(new InputFile(finalPath), {
    caption: `✅ Готово! TikTok собран полностью.\n⏱ Длительность: ${totalDurationSec.toFixed(1)} сек.`,
  });

  // После отправки видео удаляем временную папку сборки, чтобы Render не забивал диск.
  try {
    fs.rmSync(path.dirname(finalPath), { recursive: true, force: true });
  } catch (cleanupError) {
    console.warn("Не удалось очистить временные файлы short:", cleanupError.message);
  }
}

// ---------- /new_episode ----------
bot.command("new_episode", async (ctx) => {
  ctx.session.step = "awaiting_draft_choice";
  ctx.session.draft = {};
  const kb = new InlineKeyboard()
    .text("У меня есть сюжет", "draft_yes")
    .text("Сгенерировать с нуля", "draft_no");
    
  await ctx.reply("Есть у тебя готовая идея сюжета, или сгенерировать с нуля?", { reply_markup: kb });
});

bot.callbackQuery("draft_yes", async (ctx) => {
  ctx.session.step = "awaiting_draft_text";
  await safeAnswer(ctx);
  await ctx.reply("Пришли текстом свою идею/черновик сюжета (можно коротко, ИИ доработкает).");
});

bot.callbackQuery("draft_no", async (ctx) => {
  ctx.session.step = "awaiting_theme";
  await safeAnswer(ctx);
  await ctx.reply("Опиши тему/жанр для сериала (например: 'комедия про аэропорт').");
});

// ---------- /new_short ----------
bot.command("new_short", async (ctx) => {
  ctx.session.step = "awaiting_short_input";
  ctx.session.shortDraft = {};
  await ctx.reply(
    "Пришли ссылку на статью, или просто опиши тему/идею для короткого видео (30-40 сек).\n\n" +
    "Голос — русский (ElevenLabs), субтитры слово-за-словом, видео/фото со стоков (Pexels/Pixabay)."
  );
});

// ---------- Озвучка для /new_short ----------
async function handleShortVoiceUpload(ctx) {
  if (ctx.session.step !== "awaiting_short_voice" || !ctx.session.shortDraft?.shortId) return false;

  const shortId = ctx.session.shortDraft.shortId;
  const script = ctx.session.shortDraft.script;
  const message = ctx.message;

  const isAudio = Boolean(message.audio);
  const isDocument = Boolean(message.document);
  if (!isAudio && !isDocument) return false;

  const fileName =
    message.audio?.file_name ||
    message.document?.file_name ||
    `voiceover_${Date.now()}.mp3`;

  const extFromName = path.extname(fileName).toLowerCase();
  const mime = message.audio?.mime_type || message.document?.mime_type || "";
  const allowedExt = [".mp3", ".wav", ".m4a", ".ogg", ".oga", ".opus", ".aac"];

  let ext = extFromName;
  if (!allowedExt.includes(ext)) {
    if (mime.includes("mpeg")) ext = ".mp3";
    else if (mime.includes("wav")) ext = ".wav";
    else if (mime.includes("mp4") || mime.includes("m4a")) ext = ".m4a";
    else if (mime.includes("ogg") || mime.includes("opus")) ext = ".ogg";
    else return false;
  }

  const workDir = fs.mkdtempSync("/tmp/short-upload-");
  const localPath = path.join(workDir, `voiceover${ext}`);

  try {
    await ctx.reply("🎙️ Озвучка получена! Скачиваю файл...");

    // В grammY File нет метода download(). Скачиваем файл через Telegram Bot API.
    const file = await ctx.api.getFile(message.audio?.file_id || message.document?.file_id);
    if (!file.file_path) throw new Error("Telegram не вернул путь к файлу озвучки.");

    const telegramFileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
    const response = await fetch(telegramFileUrl);
    if (!response.ok) {
      throw new Error(`Не удалось скачать озвучку из Telegram: HTTP ${response.status}`);
    }
    const audioBuffer = Buffer.from(await response.arrayBuffer());
    if (!audioBuffer.length) throw new Error("Telegram вернул пустой файл озвучки.");
    fs.writeFileSync(localPath, audioBuffer);

    const voiceoverUrl = await uploadToStorage(localPath, "short-voiceovers");

    const { error: updateError } = await supabase
      .from("shorts")
      .update({ status: "voice_received", voiceover_audio_url: voiceoverUrl })
      .eq("id", shortId);

    if (updateError) throw new Error(`Не удалось сохранить озвучку: ${updateError.message}`);

    // С этого момента диалоговый шаг больше не должен запускать новую сборку — судьбу
    // сборки решает build_lock в базе. Это защищает от повторного Telegram-апдейта
    // (тот же файл, доставленный дважды) даже если дедупликация по update_id почему-то не сработала.
    ctx.session.step = null;

    const gotLock = await acquireShortBuildLock(shortId);
    if (!gotLock) {
      await ctx.reply("⏳ Сборка этого TikTok уже идёт. Дождись результата — второй раз запускать не буду.");
      return true;
    }

    await ctx.reply("🎬 Начинаю монтаж. Это может занять несколько минут...");
    await assembleShortForTelegram(ctx, shortId, script, voiceoverUrl);

    return true;
  } catch (err) {
    console.error("Ошибка сборки short после загрузки озвучки:", err);

    await releaseShortBuildLock(shortId, { status: "error", error: err.message });

    await ctx.reply(
      `❌ Не удалось собрать TikTok.\n\n` +
      `${err.message}\n\n` +
      `Нажми /replay, чтобы попробовать ещё раз.`
    );
    return true;
  } finally {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {}
  }
}

bot.on("message:audio", async (ctx) => {
  await handleShortVoiceUpload(ctx);
});

bot.on("message:document", async (ctx) => {
  await handleShortVoiceUpload(ctx);
});

// ---------- Текстовые сообщения ----------
bot.on("message:text", async (ctx, next) => {
  if (ctx.message.text.startsWith("/")) return next();

  const step = ctx.session.step;

  if (step === "awaiting_draft_text" || step === "awaiting_theme") {
    const isDraft = step === "awaiting_draft_text";
    await ctx.reply("Дорабатываю сценарий...");

    const maxScenes = estimateMaxScenes(1, { locationCount: 1, characterCount: 2 });

    let script;
    try {
      script = await generateScript({ userInput: ctx.message.text, isDraft, maxScenes });
    } catch (err) {
      console.error("Ошибка генерации сценария:", err);
      await ctx.reply("Gemini сейчас перегружен. Попробуй ещё раз через минуту — просто пришли текст заново.");
      return;
    }

    ctx.session.draft.script = script;
    ctx.session.draft.locations = (script.locations || []).map((l) => ({
      name: l.name,
      description: l.description,
      image_url: null,
    }));
    ctx.session.draft.locationQueueIndex = 0;
    ctx.session.step = "awaiting_location_step";

    await ctx.reply(`Вот разбивка по сценам:\n\n${formatScriptPreview(script)}`);
    await askLocationStep(ctx);
    return;
  }

  if (step === "awaiting_location_description") {
    const idx = ctx.session.draft.locationQueueIndex;
    ctx.session.draft.locations[idx].description = ctx.message.text.trim();
    ctx.session.draft.locationQueueIndex += 1;
    ctx.session.step = "awaiting_location_step";
    await ctx.reply("Описание сохранено, фон будет сгенерирован по нему.");
    await askLocationStep(ctx);
    return;
  }

  if (step === "awaiting_short_input") {
    ctx.session.step = null;
    await runShortPipeline(ctx, ctx.message.text.trim());
    return;
  }
});

async function runShortPipeline(ctx, rawInput) {
  const chatId = ctx.chat.id;
  let script;

  try {
    if (isUrl(rawInput)) {
      await ctx.reply("Загружаю статью по ссылке...");
      const { text: articleText, ogImage } = await fetchArticle(rawInput);
      if (!articleText || articleText.length < 200) {
        await ctx.reply("Не получилось вытащить достаточно текста. Пришли текст статьи.");
        return;
      }
      ctx.session.shortDraft = { ogImage };
      await ctx.reply("Статья загружена, пишу сценарий...");
      script = await generateShortScript({ input: articleText, isArticle: true });
    } else {
      await ctx.reply("Пишу сценарий...");
      script = await generateShortScript({ input: rawInput, isArticle: false });
    }
  } catch (err) {
    console.error("Ошибка генерации сценария short:", err);
    await ctx.reply("Не получилось сгенерировать сценарий. Попробуй ещё раз.");
    return;
  }

  // Склеиваем сценарий в один чистый текст без цифр
  const cleanScript = script.segments.map(s => s.narration).join(" ");

  const { data: shortRecord, error: insertError } = await supabase
    .from("shorts")
    .insert({
      telegram_id: ctx.from.id,
      title: script.title,
      type: script.type,
      script,
      status: "awaiting_voice",
    })
    .select()
    .single();

  if (insertError || !shortRecord) {
    console.error("Ошибка сохранения short:", insertError);
    await ctx.reply("❌ Сценарий создан, но не удалось сохранить задачу. Попробуй /new_short ещё раз.");
    return;
  }

  ctx.session.shortDraft = {
    shortId: shortRecord.id,
    script,
    ogImage: ctx.session.shortDraft?.ogImage || null,
  };
  ctx.session.step = "awaiting_short_voice";

  await ctx.reply(
    `🎬 **Сценарий готов!**\n\n` +
    `${cleanScript}\n\n` +
    `🔊 **Теперь сделай озвучку:**\n` +
    `1. Открой ElevenLabs.\n` +
    `2. Вставь этот текст.\n` +
    `3. Скачай готовую озвучку в MP3, WAV или M4A.\n` +
    `4. Пришли файл сюда в этот чат.\n\n` +
    `🔗 [Открыть ElevenLabs](https://elevenlabs.io/app/speech-synthesis)\n\n` +
    `⏳ После получения файла я сам соберу: визуал + твою озвучку + музыку + субтитры и пришлю готовый TikTok.`
  );
}
async function askLocationStep(ctx) {
  const { locations, locationQueueIndex } = ctx.session.draft;
  if (locationQueueIndex >= locations.length) {
    return askCharacterChoice(ctx);
  }
  const loc = locations[locationQueueIndex];
  const kb = new InlineKeyboard()
    .text("Сгенерировать ИИ", "loc_ai")
    .text("Своё фото", "loc_photo")
    .row()
    .text("Своё описание", "loc_desc");
  await ctx.reply(`Локация «${loc.name}»: ${loc.description}\n\nКак задать фон для неё?`, { reply_markup: kb });
}

async function askCharacterChoice(ctx) {
  ctx.session.step = "awaiting_character_choice";
  const script = ctx.session.draft.script;
  const kb = new InlineKeyboard()
    .text("Свои персонажи (пришлю фото)", "chars_own")
    .text("Сгенерировать персонажей", "chars_ai");
  const charList = script.characters.map((c) => c.name).join(", ");
  await ctx.reply(`Персонажи в сюжете: ${charList}\n\nПерсонажей — свои или сгенерировать?`, { reply_markup: kb });
}

bot.callbackQuery("loc_ai", async (ctx) => {
  await safeAnswer(ctx);
  ctx.session.draft.locationQueueIndex += 1;
  await askLocationStep(ctx);
});

bot.callbackQuery("loc_photo", async (ctx) => {
  await safeAnswer(ctx);
  ctx.session.step = "awaiting_location_photo";
  await ctx.reply("Пришли фото фона для этой локации.");
});

bot.callbackQuery("loc_desc", async (ctx) => {
  await safeAnswer(ctx);
  ctx.session.step = "awaiting_location_description";
  await ctx.reply("Опиши локацию своими словами — сгенерирую фон по этому описанию.");
});

bot.callbackQuery("chars_own", async (ctx) => {
  ctx.session.step = "awaiting_character_photos";
  ctx.session.draft.characters = [];
  await safeAnswer(ctx);
  const names = ctx.session.draft.script.characters.map((c) => c.name).join(", ");
  await ctx.reply(`Пришли фото персонажа(ей) по одному (${names}). После каждого фото выберешь, кто это. В конце — /done.`);
});

bot.callbackQuery("chars_ai", async (ctx) => {
  await safeAnswer(ctx);
  await ctx.reply("Генерирую всех персонажей по описанию из сценария...");
  try {
    const characters = await generateCharacterImages(ctx.session.draft.script.characters);
    ctx.session.draft.characters = characters;
    await confirmAndEstimateCredits(ctx);
  } catch (err) {
    console.error("Ошибка генерации персонажей:", err);
    await ctx.reply("WaveSpeed не ответил. Попробуй `/update_key` для обновления токена, либо пришли фото вручную.", { parse_mode: "Markdown" });
  }
});

bot.on("message:photo", async (ctx) => {
  if (ctx.session.step === "awaiting_location_photo") {
    const fileId = ctx.message.photo.at(-1).file_id;
    const file = await ctx.api.getFile(fileId);
    const url = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;

    const idx = ctx.session.draft.locationQueueIndex;
    ctx.session.draft.locations[idx].image_url = url;
    ctx.session.draft.locationQueueIndex += 1;
    ctx.session.step = "awaiting_location_step";
    await ctx.reply("Фон сохранён.");
    await askLocationStep(ctx);
    return;
  }

  if (ctx.session.step !== "awaiting_character_photos") return;

  const fileId = ctx.message.photo.at(-1).file_id;
  const file = await ctx.api.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
  ctx.session.draft.pendingPhotoUrl = url;

  const allNames = ctx.session.draft.script.characters.map((c) => c.name);
  const remaining = allNames.filter((n) => !ctx.session.draft.characters.some((c) => c.name === n));

  if (remaining.length === 0) {
    await ctx.reply("Все персонажи уже собраны. Можно жать /done.");
    return;
  }

  const kb = new InlineKeyboard();
  remaining.forEach((name, i) => {
    kb.text(name, `char_pick:${allNames.indexOf(name)}`);
    if (i % 2 === 1) kb.row();
  });
  await ctx.reply("Кто это?", { reply_markup: kb });
});

bot.callbackQuery(/^char_pick:/, async (ctx) => {
  await safeAnswer(ctx);
  const idx = parseInt(ctx.callbackQuery.data.split(":")[1], 10);
  const name = ctx.session.draft.script.characters[idx]?.name;
  const pendingPhoto = ctx.session.draft.pendingPhotoUrl;
  
  if (!name || !pendingPhoto) {
    await ctx.reply("Что-то пошло не так, пришли фото ещё раз.");
    return;
  }

  ctx.session.draft.characters.push({ name, source: "user_upload", ref_image_url: pendingPhoto });

  const remaining = ctx.session.draft.script.characters
    .map((c) => c.name)
    .filter((n) => !ctx.session.draft.characters.some((c) => c.name === n));

  if (remaining.length > 0) {
    await ctx.reply(`Добавлен персонаж "${name}". Осталось: ${remaining.join(", ")}.\nПришли следующее фото, или /done.`);
  } else {
    await ctx.reply(`Все персонажи собраны. Можно жать /done.`);
  }
});

bot.command("done", async (ctx) => {
  if (ctx.session.step !== "awaiting_character_photos") return;

  const scriptCharacters = ctx.session.draft.script.characters;
  const haveNames = ctx.session.draft.characters.map((c) => c.name);
  const missing = scriptCharacters.filter((c) => !haveNames.includes(c.name));

  if (missing.length > 0) {
    await ctx.reply(`Генерирую недостающих персонажей (${missing.map((c) => c.name).join(", ")})...`);
    try {
      const generated = await generateCharacterImages(missing);
      ctx.session.draft.characters.push(...generated);
    } catch (err) {
      await ctx.reply("WaveSpeed не ответил. Пришли фото для оставшихся вручную.");
      return;
    }
  }
  await confirmAndEstimateCredits(ctx);
});

async function confirmAndEstimateCredits(ctx) {
  try {
    const scenes = ctx.session.draft.script.scenes;
    const totalSeconds = scenes.reduce((s, sc) => s + sc.duration_sec, 0);
    const locationsNeedingGen = (ctx.session.draft.locations || []).filter((l) => !l.image_url).length;
    const voiceoverSceneCount = scenes.filter((s) => s.voiceover_text).length;

    const estimatedCost = estimateEpisodeCostUsd({
      sceneCount: scenes.length,
      locationCount: locationsNeedingGen,
      voiceoverSceneCount,
      characterCount: ctx.session.draft.characters.length,
    });

    let balance = null;
    try { balance = await checkBalance(); } catch (err) {}

    ctx.session.step = "awaiting_generation_confirm";
    const kb = new InlineKeyboard().text("Генерировать видео", "confirm_generate");

    let balanceLine = "";
    if (balance !== null) {
      balanceLine = `\nБаланс WaveSpeed: $${balance.toFixed(2)}.`;
      if (balance < estimatedCost) balanceLine += `\n⚠️ Баланса может не хватить на весь эпизод. Воспользуйся \`/update_key\` для смены аккаунта.`;
    }

    await ctx.reply(
      `Эпизод: ${scenes.length} сцен, ${totalSeconds} сек видео, ${ctx.session.draft.characters.length} персонажей.\n` +
      `Примерно $${estimatedCost.toFixed(2)} на WaveSpeed.${balanceLine}\n\nПодтверждаешь генерацию?`,
      { reply_markup: kb, parse_mode: "Markdown" }
    );
  } catch (err) {
    await ctx.reply("Что-то пошло не так при подсчёте. Попробуй /new_episode заново.");
  }
}

bot.callbackQuery("confirm_generate", async (ctx) => {
  await safeAnswer(ctx);
  await ctx.reply("Начинаю генерацию. Это займет несколько минут...");

  const { data: episode } = await supabase
    .from("episodes")
    .insert({
      telegram_id: ctx.from.id,
      title: ctx.session.draft.script.title,
      script: ctx.session.draft.script,
      characters: ctx.session.draft.characters,
      locations: ctx.session.draft.locations || [],
      status: "processing",
    })
    .select()
    .single();

  processEpisode(ctx, episode).catch((err) => {
    console.error("Необработанная ошибка в processEpisode:", err);
    ctx.reply("Что-то пошло не так во время генерации. Попробуй /new_episode заново.").catch(() => {});
  });
});

async function processEpisode(ctx, episode) {
  const scenes = episode.script.scenes;
  const characters = episode.characters;

  const locations = episode.locations && episode.locations.length > 0
    ? episode.locations
    : (episode.script.locations || []).map((l) => ({ ...l, image_url: null }));

  const missingLocations = locations.filter((l) => !l.image_url);
  if (missingLocations.length > 0) {
    await ctx.reply(`Готовлю фон для локаций (${missingLocations.map((l) => l.name).join(", ")})...`);
    for (const loc of missingLocations) {
      try {
        loc.image_url = await generateLocationImage(loc.description);
      } catch (err) {}
    }
    await supabase.from("episodes").update({ locations }).eq("id", episode.id);
  }
  const locationByName = new Map(locations.map((l) => [l.name, l]));

  const { data: existingScenes } = await supabase.from("scenes").select("*").eq("episode_id", episode.id);
  const existingByNumber = new Map((existingScenes || []).map((s) => [s.scene_number, s]));
  let voiceoverFailWarned = false;

  try {
    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      const sceneNumber = i + 1;
      await ctx.reply(`Сцена ${sceneNumber}/${scenes.length}: ${scene.action_prompt}`);

      let record = existingByNumber.get(sceneNumber);
      if (!record) {
        let referenceImageUrl = null;
        try {
          const loc = locationByName.get(scene.location_name);
          const locationImageUrl = loc ? loc.image_url : null;
          referenceImageUrl = await generateSceneReferenceImage({
            scenePrompt: scene.action_prompt,
            locationImageUrl,
            charactersInScene: scene.character_names,
            allCharacters: characters,
            style: "Minecraft-style, blocky, low texture, vibrant colors",
          });
        } catch (err) {
          console.error(`Ошибка генерации референса для сцены ${sceneNumber}:`, err.message);
        }

        const { data: newScene } = await supabase
          .from("scenes")
          .insert({ episode_id: episode.id, scene_number: sceneNumber, prompt: scene.action_prompt, status: "pending", reference_image_url: referenceImageUrl })
          .select().single();
        record = newScene;

        const charRefs = (scene.character_names || []).map((n) => characters.find((c) => c.name === n)?.ref_image_url).filter(Boolean);

        const taskId = await generateVideoScene(
          scene.action_prompt, charRefs, record.reference_image_url || undefined, "Minecraft-style, blocky, low texture, vibrant colors"
        );
        await supabase.from("scenes").update({ task_id: taskId, status: "processing" }).eq("id", record.id);
        record.task_id = taskId;
        record.status = "processing";
      }

      if (scene.voiceover_text && !record.voiceover_audio_url) {
        try {
          const speakerName = (scene.character_names || [])[0] || scene.primary_character || null;
          const speakerDescription = speakerName ? (episode.script.characters || []).find((c) => c.name === speakerName)?.description : null;
          
          // ДОБАВЛЕНО: Передаем ctx внутрь generateVoiceover, чтобы внутри можно было отправить скриншот
          const audioUrl = await generateVoiceover(scene.voiceover_text, speakerName, speakerDescription, ctx);
          
          await supabase.from("scenes").update({ voiceover_audio_url: audioUrl }).eq("id", record.id);
          record.voiceover_audio_url = audioUrl;
        } catch (err) {
          console.error(`Ошибка озвучки (Сцена ${sceneNumber}):`, err.message);
          if (!voiceoverFailWarned) {
             await ctx.reply("Возникли проблемы с озвучкой некоторых сцен. Они останутся без голоса.");
             voiceoverFailWarned = true;
          }
        }
      }
    }
    await pollScenes(ctx, episode.id);

  } catch (error) {
    console.error("Критическая ошибка в processEpisode:", error);
    await supabase.from("episodes").update({ status: "error" }).eq("id", episode.id);
    await ctx.reply("Генерация прервалась из-за ошибки. Ты можешь возобновить её с помощью /replay.");
  }
}

async function pollScenes(ctx, episodeId) {
  let isDone = false;
  let compositeWarned = false;

  while (!isDone) {
    await new Promise((res) => setTimeout(res, 30_000));
    const { data: scenes } = await supabase.from("scenes").select("*").eq("episode_id", episodeId);
    const pending = scenes.filter((s) => s.status === "processing" || s.status === "pending");

    if (pending.length === 0) {
      isDone = true;
      const allSuccess = scenes.every((s) => s.status === "completed" && s.video_url);

      if (!allSuccess && !compositeWarned) {
         await ctx.reply("Некоторые сцены не удалось сгенерировать. Собираю эпизод из того, что получилось.");
         compositeWarned = true;
      }

      const validScenes = scenes.filter(s => s.status === "completed" && s.video_url).sort((a, b) => a.scene_number - b.scene_number);

      if (validScenes.length === 0) {
         await supabase.from("episodes").update({ status: "error" }).eq("id", episodeId);
         await ctx.reply("Не удалось сгенерировать ни одной сцены.");
         return;
      }

      await ctx.reply("Видео сгенерировано! Начинаю сборку со звуком...");
      try {
        const finalUrl = await assembleEpisode(validScenes, episodeId);
        await supabase.from("episodes").update({ status: "completed", final_video_url: finalUrl }).eq("id", episodeId);
        await ctx.reply(`Готово! Вот твой сериал:\n${finalUrl}\n\nНачать новый — /new_episode.`);
      } catch (err) {
        console.error("Ошибка сборки:", err);
        await supabase.from("episodes").update({ status: "error" }).eq("id", episodeId);
        await ctx.reply("Видео готовы, но не получилось собрать (FFmpeg). Попробуй /replay позже.");
      }
    } else {
      for (const scene of pending) {
        if (!scene.task_id) continue;
        try {
          const status = await checkVideoStatus(scene.task_id);
          if (status.status === "COMPLETED") {
            await supabase.from("scenes").update({ status: "completed", video_url: status.video_url }).eq("id", scene.id);
            await ctx.reply(`✅ Сцена ${scene.scene_number} готова!`);
          } else if (status.status === "FAILED") {
            await supabase.from("scenes").update({ status: "failed" }).eq("id", scene.id);
            await ctx.reply(`❌ Ошибка генерации сцены ${scene.scene_number}.`);
          }
        } catch (err) {
          console.error(`Ошибка проверки сцены ${scene.id}:`, err);
        }
      }
    }
  }
}

function formatScriptPreview(script) {
  return script.scenes.map((s, i) => `**Сцена ${i + 1}**: ${s.action_prompt}\n   Локация: ${s.location_name}\n   Персонажи: ${(s.character_names || []).join(", ")}\n`).join("\n");
}

await ensureBucket();
const app = express();
app.use(express.json());
app.get("/", (req, res) => res.send("Bot is running"));
app.use(webhookCallback(bot, "express", { timeoutMilliseconds: 60_000 }));

bot.catch((err) => {
  console.error(`Необработанная ошибка в апдейте ${err.ctx.update.update_id}:`, err.error);
});

process.on("unhandledRejection", (err) => console.error("Unhandled rejection:", err));

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Server listening on port ${PORT}`);
  const publicUrl = process.env.RENDER_EXTERNAL_URL;
  if (publicUrl) {
    await bot.api.setWebhook(publicUrl);
    console.log("Webhook set to", publicUrl);
  }
});
