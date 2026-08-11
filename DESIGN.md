# MuseMate v2 Design

> Working draft. We will add each design decision here after discussing and
> agreeing on it.

## Design decisions

### 1. Remove post-connect greeting silence

- **v1:** the WebSocket handler fetches exhibit data and waits for TTS before
  sending the greeting or enabling chat. The visitor can appear connected
  while hearing silence.
- **v2:** after receiving a ticket, the page requests the authenticated
  greeting when exhibit and language are selected, and opens the v2 WebSocket
  separately. The WebSocket never waits for greeting TTS.
- **UX:** play the greeting, then enable chat.
- **Cold cache:** TTS still takes time; prefetching and caching move that work
  before or alongside connection, making normal cache-hit greetings immediate.

### 2. Greeting cache and request coalescing

- **Cache**
  - Key: `greeting:<exhibit_id>:<language>`
  - Value: greeting text, generated audio, and `expires_at`
  - Voice is server-selected; changing the default voice clears the exhibit's
    entries.

- **Expiry and invalidation**
  - `GREETING_CACHE_TTL_SECONDS` defaults to 86,400 seconds.
  - Expired entries are regenerated on the next request.
  - A content update clears `greeting:<exhibit_id>:*`.
  - The mock has no update signal; an app restart also clears its in-memory
    cache.
  - Keep the cache bounded to 100 least-recently-used entries.

- **Concurrent cold requests**
  - Keep an in-flight Promise for each cache key.
  - Matching requests await the same TTS operation.
  - Success caches the result; failure is returned to all current waiters, is
    not cached, and allows a later retry.
  - One client disconnecting does not cancel work needed by others.

- **Verification**
  - Use upstream `/stats`.
  - A repeat request is a cache hit: no extra TTS call.
  - Concurrent cold requests for one key make exactly one TTS call.

### 3. Reduce answer time to first audio

- **v1 bottleneck:** it collects the complete streamed LLM answer, then sends
  the complete answer to TTS. First audio waits for both operations.

- **Pipeline**
  - The LLM emits text `delta`s, not sentence boundaries. Buffer them, split
    on terminal punctuation (including Korean/Japanese equivalents), and flush
    remaining text when the stream ends.
  - Start TTS as soon as a complete sentence is available while the LLM
    continues generating later sentences.
  - Tag audio with a turn ID and sequence number. The client queues and plays
    chunks in order, never overlapping audio.
  - This overlaps first-sentence TTS with remaining LLM generation.

- **In-progress UX**
  - Render received text with “Muse is still answering…” until text is final.
  - Then show “Muse is speaking…” until the audio queue is empty.
  - Visitors may draft a reply, but Send stays disabled until the turn and
    audio finish.

### 4. Service boundary and scale-out

- **Initial boundary**
  - One v2 Node application contains the ticket API, greeting API, WebSocket
    chat endpoint, and demo page as separate modules.
  - The greeting API is independent of a conversation session, but shares
    authentication, exhibit data, and upstream clients with chat.
  - The existing legacy server remains the separate v1 service.

- **Three v2 replicas**
  - Every replica runs the same v2 routes and shares the ticket-signing secret.
  - Redis replaces the local greeting cache and in-flight Promise map, avoiding
    duplicate TTS work across replicas.
  - WebSocket history remains on its accepting replica; use upgrade-capable
    load balancing and sticky connections. Store state in Redis/database if
    reconnection is needed.

- **Later evolution**
  - Split greeting into its own service if its cache-heavy workload needs
    independent scaling; use object storage/CDN for a large audio catalogue.
  - Keep `/api/v2` and `/ws/v2` compatible during rolling releases. Breaking
    changes receive a new version, such as `/v3`.

### 5. Multi-language protocol

- **Explicit selection:** v2 greeting requests and session creation include
  `exhibit_id` and `lang` (for example, `moon-jar` and `en`). The UI may use
  browser locale to preselect an option, but always sends the visitor's chosen
  language explicitly.
- **Why explicit:** device locale is only a hint; a visitor may prefer another
  supported language. An explicit value is predictable, validates cleanly,
  and produces deterministic cache behavior.
- **Session behavior:** validate `lang` against the exhibit's
  `supported_langs`, bind it to the v2 session, and use it for greeting, LLM,
  and TTS. `user_message` frames do not repeat it. Confirm it in the session
  ready frame; reject unsupported languages with a typed error.
- **v1 compatibility:** leave `WS /ws/chat?exhibit_id=...` unchanged,
  unauthenticated, and Korean-only. Explicit language is required only by the
  versioned v2 API and WebSocket protocol.

### 6. Transport and implementation choice

- **Node.js:** reuse the existing runtime and Docker approach; its async I/O
  suits upstream exhibit, LLM, and TTS calls without CPU-heavy audio work.
- **WebSocket:** native browser support and bidirectional typed frames suit
  chat, server-pushed audio, and ordered turns.
- **HTTP greeting:** a one-off, cacheable resource that can be prefetched and
  authenticated with a standard HTTP header.
- **Alternatives:** SSE streams server-to-browser but needs separate requests
  for visitor messages; polling adds latency; gRPC/WebRTC add browser and
  deployment complexity.
- **Trade-off:** WebSocket authentication happens during the opening handshake,
  and each long-lived connection stays on one server instance. Reconnection at
  scale therefore needs shared session state; see the scale-out section.

### 7. Ticket authentication

- **Issue:** `POST /api/v2/tickets` creates a short-lived HMAC-signed ticket
  using `TICKET_SECRET`. It contains a server-generated subject and expiry;
  the server never trusts an identity claimed by the client.
- **HTTP:** `GET /api/v2/greeting` requires `Authorization: Bearer <ticket>`
  and validates it on every request. Missing, invalid, or expired tickets get
  HTTP 401.
- **WebSocket:** the browser opens the v2 socket with `?ticket=<ticket>`. The
  server validates it during the HTTP upgrade and returns 401 before accepting
  an invalid connection. The validated subject becomes the session owner.
- **During a session:** validate message shape and authorization, but do not
  accept an identity in a message or re-verify the ticket signature per frame.
  Close the socket when its ticket expires.
- **Trade-offs:** browser WebSocket cannot set a custom `Authorization`
  header; a query token enables connection-time rejection but can reach access
  logs. Use WSS, short ticket expiry, query-string redaction, and an explicit
  WebSocket Origin allowlist. A Secure, HttpOnly, SameSite cookie or one-time
  upgrade token is a stronger production alternative. A first-frame token is
  rejected because the socket would already be open.
- **Sources:** [MDN WebSocket constructor](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/WebSocket);
  [OWASP WebSocket Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html).

### 8. v1 compatibility and versioning

- Leave the legacy server and `WS /ws/chat?exhibit_id=...` protocol unchanged:
  Korean-only, unauthenticated, and with its existing frame shapes.
- Put new behavior only on `/api/v2/...` and `/ws/v2/...`; language and ticket
  requirements apply only to v2.
- Keep v2 backward compatible during rolling releases. Breaking changes get a
  new version, such as `/v3`, rather than changing v2 clients underneath them.

### 9. Failure modes

| Failure | Handling |
| --- | --- |
| Missing, invalid, or expired ticket | HTTP 401; reject the WebSocket upgrade with 401; close an open socket at expiry. |
| Unknown exhibit | HTTP 404 / `EXHIBIT_NOT_FOUND`; typed WebSocket error, then close. |
| Unsupported language | HTTP 400 / `UNSUPPORTED_LANGUAGE`, including supported languages; typed WebSocket error. |
| Upstream TTS failure | HTTP 502 / retryable `UPSTREAM_TTS_FAILED`; do not cache it. Coalesced callers receive the same failure and a later request may retry. |
| Upstream LLM failure | Typed, retryable `LLM_UNAVAILABLE` WebSocket error; leave the session open for another question. |
| Upstream timeout | HTTP 504 or a retryable WebSocket timeout error. |
| Invalid client request or frame | HTTP 400 or typed `INVALID_FRAME`; keep the socket open when safe. |
| Connection loss | Show a disconnected state. Reconnection is deferred work. |

- Test LLM and TTS outage paths with `FAIL_RATE`.
- Source: [RFC 9110 HTTP status codes](https://www.rfc-editor.org/rfc/rfc9110.html).

## Implementation priority

1. **Runtime skeleton:** add the v2 Node service to Compose on port 3000 with
   a health route and placeholder page.
2. **Ticket primitives:** issue and validate signed tickets.
3. **Basic greeting API:** authenticated greeting generation, exhibit/language
   validation, and structured errors.
4. **Greeting cache:** add the completed-result cache.
5. **Request coalescing:** add and verify single-flight TTS generation.
6. **v2 WebSocket:** handshake auth, language selection, typed frames, chat,
   and structured errors.
7. **Minimal frontend:** automatic ticket, exhibit/language selection,
   parallel greeting/session requests, and serialized audio.

This keeps Compose runnable throughout, secures protected routes before they
grow, completes the independently testable greeting core before realtime chat,
and leaves the frontend until the required backend behavior exists.

## Delivery notes

### Implemented

- Compose starts the unchanged v1 service and a separate v2 Node service.
- v2 issues signed, expiring tickets and validates them for HTTP and before a
  WebSocket connection is accepted.
- The greeting API validates exhibit/language, returns structured errors, and
  uses an in-memory TTL/LRU cache plus same-key request coalescing.
- The v2 WebSocket binds exhibit and language at session creation, accepts
  typed visitor messages, and returns typed answer or error frames.

### Deferred in the time box

- **Browser demo:** the page at port 3000 remains a placeholder. The backend
  was prioritized first because tickets, caching, coalescing, and the realtime
  protocol are the core required behavior.
- **Sentence-level TTS pipeline:** designed above but not implemented; the
  current WebSocket waits for the complete LLM response before generating its
  audio.
- **Redis, multi-instance coordination, reconnection, and persistent session
  state:** these are production scale-out work rather than a single-instance
  challenge prerequisite.
- **Automated test suite:** ticket, greeting, cache, and coalescing behavior
  were checked against the running Compose services and upstream statistics.
  The final WebSocket path still needs an end-to-end smoke test.

### AI assistance

An AI coding assistant was used to inspect the existing implementation,
discuss the design, implement changes, and run the completed backend checks.
The trade-offs and final repository changes were reviewed during development.
