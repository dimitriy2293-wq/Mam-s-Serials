-- Хранит свои фото/видео пользователя для сегментов TikTok (см. выбор "Свои
-- фото/видео" в /new_short). Массив в том же порядке, что и script.segments;
-- null на позиции — сегмент без своего файла, подбирается автоматически со стоков.
alter table shorts
  add column if not exists custom_visuals jsonb;
