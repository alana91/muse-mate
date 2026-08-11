const crypto = require('crypto');

const ISSUER = 'musemate';
const AUDIENCE = 'musemate-v2';
const SCOPE = 'musemate:v2';

function issueTicket({ secret, ttlSeconds, now = Date.now(), subject = crypto.randomUUID() } = {}) {
  if (!secret) throw new Error('TICKET_SECRET is required');
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error('ticket TTL must be a positive integer');
  }

  const issuedAt = Math.floor(now / 1000);
  const claims = {
    iss: ISSUER,
    aud: AUDIENCE,
    scope: SCOPE,
    sub: subject,
    iat: issuedAt,
    exp: issuedAt + ttlSeconds
  };
  const encodedClaims = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = sign(encodedClaims, secret);

  return { token: `${encodedClaims}.${signature}`, claims };
}

function verifyTicket(token, { secret, now = Date.now() } = {}) {
  if (!secret) throw new Error('TICKET_SECRET is required');
  if (typeof token !== 'string') return invalid('INVALID_TICKET');

  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return invalid('INVALID_TICKET');

  const [encodedClaims, signature] = parts;
  if (!safeEqual(signature, sign(encodedClaims, secret))) return invalid('INVALID_TICKET');

  let claims;
  try {
    claims = JSON.parse(Buffer.from(encodedClaims, 'base64url').toString('utf8'));
  } catch {
    return invalid('INVALID_TICKET');
  }

  if (
    !claims ||
    claims.iss !== ISSUER ||
    claims.aud !== AUDIENCE ||
    claims.scope !== SCOPE ||
    typeof claims.sub !== 'string' ||
    !Number.isInteger(claims.iat) ||
    !Number.isInteger(claims.exp) ||
    claims.exp <= claims.iat
  ) {
    return invalid('INVALID_TICKET');
  }

  if (claims.exp <= Math.floor(now / 1000)) return invalid('TICKET_EXPIRED');
  return { ok: true, claims };
}

function getBearerToken(authorization) {
  if (typeof authorization !== 'string') return null;
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function invalid(code) {
  return { ok: false, code };
}

module.exports = { getBearerToken, issueTicket, verifyTicket };
