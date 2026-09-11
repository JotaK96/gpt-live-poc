# GPT-Live POC

A minimal proof-of-concept for OpenAI's [GPT-Live](https://developers.openai.com/api/docs/guides/live) API: a browser client talks to `gpt-live-1` over a WebSocket for real-time voice conversation, with an optional backend model (`gpt-5.6-luna`) handling delegated reasoning/tool use.

## Requirements

- Python 3.12+
- An OpenAI API key with access to the GPT-Live API (`gpt-live-1`) and available credits
- A browser with microphone access (served over `http://localhost` or HTTPS)

## Getting Started

### Installation

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### Configuration

Copy the example env file and add your key:

```bash
cp .env.example .env
```

```
OPENAI_API_KEY=sk-...
```

### Running the project

```bash
uvicorn server:app --reload
```

Open [http://127.0.0.1:8000](http://127.0.0.1:8000), pick a voice and instructions (or one of the language presets), and click **Connect**. Grant microphone access when prompted.

## Project Structure

```
server.py           FastAPI backend: serves the UI, relays the Live WebSocket session
static/
  index.html         UI: voice/instructions controls, transcript, connect/disconnect
  app.js             Browser client: mic capture/playback (Web Audio API), WebSocket relay, event handling
.env.example         Template for required environment variables
requirements.txt      Python dependencies
```

### How it works

1. The browser (`static/app.js`) captures the microphone via `getUserMedia`, and a `ScriptProcessorNode` on a 24kHz `AudioContext` converts each chunk to base64-encoded PCM16.
2. The browser opens a WebSocket to `/ws/session` on the FastAPI backend (`server.py`) and sends the chosen voice/instructions as its first message.
3. The backend opens its own WebSocket to OpenAI (`async_client.live.connect()`), holding the API key server-side, and sends `session.start` with the model, audio format, and delegation config.
4. From there the backend purely relays: browser audio-append events go straight to OpenAI (`conn.send_raw`), and every event OpenAI sends back (transcripts, audio deltas, usage, errors) is forwarded to the browser unchanged.
5. The browser decodes incoming `session.output_audio.delta` chunks back to PCM16 and schedules them for gapless playback via `AudioBufferSourceNode`.
6. Clicking **Disconnect** sends `session.close` over the WebSocket and tears down the mic, audio context, and socket.

Audio now flows browser → server → OpenAI instead of directly browser ↔ OpenAI. This trades a bit of relay overhead for a single TCP connection instead of a WebRTC/UDP path — meaningfully more stable on networks where NAT/firewall UDP timeouts (WiFi roaming, VPNs, laptop sleep/wake) were silently killing the connection.

> An earlier WebRTC-based version of this POC (`RTCPeerConnection` + SDP offer/answer via `POST /api/session`) was replaced after repeated unexplained mid-conversation drops traced to ICE/UDP connectivity loss with no recovery path. The WebSocket approach fixed this.

## Tech Stack

- **Backend:** Python, FastAPI, Uvicorn, `openai` SDK (`AsyncOpenAI().live.connect()`)
- **Frontend:** Vanilla JavaScript, WebSocket, Web Audio API (`AudioContext`, `ScriptProcessorNode`), no build step

## Notes

- This is a local demo, not hardened for production: `/ws/session` and `/api/session` restrict requests to same-origin (`http://127.0.0.1:8000` / `http://localhost:8000`) but there's no auth of its own beyond the server-held API key.
- The delegated backend model name (`gpt-5.6-luna`) and default instructions in `server.py` are illustrative — adjust to your account's available models.
- `ScriptProcessorNode` is deprecated in favor of `AudioWorklet` but was kept for simplicity in this POC; works in all current browsers.
- A GPT-Live session with no credits on the API key fails with a generic error (`Internal Server Error` over WebRTC, `output_creation_failed` over WebSocket) rather than a clear billing error — check account credits first if session creation fails outright.
