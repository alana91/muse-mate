# MuseMate

MuseMate is a realtime AI museum docent. A visitor selects an exhibit and
language, receives an exhibit-specific greeting, and can ask the docent
questions by chat and voice.

This repository is a take-home challenge for evolving the legacy v1 system
into an authenticated, multilingual v2 while preserving existing v1 clients.

## Run

```bash
docker compose up --build
```

- v1 demo: <http://localhost:8080>
- v2 service and health check: <http://localhost:3000/health>
- Mock upstream and call statistics: <http://localhost:9000/stats>

No local dependency installation or environment file is required for the
default development setup. Configuration is supplied through Compose.

## v2 endpoints

- `POST /api/v2/tickets` issues a short-lived development ticket.
- `GET /api/v2/greeting?exhibit_id=<id>&lang=<lang>` returns greeting text and
  Base64-encoded WAV audio. Send the ticket as `Authorization: Bearer <token>`.
- `WS /ws/v2?exhibit_id=<id>&lang=<lang>&ticket=<token>` creates an
  authenticated, language-bound chat session.

The socket first returns `session_ready`. Send a typed frame such as
`{ "type": "user_message", "text": "Tell me about this exhibit" }`; a
successful reply is an `agent_message` frame containing text and
Base64-encoded WAV audio. Failures use typed `error` frames.

The v2 browser page is intentionally not complete in this time-boxed
submission; the server endpoints above are the current v2 integration surface.
See the delivery notes in the design document for the deferred work.

## Documentation

- [v2 design decisions and implementation priorities](DESIGN.md)
- Challenge brief: [English](README.en.md) · [한국어](README.kr.md)
