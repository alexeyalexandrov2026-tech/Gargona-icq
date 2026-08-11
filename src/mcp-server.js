/*
  Gorgona Chat MCP bridge.

  This file is intentionally isolated from the Worker runtime.
  For a hosted ChatGPT connection, expose an authenticated HTTPS MCP
  endpoint and map these operations to the Gorgona API.

  Recommended tools:
  - create_chat
  - get_chat
  - list_messages
  - send_message
  - create_invite

  Do not expose SUPABASE_SECRET_KEY through MCP.
*/
