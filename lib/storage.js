import { supabase } from "./supabase.js";
import fs from "fs";
import path from "path";

const BUCKET = "serial-bot-assets";

// Убедиться что бакет существует (вызывается один раз при старте бота)
export async function ensureBucket() {
  const { data: buckets } = await supabase.storage.listBuckets();
  const exists = buckets?.some((b) => b.name === BUCKET);
  if (!exists) {
    await supabase.storage.createBucket(BUCKET, { public: true });
  }
}

// Загрузить локальный файл в Storage, вернуть публичный URL
export async function uploadToStorage(localPath, folder = "misc") {
  const fileName = `${folder}/${Date.now()}_${path.basename(localPath)}`;
  const fileBuffer = fs.readFileSync(localPath);
  const contentType = localPath.endsWith(".wav")
    ? "audio/wav"
    : localPath.endsWith(".mp4")
    ? "video/mp4"
    : "image/png";

  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(fileName, fileBuffer, { contentType, upsert: true });

  if (error) throw new Error(`Supabase Storage upload error: ${error.message}`);

  const { data } = supabase.storage.from(BUCKET).getPublicUrl(fileName);
  return data.publicUrl;
}
