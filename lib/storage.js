import { supabase } from "./supabase.js";
import fs from "fs";
import path from "path";

const BUCKET = "serial-bot-assets";

export async function ensureBucket() {
  const { data: buckets, error: listError } = await supabase.storage.listBuckets();
  if (listError) throw new Error(`Не удалось проверить Supabase Storage: ${listError.message}`);

  const exists = buckets?.some((b) => b.name === BUCKET);
  if (!exists) {
    const { error } = await supabase.storage.createBucket(BUCKET, { public: true });
    if (error && !error.message?.toLowerCase().includes("already exists")) {
      throw new Error(`Не удалось создать Storage bucket: ${error.message}`);
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
