import { Bot, session, InlineKeyboard, InputFile, webhookCallback } from "grammy";
import express from "express";
import "dotenv/config";
import path from "path";
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
// Озвучка сериала — через ElevenLabs (сам определяет язык/голос), см. lib/elevenlabs.js
import { generateVoiceover } from "./lib/elevenlabs.js";
import { assembleEpisode } from "./lib/ffmpeg-assemble.js";
import { ensureBucket } from "./lib/storage.js";
import { supabaseSessionStorage } from "./lib/session-storage.js";
import { isUrl, fetchArticle, generateShortScript } from "./lib/shorts-script.js";
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
    "Команда `/update_key <твой_ключ>` — обновить API ключ WaveSpeed.\n" +
    "Если генерация упадёт с ошибкой — команда /replay продолжит с того места, где остановилось.",
    { parse_mode: "Markdown" }
  );
});

// ---------- ОБНОВЛЕНИЕ КЛЮЧА (ЧЕРЕЗ RENDER API) ----------
bot.command("update_key", async (ctx) => {
  // Получаем ключ из текста сообщения после команды
  const newKey = ctx.match ? ctx.match.trim() : "";

  if (!newKey) {
    return ctx.reply(
      "❌ **Ошибка:** Укажи новый ключ после команды!\n\nПример:\n`/update_key твой_новый_ключ_wavespeed`", 
      { parse_mode: "Markdown" }
    );
  }

  const renderApiKey = process.env.RENDER_API_KEY;
  const serviceId = process.env.RENDER_SERVICE_ID; 

  if (!renderApiKey || !serviceId) {
    return ctx.reply(
      "❌ В `process.env` не найдены `RENDER_API_KEY` или `RENDER_SERVICE_ID`!\nПроверь их наличие во вкладке Environment на Render."
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
      body: JSON.stringify({
        value: newKey
      })
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
      console.error("Render API error:", errorData);
      
      await ctx.api.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        `❌ **Ошибка Render API (${response.status}):** ${errorData.message || response.statusText}`
      );
    }
  } catch (error) {
    console.error("Fetch error:", error);
    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      "❌ Произошла ошибка при соединении с сервером Render."
    );
  }
});

// ---------- /finish_key (Заглушка) ----------
bot.command("finish_key", async (ctx) => {
  await ctx.reply("Автоматический забор ключа отключен. Используй команду `/update_key ТВОЙ_КЛЮЧ`.", { parse_mode: "Markdown" });
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
  await ctx.reply("Пришли текстом свою идею/черновик сюжета (можно коротко, ИИ доработкает).");
});

bot.callbackQuery("draft_no", async (ctx) => {
  ctx.session.step = "awaiting_theme";
  await safeAnswer(ctx);
  await ctx.reply("Опиши тему/жанр для сериала (например: 'комедия про аэропорт').");
});

// ---------- /new_short — короткое TikTok-style видео ----------
bot.command("new_short", async (ctx) => {
  ctx.session.step = "awaiting_short_input";
  ctx.session.shortDraft = {};
  await ctx.reply(
    "Пришли ссылку на статью, или просто опиши тему/идею для короткого видео (30-40 сек).\n\n" +
    "Если это похоже на реальную новость — сделаю пересказ по фактам, если это творческая идея — придумаю историю.\n\n" +
    "Голос — русский (ElevenLabs), субтитры слово-за-словом, видео/фото со стоков (Pexels/Pixabay)."
  );
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
    ctx.session.step = null; // сбрасываем сразу, чтобы /new_short можно было запустить заново, не дожидаясь конца сборки
    await runShortPipeline(ctx, ctx.message.text.trim());
    return;
  }
});

// ---------- Пайплайн генерации короткого видео (TikTok-style) ----------
async function runShortPipeline(ctx, rawInput) {
  const chatId = ctx.chat.id;
  let script;

  try {
    if (isUrl(rawInput)) {
      await ctx.reply("Загружаю статью по ссылке...");
      const { text: articleText, ogImage } = await fetchArticle(rawInput);
      if (!articleText || articleText.length < 200) {
        await ctx.reply(
          "Не получилось вытащить достаточно текста со страницы (возможно, сайт блокирует ботов). " +
          "Пришли текст статьи или тему сообщением вместо ссылки."
        );
        return;
      }
      // Примечание: og:image статьи НЕ используется в сборке ролика — фото со стоков
      // (Pexels/Pixabay) безопаснее в плане авторских прав, чем изображения из
      // конкретной статьи, которые обычно принадлежат изданию. ogImage сохраняем
      // в черновике на случай, если понадобится показать пользователю превью.
      ctx.session.shortDraft = { ogImage };
      await ctx.reply("Статья загружена, пишу сценарий...");
      script = await generateShortScript({ input: articleText, isArticle: true });
    } else {
      await ctx.reply("Пишу сценарий...");
      script = await generateShortScript({ input: rawInput, isArticle: false });
    }
  } catch (err) {
    console.error("Ошибка генерации сценария short:", err);
    await ctx.reply("Не получилось сгенерировать сценарий (Gemini). Попробуй ещё раз через минуту.");
    return;
  }

  const preview = script.segments
    .map((s, i) => `${i + 1}. ${s.narration}`)
    .join("\n");
  await ctx.reply(
    `🎬 «${script.title}» (${script.type === "news" ? "новость" : "история"})\n\n${preview}\n\nСобираю видео — это займёт пару минут...`
  );

  const { data: shortRecord } = await supabase
    .from("shorts")
    .insert({
      telegram_id: ctx.from.id,
      title: script.title,
      type: script.type,
      script,
      status: "processing",
    })
    .select()
    .single();

  try {
    const { localPath, publicUrl } = await assembleShort(script, {
      onProgress: (msg) => bot.api.sendMessage(chatId, msg),
    });
    await supabase
      .from("shorts")
      .update({ status: "completed", final_video_url: publicUrl })
      .eq("id", shortRecord.id);
    await ctx.replyWithVideo(new InputFile(localPath), {
      caption: `Готово! «${script.title}»\n${publicUrl}`,
    });
  } catch (err) {
    console.error("Ошибка сборки short:", err);
    await supabase
      .from("shorts")
      .update({ status: "error", error: err.message })
      .eq("id", shortRecord.id);
    await ctx.reply(
      `Не получилось собрать видео: ${err.message}\n\n` +
      "Проверь, что заданы ключи ELEVENLABS_API_KEY, PEXELS_API_KEY (и/или PIXABAY_API_KEY) в .env, " +
      "и что на сервере установлен ffmpeg с поддержкой libass."
    );
  }
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
      "Попробуй `/update_key КЛЮЧ` для обновления токена, либо пришли фото вручную.",
      { parse_mode: "Markdown" }
    );
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
    await ctx.reply(
      `Добавлен персонаж "${name}". Осталось: ${remaining.join(", ")}.\n` +
      `Пришли следующее фото, или /done если персонажей больше нет.`
    );
  } else {
    await ctx.reply(`Все персонажи собраны. Можно жать /done.`);
  }
});

bot.command("done", async (ctx) => {
  if (ctx.session.step !== "awaiting_character_photos") {
    await ctx.reply("Если хочешь обновить API ключ — отправь `/update_key КЛЮЧ`.\nЕсли хочешь создать эпизод — отправь /new_episode.", { parse_mode: "Markdown" });
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
          `\n⚠️ Баланса может не хватить на весь эпизод. Воспользуйся \`/update_key КЛЮЧ\` для смены аккаунта.`;
      }
    }

    await ctx.reply(
      `Эпизод: ${scenes.length} сцен, ${totalSeconds} сек видео, ${ctx.session.draft.characters.length} персонажей.\n` +
      `Примерно $${estimatedCost.toFixed(2)} на WaveSpeed.${balanceLine}\n\nПодтверждаешь генерацию?`,
      { reply_markup: kb, parse_mode: "Markdown" }
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
          .insert({
            episode_id: episode.id,
            scene_number: sceneNumber,
            prompt: scene.action_prompt,
            status: "pending",
            reference_image_url: referenceImageUrl,
          })
          .select()
          .single();
        record = newScene;

        const charRefs = (scene.character_names || [])
          .map((n) => characters.find((c) => c.name === n)?.ref_image_url)
          .filter(Boolean);

        const taskId = await generateVideoScene(
          scene.action_prompt,
          charRefs,
          record.reference_image_url || undefined,
          "Minecraft-style, blocky, low texture, vibrant colors"
        );
        await supabase
          .from("scenes")
          .update({ task_id: taskId, status: "processing" })
          .eq("id", record.id);
        record.task_id = taskId;
        record.status = "processing";
      }

      if (scene.voiceover_text && !record.voiceover_audio_url) {
        try {
          const speakerName = (scene.character_names || [])[0] || scene.primary_character || null;
          const speakerDescription = speakerName
            ? (episode.script.characters || []).find((c) => c.name === speakerName)?.description
            : null;
          const audioUrl = await generateVoiceover(scene.voiceover_text, speakerName, speakerDescription);
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
    const { data: scenes } = await supabase
      .from("scenes")
      .select("*")
      .eq("episode_id", episodeId);

    const pending = scenes.filter((s) => s.status === "processing" || s.status === "pending");

    if (pending.length === 0) {
      isDone = true;
      const allSuccess = scenes.every((s) => s.status === "completed" && s.video_url);

      if (!allSuccess) {
         if (!compositeWarned) {
             await ctx.reply("Некоторые сцены не удалось сгенерировать. Собираю эпизод из того, что получилось.");
             compositeWarned = true;
         }
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
        await ctx.reply("Видео готовы, но не получилось собрать их вместе (FFmpeg). Попробуй /replay позже.");
      }
    } else {
      for (const scene of pending) {
        if (!scene.task_id) continue;
        try {
          const status = await checkVideoStatus(scene.task_id);
          if (status.status === "COMPLETED") {
            await supabase
              .from("scenes")
              .update({ status: "completed", video_url: status.video_url })
              .eq("id", scene.id);
            await ctx.reply(`✅ Сцена ${scene.scene_number} готова!`);
          } else if (status.status === "FAILED") {
            await supabase
              .from("scenes")
            .update({ status: "failed" })
              .eq("id", scene.id);
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
  return script.scenes
    .map(
      (s, i) =>
        `**Сцена ${i + 1}**: ${s.action_prompt}\n` +
        `   Локация: ${s.location_name}\n` +
        `   Персонажи: ${(s.character_names || []).join(", ")}\n`
    )
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
