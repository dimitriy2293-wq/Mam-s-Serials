-- Хранит стили, "выученные" из референсных видео (см. /learn_style в bot.js).
-- style_profile — структурированный текстовый разбор от Gemini (хук, темп,
-- визуал, субтитры, музыка, CTA), не сам видеофайл и не дословный текст ролика.
create table if not exists short_styles (
  id uuid primary key default gen_random_uuid(),
  telegram_id bigint not null,
  name text not null,
  style_profile jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists short_styles_telegram_id_idx on short_styles(telegram_id);
