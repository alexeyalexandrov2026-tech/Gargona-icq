-- GORGONA CHAT - MIGRATION 0002
-- Allow larger body text for media messages (photos with embedded geolocation)

alter table public.chat_messages drop constraint if exists chat_messages_body_check;
alter table public.chat_messages add constraint chat_messages_body_check check (char_length(body) between 1 and 2500000);
