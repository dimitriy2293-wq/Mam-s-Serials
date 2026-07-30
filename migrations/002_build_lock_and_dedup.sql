-- Запусти один раз в Supabase SQL Editor.
-- Решает проблему "один и тот же TikTok собирается несколько раз":
--   1) processed_updates — дедупликация Telegram update_id (Telegram ретраит webhook,
--      если бот не ответил вовремя, а сборка видео занимает несколько минут).
--   2) shorts.build_lock / build_started_at — атомарный лок сборки в базе, а не в
--      памяти процесса (Render может держать/перезапускать несколько инстансов).

alter table shorts
  add column if not exists build_lock boolean not null default false,
  add column if not exists build_started_at timestamptz;

create table if not exists processed_updates (
  update_id bigint primary key,
  processed_at timestamptz not null default now()
);

-- Апдейты старше пары дней больше не нужны для дедупликации — Telegram не ретраит
-- так долго. Можно чистить вручную или повесить на pg_cron/Supabase Scheduled Function:
-- delete from processed_updates where processed_at < now() - interval '2 days';
