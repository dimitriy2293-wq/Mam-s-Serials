import { Bot, session, InlineKeyboard, InputFile, webhookCallback } from "grammy";
import express from "express";
import "dotenv/config";
import { supabase } from "./lib/supabase.js";
import { generateScript } from "./lib/gemini.js";
import { generateAndApplyNewKey } from "./lib/wavespeed-auth.js"; // <-- Подключили наш скрипт
import {
  generateCharacterImages,
  generateSceneReferenceImage,
  generateLocationImage,
  generateVideoScene,
  generateVoiceover,
  checkVideoStatus,
  checkBalance,
  estimateEpisodeCostUsd,
  estimateMaxScenes,
} from "./lib/wavespeed.js";
import { assembleEpisode } from "./lib/ffmpeg-assemble.js";
import { ensureBucket } from "./lib/storage.js";
import { supabaseSessionStorage } from "./lib/session-storage.js";

const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);

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
    "Если генерация упадёт с ошибкой — команда /replay продолжит с того места, где остановилось."
  );
});

// ---------- /update_key ----------
bot.command("update_key", async (ctx) => {
  await ctx.reply("Запускаю браузер для добычи нового ключа WaveSpeed. Это займет около минуты...");
  const key = await generateAndApplyNewKey();
  if (key) {
    await ctx.reply("Успех! Новый API-ключ получен и применен. Можно продолжать работу.");
  } else {
    await ctx.reply("Произошла ошибка при регистрации. Проверь логи Render.");
  }
});

// ---------- /replay ----------
bot.command("replay", async (ctx) => {
  const { data: episode, error } = await supabase
    .from("episodes")
    .select("*")
    .eq("telegram_id", ctx.from.id)
    .eq("status", "error")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !episode) {
    await ctx.reply("Не получилось найти эпизод для повтора. Попробуй ещё раз.");
    return;
  }

  await ctx.reply(`Продолжаю эпизод «${episode.title}».`);
  await supabase.from("episodes").update({ status: "processing" }).eq("id", episode.id);

  processEpisode(ctx, episode).catch((err) => {
    console.error("Необработанная ошибка в processEpisode (replay):", err);
    ctx.reply("Опять что-то пошло не так. Можешь попробовать /replay ещё раз.").catch(() => {});
  });
});

// ---------- /new_episode ----------
// Ошибка с точкой была здесь. Теперь синтаксис абсолютно чистый.
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
});

// ---------- Настройка фона ----------
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
  await ctx.reply(
    `Локация «${loc.name}»: ${loc.description}\n\nКак задать фон для неё?`,
    { reply_markup: kb }
  );
}

async function askCharacterChoice(ctx) {
  ctx.session.step = "awaiting_character_choice";
  const script = ctx.session.draft.script;
  const kb = new InlineKeyboard()
    .text("Свои персонажи (пришлю фото)", "chars_own")
    .text("Сгенерировать персонажей", "chars_ai");
  const charList = script.characters.map((c) => c.name).join(", ");
  await ctx.reply(
    `Персонажи в сюжете: ${charList}\n\nПерсонажей — свои или сгенерировать?`,
    { reply_markup: kb }
  );
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
  await ctx.reply("Опиши локацию своими словами — сгенерирую фон по этому описанию вместо варианта от ИИ.");
});

bot.callbackQuery("chars_own", async (ctx) => {
  ctx.session.step = "awaiting_character_photos";
  ctx.session.draft.characters = [];
  await safeAnswer(ctx);
  const names = ctx.session.draft.script.characters.map((c) => c.name).join(", ");
  await ctx.reply(
    `Пришли фото персонажа(ей) по одному (${names}). ` +
    `После каждого фото я покажу кнопки — выберешь, кто это. Когда закончишь — /done.`
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
      "Не получилось сгенерировать персонажей через ИИ — WaveSpeed не ответил. " +
      "Попробуй /update_key для обновления токена, либо пришли фото вручную."
    );
  }
});

// ---------- Приём фото ----------
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
    await ctx.reply(
      `Добавлен персонаж "${name}". Осталось: ${remaining.join(", ")}.\n` +
      `Пришли следующее фото, или /done если персонажей больше нет.`
    );
  } else {
    await ctx.reply(`Все персонажи собраны. Можно жать /done.`);
  }
});

// ---------- Завершение сбора персонажей ----------
bot.command("done", async (ctx) => {
  if (ctx.session.step !== "awaiting_character_photos") {
    await ctx.reply("Начни заново: /new_episode");
    return;
  }

  const scriptCharacters = ctx.session.draft.script.characters;
  const haveNames = ctx.session.draft.characters.map((c) => c.name);
  const missing = scriptCharacters.filter((c) => !haveNames.includes(c.name));

  if (missing.length > 0) {
    await ctx.reply(`Генерирую недостающих персонажей (${missing.map((c) => c.name).join(", ")})...`);
    try {
      const generated = await generateCharacterImages(missing);
      ctx.session.draft.characters.push(...generated);
    } catch (err) {
      console.error("Ошибка генерации недостающих персонажей:", err);
      await ctx.reply("WaveSpeed не ответил. Пришли фото для оставшихся вручную.");
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
      balance = await checkBalance();
    } catch (err) {
      console.log(`Не удалось проверить баланс WaveSpeed: ${err.message}`);
    }

    ctx.session.step = "awaiting_generation_confirm";
    const kb = new InlineKeyboard().text("Генерировать видео", "confirm_generate");

    let balanceLine = "";
    if (balance !== null) {
      balanceLine = `\nБаланс WaveSpeed: $${balance.toFixed(2)}.`;
      if (balance < estimatedCost) {
        balanceLine +=
          `\n⚠️ Баланса может не хватить на весь эпизод. Воспользуйся /update_key для смены аккаунта.`;
      }
    }

    await ctx.reply(
      `Эпизод: ${scenes.length} сцен, ${totalSeconds} сек видео, ${ctx.session.draft.characters.length} персонажей.\n` +
      `Примерно $${estimatedCost.toFixed(2)} на WaveSpeed.${balanceLine}\n\nПодтверждаешь генерацию?`,
      { reply_markup: kb }
    );
  } catch (err) {
    console.error("Ошибка в confirmAndEstimateCredits:", err);
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
      } catch (err) {
        console.log(`Не удалось сгенерировать фон локации "${loc.name}", сцены пойдут без фиксированного фона`);
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

  let voiceoverFailWarned = false;
  let compositeWarned = false;

  try {
    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      const sceneNumber = i + 1;
      const existing = existingByNumber.get(sceneNumber);

      if (existing && (existing.video_status === "processing" || existing.video_status === "done")) {
        continue;
      }

      const primaryCharacter = characters.find(
        (c) => normalizeName(c.name) === normalizeName(scene.primary_character)
      );
      if (!primaryCharacter) {
        throw new Error(`Не найден персонаж "${scene.primary_character}"`);
      }
      const secondaryCharacters = (scene.secondary_characters || [])
        .map((name) => characters.find((c) => normalizeName(c.name) === normalizeName(name)))
        .filter(Boolean);

      const location = locationByName.get(scene.location);
      let referenceImageUrl = existing?.character_ref_image_url || primaryCharacter.ref_image_url;
      let usedLocationComposite = !!existing?.character_ref_image_url;
      if (!existing?.character_ref_image_url && location?.image_url) {
        const allCharacterUrls = [primaryCharacter, ...secondaryCharacters].map((c) => c.ref_image_url);
        for (let attempt = 0; attempt < 2 && !usedLocationComposite; attempt++) {
          try {
            referenceImageUrl = await generateSceneReferenceImage(
              location.image_url,
              allCharacterUrls,
              scene.character_position || "standing naturally in the scene"
            );
            usedLocationComposite = true;
          } catch (err) {
            console.log(`Композитный кадр для сцены ${sceneNumber} не удался.`);
          }
        }
        if (!usedLocationComposite && !compositeWarned) {
          compositeWarned = true;
          await ctx.reply("Не получилось встроить персонажа в фон локации для одной из сцен.").catch(() => {});
        }
      }

      const videoPrompt = usedLocationComposite || !location
        ? scene.script_text
        : `${scene.script_text} Location: ${location.description}`;

      let voiceoverUrl = existing?.voiceover_audio_url ?? null;
      if (!voiceoverUrl && scene.voiceover_text) {
        const speakerName = scene.primary_character;
        const speakerDescription =
          episode.script.characters.find((c) => normalizeName(c.name) === normalizeName(speakerName))
            ?.description || "";
        try {
          voiceoverUrl = await generateVoiceover(
            scene.voiceover_text,
            speakerName,
            speakerDescription,
            scene.voice_style
          );
        } catch (err) {
          if (!voiceoverFailWarned) {
            voiceoverFailWarned = true;
            await ctx.reply("Озвучка не получилась для одной из сцен.").catch(() => {});
          }
        }
      }

      const job = await generateVideoScene({
        referenceImageUrl,
        prompt: videoPrompt,
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
      "Не получилось подготовить часть сцен эпизода. Продолжи командой /replay."
    );
    return;
  }

  await ctx.reply("Все сцены отправлены на генерацию. Проверяю статус...");
  pollScenes(ctx, episode.id);
}

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
      await ctx.reply("Не получилось склеить финальное видео.");
    }
  } else if (anyError) {
    await ctx.reply("Одна из сцен не сгенерировалась. Проверь позже.");
  } else if (attempt < 40) {
    setTimeout(() => pollScenes(ctx, episodeId, attempt + 1), 15000);
  } else {
    await ctx.reply("Генерация занимает необычно долго.");
  }
}

function formatScriptPreview(script) {
  return script.scenes
    .map((s, i) => `Сцена ${i + 1} (${s.duration_sec}с): ${s.script_text}`)
    .join("\n");
}

await ensureBucket();

const app = express();
app.use(express.json());
app.get("/", (req, res) => res.send("Bot is running"));
app.use(webhookCallback(bot, "express", { timeoutMilliseconds: 60_000 }));

bot.catch((err) => {
  console.error(`Необработанная ошибка в апдейте ${err.ctx.update.update_id}:`, err.error);
  err.ctx.reply("Произошла ошибка при обработке. Попробуй ещё раз или начни заново с /new_episode.").catch(() => {});
});

process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", err);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Server listening on port ${PORT}`);
  const publicUrl = process.env.RENDER_EXTERNAL_URL;
  if (publicUrl) {
    await bot.api.setWebhook(publicUrl);
    console.log("Webhook set to", publicUrl);
  }
});
