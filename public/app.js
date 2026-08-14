const $ = (s) => document.querySelector(s);
const parts = location.pathname.split("/").filter(Boolean);
const roomIdFromUrl = parts[0] === "c" ? parts[1] : null;

// Identity is scoped per room: a browser can hold a different
// participant identity in each room it has joined. Using a single
// global localStorage key (the previous behaviour) meant opening a
// second room's invite silently reused the first room's identity data.
function storageKey(roomId, name) {
  return `gorgona.${name}.${roomId}`;
}

const state = {
  roomId: roomIdFromUrl,
  invite: new URLSearchParams(location.search).get("invite"),
  participantId: roomIdFromUrl ? localStorage.getItem(storageKey(roomIdFromUrl, "participant")) : null,
  participantName: roomIdFromUrl ? localStorage.getItem(storageKey(roomIdFromUrl, "name")) : null,
  sessionToken: roomIdFromUrl ? localStorage.getItem(storageKey(roomIdFromUrl, "session")) : null,
  adminId: null,
  socket: null,
  people: new Map(),
  typingTimer: null,
  pendingGeoBlob: null,
  pendingGeoMeta: null,
  cameraStream: null,
  facingMode: "user",
  currentAdminReqId: null,
  noteMediaRecorder: null,
  noteChunks: [],
  noteStream: null,
  noteTimer: null,
  callStream: null,
  peerConnections: new Map(),
  oldestCursor: null,
  loadingOlder: false
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

function apiErrorMessage(data, fallback) {
  return data?.error?.message || fallback;
}

function setOnline(value) {
  const el = $("#status");
  if (!state.roomId) {
    el.textContent = "● Вне комнаты";
    el.classList.remove("online");
    return;
  }
  el.textContent = value ? "● Online в комнате" : "● Переподключение...";
  el.classList.toggle("online", value);
}

function renderPeople() {
  const root = $("#participants");
  root.replaceChildren();

  for (const person of state.people.values()) {
    const row = document.createElement("div");
    row.className = "person";

    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.textContent = initials(person.display_name || person.name);

    const info = document.createElement("div");
    const nameEl = document.createElement("b");
    nameEl.textContent = person.display_name || person.name;
    info.appendChild(nameEl);

    if (person.id === state.adminId) {
      const badge = document.createElement("small");
      badge.style.color = "var(--yellow)";
      badge.textContent = " (Админ)";
      info.appendChild(badge);
    }

    const role = document.createElement("small");
    role.textContent = "Участник";
    info.appendChild(role);

    row.appendChild(avatar);
    row.appendChild(info);
    root.appendChild(row);
  }
}

function clearMessages() {
  $("#messages").replaceChildren();
}

// Only ever-same-origin, server-issued paths of the exact shape the
// media upload endpoint returns are allowed as an image/video src. This
// is what stands between a crafted message payload and an attacker
// choosing an arbitrary (e.g. javascript:) URL scheme.
const MEDIA_PATH_RE = /^\/api\/media\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.[a-z0-9]+$/i;

function mediaSrc(mediaPath) {
  if (typeof mediaPath !== "string" || !MEDIA_PATH_RE.test(mediaPath)) return null;
  return `${mediaPath}?invite=${encodeURIComponent(state.invite || "")}`;
}

function buildMessageElement(message) {
  const item = document.createElement("article");
  item.className = "message" + (message.participant_id === state.participantId ? " mine" : "");

  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = message.participant_id === state.participantId ? "Вы" : (message.name || "Участник");
  item.appendChild(meta);

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  item.appendChild(bubble);

  let isMedia = false;
  try {
    if (message.body.startsWith("{") && message.body.endsWith("}")) {
      const parsed = JSON.parse(message.body);
      const src = mediaSrc(parsed.mediaPath);

      if (src && (parsed.type === "geo_photo" || parsed.type === "standard_photo")) {
        isMedia = true;
        const card = document.createElement("div");
        card.className = "chat-photo-card";

        const img = document.createElement("img");
        img.className = "chat-photo-img";
        img.src = src;
        img.alt = "Chat Photo";
        img.loading = "lazy";
        img.addEventListener("click", () => window.open(src, "_blank", "noopener,noreferrer"));
        card.appendChild(img);

        const lat = Number(parsed.lat);
        const lon = Number(parsed.lon);
        if (parsed.type === "geo_photo" && Number.isFinite(lat) && Number.isFinite(lon)) {
          const metaBox = document.createElement("div");
          metaBox.className = "chat-photo-meta";

          const geoTag = document.createElement("div");
          geoTag.className = "geo-tag";
          geoTag.textContent = `📍 GPS: ${lat.toFixed(5)}°, ${lon.toFixed(5)}°`;
          metaBox.appendChild(geoTag);

          const time = document.createElement("small");
          time.className = "time";
          time.textContent = String(parsed.timestamp || "").slice(0, 64);
          metaBox.appendChild(time);

          card.appendChild(metaBox);
        }

        bubble.appendChild(card);
      } else if (src && parsed.type === "video_note") {
        isMedia = true;
        const video = document.createElement("video");
        video.className = "chat-video-circle";
        video.src = src;
        video.controls = true;
        video.playsInline = true;
        bubble.appendChild(video);
      }
    }
  } catch (e) {
    isMedia = false;
  }

  if (!isMedia) {
    bubble.textContent = message.body;
  }

  const time = document.createElement("div");
  time.className = "time";
  time.textContent = formatTime(message.created_at);
  item.appendChild(time);

  return item;
}

function addMessage(message) {
  const container = $("#messages");
  container.appendChild(buildMessageElement(message));
  container.scrollTop = container.scrollHeight;
}

function prependMessages(messages) {
  const container = $("#messages");
  const fragment = document.createDocumentFragment();
  messages.forEach(m => fragment.appendChild(buildMessageElement(m)));
  container.prepend(fragment);
}

function renderMessages(messages) {
  clearMessages();

  if (!messages.length) {
    const welcome = document.createElement("div");
    welcome.className = "welcome";
    welcome.innerHTML = `<div class="hero-mark">G</div><h2>Комната готова</h2><p>Отправь приглашение друзьям — они отправят заявку на вход.</p>`;
    $("#messages").appendChild(welcome);
    return;
  }

  messages.forEach(addMessage);
}

function setLoadOlderVisible(visible) {
  $("#loadOlder").classList.toggle("hidden", !visible);
}

async function loadOlderMessages() {
  if (!state.oldestCursor || state.loadingOlder) return;
  state.loadingOlder = true;
  const btn = $("#loadOlder");
  btn.disabled = true;
  btn.textContent = "Загрузка…";

  try {
    const params = new URLSearchParams({
      before: state.oldestCursor.beforeCreatedAt,
      beforeId: state.oldestCursor.beforeId
    });
    const response = await fetch(`/api/chats/${encodeURIComponent(state.roomId)}?${params}`, {
      headers: { Authorization: `Bearer ${state.invite}` }
    });
    const data = await response.json();
    if (!response.ok) {
      toast(apiErrorMessage(data, "Не удалось загрузить историю"));
      return;
    }

    const container = $("#messages");
    const previousHeight = container.scrollHeight;
    prependMessages(data.messages);
    container.scrollTop = container.scrollHeight - previousHeight;

    state.oldestCursor = data.cursor;
    setLoadOlderVisible(Boolean(data.hasMore));
  } finally {
    state.loadingOlder = false;
    btn.disabled = false;
    btn.textContent = "↑ Загрузить более старые сообщения";
  }
}

async function createRoom() {
  const response = await fetch("/api/chats", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Gorgona Chat" })
  });
  const data = await response.json();

  if (!response.ok) {
    toast(apiErrorMessage(data, "Не удалось создать комнату"));
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

  state.pendingName = name;
  $("#modal").classList.add("hidden");

  if (state.people.size === 0) {
    // Nobody to approve an empty room's first participant -- holding the
    // invite is already the trust boundary for that seat, same rule the
    // server enforces in POST /participants.
    await completeJoin(name, null);
  } else {
    $("#waitingModal").classList.remove("hidden");
    connect(name);
  }
}

async function completeJoin(name, joinTicket) {
  const response = await fetch(`/api/chats/${encodeURIComponent(state.roomId)}/participants`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, inviteToken: state.invite, joinTicket: joinTicket || undefined })
  });
  const data = await response.json();

  if (!response.ok) return toast(apiErrorMessage(data, "Не удалось войти"));

  state.participantId = data.id;
  state.participantName = data.display_name;
  state.sessionToken = data.sessionToken;
  localStorage.setItem(storageKey(state.roomId, "participant"), data.id);
  localStorage.setItem(storageKey(state.roomId, "name"), data.display_name);
  localStorage.setItem(storageKey(state.roomId, "session"), data.sessionToken);

  $("#waitingModal").classList.add("hidden");
  connect();
}

async function loadRoom() {
  if (!state.roomId || !state.invite) {
    toast("Создайте комнату или откройте ссылку-приглашение");
    setOnline(false);
    return;
  }

  const response = await fetch(`/api/chats/${encodeURIComponent(state.roomId)}`, {
    headers: { Authorization: `Bearer ${state.invite}` }
  });
  const data = await response.json();

  if (!response.ok) {
    toast(apiErrorMessage(data, "Недействительная invite-ссылка"));
    setOnline(false);
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

  state.oldestCursor = data.cursor;
  setLoadOlderVisible(Boolean(data.hasMore));

  const knownParticipant = state.participantId && state.sessionToken && state.people.has(state.participantId);
  if (!knownParticipant) openJoin();
  else connect();
}

function connect(requestingName = null) {
  if (state.socket) state.socket.close();

  const tempId = state.participantId || "pending-" + Math.random().toString(36).slice(2);
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${protocol}//${location.host}/api/rooms/${encodeURIComponent(state.roomId)}/ws?participantId=${encodeURIComponent(tempId)}`;

  // Bearer credentials travel as WebSocket subprotocols rather than URL
  // query parameters: unlike the URL, they are never written to browser
  // history and never sent as a Referer.
  const protocols = [`gorgona.invite.${state.invite}`];
  if (state.participantId && state.sessionToken) {
    protocols.push(`gorgona.session.${state.sessionToken}`);
  }

  state.socket = new WebSocket(url, protocols);

  state.socket.addEventListener("open", () => {
    setOnline(true);
    if (requestingName) {
      state.socket.send(JSON.stringify({ type: "join_request", name: requestingName }));
    }
  });

  state.socket.addEventListener("close", () => setOnline(false));
  state.socket.addEventListener("error", () => setOnline(false));

  state.socket.addEventListener("message", async (event) => {
    let payload;
    try { payload = JSON.parse(event.data); } catch { return; }

    if (payload.type === "admin_join_request") {
      state.currentAdminReqId = payload.requestId;
      $("#adminReqName").textContent = payload.name;
      $("#adminRequestModal").classList.remove("hidden");
      toast(`Заявка на вход от ${payload.name}`);
      return;
    }

    if (payload.type === "join_approved") {
      $("#waitingModal").classList.add("hidden");
      toast("Администратор одобрил ваш вход!");
      await completeJoin(payload.name || state.pendingName, payload.ticket);
      return;
    }

    if (payload.type === "auto_approved") {
      $("#waitingModal").classList.add("hidden");
      await completeJoin(payload.name || state.pendingName, payload.ticket);
      return;
    }

    if (payload.type === "join_declined") {
      $("#waitingModal").classList.add("hidden");
      toast("Администратор отклонил заявку на вход.");
      return;
    }

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

    if (payload.type === "participant_joined" && payload.participant) {
      state.people.set(payload.participant.id, payload.participant);
      if (payload.adminId) state.adminId = payload.adminId;
      renderPeople();
      return;
    }

    if (payload.type === "presence") {
      if (payload.adminId) state.adminId = payload.adminId;
      if (payload.online && payload.participantId !== state.participantId) {
        const person = state.people.get(payload.participantId);
        if (person) toast(`${person.display_name} подключился`);
      }
      renderPeople();
    }

    if (payload.type === "webrtc_offer" && payload.senderId) {
      handleWebRTCOffer(payload.senderId, payload.data);
    }
    if (payload.type === "webrtc_answer" && payload.senderId) {
      handleWebRTCAnswer(payload.senderId, payload.data);
    }
    if (payload.type === "webrtc_ice_candidate" && payload.senderId) {
      handleWebRTCIce(payload.senderId, payload.data);
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

// ---- media upload (R2-backed; replaces embedding base64 in messages) ----

function canvasToBlob(canvas, type = "image/jpeg", quality = 0.78) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

async function uploadMedia(blob, contentType) {
  const response = await fetch(`/api/chats/${encodeURIComponent(state.roomId)}/media`, {
    method: "POST",
    headers: {
      "Content-Type": contentType,
      "Authorization": `Bearer ${state.sessionToken}`,
      "X-Participant-Id": state.participantId || ""
    },
    body: blob
  });
  const data = await response.json();
  if (!response.ok) throw new Error(apiErrorMessage(data, "Не удалось загрузить файл"));
  return data;
}

$("#approveJoinBtn").addEventListener("click", () => {
  if (state.currentAdminReqId && state.socket) {
    state.socket.send(JSON.stringify({ type: "approve_join", requestId: state.currentAdminReqId }));
    toast("Заявка одобрена");
  }
  $("#adminRequestModal").classList.add("hidden");
});

$("#declineJoinBtn").addEventListener("click", () => {
  if (state.currentAdminReqId && state.socket) {
    state.socket.send(JSON.stringify({ type: "decline_join", requestId: state.currentAdminReqId }));
    toast("Заявка отклонена");
  }
  $("#adminRequestModal").classList.add("hidden");
});

$("#loadOlder").addEventListener("click", loadOlderMessages);

$("#btnVideoNote").addEventListener("click", () => {
  $("#actionModal").classList.add("hidden");
  startVideoNoteViewfinder();
});

async function handleCameraError(err) {
  console.error("Camera access error:", err);
  const name = err?.name || "UnknownError";
  const msg = err?.message || String(err);

  let title = "Камера не отвечает";
  if (name === "NotAllowedError" || name === "PermissionDeniedError") {
    title = "Разрешение на камеру заблокировано браузером";
  } else if (name === "NotReadableError" || name === "TrackStartError") {
    title = "Камера используется другой программой (Zoom/Discord/Skype)";
  } else if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    title = "Веб-камера не обнаружена системой Windows";
  }

  $("#diagErrorTitle").textContent = title;
  $("#diagErrorDetail").textContent = `${name}: ${msg}`;

  let devCountText = "Проверка подключенных устройств…";
  try {
    if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoDevs = devices.filter(d => d.kind === "videoinput");
      devCountText = `Найдено видеоустройств: ${videoDevs.length}` + (videoDevs.length > 0 ? ` (${videoDevs.map(d => d.label || "Устройство без названия").join(", ")})` : " (0 вебкамер)");
    }
  } catch (e) {
    devCountText = "Не удалось перечислить устройства";
  }
  $("#diagDeviceCount").textContent = devCountText;
  $("#cameraDiagModal").classList.remove("hidden");
}

$("#closeCameraDiag").addEventListener("click", () => $("#cameraDiagModal").classList.add("hidden"));
$("#fallbackDiagFile").addEventListener("click", () => {
  $("#cameraDiagModal").classList.add("hidden");
  $("#geoInput").click();
});
$("#retryCameraBtn").addEventListener("click", () => {
  $("#cameraDiagModal").classList.add("hidden");
  startLiveCamera();
});

$("#phoneCameraBtn").addEventListener("click", async () => {
  $("#cameraDiagModal").classList.add("hidden");
  try {
    const response = await fetch(`/api/chats/${encodeURIComponent(state.roomId)}/pairing-code`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ inviteToken: state.invite })
    });
    const data = await response.json();
    if (!response.ok) return toast(apiErrorMessage(data, "Не удалось создать QR-код"));

    // The QR only ever encodes our own short-lived, single-use pairing
    // URL -- never the real invite bearer token -- so the third-party
    // rendering service never sees a working credential.
    const qrApi = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(data.url)}`;
    $("#qrCodeImg").src = qrApi;
    $("#qrModal").classList.remove("hidden");
  } catch (err) {
    toast("Не удалось создать QR-код");
  }
});

$("#closeQr").addEventListener("click", () => $("#qrModal").classList.add("hidden"));

async function getWebcamStream(audioNeeded = false, facing = "user") {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error("MediaDevices API not supported");
  }

  const attempts = [
    { video: true, audio: audioNeeded },
    { video: { facingMode: facing }, audio: audioNeeded },
    { video: true, audio: false },
    { video: { facingMode: facing }, audio: false },
    { video: { width: { ideal: 640 }, height: { ideal: 480 } }, audio: false }
  ];

  let lastErr = null;
  for (const constraints of attempts) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      if (stream) return stream;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error("Camera not accessible");
}

async function startVideoNoteViewfinder() {
  try {
    toast("Подключение камеры…");
    const stream = await getWebcamStream(true, "user");
    state.noteStream = stream;
    $("#noteVideo").srcObject = stream;
    $("#videoNoteModal").classList.remove("hidden");
    $("#startRecordNote").classList.remove("hidden");
    $("#stopRecordNote").classList.add("hidden");
  } catch (err) {
    handleCameraError(err);
  }
}

function stopVideoNoteViewfinder() {
  if (state.noteStream) {
    state.noteStream.getTracks().forEach(t => t.stop());
    state.noteStream = null;
  }
  $("#videoNoteModal").classList.add("hidden");
}

$("#closeVideoNote").addEventListener("click", stopVideoNoteViewfinder);
$("#fallbackVideoBtn").addEventListener("click", () => {
  stopVideoNoteViewfinder();
  $("#videoFileInput").click();
});

$("#videoFileInput").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;

  try {
    toast("Загрузка видео…");
    const uploaded = await uploadMedia(file, file.type || "video/mp4");
    await sendMessage(JSON.stringify({ type: "video_note", mediaPath: uploaded.mediaPath, contentType: uploaded.contentType }));
    toast("Видеокружочек отправлен!");
  } catch (err) {
    toast(err.message || "Не удалось отправить видео");
  }
  e.target.value = "";
});

$("#startRecordNote").addEventListener("click", () => {
  if (!state.noteStream) return;
  state.noteChunks = [];
  try {
    const options = MediaRecorder.isTypeSupported("video/webm;codecs=vp8,opus")
      ? { mimeType: "video/webm;codecs=vp8,opus" }
      : {};
    state.noteMediaRecorder = new MediaRecorder(state.noteStream, options);

    state.noteMediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) state.noteChunks.push(e.data);
    };

    state.noteMediaRecorder.onstop = async () => {
      const blob = new Blob(state.noteChunks, { type: "video/webm" });
      try {
        toast("Загрузка видеокружочка…");
        const uploaded = await uploadMedia(blob, "video/webm");
        await sendMessage(JSON.stringify({ type: "video_note", mediaPath: uploaded.mediaPath, contentType: uploaded.contentType }));
        toast("Видеокружочек отправлен!");
      } catch (err) {
        toast(err.message || "Не удалось отправить видеокружочек");
      } finally {
        stopVideoNoteViewfinder();
      }
    };

    state.noteMediaRecorder.start();
    toast("Запись кружочка пошла… (до 30 сек)");
    $("#startRecordNote").classList.add("hidden");
    $("#stopRecordNote").classList.remove("hidden");

    clearTimeout(state.noteTimer);
    state.noteTimer = setTimeout(() => {
      if (state.noteMediaRecorder && state.noteMediaRecorder.state === "recording") {
        state.noteMediaRecorder.stop();
      }
    }, 30000);
  } catch (err) {
    toast("Ошибка записи видеокружочка");
  }
});

$("#stopRecordNote").addEventListener("click", () => {
  clearTimeout(state.noteTimer);
  if (state.noteMediaRecorder && state.noteMediaRecorder.state === "recording") {
    state.noteMediaRecorder.stop();
  }
});

$("#startVideoCall").addEventListener("click", () => {
  startWebRTCVideoCall();
});

async function startWebRTCVideoCall() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    state.callStream = stream;
    $("#localVideo").srcObject = stream;
    $("#videoCallModal").classList.remove("hidden");
    toast("Видеочат запущен");
  } catch (err) {
    toast("Камера или микрофон недоступны для звонка");
  }
}

function leaveVideoCall() {
  if (state.callStream) {
    state.callStream.getTracks().forEach(t => t.stop());
    state.callStream = null;
  }
  state.peerConnections.forEach(pc => pc.close());
  state.peerConnections.clear();
  $("#videoCallModal").classList.add("hidden");
}

$("#closeVideoCall").addEventListener("click", leaveVideoCall);
$("#leaveCall").addEventListener("click", leaveVideoCall);

async function handleWebRTCOffer(senderId, offer) {
  const pc = createPeerConnection(senderId);
  await pc.setRemoteDescription(new RTCSessionDescription(offer));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  state.socket.send(JSON.stringify({
    type: "webrtc_answer",
    targetId: senderId,
    data: answer
  }));
}

async function handleWebRTCAnswer(senderId, answer) {
  const pc = state.peerConnections.get(senderId);
  if (pc) {
    await pc.setRemoteDescription(new RTCSessionDescription(answer));
  }
}

async function handleWebRTCIce(senderId, candidate) {
  const pc = state.peerConnections.get(senderId);
  if (pc) {
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
  }
}

function createPeerConnection(targetId) {
  const config = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };
  const pc = new RTCPeerConnection(config);

  if (state.callStream) {
    state.callStream.getTracks().forEach(track => pc.addTrack(track, state.callStream));
  }

  pc.onicecandidate = (event) => {
    if (event.candidate && state.socket) {
      state.socket.send(JSON.stringify({
        type: "webrtc_ice_candidate",
        targetId,
        data: event.candidate
      }));
    }
  };

  pc.ontrack = (event) => {
    let slot = document.getElementById(`video-slot-${targetId}`);
    if (!slot) {
      slot = document.createElement("div");
      slot.className = "video-slot";
      slot.id = `video-slot-${targetId}`;
      const video = document.createElement("video");
      video.autoplay = true;
      video.playsInline = true;
      video.srcObject = event.streams[0];
      const label = document.createElement("span");
      label.className = "video-label";
      label.textContent = "Участник звонка";
      slot.appendChild(video);
      slot.appendChild(label);
      $("#videoGrid").appendChild(slot);
    }
  };

  state.peerConnections.set(targetId, pc);
  return pc;
}

// ---- photo capture: resize, optional GPS overlay, upload -------------

function drawResizedImage(imageOrVideo, isVideo = false) {
  const canvas = document.createElement("canvas");
  const maxDim = 1000;
  let w = isVideo ? imageOrVideo.videoWidth : imageOrVideo.width;
  let h = isVideo ? imageOrVideo.videoHeight : imageOrVideo.height;

  if (!w || !h) { w = 800; h = 600; }

  if (w > maxDim || h > maxDim) {
    if (w > h) { h = Math.round((h * maxDim) / w); w = maxDim; }
    else { w = Math.round((w * maxDim) / h); h = maxDim; }
  }

  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");

  if (isVideo && state.facingMode === "user") {
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
  }

  ctx.drawImage(imageOrVideo, 0, 0, w, h);

  if (isVideo && state.facingMode === "user") {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  return canvas;
}

// Draws the GPS/time banner. `coords` is either real geolocation
// coordinates or null -- and null always means the banner says so in
// plain text. It never fabricates a location (see BUG-007 in the audit:
// this used to fall back to a hardcoded Moscow coordinate).
function drawGeoOverlay(canvas, coords) {
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  const bannerHeight = Math.max(65, Math.round(h * 0.15));

  const gradient = ctx.createLinearGradient(0, h - bannerHeight, 0, h);
  gradient.addColorStop(0, "rgba(0, 0, 0, 0)");
  gradient.addColorStop(0.3, "rgba(10, 10, 10, 0.75)");
  gradient.addColorStop(1, "rgba(10, 10, 10, 0.95)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, h - bannerHeight, w, bannerHeight);

  const now = new Date();
  const timeStr = `${now.toLocaleDateString("ru-RU")} ${now.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}`;

  ctx.fillStyle = "#ffd21a";
  ctx.font = `bold ${Math.max(14, Math.round(w * 0.03))}px Inter, sans-serif`;
  const gpsLine = coords
    ? `📍 GPS: ${Number(coords.latitude).toFixed(5)}°, ${Number(coords.longitude).toFixed(5)}° (±${Math.round(coords.accuracy)}m)`
    : "📍 GPS недоступен";
  ctx.fillText(gpsLine, 15, h - bannerHeight + 25);

  ctx.fillStyle = "#ffffff";
  ctx.font = `${Math.max(11, Math.round(w * 0.022))}px Inter, sans-serif`;
  const caption = coords ? "GORGONA CHAT VERIFIED GEO" : "GORGONA CHAT • GPS UNAVAILABLE";
  ctx.fillText(`🕒 ${timeStr}  •  ${caption}`, 15, h - bannerHeight + 48);

  return {
    lat: coords ? coords.latitude : null,
    lon: coords ? coords.longitude : null,
    timeStr
  };
}

function fetchGPS() {
  return new Promise((resolve) => {
    if (!("geolocation" in navigator)) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve(pos.coords),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 5000 }
    );
  });
}

async function startLiveCamera() {
  stopLiveCamera();
  toast("Включение вебкамеры…");

  try {
    const stream = await getWebcamStream(false, state.facingMode);
    state.cameraStream = stream;
    const video = $("#cameraVideo");
    video.srcObject = stream;
    $("#cameraModal").classList.remove("hidden");
  } catch (err) {
    handleCameraError(err);
    return;
  }

  const overlay = $("#cameraGeoOverlay");
  overlay.textContent = "📍 Определение GPS…";
  fetchGPS().then((coords) => {
    state.currentCoords = coords;
    overlay.textContent = coords
      ? `📍 GPS: ${coords.latitude.toFixed(5)}°, ${coords.longitude.toFixed(5)}°`
      : "📍 GPS недоступен";
  });
}

function stopLiveCamera() {
  if (state.cameraStream) {
    state.cameraStream.getTracks().forEach((track) => track.stop());
    state.cameraStream = null;
  }
  $("#cameraModal").classList.add("hidden");
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
$("#closeCamera").addEventListener("click", stopLiveCamera);
$("#cancelGeoSend").addEventListener("click", () => {
  $("#previewModal").classList.add("hidden");
  state.pendingGeoBlob = null;
  state.pendingGeoMeta = null;
});

$("#btnLiveCamera").addEventListener("click", () => {
  $("#actionModal").classList.add("hidden");
  startLiveCamera();
});

$("#switchCamera").addEventListener("click", () => {
  state.facingMode = state.facingMode === "user" ? "environment" : "user";
  startLiveCamera();
});

function showGeoPreview(canvas, lat, lon, timeStr) {
  $("#geoPreviewImg").src = canvas.toDataURL("image/jpeg", 0.6);
  $("#geoPreviewInfo").textContent = lat != null && lon != null
    ? `📍 Координаты: ${lat.toFixed(5)}°, ${lon.toFixed(5)}° | ${timeStr}`
    : `📍 GPS недоступен | ${timeStr}`;
  $("#previewModal").classList.remove("hidden");
}

$("#takeSnapshot").addEventListener("click", async () => {
  const video = $("#cameraVideo");
  const canvas = drawResizedImage(video, true);
  const { lat, lon, timeStr } = drawGeoOverlay(canvas, state.currentCoords);
  stopLiveCamera();

  state.pendingGeoBlob = await canvasToBlob(canvas);
  state.pendingGeoMeta = { type: "geo_photo", lat, lon, timestamp: timeStr };
  showGeoPreview(canvas, lat, lon, timeStr);
});

$("#btnGeoPhoto").addEventListener("click", async () => {
  $("#actionModal").classList.add("hidden");
  toast("Запрос геолокации...");
  state.currentCoords = await fetchGPS();
  $("#geoInput").click();
});

$("#btnStandardPhoto").addEventListener("click", () => {
  $("#actionModal").classList.add("hidden");
  $("#standardInput").click();
});

$("#geoInput").addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (evt) => {
    const img = new Image();
    img.onload = async () => {
      const canvas = drawResizedImage(img, false);
      const { lat, lon, timeStr } = drawGeoOverlay(canvas, state.currentCoords);
      state.pendingGeoBlob = await canvasToBlob(canvas);
      state.pendingGeoMeta = { type: "geo_photo", lat, lon, timestamp: timeStr };
      showGeoPreview(canvas, lat, lon, timeStr);
    };
    img.src = evt.target.result;
  };
  reader.readAsDataURL(file);
  e.target.value = "";
});

$("#standardInput").addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (evt) => {
    const img = new Image();
    img.onload = async () => {
      // No GPS overlay at all for this option -- only resized, exactly
      // what "photo without a coordinate stamp" should mean. (The
      // previous implementation stamped a fake Moscow GPS banner onto
      // this path too; see BUG-007 in the audit.)
      const canvas = drawResizedImage(img, false);
      try {
        const blob = await canvasToBlob(canvas);
        const uploaded = await uploadMedia(blob, "image/jpeg");
        await sendMessage(JSON.stringify({ type: "standard_photo", mediaPath: uploaded.mediaPath, contentType: uploaded.contentType }));
        toast("Фотография отправлена");
      } catch (err) {
        toast(err.message || "Не удалось отправить фото");
      }
    };
    img.src = evt.target.result;
  };
  reader.readAsDataURL(file);
  e.target.value = "";
});

$("#sendGeoPhoto").addEventListener("click", async () => {
  if (!state.pendingGeoBlob || !state.pendingGeoMeta) return;
  $("#previewModal").classList.add("hidden");

  try {
    const uploaded = await uploadMedia(state.pendingGeoBlob, "image/jpeg");
    const payload = { ...state.pendingGeoMeta, mediaPath: uploaded.mediaPath, contentType: uploaded.contentType };
    await sendMessage(JSON.stringify(payload));
    toast("Фото с геолокацией отправлено!");
  } catch (err) {
    toast(err.message || "Не удалось отправить фото");
  }
  state.pendingGeoBlob = null;
  state.pendingGeoMeta = null;
});

$("#composer").addEventListener("submit", (event) => {
  event.preventDefault();
  sendMessage();
});

$("#messageInput").addEventListener("input", () => {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) return;
  if (!state.isTyping) {
    state.isTyping = true;
    state.socket.send(JSON.stringify({ type: "typing", typing: true }));
  }
  clearTimeout(state.typingTimer);
  state.typingTimer = setTimeout(() => {
    state.isTyping = false;
    if (state.socket?.readyState === WebSocket.OPEN) {
      state.socket.send(JSON.stringify({ type: "typing", typing: false }));
    }
  }, 850);
});

if (state.roomId) loadRoom();
else setOnline(false);
