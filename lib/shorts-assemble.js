import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { findVisualForSegment } from "./stock-media.js";
import { generateVoiceoverWithTimestamps } from "./elevenlabs.js";
import { writeAssFile } from "./subtitles.js";
import { uploadToStorage } from "./storage.js";
import { getBackgroundMusic } from "./background-music.js";

const WIDTH = 1080;
const HEIGHT = 1920;
const FPS = 30;
const MUSIC_VOLUME = process.env.SHORTS_MUSIC_VOLUME || "0.12"; // фон тихий, чтобы не перебивать голос

function run(cmd) {
  try {
    execSync(cmd, { stdio: ["ignore", "ignore", "pipe"] });
  } catch (err) {
    throw new Error(`ffmpeg команда упала: ${cmd}\n${err.stderr?.toString().slice(-1500) || err.message}`);
  }
}

async function downloadFile(url, outPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Не удалось скачать файл (${res.status}): ${url}`);
  fs.writeFileSync(outPath, Buffer.from(await res.arrayBuffer()));
  return outPath;
}

function getDurationSec(filePath) {
  const out = execSync(
    `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`
  )
    .toString()
    .trim();
  const val = parseFloat(out);
  return Number.isFinite(val) ? val : 0;
}

// Случайный трек из assets/music или процедурно синтезированная подложка —
// см. lib/background-music.js (getBackgroundMusic).

// ---------- Готовим видео-клип под один сегмент заданной длительности ----------
// Видео: заполняем кадр 9:16 (scale+crop), непрерывный медленный zoom-in по всей длине.
// Фото: классический Ken Burns — сильнее зум, так как кадр статичный и иначе будет "мёртвым".
function buildSegmentClip({ localVisualPath, type, durationSec, workDir, index }) {
  const outPath = path.join(workDir, `seg_${index}_visual.mp4`);
  const frames = Math.max(1, Math.round(durationSec * FPS));

  if (type === "video") {
    run(
      `ffmpeg -y -stream_loop -1 -i "${localVisualPath}" -t ${durationSec} -vf ` +
        `"scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,crop=${WIDTH}:${HEIGHT},` +
        `zoompan=z='min(zoom+0.0006,1.15)':d=1:s=${WIDTH}x${HEIGHT}:fps=${FPS}" ` +
        `-r ${FPS} -an -c:v libx264 -pix_fmt yuv420p "${outPath}"`
    );
  } else {
    run(
      `ffmpeg -y -loop 1 -i "${localVisualPath}" -t ${durationSec} -vf ` +
        `"scale=${WIDTH * 2}:${HEIGHT * 2}:force_original_aspect_ratio=increase,crop=${WIDTH * 2}:${HEIGHT * 2},` +
        `zoompan=z='min(zoom+0.0018,1.3)':d=${frames}:s=${WIDTH}x${HEIGHT}:fps=${FPS}" ` +
        `-r ${FPS} -c:v libx264 -pix_fmt yuv420p "${outPath}"`
    );
  }
  return outPath;
}

/**
 * Собирает короткое вертикальное видео (1080x1920, ~30-40 сек) из сценария
 * (см. lib/shorts-script.js) — озвучка ElevenLabs, визуал со стоков, субтитры
 * "слово за словом", фоновая музыка (если есть в assets/music).
 *
 * script: { title, type, segments: [{ narration, visual_query }] }
 * Возвращает { localPath, publicUrl, totalDurationSec }.
 */
export async function assembleShort(script, { onProgress } = {}) {
  const workDir = fs.mkdtempSync("/tmp/short-");
  const notify = (msg) => onProgress && onProgress(msg).catch(() => {});

  const segmentClips = [];
  const segmentAudios = [];
  const allWords = [];
  let cumulativeOffset = 0;

  for (let i = 0; i < script.segments.length; i++) {
    const seg = script.segments[i];
    await notify(`Сегмент ${i + 1}/${script.segments.length}: озвучка и подбор видео...`);

    // 1. Озвучка сегмента с таймкодами по словам
    const { localPath: audioPath, words } = await generateVoiceoverWithTimestamps(seg.narration);
    const durationSec = Math.max(1.5, getDurationSec(audioPath));
    segmentAudios.push(audioPath);

    // Сдвигаем таймкоды слов на текущее накопленное смещение по ролику
    for (const w of words) {
      if (w.start == null || w.end == null) continue;
      allWords.push({ word: w.word, start: w.start + cumulativeOffset, end: w.end + cumulativeOffset });
    }

    // 2. Визуал под сегмент (видео приоритетнее фото)
    const visual = await findVisualForSegment(seg.visual_query || seg.narration.slice(0, 40));
    let clipPath;
    if (visual) {
      const ext = visual.type === "video" ? "mp4" : "jpg";
      const rawVisualPath = path.join(workDir, `seg_${i}_source.${ext}`);
      await downloadFile(visual.url, rawVisualPath);
      clipPath = buildSegmentClip({
        localVisualPath: rawVisualPath,
        type: visual.type,
        durationSec,
        workDir,
        index: i,
      });
    } else {
      // Ничего не нашлось на стоках — тёмный фон-заглушка, чтобы ролик не падал целиком
      clipPath = path.join(workDir, `seg_${i}_visual.mp4`);
      run(
        `ffmpeg -y -f lavfi -i color=c=0x101018:s=${WIDTH}x${HEIGHT}:d=${durationSec}:r=${FPS} ` +
          `-c:v libx264 -pix_fmt yuv420p "${clipPath}"`
      );
    }

    segmentClips.push(clipPath);
    cumulativeOffset += durationSec;
  }

  const totalDurationSec = cumulativeOffset;

  // 3. Склеиваем видео-сегменты (жёсткие склейки — быстрый TikTok-темп)
  await notify("Склеиваю видео...");
  const videoConcatList = path.join(workDir, "video_concat.txt");
  fs.writeFileSync(videoConcatList, segmentClips.map((p) => `file '${p}'`).join("\n"));
  const concatVideoPath = path.join(workDir, "concat_video.mp4");
  run(`ffmpeg -y -f concat -safe 0 -i "${videoConcatList}" -c copy "${concatVideoPath}"`);

  // 4. Склеиваем озвучку всех сегментов в одну дорожку
  const audioConcatList = path.join(workDir, "audio_concat.txt");
  fs.writeFileSync(audioConcatList, segmentAudios.map((p) => `file '${p}'`).join("\n"));
  const narrationPath = path.join(workDir, "narration.mp3");
  run(`ffmpeg -y -f concat -safe 0 -i "${audioConcatList}" -c copy "${narrationPath}"`);

  // 5. Субтитры "слово за словом"
  await notify("Собираю субтитры...");
  const assPath = writeAssFile(allWords, workDir, { width: WIDTH, height: HEIGHT });

  // 6. Фоновая музыка — автоматически (своя из assets/music, если есть, иначе
  // процедурно синтезированная амбиентная подложка, см. lib/background-music.js)
  await notify("Добавляю фоновую музыку...");
  const musicSource = getBackgroundMusic(totalDurationSec, workDir);
  const finalAudioPath = path.join(workDir, "final_audio.mp3");
  run(
    `ffmpeg -y -i "${narrationPath}" -stream_loop -1 -i "${musicSource}" -filter_complex ` +
      `"[1:a]volume=${MUSIC_VOLUME}[music];[0:a][music]amix=inputs=2:duration=first:dropout_transition=2[aout]" ` +
      `-map "[aout]" -t ${totalDurationSec} "${finalAudioPath}"`
  );

  // 7. Финальная сборка: видео + субтитры (libass) + звук
  await notify("Рендерю финальное видео...");
  const finalPath = path.join(workDir, "final_short.mp4");
  const escapedAssPath = assPath.replace(/'/g, "'\\''");
  run(
    `ffmpeg -y -i "${concatVideoPath}" -i "${finalAudioPath}" ` +
      `-vf "ass='${escapedAssPath}'" ` +
      `-map 0:v:0 -map 1:a:0 -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "${finalPath}"`
  );

  const publicUrl = await uploadToStorage(finalPath, "shorts");
  return { localPath: finalPath, publicUrl, totalDurationSec };
}
