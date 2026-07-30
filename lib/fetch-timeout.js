// Обычный fetch() может зависнуть навсегда, если внешний сервис (Pexels/Pixabay/etc.)
// не отвечает или сеть на Render "подвисла" — тогда весь пайплайн сборки короткого
// видео останавливается на этом шаге без единой ошибки в логах. AbortSignal.timeout
// гарантирует, что запрос завершится по таймауту исключением, а не будет висеть вечно.
export async function fetchWithTimeout(url, options = {}, timeoutMs = 15_000) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
}
