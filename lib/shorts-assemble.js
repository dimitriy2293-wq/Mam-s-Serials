import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { findVisualForSegment } from "./stock-media.js";
import { uploadToStorage } from "./storage.js";
import { getBackgroundMusic } from "./background-music.js";
import { buildWordByWordAss } from "./subtitles.js";

const WIDTH = 1080;
const HEIGHT = 1920;
const FPS = 30;
const MUSIC_VOLUME = process.env.SHORTS_MUSIC_VOLUME || "0.12";

function run(cmd) {
  try {
    execSync(cmd, { stdio: ["ignore", "ignore", "pipe"] });
  } catch (err) {
    throw new Error(
      `ffmpeg команда упала: ${cmd}\n${err.stderr?.toString().slice(-2000) || err.message}`
    );
  }
}

async function downloadFile(url, outPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Не удалось скачать файл (${res.status}): ${url}`);
  fs.writeFileSync(outPath, Buffer.from(await res.arrayBuffer()));
  return outPath;
}

function probeDuration(filePath) {
  try {
    const value = execSync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`,
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    ).trim();
    const duration = Number.parseFloat(value);
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error("ffprobe вернул некорректную длительность");
    }
    return duration;
  } catch (err) {
    throw new Error(`Не удалось определить длительность аудио. Убедись, что ffmpeg/ffprobe установлены: ${err.message}`);
  }
}

function buildSegmentClip({ localVisualPath, type, durationSec, workDir, index }) {
  const outPath = path.join(workDir, `seg_${index}_visual.mp4`);
  const frames = Math.max(1, Math.round(durationSec * FPS));

  if (type === "video") {
    run(
      `ffmpeg -y -stream_loop -1 -i "${localVisualPath}" -t ${durationSec.toFixed(3)} -vf ` +
      `"scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,crop=${WIDTH}:${HEIGHT},` +
      `zoompan=z='min(zoom+0.0006,1.15)':d=1:s=${WIDTH}x${HEIGHT}:fps=${FPS}" ` +
      `-r ${FPS} -an -c:v libx264 -pix_fmt yuv420p "${outPath}"`
    );
  } else {
    run(
      `ffmpeg -y -loop 1 -i "${localVisualPath}" -t ${durationSec.toFixed(3)} -vf ` +
      `"scale=${WIDTH * 2}:${HEIGHT * 2}:force_original_aspect_ratio=increase,crop=${WIDTH * 2}:${HEIGHT * 2},` +
      `zoompan=z='min(zoom+0.0018,1.3)':d=${frames}:s=${WIDTH}x${HEIGHT}:fps=${FPS}" ` +
      `-r ${FPS} -c:v libx264 -pix_fmt yuv420p "${outPath}"`
    );
  }
  return outPath;
}

function makeWordTimings(script, segmentDurations) {
  const words = [];
  let offset = 0;

  script.segments.forEach((seg, i) => {
    const tokens = (seg.narration || "").trim().split(/\s+/).filter(Boolean);
    const duration = segmentDurations[i];
    const perWord = tokens.length ? duration / tokens.length : duration;

    tokens.forEach((word, index) => {
      words.push({
        word,
        start: offset + index * perWord,
        end: offset + (index + 1) * perWord,
      });
    });
    offset += duration;
  });

  return words;
}

function writeAss(words, workDir) {
  const assPath = path.join(workDir, "subtitles.ass");
  fs.writeFileSync(assPath, buildWordByWordAss(words, { width: WIDTH, height: HEIGHT }), "utf8");
  return assPath;
}

function escapeFilterPath(filePath) {
  return filePath.replace(/\\/g, "/").replace(/:/g, "\\:");
}

/**
 * Собирает short после получения готовой озвучки пользователя.
 *
 * voiceoverUrl — публичный URL аудиофайла, который пользователь прислал в Telegram.
 * Видео строится по реальной длительности голоса, а не по приблизительному числу слов.
 */
export async function assembleShort(script, { voiceoverUrl, onProgress } = {}) {
  if (!voiceoverUrl) throw new Error("Для сборки short не передана озвучка.");

  const workDir = fs.mkdtempSync("/tmp/short-");
  const notify = async (msg) => {
    try {
      if (onProgress) await onProgress(msg);
    } catch {}
  };

  try {
    await notify("🎙️ Скачиваю озвучку...");
    const audioPath = path.join(workDir, "voiceover");
    await downloadFile(voiceoverUrl, audioPath);

    const audioDuration = probeDuration(audioPath);
    if (audioDuration < 1) throw new Error("Озвучка слишком короткая.");

    const weights = script.segments.map((s) => Math.max(1, (s.narration || "").trim().split(/\s+/).filter(Boolean).length));
    const weightSum = weights.reduce((a, b) => a + b, 0);
    const segmentDurations = weights.map((w) => (audioDuration * w) / weightSum);

    const segmentClips = [];

    for (let i = 0; i < script.segments.length; i++) {
      const seg = script.segments[i];
      const durationSec = segmentDurations[i];

      await notify(`🎬 Сегмент ${i + 1}/${script.segments.length}: подбираю визуал...`);

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
        clipPath = path.join(workDir, `seg_${i}_visual.mp4`);
        run(
          `ffmpeg -y -f lavfi -i color=c=0x101018:s=${WIDTH}x${HEIGHT}:d=${durationSec.toFixed(3)}:r=${FPS} ` +
          `-c:v libx264 -pix_fmt yuv420p "${clipPath}"`
        );
      }

      segmentClips.push(clipPath);
    }

    await notify("🎞️ Склеиваю видеоряд...");
    const videoConcatList = path.join(workDir, "video_concat.txt");
    fs.writeFileSync(videoConcatList, segmentClips.map((p) => `file '${p}'`).join("\n"));

    const concatVideoPath = path.join(workDir, "concat_video.mp4");
    run(
      `ffmpeg -y -f concat -safe 0 -i "${videoConcatList}" -c:v libx264 -pix_fmt yuv420p -r ${FPS} "${concatVideoPath}"`
    );

    await notify("💬 Добавляю динамические субтитры...");
    const words = makeWordTimings(script, segmentDurations);
    const assPath = writeAss(words, workDir);
    const subtitledPath = path.join(workDir, "subtitled_video.mp4");

    run(
      `ffmpeg -y -i "${concatVideoPath}" -vf "subtitles='${escapeFilterPath(assPath)}'" ` +
      `-c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p "${subtitledPath}"`
    );

    await notify("🎵 Добавляю фоновую музыку и твою озвучку...");
    const musicSource = getBackgroundMusic(audioDuration, workDir);
    const finalPath = path.join(workDir, "final_short.mp4");

    // Голос — основная дорожка. Музыка приглушается и зацикливается.
    // -shortest гарантирует, что итоговый ролик не будет длиннее озвучки.
    run(
      `ffmpeg -y -i "${subtitledPath}" -i "${audioPath}" -stream_loop -1 -i "${musicSource}" ` +
      `-filter_complex "[2:a]volume=${MUSIC_VOLUME}[music];[1:a][music]amix=inputs=2:duration=first:dropout_transition=2[aout]" ` +
      `-map 0:v:0 -map "[aout]" -c:v copy -c:a aac -b:a 192k -t ${audioDuration.toFixed(3)} "${finalPath}"`
    );

    await notify("☁️ Загружаю готовое видео...");
    const publicUrl = await uploadToStorage(finalPath, "shorts");

    return {
      localPath: finalPath,
      publicUrl,
      totalDurationSec: audioDuration,
    };
  } catch (err) {
    throw err;
  }
}
