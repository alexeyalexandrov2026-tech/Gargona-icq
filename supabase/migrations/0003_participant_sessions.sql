-- GORGONA CHAT - MIGRATION 0003
--
-- Adds a per-participant session credential. Previously a participantId
-- was just a public identifier: anyone holding the room's invite token
-- could open a WebSocket "as" any participantId they observed in a
-- broadcast message, because nothing proved ownership of that seat.
--
-- A session token is generated once, when a participant row is created,
-- and only its hash is stored (same pattern already used for invite
-- tokens). The raw token is returned to the client a single time and must
-- be presented on every subsequent WebSocket connection / authenticated
-- request for that participant.

alter table public.chat_participants
  add column if not exists session_token_hash text;

-- Sparse unique index: only enforced for rows that have a hash, so it
-- cannot collide with the (many) legacy rows created before this
-- migration, which simply have no session and can no longer authenticate
-- until the participant rejoins.
create unique index if not exists chat_participants_session_hash_idx
  on public.chat_participants(session_token_hash)
  where session_token_hash is not null;

comment on column public.chat_participants.session_token_hash is
  'SHA-256 hash of the per-participant session credential. The raw token is never stored and is only ever returned once, at creation time.';
