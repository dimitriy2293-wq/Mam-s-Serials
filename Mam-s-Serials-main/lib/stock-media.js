import "dotenv/config";

const PEXELS_BASE = "https://api.pexels.com";
const PIXABAY_BASE = "https://pixabay.com/api";

// ---------- Видео (Pexels) ----------
async function findPexelsVideo(query) {
  if (!process.env.PEXELS_API_KEY) return null;
  try {
    const res = await fetch(
      `${PEXELS_BASE}/videos/search?query=${encodeURIComponent(query)}&orientation=portrait&per_page=6`,
      { headers: { Authorization: process.env.PEXELS_API_KEY } }
    );
    if (!res.ok) return null;
    const json = await res.json();
    const video = (json.videos || [])[0];
    if (!video) return null;

    const files = [...(video.video_files || [])].sort((a, b) => {
      const aPortrait = a.height > a.width ? 1 : 0;
      const bPortrait = b.height > b.width ? 1 : 0;
      if (aPortrait !== bPortrait) return bPortrait - aPortrait;
      return (b.width || 0) - (a.width || 0);
    });
    const file = files[0];
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
    const res = await fetch(
      `${PEXELS_BASE}/v1/search?query=${encodeURIComponent(query)}&orientation=portrait&per_page=6`,
      { headers: { Authorization: process.env.PEXELS_API_KEY } }
    );
    if (!res.ok) return null;
    const json = await res.json();
    const photo = (json.photos || [])[0];
    if (!photo) return null;
    return { type: "photo", url: photo.src.large2x || photo.src.large || photo.src.original };
  } catch (err) {
    console.error(`Pexels photo search error ("${query}"):`, err.message);
    return null;
  }
}

async function findPixabayPhoto(query) {
  if (!process.env.PIXABAY_API_KEY) return null;
  try {
    const res = await fetch(
      `${PIXABAY_BASE}/?key=${process.env.PIXABAY_API_KEY}&q=${encodeURIComponent(query)}` +
        `&image_type=photo&orientation=vertical&safesearch=true&per_page=6`
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
    const res = await fetch(
      `https://pixabay.com/api/videos/?key=${process.env.PIXABAY_API_KEY}&q=${encodeURIComponent(query)}&safesearch=true&per_page=6`
    );
    if (!res.ok) return null;
    const json = await res.json();
    const hit = (json.hits || [])[0];
    if (!hit) return null;
    const files = hit.videos || {};
    const best = files.large || files.medium || files.small;
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
