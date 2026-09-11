import asyncio
import json
import logging
import os

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from openai import APIError, AsyncOpenAI, OpenAI

load_dotenv()

log = logging.getLogger("uvicorn.error")

api_key = os.environ.get("OPENAI_API_KEY")
if not api_key:
    raise RuntimeError("Set OPENAI_API_KEY in .env (copy .env.example)")

# Origins allowed to POST to /api/session. Requests are same-origin in normal
# use (the browser loads this same app); this exists to stop other pages
# open in the same browser from silently creating billed sessions here.
ALLOWED_ORIGINS = {"http://127.0.0.1:8000", "http://localhost:8000"}

client = OpenAI(api_key=api_key)
async_client = AsyncOpenAI(api_key=api_key)

app = FastAPI()
app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/")
def index():
    return FileResponse("static/index.html")


def _create_session(sdp: str, voice: str, instructions: str):
    session = {
        "model": "gpt-live-1",
        "instructions": instructions,
        "audio": {"output": {"voice": voice}},
        "delegation": {
            "type": "responses",
            "responses": {
                "model": "gpt-5.6-luna",
                "instructions": instructions,
            },
        },
    }
    return client.live.create(
        session=session,
        transport={"type": "webrtc", "sdp": sdp},
    )


@app.post("/api/session")
async def create_session(request: Request):
    origin = request.headers.get("origin")
    if origin is not None and origin not in ALLOWED_ORIGINS:
        raise HTTPException(status_code=403, detail="Unexpected request origin")

    body = await request.json()
    sdp = body.get("sdp")
    voice = body.get("voice", "marin")
    # Keep this default in sync with the textarea default in static/index.html.
    instructions = body.get("instructions", "Be concise and friendly.")

    if not sdp or not isinstance(sdp, str):
        raise HTTPException(status_code=400, detail="An SDP offer is required")

    try:
        result = _create_session(sdp, voice, instructions)
    except APIError as exc:
        log.exception("Live session creation failed")
        raise HTTPException(
            status_code=getattr(exc, "status_code", None) or 502,
            detail="Live session creation failed",
        )

    if hasattr(result, "model_dump"):
        return result.model_dump()
    return result


def _session_config(voice: str, instructions: str):
    return {
        "model": "gpt-live-1",
        "instructions": instructions,
        "audio": {
            "format": {"type": "audio/pcm", "rate": 24000},
            "output": {"voice": voice},
        },
        "delegation": {
            "type": "responses",
            "responses": {
                "model": "gpt-5.6-luna",
                "instructions": instructions,
            },
        },
    }


@app.websocket("/ws/session")
async def ws_session(websocket: WebSocket):
    origin = websocket.headers.get("origin")
    if origin is not None and origin not in ALLOWED_ORIGINS:
        await websocket.close(code=4403)
        return

    await websocket.accept()

    try:
        config_raw = await websocket.receive_text()
        config = json.loads(config_raw)
    except (WebSocketDisconnect, json.JSONDecodeError):
        return

    voice = config.get("voice", "marin")
    instructions = config.get("instructions", "Be concise and friendly.")

    try:
        async with async_client.live.connect() as conn:
            await conn.session.start(session=_session_config(voice, instructions))

            async def from_browser():
                while True:
                    data = await websocket.receive_text()
                    await conn.send_raw(data)

            async def from_openai():
                async for event in conn:
                    await websocket.send_text(event.model_dump_json(by_alias=True))

            forward_in = asyncio.create_task(from_browser())
            forward_out = asyncio.create_task(from_openai())
            try:
                await asyncio.wait(
                    {forward_in, forward_out}, return_when=asyncio.FIRST_COMPLETED
                )
            finally:
                forward_in.cancel()
                forward_out.cancel()
    except WebSocketDisconnect:
        pass
    except APIError:
        log.exception("Live WS session failed")
    finally:
        try:
            await websocket.close()
        except RuntimeError:
            pass
