import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { findVisualForSegment } from "./stock-media.js";
import { uploadToStorage } from "./storage.js";
import { getBackgroundMusic } from "./background-music.js";

const WIDTH = 1080;
const HEIGHT = 1920;
const FPS = 30;
const MUSIC_VOLUME = process.env.SHORTS_MUSIC_VOLUME || "0.12";

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

export async function assembleShort(script, { onProgress } = {}) {
  const workDir = fs.mkdtempSync("/tmp/short-");
  const notify = (msg) => onProgress && onProgress(msg).catch(() => {});

  const segmentClips = [];
  let cumulativeOffset = 0;

  for (let i = 0; i < script.segments.length; i++) {
    const seg = script.segments[i];
    await notify(`Сегмент ${i + 1}/${script.segments.length}: подбор видео...`);

    // Считаем примерную длину куска текста (скорость ~2 слова в секунду)
    const wordCount = (seg.narration.match(/\S+/g) || []).length;
    const durationSec = Math.max(2.5, wordCount / 2);

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
        `ffmpeg -y -f lavfi -i color=c=0x101018:s=${WIDTH}x${HEIGHT}:d=${durationSec}:r=${FPS} ` +
          `-c:v libx264 -pix_fmt yuv420p "${clipPath}"`
      );
    }

    segmentClips.push(clipPath);
    cumulativeOffset += durationSec;
  }

  const totalDurationSec = cumulativeOffset;

  await notify("Склеиваю визуал...");
  const videoConcatList = path.join(workDir, "video_concat.txt");
  fs.writeFileSync(videoConcatList, segmentClips.map((p) => `file '${p}'`).join("\n"));
  const concatVideoPath = path.join(workDir, "concat_video.mp4");
  run(`ffmpeg -y -f concat -safe 0 -i "${videoConcatList}" -c copy "${concatVideoPath}"`);

  await notify("Добавляю фоновую музыку...");
  const musicSource = getBackgroundMusic(totalDurationSec, workDir);
  const finalPath = path.join(workDir, "final_short.mp4");

  // Накладываем музыку поверх склеенного визуала
  run(
    `ffmpeg -y -i "${concatVideoPath}" -stream_loop -1 -i "${musicSource}" -filter_complex ` +
      `"[1:a]volume=${MUSIC_VOLUME}[aout]" ` +
      `-map 0:v:0 -map "[aout]" -c:v copy -c:a aac -shortest -t ${totalDurationSec} "${finalPath}"`
  );

  const publicUrl = await uploadToStorage(finalPath, "shorts");
  return { localPath: finalPath, publicUrl, totalDurationSec };
}
