// Разовый скрипт: удаляет ВСЕ файлы из папки shorts/ в бакете serial-bot-assets
// (готовые собранные TikTok-видео). Озвучки (short-voiceovers/) не трогает.
//
// Запуск локально (нужны те же переменные окружения, что и у бота):
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/clear-shorts-folder.js
//
// Либо просто запусти его один раз на Render через Shell (там переменные уже есть):
//   node scripts/clear-shorts-folder.js

import "dotenv/config";
import { supabase } from "../lib/supabase.js";

const BUCKET = "serial-bot-assets";
const FOLDER = "shorts";

async function main() {
  const { data: files, error: listError } = await supabase.storage
    .from(BUCKET)
    .list(FOLDER, { limit: 1000 });

  if (listError) {
    console.error("Не удалось получить список файлов:", listError.message);
    process.exit(1);
  }

  if (!files || files.length === 0) {
    console.log(`Папка ${FOLDER}/ уже пуста.`);
    return;
  }

  const paths = files.map((f) => `${FOLDER}/${f.name}`);
  console.log(`Найдено файлов: ${paths.length}. Удаляю...`);

  // Supabase Storage удаляет максимум пачками — режем на куски по 100, чтобы не упереться в лимит.
  const chunkSize = 100;
  let deleted = 0;

  for (let i = 0; i < paths.length; i += chunkSize) {
    const chunk = paths.slice(i, i + chunkSize);
    const { error: removeError } = await supabase.storage.from(BUCKET).remove(chunk);
    if (removeError) {
      console.error(`Ошибка удаления пачки ${i}-${i + chunk.length}:`, removeError.message);
      continue;
    }
    deleted += chunk.length;
    console.log(`Удалено ${deleted}/${paths.length}`);
  }

  console.log("Готово.");
}

main();
