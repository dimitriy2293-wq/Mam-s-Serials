import { Bot, session, InlineKeyboard, Keyboard, InputFile, webhookCallback } from "grammy";
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
  generateVoiceoverWaveSpeed,
  checkVideoStatus,
  checkBalance,
  estimateEpisodeCostUsd,
  estimateMaxScenes,
} from "./lib/wavespeed.js";
import { assembleEpisode } from "./lib/ffmpeg-assemble.js";
import { ensureBucket, uploadToStorage } from "./lib/storage.js";
import { supabaseSessionStorage } from "./lib/session-storage.js";
import { isUrl, fetchArticle, generateShortScript } from "./lib/shorts-script.js";
import { analyzeStyleFromVideo, MAX_STYLE_VIDEO_BYTES } from "./lib/style-learning.js";
import { assembleShort } from "./lib/shorts-assemble.js";

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
bot.use(async (ctx, next) => {
  const updateId = ctx.update?.update_id;
  if (updateId == null) return next();

  const { error } = await supabase.from("processed_updates").insert({ update_id: updateId });

  if (error) {
    if (error.code === "23505") {
      console.log(`Дубликат update_id=${updateId}, пропускаю повторную обработку.`);
      return;
    }
    console.error("Дедупликация update не сработала (продолжаю без неё):", error.message);
  }

  return next();
});

// ---------- Build-lock для сборки Shorts ----------
const BUILD_LOCK_STALE_MS = 15 * 60 * 1000; 

async function acquireShortBuildLock(shortId) {
  const staleThreshold = new Date(Date.now() - BUILD_LOCK_STALE_MS).toISOString();

  await supabase
    .from("shorts")
    .update({
      status: "error",
      build_lock: false,
      error: "Сборка зависла (дольше 15 минут) и была сброшена автоматически. Нажми /replay.",
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


// ---------- РОТАТОР КЛЮЧЕЙ WAVESPEED ----------
// Эта функция оборачивает все вызовы к WaveSpeed. Если ловит ошибку баланса или ключа - 
// автоматически меняет ключ в базе и в памяти, после чего продолжает генерацию.
async function withKeyRotation(ctx, actionName, actionFn) {
  let retries = 3;
  while (retries > 0) {
    try {
      // Если ключа в памяти нет (после перезапуска), пытаемся взять из базы
      if (!process.env.WAVESPEED_API_KEY) {
        const { data } = await supabase.from("wavespeed_keys").select("*").eq("is_active", true).limit(1).maybeSingle();
        if (data && data.key) {
           process.env.WAVESPEED_API_KEY = data.key;
        }
      }

      return await actionFn();
    } catch (err) {
      const msg = (err.message || "").toLowerCase();
      // Триггеры для смены ключа (ошибки авторизации, баланса, лимитов)
      if (
        msg.includes("balance") || 
        msg.includes("credit") || 
        msg.includes("unauthorized") || 
        msg.includes("key") || 
        msg.includes("401") || 
        msg.includes("403") || 
        msg.includes("insufficient") ||
        msg.includes("images.0 failed nullable validation")
      ) {
        retries--;
        const oldKey = process.env.WAVESPEED_API_KEY;
        
        // 1. Помечаем старый ключ как неактивный
        if (oldKey) {
          await supabase.from("wavespeed_keys").update({ is_active: false }).eq("key", oldKey);
        }

        // 2. Берем новый ключ
        const { data } = await supabase.from("wavespeed_keys").select("*").eq("is_active", true).limit(1).maybeSingle();
        
        if (data && data.key) {
          process.env.WAVESPEED_API_KEY = data.key;
          if (ctx) {
            // Пишем сообщение (если процесс быстрый, можно убрать, но для видео полезно)
            await ctx.reply(`🔄 API ключ WaveSpeed закончился во время задачи "${actionName}". Меняю на новый из базы и продолжаю...`).catch(() => {});
          }
          continue; // Пробуем выполнить функцию заново
        } else {
          if (ctx) await ctx.reply("❌ В базе не осталось рабочих API ключей WaveSpeed! Добавь новые через команду /update_key");
          throw new Error("Все ключи WaveSpeed израсходованы.");
        }
      }
      // Если ошибка другая, прокидываем дальше
      throw err;
    }
  }
  throw new Error(`Не удалось выполнить действие "${actionName}" после нескольких попыток смены ключа.`);
}
// ---------------------------------------------


// ---------- /start ----------
const mainMenuKeyboard = new Keyboard()
  .text("🎬 Создать сериал")
  .text("🎥 Создать TikTok")
  .resized();

bot.command("start", async (ctx) => {
  await ctx.reply(
    "Привет! Я создаю короткие AI-сериалы по твоему сюжету, а ещё умею делать короткие TikTok-style видео.\n\n" +
    "Выбери внизу, что хочешь сделать — 🎬 сериал или 🎥 TikTok.\n\n" +
    "Команда `/update_key` — пополнение базы API ключей WaveSpeed.\n" +
    "Если генерация упадёт с ошибкой — команда /replay продолжит с того места, где остановилось.",
    { parse_mode: "Markdown", reply_markup: mainMenuKeyboard }
  );
});

async function startNewEpisode(ctx) {
  ctx.session.step = "awaiting_draft_choice";
  ctx.session.draft = {};
  const kb = new InlineKeyboard()
    .text("У меня есть сюжет", "draft_yes")
    .text("Сгенерировать с нуля", "draft_no");

  await ctx.reply("Есть у тебя готовая идея сюжета, или сгенерировать с нуля?", { reply_markup: kb });
}

async function startNewShort(ctx) {
  ctx.session.shortDraft = {};
  ctx.session.step = "awaiting_short_input";
  await ctx.reply(
    "Пришли ссылку на статью, или просто опиши тему/идею для короткого видео.\n\n" +
    "Голос — русский (ElevenLabs), субтитры слово-за-словом, видео/фото со стоков (Pexels/Pixabay).\n\n" +
    "💡 Хочешь, чтобы стиль роликов ориентировался на конкретные примеры — пришли /learn_style."
  );
}

bot.hears("🎬 Создать сериал", startNewEpisode);
bot.hears("🎥 Создать TikTok", startNewShort);


// ---------- Выбор визуала: свои файлы или автоподбор со стоков ----------
bot.callbackQuery("visuals_auto", async (ctx) => {
  await safeAnswer(ctx);
  const { shortId, script, voiceoverUrl } = ctx.session.shortDraft || {};
  if (!shortId) {
    await ctx.reply("Не нашёл черновик TikTok. Начни заново — /new_short.");
    return;
  }
  ctx.session.step = null;
  await startShortBuild(ctx, shortId, script, voiceoverUrl, script?.title, []);
});

bot.callbackQuery("visuals_custom", async (ctx) => {
  await safeAnswer(ctx);
  const { script } = ctx.session.shortDraft || {};
  if (!script) {
    await ctx.reply("Не нашёл черновик TikTok. Начни заново — /new_short.");
    return;
  }
  ctx.session.step = "awaiting_custom_visuals";
  await ctx.reply(
    `Пришли фото/видео по порядку для сегментов (можно пачкой) — всего ${script.segments.length}. ` +
    `Если пришлёшь меньше — на оставшиеся сегменты бот подберёт визуал сам со стоков.`
  );
});

const customVisualBuffers = new Map();
const CUSTOM_VISUAL_DEBOUNCE_MS = 2500;

function bufferCustomVisual(ctx, item) {
  const userId = ctx.from.id;
  let buffer = customVisualBuffers.get(userId);
  if (!buffer) {
    buffer = { items: [], timer: null, ctx };
    customVisualBuffers.set(userId, buffer);
  }
  buffer.items.push(item);
  buffer.ctx = ctx;

  if (buffer.timer) clearTimeout(buffer.timer);
  buffer.timer = setTimeout(() => processCustomVisualBatch(userId), CUSTOM_VISUAL_DEBOUNCE_MS);
}

async function processCustomVisualBatch(userId) {
  const buffer = customVisualBuffers.get(userId);
  if (!buffer) return;
  customVisualBuffers.delete(userId);

  const { items, ctx } = buffer;
  const { shortId, script, voiceoverUrl } = ctx.session.shortDraft || {};
  if (!shortId) {
    await ctx.reply("Не нашёл черновик TikTok. Начни заново — /new_short.");
    return;
  }

  await ctx.reply(`📁 Получил ${items.length} файл(ов), загружаю...`);

  const customVisuals = [];
  for (const item of items) {
    const workDir = fs.mkdtempSync("/tmp/custom-visual-");
    try {
      const fileId = item.type === "video" ? item.message.file_id : item.message.file_id;
      const file = await ctx.api.getFile(fileId);
      if (!file.file_path) throw new Error("Telegram не вернул путь к файлу.");
      const telegramFileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
      const response = await fetch(telegramFileUrl);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const ext = item.type === "video" ? "mp4" : "jpg";
      const localPath = path.join(workDir, `custom.${ext}`);
      fs.writeFileSync(localPath, Buffer.from(await response.arrayBuffer()));

      const url = await uploadToStorage(localPath, "short-custom-visuals");
      customVisuals.push({ type: item.type, url });
    } catch (err) {
      console.error("Ошибка загрузки своего визуала:", err.message);
      customVisuals.push(null);
    } finally {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
    }
  }

  await supabase.from("shorts").update({ custom_visuals: customVisuals }).eq("id", shortId);

  ctx.session.step = null;
  const missing = script.segments.length - customVisuals.filter(Boolean).length;
  await ctx.reply(
    missing > 0
      ? `Принял ${customVisuals.filter(Boolean).length} файл(ов). Ещё ${missing} сегмент(ов) — визуал подберу сам.`
      : `Принял все файлы.`
  );

  await startShortBuild(ctx, shortId, script, voiceoverUrl, script?.title, customVisuals);
}

bot.command("new_episode", startNewEpisode);


// ---------- ОБНОВЛЕНИЕ КЛЮЧЕЙ (БАЗА ДАННЫХ) ----------
bot.command("update_key", async (ctx) => {
  ctx.session.step = "awaiting_api_keys";
  await ctx.reply(
    "🔑 Скинь API ключи WaveSpeed (можно сразу списком, каждый с новой строки).\n\n" +
    "🔗 Ссылка на сайт: https://wavespeed.io/login\n\n" +
    "Когда скинешь все ключи, нажми /finish_key чтобы завершить прием."
  );
});

bot.command("finish_key", async (ctx) => {
  if (ctx.session.step === "awaiting_api_keys") {
    ctx.session.step = null;
    await ctx.reply("✅ Прием ключей окончен. Теперь бот будет автоматически брать их из базы.");
  } else {
    await ctx.reply("Прием ключей сейчас и так не идет. Начни с команды /update_key.");
  }
});
// ---------------------------------------------------


// ---------- /replay ----------
bot.command("replay", async (ctx) => {
  const telegramId = ctx.from.id;

  const activeLock = await getActiveGeneration(telegramId);
  if (activeLock) {
    await ctx.reply(describeActiveGeneration(activeLock));
    return;
  }

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
    .in("status", ["error", "processing"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !episode) {
    await ctx.reply("Не получилось найти незавершённую задачу для повтора. Попробуй /new_short или /new_episode.");
    return;
  }

  const gotLock = await acquireGenerationLock(telegramId, "episode", episode.id, episode.title);
  if (!gotLock) {
    await ctx.reply(describeActiveGeneration(await getActiveGeneration(telegramId)));
    return;
  }

  await ctx.reply(`Продолжаю эпизод «${episode.title}».`);
  await supabase.from("episodes").update({ status: "processing" }).eq("id", episode.id);

  processEpisode(ctx, episode)
    .catch((err) => {
      console.error("Необработанная ошибка в processEpisode (replay):", err);
      ctx.reply("Опять что-то пошло не так. Нажми /replay ещё раз.").catch(() => {});
    })
    .finally(() => releaseGenerationLock(telegramId));
});

async function startShortBuild(ctx, shortId, script, voiceoverUrl, title, customVisuals = null) {
  const gotLock = await acquireShortBuildLock(shortId);
  if (!gotLock) {
    await ctx.reply(
      `⏳ TikTok «${title || "без названия"}» уже собирается. Дождись завершения — второй раз запускать не буду.\n\n` +
      `Если сборка реально зависла дольше 15 минут, пришли /replay ещё раз — лок сбросится автоматически, и эта попытка запустит сборку заново.`
    );
    return;
  }

  const gotGenerationLock = await acquireGenerationLock(ctx.from.id, "short", shortId, title);
  if (!gotGenerationLock) {
    await releaseShortBuildLock(shortId, { status: "error", error: "Другая генерация уже шла, начать сборку не удалось." });
    await ctx.reply(describeActiveGeneration(await getActiveGeneration(ctx.from.id)));
    return;
  }

  let visuals = customVisuals;
  if (visuals === null) {
    const { data } = await supabase.from("shorts").select("custom_visuals").eq("id", shortId).maybeSingle();
    visuals = data?.custom_visuals || [];
  }

  await ctx.reply(`🎬 Начинаю монтаж «${title || "TikTok"}». Это может занять несколько минут...`);

  assembleShortForTelegram(ctx, shortId, script, voiceoverUrl, visuals)
    .catch(async (err) => {
      console.error("Ошибка сборки short:", err);
      await releaseShortBuildLock(shortId, { status: "error", error: err.message });
      await ctx.reply(`❌ Не удалось собрать TikTok.\n\n${err.message}\n\nНажми /replay, чтобы попробовать ещё раз.`).catch(() => {});
    })
    .finally(() => releaseGenerationLock(ctx.from.id));
}

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

    ctx.session.shortDraft = { shortId: short.id, script: short.script };
    ctx.session.step = null;

    await ctx.reply(`🔄 Возобновляю сборку TikTok «${short.title || "без названия"}» с сохранённой озвучкой...`);
    await startShortBuild(ctx, short.id, short.script, short.voiceover_audio_url, short.title);
  } catch (err) {
    console.error("Ошибка /replay для short:", err);
    await releaseShortBuildLock(short.id, { status: "error", error: err.message });
    await ctx.reply(`❌ Не удалось продолжить TikTok.\n\n${err.message}\n\nНажми /replay, чтобы попробовать ещё раз.`);
  }
}

let currentlyBuildingShortId = null;
let currentGeneration = null;

const GENERATION_LOCK_STALE_MS = 20 * 60 * 1000; 

async function acquireGenerationLock(telegramId, kind, resourceId, resourceTitle) {
  const staleThreshold = new Date(Date.now() - GENERATION_LOCK_STALE_MS).toISOString();
  await supabase.from("generation_locks").delete().eq("telegram_id", telegramId).lt("locked_at", staleThreshold);

  const { error } = await supabase
    .from("generation_locks")
    .insert({ telegram_id: telegramId, kind, resource_id: resourceId, resource_title: resourceTitle || null });

  if (error) {
    if (error.code === "23505") return false; 
    console.error("Ошибка при попытке взять generation lock:", error);
    return false;
  }
  currentGeneration = { telegramId, kind, resourceId };
  return true;
}

async function releaseGenerationLock(telegramId) {
  const { error } = await supabase.from("generation_locks").delete().eq("telegram_id", telegramId);
  if (error) console.error("Не удалось освободить generation lock:", error);
  currentGeneration = null;
}

async function getActiveGeneration(telegramId) {
  const { data } = await supabase.from("generation_locks").select("*").eq("telegram_id", telegramId).maybeSingle();
  return data || null;
}

function describeActiveGeneration(lock) {
  const kindLabel = lock.kind === "episode" ? "сериал" : "TikTok";
  const title = lock.resource_title ? ` «${lock.resource_title}»` : "";
  return `⏳ Сейчас уже собирается ${kindLabel}${title}. Дождись, пока он закончится, прежде чем начинать новое.`;
}

async function gracefulShutdown(signal) {
  console.log(`Получен ${signal} — контейнер останавливается.`);
  if (currentlyBuildingShortId) {
    try {
      await releaseShortBuildLock(currentlyBuildingShortId, {
        status: "error",
        error: `Контейнер был перезапущен во время сборки (${signal}). Нажми /replay.`,
      });
    } catch (err) {}
  }
  if (currentGeneration) {
    if (currentGeneration.kind === "episode") {
      try {
        await supabase
          .from("episodes")
          .update({ status: "error", error: `Контейнер был перезапущен во время сборки (${signal}). Нажми /replay.` })
          .eq("id", currentGeneration.resourceId);
      } catch (err) {}
    }
    try {
      await releaseGenerationLock(currentGeneration.telegramId);
    } catch (err) {}
  }
  process.exit(0);
}
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

async function assembleShortForTelegram(ctx, shortId, script, voiceoverUrl, customVisuals = []) {
  currentlyBuildingShortId = shortId;
  try {
    const { localPath: finalPath, publicUrl, totalDurationSec } = await assembleShort(script, {
      voiceoverUrl,
      customVisuals,
      onProgress: (msg) => bot.api.sendMessage(ctx.chat.id, msg),
    });

    const { error } = await supabase
      .from("shorts")
      .update({ status: "completed", final_video_url: publicUrl, error: null, build_lock: false })
      .eq("id", shortId);
    if (error) console.error("Не удалось обновить completed short:", error);

    ctx.session.step = null;
    ctx.session.shortDraft = {};

    try {
      await ctx.replyWithVideo(publicUrl, {
        caption: `✅ Готово! TikTok собран полностью.\n⏱ Длительность: ${totalDurationSec.toFixed(1)} сек.`,
      });
    } catch (sendErr) {
      console.warn("Отправка по ссылке не удалась, пробую загрузить файл напрямую:", sendErr.message);
      await ctx.replyWithVideo(new InputFile(finalPath), {
        caption: `✅ Готово! TikTok собран полностью.\n⏱ Длительность: ${totalDurationSec.toFixed(1)} сек.`,
      });
    }

    try {
      fs.rmSync(path.dirname(finalPath), { recursive: true, force: true });
    } catch (cleanupError) {}
  } finally {
    currentlyBuildingShortId = null;
  }
}

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

bot.command("new_short", startNewShort);

bot.command("learn_style", async (ctx) => {
  await ctx.reply(
    "Пришли сюда одно или несколько видео файлом (можно сразу пачкой/альбомом, не по одному) — " +
    "разберу хук, темп, структуру, стиль субтитров и музыки в каждом, и учту это в следующих сценариях.\n\n" +
    "⚠️ Telegram отдаёт боту файлы только до 20 MB за штуку — если видео тяжелее, сожми или обрежь покороче."
  );
});

const videoBatchBuffers = new Map();
const VIDEO_BATCH_DEBOUNCE_MS = 2500;

bot.on("message:video", async (ctx) => {
  if (ctx.session.step === "awaiting_custom_visuals") {
    bufferCustomVisual(ctx, { type: "video", message: ctx.message.video });
    return;
  }

  const userId = ctx.from.id;
  let buffer = videoBatchBuffers.get(userId);
  if (!buffer) {
    buffer = { videos: [], timer: null, ctx };
    videoBatchBuffers.set(userId, buffer);
  }
  buffer.videos.push(ctx.message.video);
  buffer.ctx = ctx; 

  if (buffer.timer) clearTimeout(buffer.timer);
  buffer.timer = setTimeout(() => processVideoBatch(userId), VIDEO_BATCH_DEBOUNCE_MS);
});

bot.on("message:photo", async (ctx, next) => {
  if (ctx.session.step !== "awaiting_custom_visuals") return next();
  const sizes = ctx.message.photo;
  const largest = sizes[sizes.length - 1];
  bufferCustomVisual(ctx, { type: "photo", message: largest });
});

async function processVideoBatch(userId) {
  const buffer = videoBatchBuffers.get(userId);
  if (!buffer) return;
  videoBatchBuffers.delete(userId);

  const { videos, ctx } = buffer;
  await ctx.reply(
    videos.length > 1
      ? `📼 Получил ${videos.length} видео, разбираю стиль каждого (это может занять несколько минут)...`
      : `📼 Видео получено, разбираю стиль (может занять минуту)...`
  );

  let savedCount = 0;
  const failedReasons = [];

  for (const video of videos) {
    if (video.file_size && video.file_size > MAX_STYLE_VIDEO_BYTES) {
      failedReasons.push(`${(video.file_size / 1024 / 1024).toFixed(1)} MB — больше 20 MB, Telegram не отдаст файл боту.`);
      continue;
    }

    const workDir = fs.mkdtempSync("/tmp/style-video-");
    const localPath = path.join(workDir, "reference.mp4");
    try {
      const file = await ctx.api.getFile(video.file_id);
      if (!file.file_path) throw new Error("Telegram не вернул путь к файлу видео.");
      const telegramFileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
      const response = await fetch(telegramFileUrl);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      fs.writeFileSync(localPath, Buffer.from(await response.arrayBuffer()));

      const styleProfile = await analyzeStyleFromVideo(localPath);

      const { error: insertError } = await supabase
        .from("short_styles")
        .insert({ telegram_id: userId, name: `видео от ${new Date().toLocaleDateString("ru-RU")}`, style_profile: styleProfile });
      if (insertError) throw new Error(insertError.message);

      savedCount++;
    } catch (err) {
      console.error("Ошибка анализа стиля видео:", err);
      failedReasons.push(err.message);
    } finally {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
    }
  }

  let reply = `✅ Разобрано и сохранено: ${savedCount}/${videos.length}.`;
  if (failedReasons.length > 0) {
    reply += `\n\n❌ Не получилось разобрать:\n${failedReasons.map((r) => `— ${r}`).join("\n")}`;
  }
  if (savedCount > 0) {
    reply += `\n\nТеперь новые сценарии в /new_short будут ориентироваться на стиль этих роликов.`;
  }
  await ctx.reply(reply);
}

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

    ctx.session.step = "awaiting_visual_choice";
    ctx.session.shortDraft = { shortId, script, voiceoverUrl };

    const kb = new InlineKeyboard()
      .text("📁 Свои фото/видео", "visuals_custom")
      .text("🤖 Подобрать автоматически", "visuals_auto");
    await ctx.reply(
      `Озвучка получена (${script.segments.length} сегментов). Визуал для роликов — свой или подобрать со стоков автоматически?`,
      { reply_markup: kb }
    );

    return true;
  } catch (err) {
    console.error("Ошибка сборки short после загрузки озвучки:", err);
    await releaseShortBuildLock(shortId, { status: "error", error: err.message });
    await ctx.reply(`❌ Не удалось собрать TikTok.\n\n${err.message}\n\nНажми /replay, чтобы попробовать ещё раз.`);
    return true;
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
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

  // НОВЫЙ БЛОК ПРИЕМА КЛЮЧЕЙ WAVESPEED
  if (step === "awaiting_api_keys") {
    const keys = ctx.message.text.split("\n").map(k => k.trim()).filter(Boolean);
    let added = 0;
    for (const key of keys) {
      const { error } = await supabase.from("wavespeed_keys").insert({ key, is_active: true });
      if (!error) added++;
    }
    await ctx.reply(`✅ Сохранил ключей: ${added}. Можешь кидать еще или жми /finish_key для завершения.`);
    return;
  }

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
  let script;

  const { data: learnedStyles } = await supabase
    .from("short_styles")
    .select("style_profile")
    .eq("telegram_id", ctx.from.id)
    .order("created_at", { ascending: false })
    .limit(5);
  const styleProfiles = (learnedStyles || []).map((r) => r.style_profile);

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
      script = await generateShortScript({ input: articleText, isArticle: true, styleProfiles });
    } else {
      await ctx.reply("Пишу сценарий...");
      script = await generateShortScript({ input: rawInput, isArticle: false, styleProfiles });
    }
  } catch (err) {
    console.error("Ошибка генерации сценария short:", err);
    await ctx.reply("Не получилось сгенерировать сценарий. Попробуй ещё раз.");
    return;
  }

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
    // ВЫЗОВ С РОТАЦИЕЙ КЛЮЧЕЙ
    const characters = await withKeyRotation(ctx, "генерация персонажей", () => generateCharacterImages(ctx.session.draft.script.characters));
    ctx.session.draft.characters = characters;
    await confirmAndEstimateCredits(ctx);
  } catch (err) {
    console.error("Ошибка генерации персонажей:", err);
    await ctx.reply("WaveSpeed не ответил (или закончились ключи).", { parse_mode: "Markdown" });
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
      // ВЫЗОВ С РОТАЦИЕЙ КЛЮЧЕЙ
      const generated = await withKeyRotation(ctx, "недостающие персонажи", () => generateCharacterImages(missing));
      ctx.session.draft.characters.push(...generated);
    } catch (err) {
      await ctx.reply("Ошибка генерации. Пришли фото для оставшихся вручную.");
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
    try { 
      balance = await withKeyRotation(ctx, "проверка баланса", checkBalance); 
    } catch (err) {}

    ctx.session.step = "awaiting_generation_confirm";
    const kb = new InlineKeyboard().text("Генерировать видео", "confirm_generate");

    let balanceLine = "";
    if (balance !== null) {
      balanceLine = `\nБаланс WaveSpeed: $${balance.toFixed(2)}.`;
      if (balance < estimatedCost) balanceLine += `\n⚠️ Баланса может не хватить на весь эпизод, но бот сам переключит ключ, если они есть в базе.`;
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

  const telegramId = ctx.from.id;
  const activeLock = await getActiveGeneration(telegramId);
  if (activeLock) {
    await ctx.reply(describeActiveGeneration(activeLock));
    return;
  }

  await ctx.reply("Начинаю генерацию. Это займет несколько минут...");

  const { data: episode } = await supabase
    .from("episodes")
    .insert({
      telegram_id: telegramId,
      title: ctx.session.draft.script.title,
      script: ctx.session.draft.script,
      characters: ctx.session.draft.characters,
      locations: ctx.session.draft.locations || [],
      status: "processing",
    })
    .select()
    .single();

  const gotLock = await acquireGenerationLock(telegramId, "episode", episode.id, episode.title);
  if (!gotLock) {
    await ctx.reply(describeActiveGeneration(await getActiveGeneration(telegramId)));
    return;
  }

  processEpisode(ctx, episode)
    .catch((err) => {
      console.error("Необработанная ошибка в processEpisode:", err);
      ctx.reply("Что-то пошло не так во время генерации. Попробуй /new_episode заново.").catch(() => {});
    })
    .finally(() => releaseGenerationLock(telegramId));
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
        // ВЫЗОВ С РОТАЦИЕЙ КЛЮЧЕЙ
        loc.image_url = await withKeyRotation(ctx, `фон локации "${loc.name}"`, () => generateLocationImage(loc.description));
      } catch (err) {
        console.error(`Не удалось сгенерировать фон локации "${loc.name}":`, err.message);
        await ctx.reply(`⚠️ Не получилось сгенерировать фон для локации "${loc.name}": ${err.message}`);
      }
    }
    await supabase.from("episodes").update({ locations }).eq("id", episode.id);
  }
  const locationByName = new Map(locations.map((l) => [l.name, l]));

  const { data: existingScenes } = await supabase.from("scenes").select("*").eq("episode_id", episode.id);
  const existingByNumber = new Map((existingScenes || []).map((s) => [s.scene_number, s]));
  let voiceoverFailWarned = false;

  const sceneCharacterNames = (scene) =>
    [scene.primary_character, ...(scene.secondary_characters || [])].filter(Boolean);

  try {
    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      const sceneNumber = i + 1;
      await ctx.reply(`Сцена ${sceneNumber}/${scenes.length}: ${scene.script_text}`);

      let record = existingByNumber.get(sceneNumber);
      if (!record) {
        const charRefs = sceneCharacterNames(scene)
          .map((n) => characters.find((c) => c.name === n)?.ref_image_url)
          .filter(Boolean);

        let referenceImageUrl = null;
        try {
          const loc = locationByName.get(scene.location);
          const locationImageUrl = loc ? loc.image_url : null;

          if (!locationImageUrl) {
            throw new Error(`Фон локации "${scene.location}" не готов (не сгенерировался ранее) — пропускаю референс для этой сцены.`);
          }

          // ВЫЗОВ С РОТАЦИЕЙ КЛЮЧЕЙ
          referenceImageUrl = await withKeyRotation(ctx, `референс сцены ${sceneNumber}`, () => generateSceneReferenceImage(
            locationImageUrl,
            charRefs,
            scene.character_position || "in the scene"
          ));
        } catch (err) {
          console.error(`Ошибка генерации референса для сцены ${sceneNumber}:`, err.message);
        }

        const { data: newScene, error: insertSceneError } = await supabase
          .from("scenes")
          .insert({
            episode_id: episode.id,
            scene_number: sceneNumber,
            script_text: scene.script_text,
            video_status: "pending",
            character_ref_image_url: referenceImageUrl,
            duration_sec: scene.duration_sec || 5,
          })
          .select().single();

        if (insertSceneError || !newScene) {
          throw new Error(`Не удалось сохранить сцену ${sceneNumber} в базу: ${insertSceneError?.message || "неизвестная ошибка"}`);
        }
        record = newScene;

        if (!record.character_ref_image_url) {
          console.error(`Сцена ${sceneNumber}: нет референс-картинки, пропускаю генерацию видео.`);
          await supabase.from("scenes").update({ video_status: "failed" }).eq("id", record.id);
          record.video_status = "failed";
          continue;
        }

        try {
          // ВЫЗОВ С РОТАЦИЕЙ КЛЮЧЕЙ
          const videoResult = await withKeyRotation(ctx, `видео для сцены ${sceneNumber}`, () => generateVideoScene({
            referenceImageUrl: record.character_ref_image_url,
            prompt: scene.script_text,
          }));
          const taskId = videoResult.job_id;
          await supabase.from("scenes").update({ video_job_id: taskId, video_status: "processing" }).eq("id", record.id);
          record.video_job_id = taskId;
          record.video_status = "processing";
        } catch (err) {
          console.error(`Ошибка запуска генерации видео для сцены ${sceneNumber}:`, err.message);
          await supabase.from("scenes").update({ video_status: "failed" }).eq("id", record.id);
          record.video_status = "failed";
          continue;
        }
      }

      if (scene.voiceover_text && !record.voiceover_audio_url) {
        try {
          const speakerName = sceneCharacterNames(scene)[0] || null;
          const speakerDescription = speakerName ? (episode.script.characters || []).find((c) => c.name === speakerName)?.description : null;
          
          // ВЫЗОВ С РОТАЦИЕЙ КЛЮЧЕЙ
          const audioUrl = await withKeyRotation(ctx, `озвучка сцены ${sceneNumber}`, () => generateVoiceoverWaveSpeed(scene.voiceover_text, speakerDescription || ""));

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
    await ctx.reply("Генерация прервалась из-за ошибки (возможно закончились ключи). Возобнови её с помощью /replay.");
  }
}

async function pollScenes(ctx, episodeId) {
  let isDone = false;
  let compositeWarned = false;

  while (!isDone) {
    await new Promise((res) => setTimeout(res, 30_000));
    const { data: scenes } = await supabase.from("scenes").select("*").eq("episode_id", episodeId);
    const pending = scenes.filter((s) => s.video_status === "processing" || s.video_status === "pending");

    if (pending.length === 0) {
      isDone = true;
      const allSuccess = scenes.every((s) => s.video_status === "completed" && s.video_url);

      if (!allSuccess && !compositeWarned) {
         await ctx.reply("Некоторые сцены не удалось сгенерировать. Собираю эпизод из того, что получилось.");
         compositeWarned = true;
      }

      const validScenes = scenes.filter(s => s.video_status === "completed" && s.video_url).sort((a, b) => a.scene_number - b.scene_number);

      if (validScenes.length === 0) {
         await supabase.from("episodes").update({ status: "error" }).eq("id", episodeId);
         await ctx.reply("Не удалось сгенерировать ни одной сцены.");
         return;
      }

      await ctx.reply("Видео сгенерировано! Начинаю сборку со звуком...");
      try {
        const { localPath: finalPath, publicUrl } = await assembleEpisode(validScenes, episodeId);
        await supabase.from("episodes").update({ status: "completed", final_video_url: publicUrl }).eq("id", episodeId);

        try {
          await ctx.replyWithVideo(publicUrl, {
            caption: "✅ Готово! Твой сериал.\n\nНачать новый — /new_episode.",
          });
        } catch (sendErr) {
          console.warn("Отправка эпизода по ссылке не удалась, пробую загрузить файл напрямую:", sendErr.message);
          await ctx.replyWithVideo(new InputFile(finalPath), {
            caption: "✅ Готово! Твой сериал.\n\nНачать новый — /new_episode.",
          });
        }

        try {
          fs.rmSync(path.dirname(finalPath), { recursive: true, force: true });
        } catch (cleanupError) {}
      } catch (err) {
        console.error("Ошибка сборки:", err);
        await supabase.from("episodes").update({ status: "error", error: err.message }).eq("id", episodeId);
        await ctx.reply("Видео готовы, но не получилось собрать (FFmpeg). Попробуй /replay позже.");
      }
    } else {
      for (const scene of pending) {
        if (!scene.video_job_id) continue;
        try {
          // ВЫЗОВ С РОТАЦИЕЙ КЛЮЧЕЙ
          const status = await withKeyRotation(ctx, `проверка статуса сцены ${scene.scene_number}`, () => checkVideoStatus(scene.video_job_id));
          
          if (status.done) {
            await supabase.from("scenes").update({ video_status: "completed", video_url: status.video_url }).eq("id", scene.id);
            await ctx.reply(`✅ Сцена ${scene.scene_number} готова!`);
          } else if (status.error) {
            await supabase.from("scenes").update({ video_status: "failed" }).eq("id", scene.id);
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
  return script.scenes.map((s, i) => {
    const chars = [s.primary_character, ...(s.secondary_characters || [])].filter(Boolean);
    return `**Сцена ${i + 1}**: ${s.script_text}\n   Локация: ${s.location}\n   Персонажи: ${chars.join(", ")}\n`;
  }).join("\n");
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
  } else {
    bot.start(); 
    console.log("Started long polling mode");
  }
});
