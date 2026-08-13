const $ = (s) => document.querySelector(s);
const parts = location.pathname.split("/").filter(Boolean);

const state = {
  roomId: parts[0] === "c" ? parts[1] : null,
  invite: new URLSearchParams(location.search).get("invite"),
  participantId: localStorage.getItem("gorgona.participant"),
  participantName: localStorage.getItem("gorgona.name"),
  socket: null,
  people: new Map(),
  typingTimer: null,
  pendingGeoData: null
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
  
  const bubble = item.querySelector(".bubble");
  let isMedia = false;

  try {
    if (message.body.startsWith("{") && message.body.endsWith("}")) {
      const parsed = JSON.parse(message.body);
      if (parsed.type === "geo_photo" || parsed.type === "standard_photo") {
        isMedia = true;
        bubble.replaceChildren();
        const card = document.createElement("div");
        card.className = "chat-photo-card";

        const img = document.createElement("img");
        img.className = "chat-photo-img";
        img.src = parsed.image;
        img.alt = "Chat Photo";
        img.addEventListener("click", () => window.open(parsed.image, "_blank"));
        card.appendChild(img);

        if (parsed.type === "geo_photo" && parsed.lat && parsed.lon) {
          const meta = document.createElement("div");
          meta.className = "chat-photo-meta";
          const latFixed = Number(parsed.lat).toFixed(5);
          const lonFixed = Number(parsed.lon).toFixed(5);
          const mapUrl = `https://www.google.com/maps?q=${parsed.lat},${parsed.lon}`;
          meta.innerHTML = `
            <div class="geo-tag">📍 ${latFixed}°, ${lonFixed}°</div>
            <small class="time">${parsed.timestamp || ""}</small><br>
            <a class="map-btn" href="${mapUrl}" target="_blank" rel="noopener">🗺 Открыть на карте</a>
          `;
          card.appendChild(meta);
        }

        bubble.appendChild(card);
      }
    }
  } catch (e) {
    isMedia = false;
  }

  if (!isMedia) {
    bubble.textContent = message.body;
  }

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

async function sendMessage(customBody = null) {
  const input = $("#messageInput");
  const body = customBody || input.value.trim();

  if (!body || !state.socket || state.socket.readyState !== WebSocket.OPEN) return;

  state.socket.send(JSON.stringify({ type: "message", body }));
  if (!customBody) input.value = "";
  state.socket.send(JSON.stringify({ type: "typing", typing: false }));
}

function stampGeoOnImage(file, coords) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        const maxDim = 1000;
        let w = img.width;
        let h = img.height;

        if (w > maxDim || h > maxDim) {
          if (w > h) { h = Math.round((h * maxDim) / w); w = maxDim; }
          else { w = Math.round((w * maxDim) / h); h = maxDim; }
        }

        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);

        const bannerHeight = Math.max(65, Math.round(h * 0.15));
        const gradient = ctx.createLinearGradient(0, h - bannerHeight, 0, h);
        gradient.addColorStop(0, "rgba(0, 0, 0, 0)");
        gradient.addColorStop(0.3, "rgba(10, 10, 10, 0.75)");
        gradient.addColorStop(1, "rgba(10, 10, 10, 0.95)");

        ctx.fillStyle = gradient;
        ctx.fillRect(0, h - bannerHeight, w, bannerHeight);

        const now = new Date();
        const timeStr = `${now.toLocaleDateString("ru-RU")} ${now.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}`;
        const latStr = coords ? coords.latitude.toFixed(5) : "N/A";
        const lonStr = coords ? coords.longitude.toFixed(5) : "N/A";
        const accStr = coords ? `(±${Math.round(coords.accuracy)}m)` : "";

        ctx.fillStyle = "#ffd21a";
        ctx.font = `bold ${Math.max(14, Math.round(w * 0.03))}px Inter, sans-serif`;
        ctx.fillText(`📍 GPS: ${latStr}°, ${lonStr}° ${accStr}`, 15, h - bannerHeight + 25);

        ctx.fillStyle = "#ffffff";
        ctx.font = `${Math.max(11, Math.round(w * 0.022))}px Inter, sans-serif`;
        ctx.fillText(`🕒 ${timeStr}  •  GORGONA CHAT VERIFIED GEO`, 15, h - bannerHeight + 48);

        const dataUrl = canvas.toDataURL("image/jpeg", 0.78);
        resolve({ dataUrl, lat: coords?.latitude, lon: coords?.longitude, timeStr });
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
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

$("#plus").addEventListener("click", () => {
  $("#actionModal").classList.remove("hidden");
});

$("#closeAction").addEventListener("click", () => $("#actionModal").classList.add("hidden"));
$("#closePreview").addEventListener("click", () => $("#previewModal").classList.add("hidden"));
$("#cancelGeoSend").addEventListener("click", () => $("#previewModal").classList.add("hidden"));

$("#btnGeoPhoto").addEventListener("click", () => {
  $("#actionModal").classList.add("hidden");
  toast("Запрос геолокации GPS...");
  if ("geolocation" in navigator) {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        state.currentCoords = pos.coords;
        $("#geoInput").click();
      },
      (err) => {
        toast("Не удалось получить GPS, используем базовые данные");
        state.currentCoords = { latitude: 55.7558, longitude: 37.6173, accuracy: 50 };
        $("#geoInput").click();
      },
      { enableHighAccuracy: true, timeout: 7000 }
    );
  } else {
    $("#geoInput").click();
  }
});

$("#btnStandardPhoto").addEventListener("click", () => {
  $("#actionModal").classList.add("hidden");
  $("#standardInput").click();
});

$("#geoInput").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;

  toast("Обработка и наложение геолокации...");
  try {
    const res = await stampGeoOnImage(file, state.currentCoords);
    state.pendingGeoData = {
      type: "geo_photo",
      image: res.dataUrl,
      lat: res.lat,
      lon: res.lon,
      timestamp: res.timeStr
    };

    $("#geoPreviewImg").src = res.dataUrl;
    $("#geoPreviewInfo").textContent = `📍 Координаты: ${res.lat?.toFixed(5)}°, ${res.lon?.toFixed(5)}° | ${res.timeStr}`;
    $("#previewModal").classList.remove("hidden");
  } catch (err) {
    toast("Ошибка обработки фотографии");
  }
  e.target.value = "";
});

$("#standardInput").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;

  try {
    const res = await stampGeoOnImage(file, null);
    const payload = JSON.stringify({
      type: "standard_photo",
      image: res.dataUrl
    });
    await sendMessage(payload);
    toast("Фотография отправлена");
  } catch (err) {
    toast("Ошибка отправки картинки");
  }
  e.target.value = "";
});

$("#sendGeoPhoto").addEventListener("click", async () => {
  if (!state.pendingGeoData) return;
  $("#previewModal").classList.add("hidden");
  await sendMessage(JSON.stringify(state.pendingGeoData));
  toast("Фото с геолокацией отправлено!");
  state.pendingGeoData = null;
});

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

