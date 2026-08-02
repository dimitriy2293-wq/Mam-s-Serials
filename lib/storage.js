import { supabase } from "./supabase.js";
import fs from "fs";
import path from "path";

const BUCKET = "serial-bot-assets";

export async function ensureBucket() {
  const { data: buckets, error: listError } = await supabase.storage.listBuckets();
  if (listError) throw new Error(`Не удалось проверить Supabase Storage: ${listError.message}`);

  const existing = buckets?.find((b) => b.name === BUCKET);

  if (!existing) {
    const { error } = await supabase.storage.createBucket(BUCKET, { public: true });
    if (error && !error.message?.toLowerCase().includes("already exists")) {
      throw new Error(`Не удалось создать Storage bucket: ${error.message}`);
    }
    return;
  }

  // Бакет уже существовал (например, создан раньше, до того как здесь появился
  // public:true) — принудительно делаем его публичным, иначе getPublicUrl() будет
  // возвращать ссылки, которые выглядят валидными, но Telegram не сможет их
  // скачать ("failed to get HTTP URL content"), потому что доступ на самом деле
  // закрыт.
  if (!existing.public) {
    const { error } = await supabase.storage.updateBucket(BUCKET, { public: true });
    if (error) {
      console.error(`Не удалось сделать bucket "${BUCKET}" публичным:`, error.message);
    } else {
      console.log(`Bucket "${BUCKET}" был приватным — переключил на публичный.`);
    }
  }
}

function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".ogg": "audio/ogg",
    ".oga": "audio/ogg",
    ".opus": "audio/opus",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
  };
  return types[ext] || "application/octet-stream";
}

export async function uploadToStorage(localPath, folder = "misc") {
  const fileName = `${folder}/${Date.now()}_${path.basename(localPath)}`;
  const fileBuffer = fs.readFileSync(localPath);
  const contentType = getContentType(localPath);

  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(fileName, fileBuffer, { contentType, upsert: true });

  if (error) throw new Error(`Supabase Storage upload error: ${error.message}`);

  const { data } = supabase.storage.from(BUCKET).getPublicUrl(fileName);
  return data.publicUrl;
}
