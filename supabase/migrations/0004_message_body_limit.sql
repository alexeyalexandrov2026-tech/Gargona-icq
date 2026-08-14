-- GORGONA CHAT - MIGRATION 0004
--
-- Migration 0002 raised the message body limit to 5,000,000 characters so
-- that base64-encoded photos/video notes could be embedded directly in
-- chat_messages.body. That was never a safe production model: it let a
-- single row bloat Postgres by several megabytes, forced every connected
-- client to receive the full blob over the room broadcast fan-out, and
-- still exceeded common WebSocket/proxy frame limits in practice.
--
-- Media now lives in object storage (R2); chat_messages.body only ever
-- holds plain text or a small JSON reference (type/key/metadata), which
-- comfortably fits in a few hundred characters. Restore a real limit so
-- the database keeps enforcing what the application actually intends,
-- instead of silently accepting multi-megabyte rows.

alter table public.chat_messages drop constraint if exists chat_messages_body_check;
alter table public.chat_messages add constraint chat_messages_body_check check (char_length(body) between 1 and 4000);
