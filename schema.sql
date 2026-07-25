create table episodes (
  id uuid primary key default gen_random_uuid(),
  telegram_id bigint not null,
  title text,
  script jsonb not null,
  characters jsonb not null default '[]',
  status text not null default 'pending', -- pending | processing | done | error
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
  created_at timestamptz not null default now()
);

create index scenes_episode_id_idx on scenes(episode_id);

create table bot_sessions (
  telegram_id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
