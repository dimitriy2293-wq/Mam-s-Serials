import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import os from "os"; // <-- Добавлено для кроссплатформенности
import { uploadToStorage } from "./storage.js";
import ffmpegPath from "ffmpeg-static";

async function downloadFile(url, outPath) {
  const res = await fetch(url);
  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(outPath, buffer);
  return outPath;
}

// Длительность файла в секундах. Без ffprobe-static в зависимостях — парсим
// строку "Duration: 00:00:05.23" из стандартного вывода ffmpeg -i.
function getDurationSec(filePath) {
  try {
    execSync(`"${ffmpegPath}" -i "${filePath}"`, { stdio: ["ignore", "ignore", "pipe"] });
  } catch (err) {
    const stderr = err.stderr?.toString() || "";
    const match = stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
    if (match) {
      const [, h, m, s] = match;
      return Number(h) * 3600 + Number(m) * 60 + Number(s);
    }
  }
  return null;
}

// ---------- Собрать один эпизод из сцен (видео + опциональная озвучка) ----------
export async function assembleEpisode(scenes) {
  // Меняем /tmp/ на системную временную папку, чтобы не падало на Windows
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "episode-"));
  const processedClips = [];

  for (const scene of scenes) {
    const rawVideo = path.join(workDir, `scene_${scene.scene_number}_raw.mp4`);
    await downloadFile(scene.video_url, rawVideo);
    const merged = path.join(workDir, `scene_${scene.scene_number}_merged.mp4`);

    if (scene.voiceover_audio_url) {
      const audioPath = path.join(workDir, `scene_${scene.scene_number}_audio`);
      const localAudio = scene.voiceover_audio_url.startsWith("http")
        ? await downloadFile(scene.voiceover_audio_url, `${audioPath}.wav`)
        : scene.voiceover_audio_url;

      try {
        // РАНЬШЕ здесь стоял флаг -shortest: он режет по короткой дорожке.
        // Видео-сцена всегда ровно 5 сек (см. generateVideoScene), а озвучка —
        // сколько нужно на реплику. Если реплика длиннее 5 сек, -shortest
        // отрубал конец фразы на полуслове — это и есть "озвучка сместилась
        // странно", о которой ты писал. Теперь подгоняем длины ПЕРЕД склейкой:
        // если аудио длиннее видео — стоп-кадром продлеваем видео (tpad);
        // если короче — дополняем тишиной в конце (apad). Ничего не обрезаем.
        const videoDur = getDurationSec(rawVideo);
        const audioDur = getDurationSec(localAudio);

        if (videoDur != null && audioDur != null && audioDur > videoDur + 0.05) {
          const extra = (audioDur - videoDur).toFixed(2);
          execSync(
            `"${ffmpegPath}" -y -i "${rawVideo}" -i "${localAudio}" ` +
              `-filter_complex "[0:v]tpad=stop_mode=clone:stop_duration=${extra}[v]" ` +
              `-map "[v]" -map 1:a:0 -c:v libx264 -preset veryfast -crf 20 -c:a aac -b:a 128k "${merged}"`,
            { stdio: ["ignore", "ignore", "pipe"] }
          );
        } else {
          execSync(
            `"${ffmpegPath}" -y -i "${rawVideo}" -i "${localAudio}" ` +
              `-filter_complex "[1:a]apad=whole_dur=${(videoDur || 5).toFixed(2)}[a]" ` +
              `-map 0:v:0 -map "[a]" -c:v copy -c:a aac -b:a 128k "${merged}"`,
            { stdio: ["ignore", "ignore", "pipe"] }
          );
        }
        processedClips.push(merged);
      } catch (err) {
        console.error(`Не удалось наложить озвучку на сцену ${scene.scene_number}:`, err.message);
        processedClips.push(rawVideo);
      }
    } else {
      try {
        // Если озвучки нет, генерируем пустую аудиодорожку (тишину), иначе concat сломает склейку
        execSync(
          `"${ffmpegPath}" -y -i "${rawVideo}" -f lavfi -i anullsrc=channel_layout=stereo:sample_rate=44100 -c:v copy -c:a aac -b:a 128k -map 0:v:0 -map 1:a:0 -shortest "${merged}"`,
          { stdio: ["ignore", "ignore", "pipe"] }
        );
        processedClips.push(merged);
      } catch (err) {
        console.error(`Не удалось добавить тишину на сцену ${scene.scene_number}:`, err.message);
        processedClips.push(rawVideo);
      }
    }
  }

  const concatListPath = path.join(workDir, "concat.txt");
  fs.writeFileSync(
    concatListPath,
    // Заменяем \ на / для корректной работы FFmpeg на Windows
    processedClips.map((p) => `file '${p.replace(/\\/g, "/")}'`).join("\n")
  );

  const finalPath = path.join(workDir, "final_episode.mp4");
  try {
    execSync(`"${ffmpegPath}" -y -f concat -safe 0 -i "${concatListPath}" -c copy "${finalPath}"`, {
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch (err) {
    throw new Error(`ffmpeg concat failed: ${err.stderr?.toString().slice(-500) || err.message}`);
  }

  const publicUrl = await uploadToStorage(finalPath, "episodes");
  return { localPath: finalPath, publicUrl };
}
