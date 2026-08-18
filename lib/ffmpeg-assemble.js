import ffmpegPath from 'ffmpeg-static';
import { exec } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { promisify } from 'util';
import fetch from 'node-fetch';
import { uploadToStorage } from './storage.js';

const execAsync = promisify(exec);

export async function assembleEpisode(scenes, episodeId) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), `episode-${episodeId}-`));
  try {
    const listPath = path.join(workDir, 'list.txt');
    const validScenes = scenes.filter(s => s.video_url);
    let listContent = '';

    for (let i = 0; i < validScenes.length; i++) {
      const scene = validScenes[i];
      const videoPath = path.join(workDir, `video_${i}.mp4`);
      
      // Скачиваем видео-кусок
      const vRes = await fetch(scene.video_url);
      fs.writeFileSync(videoPath, Buffer.from(await vRes.arrayBuffer()));

      const sceneOutputPath = path.join(workDir, `scene_${i}.mp4`);

      // Накладываем блюр на правый нижний угол (скрываем лого Digen)
      // delogo маскирует участок. w/h - ширина/высота, x/y координаты с правого нижнего угла
      const vfBlur = "delogo=x=W-240:y=H-90:w=230:h=80";

      if (scene.voiceover_audio_url) {
        // Качаем озвучку
        const audioPath = path.join(workDir, `audio_${i}.mp3`);
        const aRes = await fetch(scene.voiceover_audio_url);
        fs.writeFileSync(audioPath, Buffer.from(await aRes.arrayBuffer()));

        // Склеиваем видео + звук + блюр
        await execAsync(`"${ffmpegPath}" -i "${videoPath}" -i "${audioPath}" -vf "${vfBlur}" -c:v libx264 -c:a aac -map 0:v:0 -map 1:a:0 -shortest -y "${sceneOutputPath}"`);
      } else {
        // Только блюр (если нет озвучки)
        await execAsync(`"${ffmpegPath}" -i "${videoPath}" -vf "${vfBlur}" -c:v libx264 -y "${sceneOutputPath}"`);
      }

      listContent += `file 'scene_${i}.mp4'\n`;
    }

    fs.writeFileSync(listPath, listContent);
    const finalPath = path.join(workDir, 'final.mp4');

    // Собираем всё в финальный файл
    await execAsync(`"${ffmpegPath}" -f concat -safe 0 -i "${listPath}" -c copy -y "${finalPath}"`);

    // Загружаем результат
    const publicUrl = await uploadToStorage(finalPath, `episodes/${episodeId}`);
    return { localPath: finalPath, publicUrl };
  } finally {
    // Временная папка удаляется в bot.js (через fs.rmSync) после отправки
  }
}
