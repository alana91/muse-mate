# MuseMate — AI Docent Realtime System Challenge

**Role**: Full-stack engineer · **Time limit**: 3 hours · **Deliverable**: this repo, extended

한국어 버전: [README.md](README.md)

## Background

MuseMate is a service where a museum visitor opens a web page in front of an
exhibit, and an AI docent named "Muse" greets them by voice and answers their
questions.

The current system (v1) works, but two problems keep coming up since launch:

1. **Silence after connecting.** After the visitor opens the page, nothing is
   heard for several seconds before the docent says its first words. The
   greeting (TTS) is prepared *inside* the session, *after* connecting, from
   scratch on every connection. Try the demo at `http://localhost:8080` —
   it shows timestamps so you can feel the silence.
2. **Korean only.** The share of international visitors is growing, but v1
   hardcodes Korean. The exhibit data already contains per-exhibit supported
   languages (`supported_langs`) and per-language intro text.
3. **Anyone can use it.** The service sits on the public internet, but v1 has
   no authentication — people without an admission ticket can use the docent.
   From v2 on, the service must only be usable with a **ticket token** issued
   at admission.

Your mission is to evolve this system to **v2**. However, v1 clients are
already deployed in the field, so **the v1 protocol must keep working.**

## The current system

```
[Browser] ──WS──> [legacy-server :8080] ──HTTP──> [mock-upstream :9000]
                   v1 protocol                     exhibit data / LLM / TTS
```

Run it:

```bash
docker compose up --build
# demo: http://localhost:8080
# upstream API: http://localhost:9000 (GET /exhibits, GET /exhibits/{id}, POST /llm/chat, POST /tts)
```

- **`mock-upstream/`** — simulates the external systems: exhibit content DB,
  LLM, and TTS. Like real providers, **it is slow on purpose** (LLM first
  token ~1.2s, TTS ~1.5s + proportional to text length).
  **Do not modify** — treat it as an external service you don't control.
  - Self-verification tools: `GET /stats` returns the LLM/TTS call counts so
    far, and `POST /stats/reset` zeroes them. Use them to confirm your caching
    and request coalescing actually work. Setting the `FAIL_RATE` env var
    (0–1) makes upstream return 500s probabilistically, so you can test
    failure behavior.
- **`legacy-server/`** — the v1 server. You may keep, extend, wrap, or replace
  it, as long as the v1 protocol documented at the top of the file keeps
  working for existing clients.

## Tasks

### 1. Design document — `DESIGN.md` (required)

Write down your v2 design. It doesn't have to be long (bullets are fine), but
it must cover:

- The structural change that removes the post-connect silence, and why
- Caching strategy: what is cached, under which key, for how long, and when
  it is invalidated. How you handle simultaneous identical requests
  (a tour group walking in at once)
- **Response-latency improvement**: when answering, v1 serially waits for the
  full LLM answer and then the full TTS (~6s to first audio). Design a way to
  structurally reduce time-to-first-audio (e.g. sentence-level TTS pipelining
  with ordering guarantees). Implementing it is bonus; designing it is
  required.
- **Service boundaries and scale-out**: does the greeting API live inside the
  conversation server, or as a separate service — with reasoning. And what
  breaks when your server scales to 3 instances (where must the cache live?
  what about session state?)
- How multi-language support is expressed in the protocol
- **Auth**: where the token is validated (at connection time vs per message),
  how the token is carried on the realtime channel (query string? header?
  first frame?), and the trade-offs of each
- How v1 compatibility is preserved (your versioning approach)
- Key failure modes and how you handle them (upstream outage, unsupported
  language, etc. — you can simulate these with `FAIL_RATE`)
- What you didn't have time to build, and why you deprioritized it

### 2. Backend (required — the core of this challenge)

- **Greeting API**: design and implement an HTTP endpoint that returns the
  greeting (text + audio) without a session.
  - Repeated requests must be fast (caching — in-memory is fine; the key
    design is what matters).
  - **Request coalescing**: with a cold cache, N simultaneous requests for
    the same greeting must result in **exactly one** upstream TTS call.
    (Verify it yourself: `POST /stats/reset`, fire concurrent requests, then
    check `GET /stats` — the evaluator will do the same.)
  - Include error responses for unknown exhibits, unsupported languages, etc.
- **v2 realtime channel**: design and implement a v2 session protocol that
  supports specifying a language and creates no silence at connection time.
  - The transport is not prescribed — WebSocket, SSE, HTTP streaming, gRPC,
    anything. Only two constraints: it must be demonstrable from your page
    (a browser), and the reasoning (trade-offs against the alternatives) must
    be in DESIGN.md. We grade the reasoning, not the choice.
  - Frames must be type-discriminated, and upstream failures must reach the
    client as structured errors.
- **Ticket auth**: visitors may only use v2 with an issued ticket token.
  - Build a token-issuing endpoint. A fake login is enough — any signed token
    format (your own HMAC, JWT, …) with the secret in an env var. No external
    IdP needed.
  - The greeting API and the v2 channel must reject requests without a valid
    token — 401 for HTTP, and the realtime channel must reject **at
    connection time**.
  - Never trust an identity the client claims inside a message. Who owns the
    session is decided by the validated token.
  - v1 stays unauthenticated (compatibility with deployed clients).
- The v1 protocol must keep working.

### 3. Frontend (required — minimal)

The backend is the core of this challenge. The frontend only needs to be a
**minimal page** that actually demonstrates your v2 — a single HTML file at
the level of the legacy demo is acceptable; no framework required.

- Pick an exhibit + language → on connect, **the docent's greeting plays
  without noticeable delay**, then the visitor can chat. (Naturally, greeting
  preparation and session connection should run in parallel.)
- Obtain a ticket token before connecting. Issuing may be automatic (e.g. on
  page load — no login screen needed).
- Audio must never overlap.
- Styling is not evaluated.

### 4. Runtime (required)

- A single `docker compose up --build` must bring up **the entire system**,
  and the evaluator must be able to use your widget at
  `http://localhost:3000` immediately.
- Manual steps (local npm install, writing env files, …) cost points.
  Solve setup inside compose.

### Bonus (only after the required tasks are done)

- Actually implementing the response-latency design from DESIGN.md
  (e.g. sentence-level TTS pipelining)
- Graceful degradation under upstream failures (test with `FAIL_RATE=0.3` —
  e.g. deliver text even when TTS fails)
- Mid-conversation language switching (including handling of in-flight
  responses/audio)
- Interrupting the greeting when the user starts typing during playback
- Progressive (streaming) rendering of response text
- Reconnection after connection loss
- Tests for the core logic

## Rules

- **3-hour time limit.** We evaluate prioritization over completeness. Don't
  hide what you couldn't finish — write it in DESIGN.md; "what you dropped
  and why" is a graded item.
- `mock-upstream/` must not be modified. Everything else is yours.
- Your implementation language/stack is free (it just has to run via compose).
- AI coding tools are allowed. If you used them, add a line or two to
  DESIGN.md about how.
- Commit in meaningful units. We read the commit history too.

## Submission

- Zip this repo (excluding `node_modules`) or push it to a private repo and
  share access.
- If running it differs from `docker compose up --build`, say so at the very
  top of the README.

## Evaluation criteria (summary)

| Area | Weight | What we look at |
|---|---|---|
| Design | 30% | Root-cause diagnosis, cache key/invalidation, latency improvement design, versioning, trade-off reasoning |
| Backend | 40% | Greeting API (caching + request coalescing), v2 channel, ticket auth, error handling, code structure |
| Frontend | 15% | Working v2 demo, parallel greeting load and immediate playback, no overlapping audio |
| Reproducibility | 15% | One-command compose, docs matching reality |

Good luck. 🏺
