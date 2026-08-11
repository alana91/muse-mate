const http = require('http');
const fs = require('fs');
const path = require('path');
const { getBearerToken, issueTicket, verifyTicket } = require('./auth');
const { createUpstreamClient, UpstreamError } = require('./upstream');

const PORT = Number(process.env.PORT || 3000);
const UPSTREAM_URL = process.env.UPSTREAM_URL || 'http://localhost:9000';
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 10000);
const TICKET_SECRET = process.env.TICKET_SECRET;
const TICKET_TTL_SECONDS = Number(process.env.TICKET_TTL_SECONDS || 1800);
const indexHtml = fs.readFileSync(path.join(__dirname, 'index.html'));

if (!TICKET_SECRET) throw new Error('TICKET_SECRET is required');
if (!Number.isInteger(TICKET_TTL_SECONDS) || TICKET_TTL_SECONDS <= 0) {
  throw new Error('TICKET_TTL_SECONDS must be a positive integer');
}
if (!Number.isInteger(UPSTREAM_TIMEOUT_MS) || UPSTREAM_TIMEOUT_MS <= 0) {
  throw new Error('UPSTREAM_TIMEOUT_MS must be a positive integer');
}

const upstream = createUpstreamClient({
  baseUrl: UPSTREAM_URL,
  timeoutMs: UPSTREAM_TIMEOUT_MS
});

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

  const exhibit = await upstream.getExhibit(exhibitId);
  if (!exhibit) return sendError(res, 404, 'EXHIBIT_NOT_FOUND', 'The exhibit was not found.');

  if (!Array.isArray(exhibit.supported_langs) || !exhibit.supported_langs.includes(lang)) {
    return sendError(res, 400, 'UNSUPPORTED_LANGUAGE', 'This language is not supported for the exhibit.', {
      details: { supported_langs: exhibit.supported_langs || [] }
    });
  }

  const text = exhibit.intro_text?.[lang];
  const voice = exhibit.voices?.[0];
  if (typeof text !== 'string' || !voice) {
    throw new UpstreamError(502, 'UPSTREAM_EXHIBIT_FAILED', 'Exhibit information is temporarily unavailable.', true);
  }

  const wav = await upstream.ttsWav({ text, lang, voice });
  return json(res, 200, {
    exhibit_id: exhibit.id,
    lang,
    voice,
    text,
    audio_b64: wav.toString('base64')
  }, { 'cache-control': 'no-store' });
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
    if (error instanceof UpstreamError) {
      return sendError(res, error.status, error.code, error.message, { retryable: error.retryable });
    }

    console.error('[app-server] unexpected request error', error);
    if (!res.headersSent) return sendError(res, 500, 'INTERNAL_ERROR', 'An unexpected error occurred.');
    res.destroy();
  });
});

server.listen(PORT, () => {
  console.log(`[app-server] v2 runtime skeleton listening on :${PORT} (upstream: ${UPSTREAM_URL})`);
});
