const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocket, WebSocketServer } = require('ws');
const { getBearerToken, issueTicket, verifyTicket } = require('./auth');
const { GreetingCache, greetingCacheKey } = require('./greeting-cache');
const { SingleFlight } = require('./single-flight');
const { createUpstreamClient, UpstreamError } = require('./upstream');

const PORT = Number(process.env.PORT || 3000);
const UPSTREAM_URL = process.env.UPSTREAM_URL || 'http://localhost:9000';
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 10000);
const TICKET_SECRET = process.env.TICKET_SECRET;
const TICKET_TTL_SECONDS = Number(process.env.TICKET_TTL_SECONDS || 1800);
const GREETING_CACHE_TTL_SECONDS = Number(process.env.GREETING_CACHE_TTL_SECONDS || 86400);
const GREETING_CACHE_MAX_ENTRIES = Number(process.env.GREETING_CACHE_MAX_ENTRIES || 100);
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || `http://localhost:${PORT}`;
const indexHtml = fs.readFileSync(path.join(__dirname, 'index.html'));

if (!TICKET_SECRET) throw new Error('TICKET_SECRET is required');
if (!Number.isInteger(TICKET_TTL_SECONDS) || TICKET_TTL_SECONDS <= 0) {
  throw new Error('TICKET_TTL_SECONDS must be a positive integer');
}
if (!Number.isInteger(UPSTREAM_TIMEOUT_MS) || UPSTREAM_TIMEOUT_MS <= 0) {
  throw new Error('UPSTREAM_TIMEOUT_MS must be a positive integer');
}
if (!Number.isInteger(GREETING_CACHE_TTL_SECONDS) || GREETING_CACHE_TTL_SECONDS <= 0) {
  throw new Error('GREETING_CACHE_TTL_SECONDS must be a positive integer');
}
if (!Number.isInteger(GREETING_CACHE_MAX_ENTRIES) || GREETING_CACHE_MAX_ENTRIES <= 0) {
  throw new Error('GREETING_CACHE_MAX_ENTRIES must be a positive integer');
}

const upstream = createUpstreamClient({
  baseUrl: UPSTREAM_URL,
  timeoutMs: UPSTREAM_TIMEOUT_MS
});
const greetingCache = new GreetingCache({
  ttlMs: GREETING_CACHE_TTL_SECONDS * 1000,
  maxEntries: GREETING_CACHE_MAX_ENTRIES
});
const greetingFlights = new SingleFlight();

class GreetingRequestError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'GreetingRequestError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function json(res, status, body, headers = {}) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': payload.length,
    ...headers
  });
  res.end(payload);
}

function sendError(res, status, code, message, { retryable = false, details } = {}) {
  const error = { code, message, retryable };
  if (details) error.details = details;
  return json(res, status, { error }, { 'cache-control': 'no-store' });
}

function authenticate(req, res) {
  const token = getBearerToken(req.headers.authorization);
  if (!token) {
    sendError(res, 401, 'UNAUTHORIZED', 'A valid ticket is required.');
    return null;
  }

  const result = verifyTicket(token, { secret: TICKET_SECRET });
  if (!result.ok) {
    const message = result.code === 'TICKET_EXPIRED' ? 'Ticket has expired.' : 'Ticket is invalid.';
    sendError(res, 401, result.code, message);
    return null;
  }

  return result.claims;
}

async function handleGreeting(req, res, url) {
  if (!authenticate(req, res)) return;

  const exhibitId = url.searchParams.get('exhibit_id');
  const lang = url.searchParams.get('lang');
  if (!exhibitId) return sendError(res, 400, 'EXHIBIT_ID_REQUIRED', 'exhibit_id is required.');
  if (!lang) return sendError(res, 400, 'LANG_REQUIRED', 'lang is required.');

  const cacheKey = greetingCacheKey(exhibitId, lang);
  const cachedGreeting = greetingCache.get(cacheKey);
  if (cachedGreeting) return sendGreeting(res, cachedGreeting);

  const greeting = await greetingFlights.run(cacheKey, async () => {
    const cached = greetingCache.get(cacheKey);
    if (cached) return cached;
    return generateGreeting(exhibitId, lang, cacheKey);
  });
  return sendGreeting(res, greeting);
}

async function generateGreeting(exhibitId, lang, cacheKey) {
  const exhibit = await upstream.getExhibit(exhibitId);
  if (!exhibit) throw new GreetingRequestError(404, 'EXHIBIT_NOT_FOUND', 'The exhibit was not found.');

  if (!Array.isArray(exhibit.supported_langs) || !exhibit.supported_langs.includes(lang)) {
    throw new GreetingRequestError(
      400,
      'UNSUPPORTED_LANGUAGE',
      'This language is not supported for the exhibit.',
      { supported_langs: exhibit.supported_langs || [] }
    );
  }

  const text = exhibit.intro_text?.[lang];
  const voice = exhibit.voices?.[0];
  if (typeof text !== 'string' || !voice) {
    throw new UpstreamError(502, 'UPSTREAM_EXHIBIT_FAILED', 'Exhibit information is temporarily unavailable.', true);
  }

  const wav = await upstream.ttsWav({ text, lang, voice });
  const greeting = { exhibitId: exhibit.id, lang, voice, text, wav };
  greetingCache.set(cacheKey, greeting);
  return greeting;
}

function sendGreeting(res, { exhibitId, lang, voice, text, wav }) {
  return json(res, 200, {
    exhibit_id: exhibitId,
    lang,
    voice,
    text,
    audio_b64: wav.toString('base64')
  }, { 'cache-control': 'no-store' });
}

function sendSocketFrame(ws, frame) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
}

function sendSocketError(ws, code, message, { retryable = false, details, turnId } = {}) {
  const frame = { type: 'error', code, message, retryable };
  if (details) frame.details = details;
  if (turnId !== undefined) frame.turn_id = turnId;
  sendSocketFrame(ws, frame);
}

function closeSocketWithError(ws, code, message, options = {}, closeCode = 1008) {
  sendSocketError(ws, code, message, options);
  if (ws.readyState === WebSocket.OPEN) ws.close(closeCode);
}

async function initializeRealtimeSession(ws, { claims, exhibitId, lang }) {
  if (!exhibitId) return closeSocketWithError(ws, 'EXHIBIT_ID_REQUIRED', 'exhibit_id is required.');
  if (!lang) return closeSocketWithError(ws, 'LANG_REQUIRED', 'lang is required.');

  let exhibit;
  try {
    exhibit = await upstream.getExhibit(exhibitId);
  } catch (error) {
    if (error instanceof UpstreamError) {
      return closeSocketWithError(ws, error.code, error.message, { retryable: error.retryable }, 1011);
    }
    throw error;
  }

  if (!exhibit) return closeSocketWithError(ws, 'EXHIBIT_NOT_FOUND', 'The exhibit was not found.');
  if (!Array.isArray(exhibit.supported_langs) || !exhibit.supported_langs.includes(lang)) {
    return closeSocketWithError(
      ws,
      'UNSUPPORTED_LANGUAGE',
      'This language is not supported for the exhibit.',
      { details: { supported_langs: exhibit.supported_langs || [] } }
    );
  }

  const introText = exhibit.intro_text?.[lang];
  const voice = exhibit.voices?.[0];
  if (typeof introText !== 'string' || !voice) {
    return closeSocketWithError(ws, 'UPSTREAM_EXHIBIT_FAILED', 'Exhibit information is temporarily unavailable.', {
      retryable: true
    }, 1011);
  }

  const session = {
    ownerId: claims.sub,
    exhibitId: exhibit.id,
    lang,
    voice,
    history: [{ role: 'assistant', content: introText }],
    nextTurnId: 0
  };
  const expiresInMs = Math.max(0, claims.exp * 1000 - Date.now());
  const expiryTimer = setTimeout(() => {
    closeSocketWithError(ws, 'TICKET_EXPIRED', 'Ticket has expired.');
  }, expiresInMs);

  ws.on('close', () => clearTimeout(expiryTimer));
  ws.on('error', (error) => console.error('[app-server] websocket error', error.message));
  attachChatHandler(ws, session);
  sendSocketFrame(ws, {
    type: 'session_ready',
    exhibit_id: session.exhibitId,
    lang: session.lang
  });
}

function attachChatHandler(ws, session) {
  let turnChain = Promise.resolve();

  ws.on('message', (raw, isBinary) => {
    turnChain = turnChain
      .then(() => handleChatFrame(ws, session, raw, isBinary))
      .catch((error) => {
        console.error('[app-server] unexpected chat error', error);
        sendSocketError(ws, 'INTERNAL_ERROR', 'An unexpected error occurred.');
      });
  });
}

async function handleChatFrame(ws, session, raw, isBinary) {
  if (isBinary) return sendSocketError(ws, 'INVALID_FRAME', 'Frames must be JSON text.');

  let frame;
  try {
    frame = JSON.parse(raw.toString());
  } catch {
    return sendSocketError(ws, 'INVALID_FRAME', 'Frames must be JSON.');
  }

  if (frame.type !== 'user_message' || typeof frame.text !== 'string' || !frame.text.trim()) {
    return sendSocketError(ws, 'INVALID_FRAME', 'Expected { type: "user_message", text }.');
  }

  const text = frame.text.trim();
  const turnId = ++session.nextTurnId;
  const nextHistory = [...session.history, { role: 'user', content: text }];

  try {
    const answer = await upstream.llmAnswer({
      exhibitId: session.exhibitId,
      lang: session.lang,
      messages: nextHistory
    });
    const wav = await upstream.ttsWav({ text: answer, lang: session.lang, voice: session.voice });

    session.history = [...nextHistory, { role: 'assistant', content: answer }];
    sendSocketFrame(ws, {
      type: 'agent_message',
      turn_id: turnId,
      text: answer,
      audio_b64: wav.toString('base64')
    });
  } catch (error) {
    if (error instanceof UpstreamError) {
      return sendSocketError(ws, error.code, error.message, {
        retryable: error.retryable,
        turnId
      });
    }
    throw error;
  }
}

function rejectUpgrade(socket, statusCode, statusText) {
  socket.write(
    `HTTP/1.1 ${statusCode} ${statusText}\r\n` +
    'Connection: close\r\n' +
    'Content-Length: 0\r\n\r\n'
  );
  socket.destroy();
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || `localhost:${PORT}`}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    return json(res, 200, { ok: true, service: 'musemate-v2' });
  }

  if (req.method === 'POST' && url.pathname === '/api/v2/tickets') {
    const { token, claims } = issueTicket({
      secret: TICKET_SECRET,
      ttlSeconds: TICKET_TTL_SECONDS
    });
    return json(res, 201, {
      ticket: token,
      token_type: 'Bearer',
      expires_at: new Date(claims.exp * 1000).toISOString()
    }, { 'cache-control': 'no-store' });
  }

  if (req.method === 'GET' && url.pathname === '/api/v2/greeting') {
    return handleGreeting(req, res, url);
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': indexHtml.length
    });
    return res.end(indexHtml);
  }

  return json(res, 404, { error: { code: 'NOT_FOUND', message: 'not found' } });
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    if (error instanceof GreetingRequestError) {
      return sendError(res, error.status, error.code, error.message, { details: error.details });
    }

    if (error instanceof UpstreamError) {
      return sendError(res, error.status, error.code, error.message, { retryable: error.retryable });
    }

    console.error('[app-server] unexpected request error', error);
    if (!res.headersSent) return sendError(res, 500, 'INTERNAL_ERROR', 'An unexpected error occurred.');
    res.destroy();
  });
});

const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host || `localhost:${PORT}`}`);
  if (url.pathname !== '/ws/v2') return rejectUpgrade(socket, 404, 'Not Found');

  if (req.headers.origin && req.headers.origin !== ALLOWED_ORIGIN) {
    return rejectUpgrade(socket, 403, 'Forbidden');
  }

  const ticket = url.searchParams.get('ticket');
  const ticketResult = verifyTicket(ticket, { secret: TICKET_SECRET });
  if (!ticketResult.ok) return rejectUpgrade(socket, 401, 'Unauthorized');

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, {
      claims: ticketResult.claims,
      exhibitId: url.searchParams.get('exhibit_id'),
      lang: url.searchParams.get('lang')
    });
  });
});

wss.on('connection', (ws, sessionRequest) => {
  initializeRealtimeSession(ws, sessionRequest).catch((error) => {
    console.error('[app-server] session initialization error', error);
    closeSocketWithError(ws, 'INTERNAL_ERROR', 'An unexpected error occurred.', {}, 1011);
  });
});

server.listen(PORT, () => {
  console.log(`[app-server] v2 runtime skeleton listening on :${PORT} (upstream: ${UPSTREAM_URL})`);
});
