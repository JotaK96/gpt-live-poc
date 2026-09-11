const voiceSelect = document.getElementById("voice");
const instructionsBox = document.getElementById("instructions");
const connectBtn = document.getElementById("connect");
const disconnectBtn = document.getElementById("disconnect");
const statusEl = document.getElementById("status");
const transcriptEl = document.getElementById("transcript");
const remoteAudio = document.getElementById("remoteAudio");

document.querySelectorAll(".langs button").forEach((btn) => {
  btn.addEventListener("click", () => {
    instructionsBox.value = btn.dataset.lang;
  });
});

let peer = null;
let events = null;
let micStream = null;

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
  instructionsBox.disabled = connected;
}

async function connect() {
  setStatus("Requesting mic...");
  setConnectedUI(true);
  lastSpeaker = null;

  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    setStatus(`Mic permission denied: ${err.message}`);
    setConnectedUI(false);
    return;
  }

  peer = new RTCPeerConnection();
  events = peer.createDataChannel("oai-events");

  for (const track of micStream.getAudioTracks()) {
    peer.addTrack(track, micStream);
  }

  peer.addEventListener("track", (event) => {
    remoteAudio.srcObject = new MediaStream([event.track]);
  });

  events.addEventListener("message", ({ data }) => {
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

  setStatus("Negotiating connection...");

  try {
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);

    if (peer.iceGatheringState !== "complete") {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          peer.removeEventListener("icegatheringstatechange", onState);
          reject(new Error("Timed out while gathering ICE candidates"));
        }, 10_000);
        function onState() {
          if (peer.iceGatheringState !== "complete") return;
          clearTimeout(timeout);
          peer.removeEventListener("icegatheringstatechange", onState);
          resolve();
        }
        peer.addEventListener("icegatheringstatechange", onState);
      });
    }
  } catch (err) {
    setStatus(`Connection negotiation failed: ${err.message}`);
    disconnect();
    return;
  }

  try {
    const response = await fetch("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sdp: peer.localDescription.sdp,
        voice: voiceSelect.value,
        instructions: instructionsBox.value,
      }),
    });

    if (!response.ok) {
      const errBody = await response.json().catch(() => ({}));
      throw new Error(errBody.detail || `HTTP ${response.status}`);
    }

    const result = await response.json();
    await peer.setRemoteDescription({
      type: "answer",
      sdp: result.transport.sdp,
    });
  } catch (err) {
    setStatus(`Session creation failed: ${err.message}`);
    disconnect();
  }
}

function disconnect() {
  if (events?.readyState === "open") {
    try {
      events.send(JSON.stringify({ type: "session.close" }));
    } catch {
      // ignore, we're tearing down anyway
    }
  }
  if (micStream) {
    micStream.getTracks().forEach((t) => t.stop());
    micStream = null;
  }
  if (peer) {
    peer.close();
    peer = null;
  }
  events = null;
  setConnectedUI(false);
  setStatus("Disconnected");
}

connectBtn.addEventListener("click", connect);
disconnectBtn.addEventListener("click", disconnect);
