-- У таблицы episodes не было колонки error (в отличие от shorts), из-за чего
-- gracefulShutdown не мог записать причину прерывания эпизода при перезапуске
-- контейнера (SIGTERM от Render), и /replay для сериала оставался без диагностики.
alter table episodes add column if not exists error text;
