-- Нужны для логики "1 доп. попытка на зависшую сцену" в pollScenes:
-- retry_count — сколько раз уже перезапускали генерацию видео для сцены;
-- last_attempt_at — когда была последняя попытка (created_at не годится,
-- он фиксируется один раз при вставке строки и не двигается при ретрае).
alter table scenes add column if not exists retry_count int not null default 0;
alter table scenes add column if not exists last_attempt_at timestamptz;
update scenes set last_attempt_at = created_at where last_attempt_at is null;
