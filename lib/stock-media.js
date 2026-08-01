import "dotenv/config";
import { fetchWithTimeout } from "./fetch-timeout.js";

const PEXELS_BASE = "https://api.pexels.com";
const PIXABAY_BASE = "https://pixabay.com/api";
const MEDIA_TIMEOUT_MS = 12_000; // если Pexels/Pixabay не ответил за 12 сек — считаем, что визуала нет, и идём дальше

// ---------- Видео (Pexels) ----------
// Берём вариант БЛИЗКИЙ к нашему выходному разрешению (см. TARGET_LONG_SIDE), а не
// самый большой доступный. Pexels часто отдаёт исходники в 1080p/4K — декодировать
// такой файл ffmpeg'ом только ради того, чтобы тут же сжать его до 720x1280,
// заметно дороже по памяти, чем взять сразу подходящий по размеру вариант.
const TARGET_LONG_SIDE = Math.max(
  Number(process.env.SHORTS_WIDTH) || 720,
  Number(process.env.SHORTS_HEIGHT) || 1280
);

function pickClosestBySize(files, getLongSide) {
  // Предпочитаем файлы РАВНЫЕ ИЛИ ЧУТЬ БОЛЬШЕ цели (без апскейла), а среди них — самый
  // маленький подходящий; если таких нет вообще, берём максимально доступный (лучше
  // немного растянуть, чем остаться без визуала).
  const withSize = files.filter((f) => getLongSide(f) > 0);
  if (withSize.length === 0) return files[0];

  const atLeastTarget = withSize
    .filter((f) => getLongSide(f) >= TARGET_LONG_SIDE)
    .sort((a, b) => getLongSide(a) - getLongSide(b));
  if (atLeastTarget.length > 0) return atLeastTarget[0];

  return withSize.sort((a, b) => getLongSide(b) - getLongSide(a))[0];
}

async function findPexelsVideo(query) {
  if (!process.env.PEXELS_API_KEY) return null;
  try {
    const res = await fetchWithTimeout(
      `${PEXELS_BASE}/videos/search?query=${encodeURIComponent(query)}&orientation=portrait&per_page=6`,
      { headers: { Authorization: process.env.PEXELS_API_KEY } },
      MEDIA_TIMEOUT_MS
    );
    if (!res.ok) return null;
    const json = await res.json();
    const video = (json.videos || [])[0];
    if (!video) return null;

    const portraitFiles = (video.video_files || []).filter((f) => f.height > f.width);
    const candidates = portraitFiles.length > 0 ? portraitFiles : (video.video_files || []);
    const file = pickClosestBySize(candidates, (f) => Math.max(f.width || 0, f.height || 0));
    if (!file) return null;
    return { type: "video", url: file.link };
  } catch (err) {
    console.error(`Pexels video search error ("${query}"):`, err.message);
    return null;
  }
}

// ---------- Фото (Pexels, потом Pixabay как запасной вариант) ----------
async function findPexelsPhoto(query) {
  if (!process.env.PEXELS_API_KEY) return null;
  try {
    const res = await fetchWithTimeout(
      `${PEXELS_BASE}/v1/search?query=${encodeURIComponent(query)}&orientation=portrait&per_page=6`,
      { headers: { Authorization: process.env.PEXELS_API_KEY } },
      MEDIA_TIMEOUT_MS
    );
    if (!res.ok) return null;
    const json = await res.json();
    const photo = (json.photos || [])[0];
    if (!photo) return null;
    return { type: "photo", url: photo.src.large || photo.src.medium || photo.src.original };
  } catch (err) {
    console.error(`Pexels photo search error ("${query}"):`, err.message);
    return null;
  }
}

async function findPixabayPhoto(query) {
  if (!process.env.PIXABAY_API_KEY) return null;
  try {
    const res = await fetchWithTimeout(
      `${PIXABAY_BASE}/?key=${process.env.PIXABAY_API_KEY}&q=${encodeURIComponent(query)}` +
        `&image_type=photo&orientation=vertical&safesearch=true&per_page=6`,
      {},
      MEDIA_TIMEOUT_MS
    );
    if (!res.ok) return null;
    const json = await res.json();
    const hit = (json.hits || [])[0];
    if (!hit) return null;
    return { type: "photo", url: hit.largeImageURL };
  } catch (err) {
    console.error(`Pixabay photo search error ("${query}"):`, err.message);
    return null;
  }
}

async function findPixabayVideo(query) {
  if (!process.env.PIXABAY_API_KEY) return null;
  try {
    const res = await fetchWithTimeout(
      `https://pixabay.com/api/videos/?key=${process.env.PIXABAY_API_KEY}&q=${encodeURIComponent(query)}&safesearch=true&per_page=6`,
      {},
      MEDIA_TIMEOUT_MS
    );
    if (!res.ok) return null;
    const json = await res.json();
    const hit = (json.hits || [])[0];
    if (!hit) return null;
    const files = hit.videos || {};
    // Pixabay отдаёт всего 3-4 готовых варианта (large/medium/small/tiny) без точных
    // размеров в этом ответе — "medium" обычно ближе всего к нашим 720x1280, чем
    // "large" (часто 1080p+), так что берём его первым, а не самый тяжёлый.
    const best = files.medium || files.small || files.large || files.tiny;
    if (!best) return null;
    return { type: "video", url: best.url };
  } catch (err) {
    console.error(`Pixabay video search error ("${query}"):`, err.message);
    return null;
  }
}

// ---------- Найти визуал для сегмента сценария ----------
// Порядок: видео Pexels → видео Pixabay → фото Pexels → фото Pixabay.
// Видео приоритетнее фото (динамичнее для формата коротких видео),
// фото используется как запасной вариант — при монтаже к нему добавляется
// эффект медленного приближения (Ken Burns), см. lib/shorts-assemble.js.
export async function findVisualForSegment(query) {
  const video = (await findPexelsVideo(query)) || (await findPixabayVideo(query));
  if (video) return video;

  const photo = (await findPexelsPhoto(query)) || (await findPixabayPhoto(query));
  if (photo) return photo;

  return null;
}
