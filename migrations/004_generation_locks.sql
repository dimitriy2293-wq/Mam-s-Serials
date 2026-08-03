-- Единый лок "что сейчас генерируется у этого пользователя" — общий и для shorts,
-- и для episodes. Раньше у shorts был свой build_lock, а у episodes не было вообще
-- никакой защиты от параллельного запуска — можно было одновременно затеять и
-- TikTok, и сериал. Один ряд на telegram_id = можно начинать только одно за раз.
create table if not exists generation_locks (
  telegram_id bigint primary key,
  kind text not null, -- 'short' | 'episode'
  resource_id uuid not null,
  resource_title text,
  locked_at timestamptz not null default now()
);
