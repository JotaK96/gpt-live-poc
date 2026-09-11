const voiceSelect = document.getElementById("voice");
const toneSelect = document.getElementById("tone");
const styleSelect = document.getElementById("style");
const instructionsBox = document.getElementById("instructions");
const connectBtn = document.getElementById("connect");
const disconnectBtn = document.getElementById("disconnect");
const statusEl = document.getElementById("status");
const transcriptEl = document.getElementById("transcript");

document.querySelectorAll(".langs button").forEach((btn) => {
  btn.addEventListener("click", () => {
    instructionsBox.value = btn.dataset.lang;
  });
});

const SAMPLE_RATE = 24000;

let ws = null;
let audioCtx = null;
let micStream = null;
let micSource = null;
let micProcessor = null;
let nextPlayTime = 0;
let closing = false;

function setStatus(text) {
  statusEl.textContent = text;
}

function appendTranscript(label, text, cls) {
  const line = document.createElement("div");
  line.className = cls;
  line.textContent = `${label}: ${text}`;
  transcriptEl.appendChild(line);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

// Deltas stream in piecemeal; keep growing the last line per speaker instead
// of adding a new line per delta.
let lastSpeaker = null;
function appendDelta(label, delta, cls) {
  if (lastSpeaker === label && transcriptEl.lastChild) {
    transcriptEl.lastChild.textContent += delta;
  } else {
    appendTranscript(label, delta, cls);
    lastSpeaker = label;
  }
}

function setConnectedUI(connected) {
  connectBtn.disabled = connected;
  disconnectBtn.disabled = !connected;
  voiceSelect.disabled = connected;
  toneSelect.disabled = connected;
  styleSelect.disabled = connected;
  instructionsBox.disabled = connected;
}

function buildInstructions() {
  const styleLine = `Speak in a ${toneSelect.value} tone with a ${styleSelect.value} style.`;
  const base = instructionsBox.value.trim();
  return base ? `${styleLine} ${base}` : styleLine;
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function playPcm16Base64(b64) {
  const bytes = base64ToBytes(b64);
  const samples = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.length / 2);
  const float32 = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) float32[i] = samples[i] / 32768;

  const buffer = audioCtx.createBuffer(1, float32.length, SAMPLE_RATE);
  buffer.copyToChannel(float32, 0);

  const source = audioCtx.createBufferSource();
  source.buffer = buffer;
  source.connect(audioCtx.destination);

  const startAt = Math.max(nextPlayTime, audioCtx.currentTime);
  source.start(startAt);
  nextPlayTime = startAt + buffer.duration;
}

function encodePcm16Base64(float32Array) {
  const int16 = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return bytesToBase64(new Uint8Array(int16.buffer));
}

async function connect() {
  setStatus("Requesting mic...");
  setConnectedUI(true);
  lastSpeaker = null;
  nextPlayTime = 0;
  closing = false;

  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    setStatus(`Mic permission denied: ${err.message}`);
    setConnectedUI(false);
    return;
  }

  audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
  micSource = audioCtx.createMediaStreamSource(micStream);
  // ScriptProcessorNode is deprecated but simplest for a POC; needs to be
  // connected to a destination to be pulled, so route through a silent gain
  // node to avoid echoing the mic back out of the speakers.
  micProcessor = audioCtx.createScriptProcessor(4096, 1, 1);
  const silentGain = audioCtx.createGain();
  silentGain.gain.value = 0;
  micSource.connect(micProcessor);
  micProcessor.connect(silentGain);
  silentGain.connect(audioCtx.destination);

  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${protocol}//${location.host}/ws/session`);

  micProcessor.onaudioprocess = (e) => {
    if (ws?.readyState !== WebSocket.OPEN) return;
    const input = e.inputBuffer.getChannelData(0);
    const audio = encodePcm16Base64(input);
    ws.send(JSON.stringify({ type: "session.input_audio.append", audio }));
  };

  ws.addEventListener("open", () => {
    setStatus("Negotiating connection...");
    ws.send(
      JSON.stringify({
        voice: voiceSelect.value,
        instructions: buildInstructions(),
      })
    );
  });

  ws.addEventListener("close", () => {
    if (!closing) setStatus("Connection lost — reconnect to continue");
    teardown();
  });

  ws.addEventListener("error", () => {
    console.log("websocket error");
  });

  ws.addEventListener("message", ({ data }) => {
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      return;
    }

    switch (event.type) {
      case "session.started":
        setStatus("Connected — speak now");
        break;
      case "session.input_transcript.delta":
        appendDelta("You", event.delta, "you");
        break;
      case "session.output_transcript.delta":
        appendDelta("Assistant", event.delta, "assistant");
        break;
      case "session.output_audio.delta":
        playPcm16Base64(event.delta);
        break;
      case "session.closed":
        setStatus(`Closed (usage: ${JSON.stringify(event.usage)})`);
        break;
      case "error":
        appendTranscript("Error", JSON.stringify(event), "err");
        setStatus("Error — see transcript");
        break;
      default:
        console.log("event", event);
    }
  });
}

function teardown() {
  if (micProcessor) {
    micProcessor.onaudioprocess = null;
    micProcessor.disconnect();
    micProcessor = null;
  }
  if (micSource) {
    micSource.disconnect();
    micSource = null;
  }
  if (audioCtx) {
    audioCtx.close();
    audioCtx = null;
  }
  if (micStream) {
    micStream.getTracks().forEach((t) => t.stop());
    micStream = null;
  }
  ws = null;
  setConnectedUI(false);
}

function disconnect() {
  closing = true;
  if (ws?.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ type: "session.close" }));
    } catch {
      // ignore, we're tearing down anyway
    }
  }
  if (ws) ws.close();
  teardown();
  setStatus("Disconnected");
}

connectBtn.addEventListener("click", connect);
disconnectBtn.addEventListener("click", disconnect);
