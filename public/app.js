const $ = (s) => document.querySelector(s);
const parts = location.pathname.split("/").filter(Boolean);

const state = {
  roomId: parts[0] === "c" ? parts[1] : null,
  invite: new URLSearchParams(location.search).get("invite"),
  participantId: localStorage.getItem("gorgona.participant"),
  participantName: localStorage.getItem("gorgona.name"),
  socket: null,
  people: new Map(),
  typingTimer: null
};

function toast(text) {
  const el = $("#toast");
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove("show"), 1900);
}

function initials(name) {
  return String(name || "?").trim().split(/\s+/).slice(0,2).map(x => x[0]).join("").toUpperCase();
}

function formatTime(value) {
  return new Intl.DateTimeFormat("ru-RU", { hour:"2-digit", minute:"2-digit" }).format(new Date(value));
}

function setOnline(value) {
  const el = $("#status");
  el.textContent = value ? "● Online" : "● Offline";
  el.classList.toggle("online", value);
}

function renderPeople() {
  const root = $("#participants");
  root.replaceChildren();

  for (const person of state.people.values()) {
    const row = document.createElement("div");
    row.className = "person";
    row.innerHTML = `<div class="avatar"></div><div><b></b><small>Участник</small></div>`;
    row.querySelector(".avatar").textContent = initials(person.display_name || person.name);
    row.querySelector("b").textContent = person.display_name || person.name;
    root.appendChild(row);
  }
}

function clearMessages() {
  $("#messages").replaceChildren();
}

function addMessage(message) {
  const item = document.createElement("article");
  item.className = "message" + (message.participant_id === state.participantId ? " mine" : "");
  item.innerHTML = `<div class="meta"></div><div class="bubble"></div><div class="time"></div>`;
  item.querySelector(".meta").textContent = message.participant_id === state.participantId ? "Вы" : (message.name || "Участник");
  item.querySelector(".bubble").textContent = message.body;
  item.querySelector(".time").textContent = formatTime(message.created_at);
  $("#messages").appendChild(item);
  $("#messages").scrollTop = $("#messages").scrollHeight;
}

function renderMessages(messages) {
  clearMessages();

  if (!messages.length) {
    const welcome = document.createElement("div");
    welcome.className = "welcome";
    welcome.innerHTML = `<div class="hero-mark">G</div><h2>Комната готова</h2><p>Отправь приглашение второму человеку и начинайте переписку.</p>`;
    $("#messages").appendChild(welcome);
    return;
  }

  messages.forEach(addMessage);
}

async function createRoom() {
  const response = await fetch("/api/chats", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Gorgona Chat" })
  });
  const data = await response.json();

  if (!response.ok) {
    toast(data.error || "Не удалось создать комнату");
    return;
  }

  location.href = data.url;
}

function openJoin() {
  $("#modal").classList.remove("hidden");
  $("#nameInput").value = state.participantName || "";
  setTimeout(() => $("#nameInput").focus(), 40);
}

async function joinRoom() {
  const name = $("#nameInput").value.trim();
  if (!name) return toast("Введите имя");

  const response = await fetch(`/api/chats/${encodeURIComponent(state.roomId)}/participants`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, inviteToken: state.invite })
  });
  const data = await response.json();

  if (!response.ok) return toast(data.error || "Не удалось войти");

  state.participantId = data.id;
  state.participantName = data.display_name;
  localStorage.setItem("gorgona.participant", data.id);
  localStorage.setItem("gorgona.name", data.display_name);

  $("#modal").classList.add("hidden");
  connect();
}

async function loadRoom() {
  if (!state.roomId || !state.invite) {
    toast("Откройте комнату по invite-ссылке");
    return;
  }

  const response = await fetch(
    `/api/chats/${encodeURIComponent(state.roomId)}?invite=${encodeURIComponent(state.invite)}`
  );
  const data = await response.json();

  if (!response.ok) {
    toast("Недействительная invite-ссылка");
    return;
  }

  $("#roomCard").classList.remove("hidden");
  $("#roomTitle").textContent = data.chat.title;
  $("#roomId").textContent = data.chat.id;
  $("#headerTitle").textContent = data.chat.title;

  state.people.clear();
  data.participants.forEach(p => state.people.set(p.id, p));
  renderPeople();
  renderMessages(data.messages);

  if (!state.participantId || !state.people.has(state.participantId)) openJoin();
  else connect();
}

function connect() {
  if (state.socket) state.socket.close();

  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const url =
    `${protocol}//${location.host}/api/rooms/${encodeURIComponent(state.roomId)}/ws` +
    `?invite=${encodeURIComponent(state.invite)}` +
    `&participantId=${encodeURIComponent(state.participantId)}`;

  state.socket = new WebSocket(url);

  state.socket.addEventListener("open", () => setOnline(true));
  state.socket.addEventListener("close", () => setOnline(false));
  state.socket.addEventListener("error", () => setOnline(false));

  state.socket.addEventListener("message", (event) => {
    let payload;
    try { payload = JSON.parse(event.data); } catch { return; }

    if (payload.type === "message") {
      addMessage(payload.message);
      return;
    }

    if (payload.type === "typing") {
      const person = state.people.get(payload.participantId);
      if (payload.participantId === state.participantId) return;
      $("#typing").textContent = payload.typing ? `${person?.display_name || "Участник"} печатает…` : "";
      $("#typing").classList.toggle("hidden", !payload.typing);
      return;
    }

    if (payload.type === "presence" && payload.online && payload.participantId !== state.participantId) {
      const person = state.people.get(payload.participantId);
      if (person) toast(`${person.display_name} подключился`);
    }

    if (payload.type === "error") toast(payload.message || "Ошибка");
  });
}

async function sendMessage() {
  const input = $("#messageInput");
  const body = input.value.trim();

  if (!body || !state.socket || state.socket.readyState !== WebSocket.OPEN) return;

  state.socket.send(JSON.stringify({ type: "message", body }));
  input.value = "";
  state.socket.send(JSON.stringify({ type: "typing", typing: false }));
}

$("#newChat").addEventListener("click", createRoom);
$("#createRoom").addEventListener("click", createRoom);
$("#join").addEventListener("click", joinRoom);
$("#close").addEventListener("click", () => $("#modal").classList.add("hidden"));
$("#menu").addEventListener("click", () => $("#sidebar").classList.toggle("open"));

$("#invite").addEventListener("click", async () => {
  await navigator.clipboard.writeText(location.href);
  toast("Ссылка приглашения скопирована");
});

$("#copyInvite").addEventListener("click", async () => {
  if (!state.roomId) return createRoom();
  await navigator.clipboard.writeText(location.href);
  toast("Ссылка приглашения скопирована");
});

$("#plus").addEventListener("click", () => toast("Медиа-модуль подключим после базового realtime-теста"));

$("#composer").addEventListener("submit", (event) => {
  event.preventDefault();
  sendMessage();
});

$("#messageInput").addEventListener("input", () => {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) return;
  state.socket.send(JSON.stringify({ type: "typing", typing: true }));
  clearTimeout(state.typingTimer);
  state.typingTimer = setTimeout(() => {
    if (state.socket?.readyState === WebSocket.OPEN) {
      state.socket.send(JSON.stringify({ type: "typing", typing: false }));
    }
  }, 850);
});

if (state.roomId) loadRoom();
