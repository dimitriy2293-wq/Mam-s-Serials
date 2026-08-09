-- Нужна, чтобы retry зависшей сцены (в pollScenes) пересоздавал видео с тем же
-- планом (close-up/medium close-up/...), а не терял его между попытками.
alter table scenes add column if not exists shot_type text;
