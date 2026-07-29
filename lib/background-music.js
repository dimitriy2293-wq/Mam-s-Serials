import { execSync } from "child_process";
import fs from "fs";
import path from "path";

const MUSIC_DIR = path.join(process.cwd(), "assets", "music");

function run(cmd) {
  try {
    execSync(cmd, { stdio: ["ignore", "ignore", "pipe"] });
  } catch (err) {
    throw new Error(`ffmpeg (background-music) упал: ${cmd}\n${err.stderr?.toString().slice(-1000) || err.message}`);
  }
}

// Если пользователь сам положил свои (лицензионные/CC0) треки в assets/music —
// используем один из них случайно, это даёт более "живой" звук, чем генерация.
function pickUserMusicFile() {
  if (!fs.existsSync(MUSIC_DIR)) return null;
  const files = fs.readdirSync(MUSIC_DIR).filter((f) => /\.(mp3|wav|m4a)$/i.test(f));
  if (files.length === 0) return null;
  return path.join(MUSIC_DIR, files[Math.floor(Math.random() * files.length)]);
}

// Несколько наборов частот (мягкие минорные/нейтральные созвучия) — чтобы
// разные ролики не звучали абсолютно одинаково.
const CHORD_SETS = [
  [110, 165, 220], // A2-E3-A3
  [98, 147, 196], // G2-D3-G3
  [130.8, 196, 261.6], // C3-G3-C4
  [87.3, 130.8, 174.6], // F2-C3-F3
];

// Автоматически синтезирует спокойную амбиентную "подложку" через ffmpeg —
// без внешних файлов и без вопросов об авторских правах, полностью процедурно.
function synthesizeAmbientBed(durationSec, outPath) {
  const chord = CHORD_SETS[Math.floor(Math.random() * CHORD_SETS.length)];
  const dur = Math.max(3, Math.ceil(durationSec) + 1);
  const fadeOutStart = Math.max(0, dur - 2);

  run(
    `ffmpeg -y ` +
      `-f lavfi -i "sine=frequency=${chord[0]}:duration=${dur}" ` +
      `-f lavfi -i "sine=frequency=${chord[1]}:duration=${dur}" ` +
      `-f lavfi -i "sine=frequency=${chord[2]}:duration=${dur}" ` +
      `-filter_complex "[0:a][1:a][2:a]amix=inputs=3:duration=longest:weights=1 0.8 0.6,` +
      `tremolo=f=0.15:d=0.25,lowpass=f=2200,` +
      `afade=t=in:st=0:d=2,afade=t=out:st=${fadeOutStart}:d=2,volume=0.5" ` +
      `-ac 2 -ar 44100 "${outPath}"`
  );
  return outPath;
}

// Возвращает путь к аудиофайлу фоновой музыки нужной (примерной) длительности.
// Приоритет: файл пользователя из assets/music (если есть) → синтезированная подложка.
export function getBackgroundMusic(durationSec, workDir) {
  const userFile = pickUserMusicFile();
  if (userFile) return userFile;

  const outPath = path.join(workDir, `ambient_bed_${Date.now()}.mp3`);
  return synthesizeAmbientBed(durationSec, outPath);
}
