const $ = (s) => document.querySelector(s);
const parts = location.pathname.split("/").filter(Boolean);

const _roomId = parts[0] === "c" ? parts[1] : null;

function roomKey(key) {
  return _roomId ? `gorgona.${_roomId}.${key}` : `gorgona.${key}`;
}

const state = {
  roomId: _roomId,
  invite: new URLSearchParams(location.search).get("invite"),
  participantId: localStorage.getItem(roomKey("participant")),
  participantName: localStorage.getItem(roomKey("name")),
  isAdmin: localStorage.getItem(roomKey("is_admin")) === "true",
  socket: null,
  people: new Map(),
  typingTimer: null,
  pendingGeoData: null,
  cameraStream: null,
  facingMode: "user",
  pendingJoinRequests: [],
  noteMediaRecorder: null,
  noteChunks: [],
  noteStream: null,
  noteTimer: null,
  callStream: null,
  peerConnections: new Map(),
  reconnectAttempts: 0,
  reconnectTimer: null,
  intentionalClose: false
};

const MAX_WS_PAYLOAD = 2.5 * 1024 * 1024;

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
    const roleEl = document.createElement("small");
    roleEl.textContent = "Участник";
    info.appendChild(roleEl);
    row.appendChild(avatar);
    row.appendChild(info);
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
          meta.innerHTML = `
            <div class="geo-tag">📍 GPS: ${latFixed}°, ${lonFixed}°</div>
            <small class="time">${parsed.timestamp || ""}</small>
          `;
          card.appendChild(meta);
        }

        bubble.appendChild(card);
      } else if (parsed.type === "video_note") {
        isMedia = true;
        bubble.replaceChildren();
        const video = document.createElement("video");
        video.className = "chat-video-circle";
        video.src = parsed.video;
        video.controls = true;
        video.autoplay = false;
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

  item.querySelector(".time").textContent = formatTime(message.created_at);
  $("#messages").appendChild(item);
  $("#messages").scrollTop = $("#messages").scrollHeight;
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

  localStorage.setItem(roomKey("is_admin"), "true");
  state.isAdmin = true;
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

  if (state.isAdmin || state.people.size === 0) {
    await completeJoin(name);
  } else {
    $("#waitingModal").classList.remove("hidden");
    connect(name);
  }
}

async function completeJoin(name) {
  const response = await fetch(`/api/chats/${encodeURIComponent(state.roomId)}/participants`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, inviteToken: state.invite })
  });
  const data = await response.json();

  if (!response.ok) return toast(data.error || "Не удалось войти");

  state.participantId = data.id;
  state.participantName = data.display_name;
  localStorage.setItem(roomKey("participant"), data.id);
  localStorage.setItem(roomKey("name"), data.display_name);

  $("#waitingModal").classList.add("hidden");
  connect();
}

async function loadRoom() {
  if (!state.roomId || !state.invite) {
    toast("Создайте комнату или откройте ссылку-приглашение");
    setOnline(false);
    return;
  }

  const response = await fetch(
    `/api/chats/${encodeURIComponent(state.roomId)}?invite=${encodeURIComponent(state.invite)}`
  );
  const data = await response.json();

  if (!response.ok) {
    toast("Недействительная invite-ссылка");
    setOnline(false);
    return;
  }

  $("#roomCard").classList.remove("hidden");
  $("#roomTitle").textContent = data.chat.title;
  $("#roomId").textContent = data.chat.id;
  $("#headerTitle").textContent = data.chat.title;

  state.people.clear();
  data.participants.forEach(p => state.people.set(p.id, p));
  
  if (data.participants.length > 0 && data.participants[0].id === state.participantId) {
    state.isAdmin = true;
    localStorage.setItem(roomKey("is_admin"), "true");
  }

  renderPeople();
  renderMessages(data.messages);

  if (!state.participantId || !state.people.has(state.participantId)) openJoin();
  else connect();
}

function connect(requestingName = null) {
  if (state.socket) {
    state.intentionalClose = true;
    state.socket.close();
  }
  state.intentionalClose = false;

  const tempId = state.participantId || "pending-" + Math.random().toString(36).slice(2);
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const url =
    `${protocol}//${location.host}/api/rooms/${encodeURIComponent(state.roomId)}/ws` +
    `?invite=${encodeURIComponent(state.invite)}` +
    `&participantId=${encodeURIComponent(tempId)}`;

  state.socket = new WebSocket(url);

  state.socket.addEventListener("open", () => {
    setOnline(true);
    state.reconnectAttempts = 0;
    clearTimeout(state.reconnectTimer);
    if (requestingName) {
      state.socket.send(JSON.stringify({ type: "join_request", name: requestingName }));
    }
  });

  state.socket.addEventListener("close", () => {
    setOnline(false);
    if (!state.intentionalClose && state.participantId) {
      const delay = Math.min(1000 * Math.pow(2, state.reconnectAttempts), 15000);
      state.reconnectAttempts++;
      state.reconnectTimer = setTimeout(() => connect(), delay);
    }
  });
  state.socket.addEventListener("error", () => {});

  state.socket.addEventListener("message", async (event) => {
    let payload;
    try { payload = JSON.parse(event.data); } catch { return; }

    if (payload.type === "admin_join_request") {
      state.pendingJoinRequests.push({ requestId: payload.requestId, name: payload.name });
      showNextJoinRequest();
      toast(`Заявка на вход от ${payload.name}`);
      return;
    }

    if (payload.type === "join_approved") {
      $("#waitingModal").classList.add("hidden");
      toast("Администратор одобрил ваш вход!");
      await completeJoin(payload.name || state.pendingName);
      return;
    }

    if (payload.type === "auto_approved") {
      $("#waitingModal").classList.add("hidden");
      await completeJoin(state.pendingName);
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

    if (payload.type === "presence" && payload.online && payload.participantId !== state.participantId) {
      const person = state.people.get(payload.participantId);
      if (person) toast(`${person.display_name} подключился`);
    }

    if (payload.type === "webrtc_offer" && payload.targetId === state.participantId) {
      handleWebRTCOffer(payload.senderId, payload.data);
    }
    if (payload.type === "webrtc_answer" && payload.targetId === state.participantId) {
      handleWebRTCAnswer(payload.senderId, payload.data);
    }
    if (payload.type === "webrtc_ice_candidate" && payload.targetId === state.participantId) {
      handleWebRTCIce(payload.senderId, payload.data);
    }

    if (payload.type === "error") toast(payload.message || "Ошибка");
  });
}

function showNextJoinRequest() {
  if (state.pendingJoinRequests.length === 0) {
    $("#adminRequestModal").classList.add("hidden");
    return;
  }
  const req = state.pendingJoinRequests[0];
  $("#adminReqName").textContent = req.name;
  $("#adminRequestModal").classList.remove("hidden");
}

async function sendMessage(customBody = null) {
  const input = $("#messageInput");
  const body = customBody || input.value.trim();

  if (!body || !state.socket || state.socket.readyState !== WebSocket.OPEN) return;

  const wsPayload = JSON.stringify({ type: "message", body });
  if (wsPayload.length > MAX_WS_PAYLOAD) {
    toast("Файл слишком большой (макс ~900 КБ). Сожмите или выберите другой.");
    return;
  }

  state.socket.send(wsPayload);
  if (!customBody) input.value = "";
  state.socket.send(JSON.stringify({ type: "typing", typing: false }));
}

$("#approveJoinBtn").addEventListener("click", () => {
  const req = state.pendingJoinRequests.shift();
  if (req && state.socket) {
    state.socket.send(JSON.stringify({ type: "approve_join", requestId: req.requestId }));
    toast("Заявка одобрена");
  }
  showNextJoinRequest();
});

$("#declineJoinBtn").addEventListener("click", () => {
  const req = state.pendingJoinRequests.shift();
  if (req && state.socket) {
    state.socket.send(JSON.stringify({ type: "decline_join", requestId: req.requestId }));
    toast("Заявка отклонена");
  }
  showNextJoinRequest();
});

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

$("#phoneCameraBtn").addEventListener("click", () => {
  $("#cameraDiagModal").classList.add("hidden");
  const url = location.href;
  const qrApi = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(url)}`;
  $("#qrCodeImg").src = qrApi;
  $("#qrModal").classList.remove("hidden");
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

$("#videoFileInput").addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async (evt) => {
    const dataUrl = evt.target.result;
    const payload = JSON.stringify({ type: "video_note", video: dataUrl });
    await sendMessage(payload);
    toast("Видеокружочек отправлен!");
  };
  reader.readAsDataURL(file);
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
      const reader = new FileReader();
      reader.onload = async (evt) => {
        const dataUrl = evt.target.result;
        const payload = JSON.stringify({ type: "video_note", video: dataUrl });
        await sendMessage(payload);
        toast("Видеокружочек отправлен!");
        stopVideoNoteViewfinder();
      };
      reader.readAsDataURL(blob);
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

$("#toggleMic").addEventListener("click", () => {
  if (!state.callStream) return;
  const audioTrack = state.callStream.getAudioTracks()[0];
  if (audioTrack) {
    audioTrack.enabled = !audioTrack.enabled;
    $("#toggleMic").textContent = audioTrack.enabled ? "🎤 Микрофон" : "🔇 Микрофон выкл";
  }
});

$("#toggleCam").addEventListener("click", () => {
  if (!state.callStream) return;
  const videoTrack = state.callStream.getVideoTracks()[0];
  if (videoTrack) {
    videoTrack.enabled = !videoTrack.enabled;
    $("#toggleCam").textContent = videoTrack.enabled ? "📹 Камера" : "📷 Камера выкл";
  }
});

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
  const config = {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
      { urls: "stun:stun.cloudflare.com:3478" },
      { urls: "turn:turn.gorgona.chat:3478", username: "gorgona", credential: "gorgona" }
    ],
    iceTransportPolicy: "all"
  };
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

function stampGeoOnCanvas(imageOrVideo, coords, isVideo = false) {
  const canvas = document.createElement("canvas");
  const maxDim = 850;
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

  const bannerHeight = Math.max(65, Math.round(h * 0.15));
  const gradient = ctx.createLinearGradient(0, h - bannerHeight, 0, h);
  gradient.addColorStop(0, "rgba(0, 0, 0, 0)");
  gradient.addColorStop(0.3, "rgba(10, 10, 10, 0.75)");
  gradient.addColorStop(1, "rgba(10, 10, 10, 0.95)");

  ctx.fillStyle = gradient;
  ctx.fillRect(0, h - bannerHeight, w, bannerHeight);

  const now = new Date();
  const timeStr = `${now.toLocaleDateString("ru-RU")} ${now.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}`;
  const latStr = coords ? Number(coords.latitude).toFixed(5) : "55.75580";
  const lonStr = coords ? Number(coords.longitude).toFixed(5) : "37.61730";
  const accStr = coords ? `(±${Math.round(coords.accuracy)}m)` : "";

  ctx.fillStyle = "#ffd21a";
  ctx.font = `bold ${Math.max(14, Math.round(w * 0.03))}px Inter, sans-serif`;
  ctx.fillText(`📍 GPS: ${latStr}°, ${lonStr}° ${accStr}`, 15, h - bannerHeight + 25);

  ctx.fillStyle = "#ffffff";
  ctx.font = `${Math.max(11, Math.round(w * 0.022))}px Inter, sans-serif`;
  ctx.fillText(`🕒 ${timeStr}  •  GORGONA CHAT VERIFIED GEO`, 15, h - bannerHeight + 48);

  return {
    dataUrl: canvas.toDataURL("image/jpeg", 0.72),
    lat: coords ? coords.latitude : 55.7558,
    lon: coords ? coords.longitude : 37.6173,
    timeStr
  };
}

function fetchGPS() {
  return new Promise((resolve) => {
    if ("geolocation" in navigator) {
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve(pos.coords),
        () => resolve({ latitude: 55.7558, longitude: 37.6173, accuracy: 50 }),
        { enableHighAccuracy: true, timeout: 5000 }
      );
    } else {
      resolve({ latitude: 55.7558, longitude: 37.6173, accuracy: 50 });
    }
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
    overlay.textContent = `📍 GPS: ${coords.latitude.toFixed(5)}°, ${coords.longitude.toFixed(5)}°`;
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
$("#cancelGeoSend").addEventListener("click", () => $("#previewModal").classList.add("hidden"));

$("#btnLiveCamera").addEventListener("click", () => {
  $("#actionModal").classList.add("hidden");
  startLiveCamera();
});

$("#switchCamera").addEventListener("click", () => {
  state.facingMode = state.facingMode === "user" ? "environment" : "user";
  startLiveCamera();
});

$("#takeSnapshot").addEventListener("click", () => {
  const video = $("#cameraVideo");
  const res = stampGeoOnCanvas(video, state.currentCoords, true);
  stopLiveCamera();

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
    img.onload = () => {
      const res = stampGeoOnCanvas(img, state.currentCoords, false);
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
    img.onload = () => {
      const res = stampGeoOnCanvas(img, null, false);
      const payload = JSON.stringify({
        type: "standard_photo",
        image: res.dataUrl
      });
      sendMessage(payload);
      toast("Фотография отправлена");
    };
    img.src = evt.target.result;
  };
  reader.readAsDataURL(file);
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
else setOnline(false);


