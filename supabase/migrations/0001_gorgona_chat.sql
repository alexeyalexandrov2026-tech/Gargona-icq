-- GORGONA CHAT
-- Run this migration in Supabase SQL Editor.

create extension if not exists pgcrypto;

create table if not exists public.chat_rooms (
  id uuid primary key default gen_random_uuid(),
  title text not null default 'Gorgona Chat',
  created_at timestamptz not null default now(),
  created_by text
);

create table if not exists public.chat_invites (
  token_hash text primary key,
  room_id uuid not null references public.chat_rooms(id) on delete cascade,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create index if not exists chat_invites_room_idx on public.chat_invites(room_id);

create table if not exists public.chat_participants (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.chat_rooms(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 40),
  created_at timestamptz not null default now()
);

create index if not exists chat_participants_room_idx on public.chat_participants(room_id);

create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.chat_rooms(id) on delete cascade,
  participant_id uuid not null references public.chat_participants(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 4000),
  created_at timestamptz not null default now()
);

create index if not exists chat_messages_room_created_idx
  on public.chat_messages(room_id, created_at);

-- The Worker is the trusted application boundary.
-- Browser clients do not get direct table access.
alter table public.chat_rooms enable row level security;
alter table public.chat_invites enable row level security;
alter table public.chat_participants enable row level security;
alter table public.chat_messages enable row level security;

revoke all on public.chat_rooms from anon, authenticated;
revoke all on public.chat_invites from anon, authenticated;
revoke all on public.chat_participants from anon, authenticated;
revoke all on public.chat_messages from anon, authenticated;

comment on table public.chat_rooms is 'Gorgona Chat rooms. Accessed by the trusted Cloudflare Worker.';
comment on table public.chat_invites is 'Hashed bearer invite tokens. Raw invite tokens never enter this table.';
