const http = require('http');
const fs = require('fs');
const path = require('path');
const { issueTicket } = require('./auth');

const PORT = Number(process.env.PORT || 3000);
const UPSTREAM_URL = process.env.UPSTREAM_URL || 'http://localhost:9000';
const TICKET_SECRET = process.env.TICKET_SECRET;
const TICKET_TTL_SECONDS = Number(process.env.TICKET_TTL_SECONDS || 1800);
const indexHtml = fs.readFileSync(path.join(__dirname, 'index.html'));

if (!TICKET_SECRET) throw new Error('TICKET_SECRET is required');
if (!Number.isInteger(TICKET_TTL_SECONDS) || TICKET_TTL_SECONDS <= 0) {
  throw new Error('TICKET_TTL_SECONDS must be a positive integer');
}

function json(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': payload.length
  });
  res.end(payload);
}

const server = http.createServer((req, res) => {
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
    });
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': indexHtml.length
    });
    return res.end(indexHtml);
  }

  return json(res, 404, { error: { code: 'NOT_FOUND', message: 'not found' } });
});

server.listen(PORT, () => {
  console.log(`[app-server] v2 runtime skeleton listening on :${PORT} (upstream: ${UPSTREAM_URL})`);
});
