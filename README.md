# GPT-Live POC

A minimal proof-of-concept for OpenAI's [GPT-Live](https://developers.openai.com/api/docs/guides/live) API: a browser client talks to `gpt-live-1` over WebRTC for real-time voice conversation, with an optional backend model (`gpt-5.6-luna`) handling delegated reasoning/tool use.

## Requirements

- Python 3.12+
- An OpenAI API key with access to the GPT-Live API (`gpt-live-1`)
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
server.py           FastAPI backend: serves the UI and brokers session creation
static/
  index.html         UI: voice/instructions controls, transcript, connect/disconnect
  app.js             Browser client: WebRTC peer connection, mic capture, event handling
.env.example         Template for required environment variables
requirements.txt      Python dependencies
```

### How it works

1. The browser (`static/app.js`) captures the microphone, creates an `RTCPeerConnection`, and builds an SDP offer.
2. The offer is POSTed to `/api/session` on the FastAPI backend (`server.py`), which holds the OpenAI API key.
3. The backend calls `client.live.create()` to start a GPT-Live session, forwarding the offer and getting back an SDP answer.
4. The browser applies the answer, audio starts flowing directly between the browser and OpenAI over WebRTC, and a `oai-events` data channel streams transcript/session events back to the UI.
5. Clicking **Disconnect** sends `session.close` over the data channel and tears down the peer connection and mic track.

The backend never proxies audio itself — it only brokers the WebRTC handshake, so the API key stays server-side while media flows peer-to-peer.

## Tech Stack

- **Backend:** Python, FastAPI, Uvicorn, `openai` SDK
- **Frontend:** Vanilla JavaScript, WebRTC (`RTCPeerConnection`), no build step

## Notes

- This is a local demo, not hardened for production: `/api/session` restricts requests to same-origin (`http://127.0.0.1:8000` / `http://localhost:8000`) but has no auth of its own beyond the server-held API key.
- The delegated backend model name (`gpt-5.6-luna`) and default instructions in `server.py` are illustrative — adjust to your account's available models.
