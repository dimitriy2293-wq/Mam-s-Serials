import { Bot, session, InlineKeyboard, webhookCallback } from "grammy";
import express from "express";
import "dotenv/config";
import { supabase } from "./lib/supabase.js";
import {
  generateScript,
  generateCharacterImages,
  generateSceneReferenceImage,
  generateVoiceover,
} from "./lib/gemini.js";
import { generateVideoScene, checkVideoStatus } from "./lib/magichour.js";
import { assembleEpisode } from "./lib/ffmpeg-assemble.js";
import { ensureBucket } from "./lib/storage.js";
import { supabaseSessionStorage } from "./lib/session-storage.js";

const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);

bot.use(session({
  initial: () => ({ step: null, draft: {} }),
  storage: supabaseSessionStorage,
  getSessionKey: (ctx) => ctx.from?.id.toString(),
}));

// ---------- /start ----------
bot.command("start", async (ctx) => {
  await ctx.reply(
    "Привет! Я создаю короткие AI-сериалы по твоему сюжету.\n\n" +
    "Нажми /new_episode чтобы начать новый эпизод."
  );
});

// ---------- /new_episode ----------
bot.command("new_episode", async (ctx) => {
  ctx.session.step = "awaiting_draft_choice";
  ctx.session.draft = {};
  const kb = new InlineKeyboard()
    .text("У меня есть сюжет", "draft_yes")
    .text("Сгенерировать с нуля", "draft_no");
  await ctx.reply("Есть у тебя готовая идея сюжета, или сгенерировать с нуля?", {
    reply_markup: kb,
  });
});

bot.callbackQuery("draft_yes", async (ctx) => {
  ctx.session.step = "awaiting_draft_text";
  await ctx.answerCallbackQuery();
  await ctx.reply("Пришли текстом свою идею/черновик сюжета (можно коротко, ИИ доработает).");
});

bot.callbackQuery("draft_no", async (ctx) => {
  ctx.session.step = "awaiting_theme";
  await ctx.answerCallbackQuery();
  await ctx.reply("Опиши тему/жанр для сериала (например: 'комедия про аэропорт').");
});

// ---------- Текстовые сообщения (роутинг по шагам) ----------
bot.on("message:text", async (ctx) => {
  const step = ctx.session.step;

  if (step === "awaiting_draft_text" || step === "awaiting_theme") {
    const isDraft = step === "awaiting_draft_text";
    await ctx.reply("Дорабатываю сценарий...");

    let script;
    try {
      script = await generateScript({ userInput: ctx.message.text, isDraft });
    } catch (err) {
      console.error("Ошибка генерации сценария:", err);
      await ctx.reply("Gemini сейчас перегружен и не ответил после нескольких попыток. Попробуй ещё раз через минуту — просто пришли текст заново.");
      return;
    }

    ctx.session.draft.script = script;
    ctx.session.step = "awaiting_character_choice";

    const kb = new InlineKeyboard()
      .text("Свои персонажи (пришлю фото)", "chars_own")
      .text("Сгенерировать персонажей", "chars_ai");

    const charList = script.characters.map((c) => c.name).join(", ");
    await ctx.reply(
      `Вот разбивка по сценам:\n\n${formatScriptPreview(script)}\n\n` +
      `Персонажи в сюжете: ${charList}\n\nПерсонажей — свои или сгенерировать?`,
      { reply_markup: kb }
    );
    return;
  }

  if (step === "awaiting_character_name") {
    // Пользователь только что прислал фото, теперь пишет имя для него
    const name = ctx.message.text.trim();
    const pendingPhoto = ctx.session.draft.pendingPhotoUrl;
    ctx.session.draft.characters.push({
      name,
      source: "user_upload",
      ref_image_url: pendingPhoto,
    });
    ctx.session.step = "awaiting_character_photos";

    const remaining = ctx.session.draft.script.characters
      .map((c) => c.name)
      .filter((n) => !ctx.session.draft.characters.some((c) => c.name === n));

    if (remaining.length > 0) {
      await ctx.reply(
        `Добавлен персонаж "${name}". Осталось: ${remaining.join(", ")}.\n` +
        `Пришли следующее фото, или /done если персонажей больше нет (недостающие будут сгенерированы ИИ).`
      );
    } else {
      await ctx.reply(`Все персонажи собраны. Можно жать /done.`);
    }
  }
});

bot.callbackQuery("chars_own", async (ctx) => {
  ctx.session.step = "awaiting_character_photos";
  ctx.session.draft.characters = [];
  await ctx.answerCallbackQuery();
  const names = ctx.session.draft.script.characters.map((c) => c.name).join(", ");
  await ctx.reply(
    `Пришли фото персонажа(ей) по одному (${names}). ` +
    `После каждого фото напиши, кто это (имя из сценария). Когда закончишь — /done.`
  );
});

bot.callbackQuery("chars_ai", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply("Генерирую всех персонажей по описанию из сценария...");
  try {
    const characters = await generateCharacterImages(ctx.session.draft.script.characters);
    ctx.session.draft.characters = characters;
    await confirmAndEstimateCredits(ctx);
  } catch (err) {
    console.error("Ошибка генерации персонажей:", err);
    await ctx.reply("Не получилось сгенерировать персонажей — Gemini не ответил. Попробуй нажать ещё раз через минуту.");
  }
});

// ---------- Приём фото персонажей (несколько, по одному за раз) ----------
bot.on("message:photo", async (ctx) => {
  if (ctx.session.step !== "awaiting_character_photos") return;

  const fileId = ctx.message.photo.at(-1).file_id;
  const file = await ctx.api.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;

  ctx.session.draft.pendingPhotoUrl = url;
  ctx.session.step = "awaiting_character_name";
  await ctx.reply("Как зовут этого персонажа? (используй имя из сценария выше)");
});

// ---------- Завершение сбора персонажей ----------
bot.command("done", async (ctx) => {
  if (ctx.session.step !== "awaiting_character_photos") {
    await ctx.reply("Похоже, сессия сброшена или мы не на этом шаге. Начни заново: /new_episode");
    return;
  }

  const scriptCharacters = ctx.session.draft.script.characters;
  const haveNames = ctx.session.draft.characters.map((c) => c.name);
  const missing = scriptCharacters.filter((c) => !haveNames.includes(c.name));

  if (missing.length > 0) {
    await ctx.reply(`Генерирую недостающих персонажей (${missing.map((c) => c.name).join(", ")}) через ИИ...`);
    try {
      const generated = await generateCharacterImages(missing);
      ctx.session.draft.characters.push(...generated);
    } catch (err) {
      console.error("Ошибка генерации недостающих персонажей:", err);
      await ctx.reply("Gemini не ответил при генерации персонажей. Попробуй /done ещё раз через минуту.");
      return;
    }
  }

  await confirmAndEstimateCredits(ctx);
});

// ---------- Подтверждение перед тратой кредитов ----------
async function confirmAndEstimateCredits(ctx) {
  const scenes = ctx.session.draft.script.scenes;
  const totalSeconds = scenes.reduce((s, sc) => s + sc.duration_sec, 0);
  const estimatedCredits = totalSeconds * 24; // Wan 2.2: 24 кредита/сек

  ctx.session.step = "awaiting_generation_confirm";
  const kb = new InlineKeyboard().text("Генерировать видео", "confirm_generate");

  await ctx.reply(
    `Эпизод: ${scenes.length} сцен, ${totalSeconds} сек видео, ${ctx.session.draft.characters.length} персонажей.\n` +
    `Примерно ${estimatedCredits} кредитов Magic Hour.\n\nПодтверждаешь генерацию?`,
    { reply_markup: kb }
  );
}

bot.callbackQuery("confirm_generate", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply("Начинаю генерацию. Это может занять несколько минут...");

  const { data: episode } = await supabase
    .from("episodes")
    .insert({
      telegram_id: ctx.from.id,
      title: ctx.session.draft.script.title,
      script: ctx.session.draft.script,
      characters: ctx.session.draft.characters,
      status: "processing",
    })
    .select()
    .single();

  await processEpisode(ctx, episode);
});

// ---------- Обработка эпизода: генерация сцен + сборка ----------
async function processEpisode(ctx, episode) {
  const scenes = episode.script.scenes;
  const characters = episode.characters; // [{name, ref_image_url, source}]
  const sceneRows = [];

  try {
    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];

      const primaryCharacter =
        characters.find((c) => c.name === scene.primary_character) || characters[0];
      const secondaryCharacters = (scene.secondary_characters || [])
        .map((name) => characters.find((c) => c.name === name))
        .filter(Boolean);

      // Для КАЖДОЙ сцены (не только многоперсонажной) сначала собираем полный кадр:
      // персонаж(и) из их референс-фото + фон/декорация по описанию сцены из сценария.
      // Именно этот собранный кадр — единственный референс, который дальше идёт в Wan 2.2.
      const allCharacterUrls = [primaryCharacter, ...secondaryCharacters].map((c) => c.ref_image_url);
      const referenceImageUrl = await generateSceneReferenceImage(allCharacterUrls, scene.script_text);

      const voiceoverUrl = scene.voiceover_text
        ? await generateVoiceover(scene.voiceover_text, scene.voice_style)
        : null;

      const job = await generateVideoScene({
        referenceImageUrl,
        prompt: scene.script_text,
        durationSec: scene.duration_sec,
      });

      sceneRows.push({
        episode_id: episode.id,
        scene_number: i + 1,
        script_text: scene.script_text,
        character_ref_image_url: referenceImageUrl,
        video_job_id: job.job_id,
        video_status: "processing",
        voiceover_audio_url: voiceoverUrl,
        duration_sec: scene.duration_sec,
      });
    }
  } catch (err) {
    console.error("Ошибка при подготовке сцен эпизода:", err);
    await supabase.from("episodes").update({ status: "error" }).eq("id", episode.id);
    await ctx.reply("Не получилось подготовить сцены — один из сервисов (Gemini или Magic Hour) не ответил. Попробуй /new_episode заново через минуту.");
    return;
  }

  await supabase.from("scenes").insert(sceneRows);
  await ctx.reply("Все сцены отправлены на генерацию. Проверяю статус...");

  pollScenes(ctx, episode.id);
}

// ---------- Поллинг статуса генерации ----------
async function pollScenes(ctx, episodeId, attempt = 0) {
  const { data: scenes } = await supabase
    .from("scenes")
    .select("*")
    .eq("episode_id", episodeId)
    .order("scene_number");

  const pending = scenes.filter((s) => s.video_status === "processing");

  for (const scene of pending) {
    const status = await checkVideoStatus(scene.video_job_id);
    if (status.done) {
      await supabase
        .from("scenes")
        .update({ video_status: "done", video_url: status.video_url })
        .eq("id", scene.id);
    } else if (status.error) {
      await supabase.from("scenes").update({ video_status: "error" }).eq("id", scene.id);
    }
  }

  const { data: refreshed } = await supabase
    .from("scenes")
    .select("*")
    .eq("episode_id", episodeId)
    .order("scene_number");

  const allDone = refreshed.every((s) => s.video_status === "done");
  const anyError = refreshed.some((s) => s.video_status === "error");

  if (allDone) {
    await ctx.reply("Все сцены готовы, собираю финальное видео...");
    const finalPath = await assembleEpisode(refreshed);
    await ctx.replyWithVideo({ source: finalPath });
    await supabase.from("episodes").update({ status: "done" }).eq("id", episodeId);
  } else if (anyError) {
    await ctx.reply("Одна из сцен не сгенерировалась. Проверь /episode_status позже.");
  } else if (attempt < 40) {
    setTimeout(() => pollScenes(ctx, episodeId, attempt + 1), 15000);
  } else {
    await ctx.reply("Генерация занимает необычно долго, проверь позже через /episode_status.");
  }
}

function formatScriptPreview(script) {
  return script.scenes
    .map((s, i) => `Сцена ${i + 1} (${s.duration_sec}с): ${s.script_text}`)
    .join("\n");
}

await ensureBucket();

// ---------- Webhook вместо long polling ----------
// На бесплатном Render процесс "усыпляется" без входящего HTTP-трафика,
// а long polling (bot.start()) для Render не годится — нужен веб-сервер,
// который Telegram будит входящими запросами.
const app = express();
app.use(express.json());
app.get("/", (req, res) => res.send("Bot is running"));
// timeoutMilliseconds увеличен, потому что генерация сценария/фото через Gemini
// иногда занимает дольше стандартных 10 секунд — с дефолтом grammy обрывал обработку.
app.use(webhookCallback(bot, "express", { timeoutMilliseconds: 60_000 }));

// Страховка: если где-то всё же вылетит необработанный reject (например, реальный
// сетевой сбой), процесс не должен падать целиком и валить весь бот для всех пользователей.
process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection (процесс продолжает работать):", err);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Server listening on port ${PORT}`);
  const publicUrl = process.env.RENDER_EXTERNAL_URL;
  if (publicUrl) {
    await bot.api.setWebhook(publicUrl);
    console.log("Webhook set to", publicUrl);
  } else {
    console.log("RENDER_EXTERNAL_URL не задан — webhook не установлен автоматически");
  }
});
