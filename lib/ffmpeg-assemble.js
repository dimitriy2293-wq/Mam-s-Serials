import { execSync } from "child_process";
import fs from "fs";
import path from "path";

async function downloadFile(url, outPath) {
  const res = await fetch(url);
  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(outPath, buffer);
  return outPath;
}

// ---------- Собрать один эпизод из сцен (видео + опциональная озвучка) ----------
export async function assembleEpisode(scenes) {
  const workDir = fs.mkdtempSync("/tmp/episode-");
  const processedClips = [];

  for (const scene of scenes) {
    const rawVideo = path.join(workDir, `scene_${scene.scene_number}_raw.mp4`);
    await downloadFile(scene.video_url, rawVideo);

    if (scene.voiceover_audio_url) {
      const audioPath = path.join(workDir, `scene_${scene.scene_number}_audio`);
      // voiceover_audio_url — либо URL, либо уже локальный путь (см. TODO в gemini.js про Supabase Storage)
      const localAudio = scene.voiceover_audio_url.startsWith("http")
        ? await downloadFile(scene.voiceover_audio_url, `${audioPath}.wav`)
        : scene.voiceover_audio_url;

      const merged = path.join(workDir, `scene_${scene.scene_number}_merged.mp4`);
      execSync(
        `ffmpeg -y -i "${rawVideo}" -i "${localAudio}" -c:v copy -map 0:v:0 -map 1:a:0 -shortest "${merged}"`
      );
      processedClips.push(merged);
    } else {
      processedClips.push(rawVideo);
    }
  }

  const concatListPath = path.join(workDir, "concat.txt");
  fs.writeFileSync(
    concatListPath,
    processedClips.map((p) => `file '${p}'`).join("\n")
  );

  const finalPath = path.join(workDir, "final_episode.mp4");
  execSync(
    `ffmpeg -y -f concat -safe 0 -i "${concatListPath}" -c copy "${finalPath}"`
  );

  return finalPath;
}
