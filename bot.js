import { Bot, session, InlineKeyboard, InputFile, webhookCallback } from "grammy";
import express from "express";
import "dotenv/config";
import { supabase } from "./lib/supabase.js";
import { generateScript, generateVoiceover } from "./lib/gemini.js";
import {
  generateCharacterImages,
  generateSceneReferenceImage,
  generateLocationImage,
  generateVideoScene,
  checkVideoStatus,
} from "./lib/wavespeed.js";
import { assembleEpisode } from "./lib/ffmpeg-assemble.js";
import { ensureBucket } from "./lib/storage.js";
import { supabaseSessionStorage } from "./lib/session-storage.js";

const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);

// ---------- Безопасный answerCallbackQuery ----------
// На бесплатном Render инстанс "засыпает" и просыпается с задержкой 50с и больше
// (см. баннер в дашборде). Из-за этого к моменту вызова answerCallbackQuery
// Telegram иногда уже считает callback_query устаревшим и кидает 400 "query is
// too old". Раньше это было незапойманным throw, который обрывал обработчик
// целиком — то есть, например, генерация эпизода в confirm_generate вообще не
// стартовала. Оборачиваем во всех местах, чтобы это никогда не блокировало
// остальную логику хендлера.
async function safeAnswer(ctx) {
  await ctx.answerCallbackQuery().catch((err) => {
    console.log("answerCallbackQuery не прошёл (не критично):", err.message);
  });
}

function normalizeName(name) {
  return (name || "").trim().toLowerCase();
}

bot.use(session({
  initial: () => ({ step: null, draft: {} }),
  storage: supabaseSessionStorage,
  getSessionKey: (ctx) => ctx.from?.id.toString(),
}));

// ---------- /start ----------
bot.command("start", async (ctx) => {
  await ctx.reply(
    "Привет! Я создаю короткие AI-сериалы по твоему сюжету.\n\n" +
    "Нажми /new_episode чтобы начать новый эпизод.\n" +
    "Если генерация упадёт с ошибкой — команда /replay продолжит с того места, где остановилось, " +
    "не переделывая сценарий и персонажей."
  );
});

// ---------- /replay: продолжить последний упавший эпизод, не переделывая сценарий/персонажей ----------
bot.command("replay", async (ctx) => {
  const { data: episode, error } = await supabase
    .from("episodes")
    .select("*")
    .eq("telegram_id", ctx.from.id)
    .eq("status", "error")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("Ошибка при поиске эпизода для /replay:", error);
    await ctx.reply("Не получилось найти эпизод для повтора. Попробуй ещё раз.");
    return;
  }
  if (!episode) {
    await ctx.reply("Не нашёл эпизодов с ошибкой для повтора — либо всё готово, либо ещё генерируется.");
    return;
  }

  await ctx.reply(
    `Продолжаю эпизод «${episode.title}» — сценарий, персонажи и уже готовые сцены не трогаю, ` +
    `доделываю только то, что не успело сгенерироваться.`
  );
  await supabase.from("episodes").update({ status: "processing" }).eq("id", episode.id);

  processEpisode(ctx, episode).catch((err) => {
    console.error("Необработанная ошибка в processEpisode (replay):", err);
    ctx.reply("Опять что-то пошло не так. Можешь попробовать /replay ещё раз.").catch(() => {});
  });
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
  await safeAnswer(ctx);
  await ctx.reply("Пришли текстом свою идею/черновик сюжета (можно коротко, ИИ доработает).");
});

bot.callbackQuery("draft_no", async (ctx) => {
  ctx.session.step = "awaiting_theme";
  await safeAnswer(ctx);
  await ctx.reply("Опиши тему/жанр для сериала (например: 'комедия про аэропорт').");
});

// ---------- Текстовые сообщения (роутинг по шагам) ----------
bot.on("message:text", async (ctx, next) => {
  // Команды (/done, /start и т.д.) — это тоже текстовые сообщения, но их должны
  // обрабатывать соответствующие bot.command(...), а не этот общий текстовый хендлер.
  // Без этой проверки, например, /done "проглатывался" здесь и не долетал до
  // bot.command("done"), потому что этот обработчик зарегистрирован раньше в коде.
  if (ctx.message.text.startsWith("/")) return next();

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
  await safeAnswer(ctx);
  const names = ctx.session.draft.script.characters.map((c) => c.name).join(", ");
  await ctx.reply(
    `Пришли фото персонажа(ей) по одному (${names}). ` +
    `После каждого фото напиши, кто это (имя из сценария). Когда закончишь — /done.`
  );
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
    await ctx.reply(
      "Не получилось сгенерировать персонажей через ИИ — WaveSpeed не ответил (возможно, кончились кредиты). " +
      "Пришли свои фото персонажей вместо этого: набери /new_episode заново и выбери 'Свои персонажи'."
    );
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
      await ctx.reply(
        "WaveSpeed не ответил при генерации персонажей (возможно, кончились кредиты). " +
        "Пришли фото для оставшихся персонажей вручную вместо ИИ-генерации."
      );
      return;
    }
  }

  await confirmAndEstimateCredits(ctx);
});

// ---------- Подтверждение перед тратой $ ----------
async function confirmAndEstimateCredits(ctx) {
  try {
    const scenes = ctx.session.draft.script.scenes;
    const totalSeconds = scenes.reduce((s, sc) => s + sc.duration_sec, 0);
    // Ориентировочно: Wan 2.2 image-to-video ~$0.01/сек, Nano Banana 2 (edit/composite кадра) ~$0.07/картинку
    const videoCost = totalSeconds * 0.01;
    const imageCost = scenes.length * 0.07;
    const estimatedCost = (videoCost + imageCost).toFixed(2);

    ctx.session.step = "awaiting_generation_confirm";
    const kb = new InlineKeyboard().text("Генерировать видео", "confirm_generate");

    await ctx.reply(
      `Эпизод: ${scenes.length} сцен, ${totalSeconds} сек видео, ${ctx.session.draft.characters.length} персонажей.\n` +
      `Примерно $${estimatedCost} на WaveSpeed.\n\nПодтверждаешь генерацию?`,
      { reply_markup: kb }
    );
  } catch (err) {
    console.error("Ошибка в confirmAndEstimateCredits:", err);
    await ctx.reply("Что-то пошло не так при подсчёте кредитов. Попробуй /new_episode заново.");
  }
}

bot.callbackQuery("confirm_generate", async (ctx) => {
  await safeAnswer(ctx);
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

  // Намеренно НЕ ждём здесь processEpisode целиком: с троттлингом/повторами
  // WaveSpeed генерация одного эпизода может занять несколько минут, а грамми
  // оборачивает webhook-хендлер таймаутом в 60с. Если ждать внутри хендлера,
  // Telegram может посчитать запрос "зависшим", а следующие апдейты от этого же
  // пользователя будут дожидаться своей очереди и рисковать словить "query is
  // too old". ctx.api-вызовы (ctx.reply и т.д.) работают независимо от того,
  // завершился ли исходный webhook-запрос, так что фоновая генерация безопасна.
  processEpisode(ctx, episode).catch((err) => {
    console.error("Необработанная ошибка в processEpisode:", err);
    ctx.reply("Что-то пошло не так во время генерации. Попробуй /new_episode заново.").catch(() => {});
  });
});

// ---------- Обработка эпизода: генерация сцен + сборка ----------
// Резюмируемая: episode.script и episode.characters уже лежат в БД (сохранены
// до вызова этой функции), поэтому при повторном вызове (через /replay после
// ошибки) сценарий и персонажи НЕ перегенерируются. Уже отправленные на
// генерацию или готовые сцены (video_status processing/done) тоже пропускаются —
// каждая сцена пишется в БД сразу после подготовки, а не пачкой в конце, поэтому
// частичный прогресс не теряется при падении на середине.
async function processEpisode(ctx, episode) {
  const scenes = episode.script.scenes;
  const characters = episode.characters; // [{name, ref_image_url, source}]

  // Фон каждой локации генерируется один раз и переиспользуется во всех её сценах
  // (и при /replay — тоже переиспользуется, а не генерируется заново).
  const locations = episode.locations && episode.locations.length > 0
    ? episode.locations
    : (episode.script.locations || []).map((l) => ({ ...l, image_url: null }));

  const missingLocations = locations.filter((l) => !l.image_url);
  if (missingLocations.length > 0) {
    await ctx.reply(`Готовлю фон для локаций (${missingLocations.map((l) => l.name).join(", ")})...`);
    for (const loc of missingLocations) {
      try {
        loc.image_url = await generateLocationImage(loc.description);
      } catch (err) {
        console.log(`Не удалось сгенерировать фон локации "${loc.name}" (${err.message?.slice(0, 100)}), сцены в ней пойдут без фиксированного фона`);
      }
    }
    await supabase.from("episodes").update({ locations }).eq("id", episode.id);
  }
  const locationByName = new Map(locations.map((l) => [l.name, l]));

  const { data: existingScenes } = await supabase
    .from("scenes")
    .select("*")
    .eq("episode_id", episode.id);
  const existingByNumber = new Map((existingScenes || []).map((s) => [s.scene_number, s]));

  let voiceoverQuotaWarned = false;

  try {
    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      const sceneNumber = i + 1;
      const existing = existingByNumber.get(sceneNumber);

      // Сцена уже отправлена на генерацию видео или готова — не трогаем её.
      if (existing && (existing.video_status === "processing" || existing.video_status === "done")) {
        continue;
      }

      // Раньше при отсутствии совпадения по имени тихо подставлялся characters[0] —
      // из-за этого сцена могла молча получить лицо совсем другого персонажа.
      // Теперь требуем точное совпадение (без учёта регистра/пробелов) и явно
      // падаем с понятной ошибкой, если персонаж не найден.
      const primaryCharacter = characters.find(
        (c) => normalizeName(c.name) === normalizeName(scene.primary_character)
      );
      if (!primaryCharacter) {
        throw new Error(
          `Не найден персонаж "${scene.primary_character}" для сцены ${i + 1} среди загруженных: ` +
          characters.map((c) => c.name).join(", ")
        );
      }
      const secondaryCharacters = (scene.secondary_characters || [])
        .map((name) => characters.find((c) => normalizeName(c.name) === normalizeName(name)))
        .filter(Boolean);

      // При повторе (/replay) уже подготовленный референс-кадр сцены переиспользуем —
      // не тратим WaveSpeed-квоту повторно на то, что уже сгенерировалось нормально.
      const location = locationByName.get(scene.location);
      let referenceImageUrl = existing?.character_ref_image_url || primaryCharacter.ref_image_url;
      if (!existing?.character_ref_image_url && location?.image_url) {
        try {
          const allCharacterUrls = [primaryCharacter, ...secondaryCharacters].map((c) => c.ref_image_url);
          referenceImageUrl = await generateSceneReferenceImage(
            location.image_url,
            allCharacterUrls,
            scene.character_position || "standing naturally in the scene"
          );
        } catch (err) {
          console.log(
            `Композитный кадр недоступен (${err.message?.slice(0, 100)}), использую фото персонажа напрямую`
          );
        }
      }

      // Аналогично — если озвучка уже была сгенерирована в прошлый раз, не бьём
      // по TTS-квоте ещё раз. Если квота исчерпана — сцена идёт без звука, но
      // эпизод продолжает собираться, а не падает целиком.
      let voiceoverUrl = existing?.voiceover_audio_url ?? null;
      if (!voiceoverUrl && scene.voiceover_text) {
        try {
          voiceoverUrl = await generateVoiceover(scene.voiceover_text, scene.voice_style);
        } catch (err) {
          if (!voiceoverQuotaWarned) {
            voiceoverQuotaWarned = true;
            await ctx
              .reply("Озвучка временно недоступна (лимит запросов Gemini TTS исчерпан) — эпизод соберётся без неё.")
              .catch(() => {});
          }
          console.log(`Озвучка недоступна для сцены ${sceneNumber} (${err.message?.slice(0, 150)}), продолжаю без звука`);
        }
      }

      const job = await generateVideoScene({
        referenceImageUrl,
        prompt: scene.script_text,
        durationSec: scene.duration_sec,
      });

      const row = {
        episode_id: episode.id,
        scene_number: sceneNumber,
        script_text: scene.script_text,
        character_ref_image_url: referenceImageUrl,
        video_job_id: job.job_id,
        video_status: "processing",
        voiceover_audio_url: voiceoverUrl,
        duration_sec: scene.duration_sec,
      };

      if (existing) {
        await supabase.from("scenes").update(row).eq("id", existing.id);
      } else {
        await supabase.from("scenes").insert(row);
      }
    }
  } catch (err) {
    console.error("Ошибка при подготовке сцен эпизода:", err);
    await supabase.from("episodes").update({ status: "error" }).eq("id", episode.id);
    await ctx.reply(
      "Не получилось подготовить часть сцен эпизода. Уже готовые и отправленные сцены сохранены — " +
      "продолжи командой /replay, она не будет пересоздавать сценарий, персонажей и то, что уже сделано."
    );
    return;
  }

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
    try {
      const finalPath = await assembleEpisode(refreshed);
      await ctx.replyWithVideo(new InputFile(finalPath));
      await supabase.from("episodes").update({ status: "done" }).eq("id", episodeId);
    } catch (err) {
      console.error("Ошибка при сборке финального видео:", err);
      await supabase.from("episodes").update({ status: "error" }).eq("id", episodeId);
      await ctx.reply(
        "Все сцены сгенерировались, но не получилось склеить финальное видео (ошибка ffmpeg). " +
        "Данные сцен сохранены, можно попробовать пересобрать вручную."
      );
    }
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
bot.catch((err) => {
  console.error(`Необработанная ошибка в апдейте ${err.ctx.update.update_id}:`, err.error);
  err.ctx.reply("Произошла ошибка при обработке. Попробуй ещё раз или начни заново с /new_episode.").catch(() => {});
});

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
