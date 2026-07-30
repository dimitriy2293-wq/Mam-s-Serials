-- Run this once in Supabase SQL Editor for an existing installation.
alter table shorts
  add column if not exists voiceover_audio_url text;
