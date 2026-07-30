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

  await ctx.reply(
    `🎬 **Сценарий готов!**\n\n` +
    `${cleanScript}\n\n` +
    `🔗 [Сделать озвучку в ElevenLabs](https://elevenlabs.io/app/speech-synthesis)\n\n` +
    `⏳ Собираю видеоряд (визуал + музыка)...`
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
      onProgress: (msg) => bot.api.sendMessage(chatId, msg)
    });
    
    await supabase.from("shorts").update({ status: "completed", final_video_url: publicUrl }).eq("id", shortRecord.id);
    await ctx.replyWithVideo(new InputFile(localPath), { caption: `✅ Визуал готов! Накладывай голос из ElevenLabs и заливай.` });
  } catch (err) {
    console.error("Ошибка сборки short:", err);
    await supabase.from("shorts").update({ status: "error", error: err.message }).eq("id", shortRecord.id);
    await ctx.reply(`❌ Не получилось собрать видео: ${err.message}`);
  }
}
