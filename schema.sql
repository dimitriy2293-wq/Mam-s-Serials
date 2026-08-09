create table episodes (
  id uuid primary key default gen_random_uuid(),
  telegram_id bigint not null,
  title text,
  script jsonb not null,
  characters jsonb not null default '[]',
  locations jsonb not null default '[]', -- [{ name, description, image_url }] — фиксированный фон на локацию
  status text not null default 'pending', -- pending | processing | done | error
  error text,
  created_at timestamptz not null default now()
);

create table scenes (
  id uuid primary key default gen_random_uuid(),
  episode_id uuid references episodes(id) on delete cascade,
  scene_number int not null,
  script_text text not null,
  character_ref_image_url text,
  video_job_id text,
  video_status text not null default 'pending', -- pending | processing | done | error
  video_url text,
  voiceover_audio_url text,
  duration_sec int not null,
  retry_count int not null default 0,
  last_attempt_at timestamptz,
  created_at timestamptz not null default now()
);

create index scenes_episode_id_idx on scenes(episode_id);

create table bot_sessions (
  telegram_id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

create table shorts (
  id uuid primary key default gen_random_uuid(),
  telegram_id bigint not null,
  title text,
  type text, -- 'news' | 'story'
  script jsonb not null,
  status text not null default 'processing', -- awaiting_voice | voice_received | building | completed | error
  final_video_url text,
  voiceover_audio_url text,
  error text,
  build_lock boolean not null default false,
  build_started_at timestamptz,
  created_at timestamptz not null default now()
);

create index shorts_telegram_id_idx on shorts(telegram_id);

-- Дедупликация Telegram update_id — защита от повторной обработки одного апдейта,
-- когда Telegram ретраит webhook (например, если сборка видео заняла больше таймаута).
create table processed_updates (
  update_id bigint primary key,
  processed_at timestamptz not null default now()
);
