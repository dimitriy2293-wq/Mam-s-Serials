import "dotenv/config";

const API_BASE = "https://api.magichour.ai/v1";
const headers = {
  Authorization: `Bearer ${process.env.MAGICHOUR_API_KEY}`,
  "Content-Type": "application/json",
};

// ---------- Запуск генерации сцены ----------
export async function generateVideoScene({ referenceImageUrl, prompt, durationSec }) {
  const res = await fetch(`${API_BASE}/image-to-video`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      assets: { image_file_path: referenceImageUrl },
      end_seconds: durationSec,
      model: "wan-2.2",
      resolution: "480p", // дешевле по кредитам для MVP
      style: { prompt },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Magic Hour API error: ${res.status} ${err}`);
  }

  const data = await res.json();
  return { job_id: data.id };
}

// ---------- Проверка статуса ----------
export async function checkVideoStatus(jobId) {
  const res = await fetch(`${API_BASE}/image-to-video/${jobId}`, { headers });
  const data = await res.json();

  if (data.status === "complete") {
    return { done: true, video_url: data.downloads[0].url };
  }
  if (data.status === "error") {
    return { done: false, error: true };
  }
  return { done: false, error: false };
}
