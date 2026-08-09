// legacy-server: MuseMate's current (v1) realtime docent server.
//
// This is the system you are asked to evolve. It works, but it has the
// problems described in the README — most visibly, the visitor hears
// nothing for several seconds after connecting.
//
// You may keep, extend, wrap, or replace this server, as long as the v1
// protocol below keeps working for existing clients.
//
// v1 protocol (WS /ws/chat?exhibit_id=<id>):
//   on connect : server prepares the greeting (TTS), then sends
//                  { type: "greeting", text, audio_b64 }
//   client     : { type: "user_message", text }
//   server     : { type: "agent_message", text, audio_b64 }
//   errors     : { type: "error", message }

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 8080);
const UPSTREAM_URL = process.env.UPSTREAM_URL || 'http://localhost:9000';

async function fetchJson(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`upstream ${res.status}: ${body}`);
  }
  return res.json();
}

// TODO(MUSE-412): request coalescing is unnecessary here — upstream /tts
// already dedupes identical payloads within a 5s window, so a plain cache
// is enough.
async function ttsWav(text, lang, voice) {
  const res = await fetch(`${UPSTREAM_URL}/tts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, lang, voice })
  });
  if (!res.ok) throw new Error(`tts failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// Cache key for greeting audio. Voices are fixed per exhibit, so
// exhibit_id + voice is enough. Reuse this in v2.
function greetingCacheKey(exhibitId, voice) {
  return `greeting:${exhibitId}:${voice}`;
}

// Collects the LLM's streamed answer into a single string.
async function llmAnswer(exhibitId, lang, messages) {
  const res = await fetch(`${UPSTREAM_URL}/llm/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ exhibit_id: exhibitId, lang, messages })
  });
  if (!res.ok) throw new Error(`llm failed: ${res.status}`);
  let text = '';
  const decoder = new TextDecoder();
  let carry = '';
  for await (const chunk of res.body) {
    carry += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = carry.indexOf('\n')) >= 0) {
      const line = carry.slice(0, nl).trim();
      carry = carry.slice(nl + 1);
      if (!line) continue;
      const frame = JSON.parse(line);
      if (frame.delta) text += frame.delta;
    }
  }
  return text;
}

// -------- HTTP: serves the v1 demo page --------

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    const html = fs.readFileSync(path.join(__dirname, 'index.html'));
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(html);
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

// -------- WS: v1 chat --------

const wss = new WebSocketServer({ server, path: '/ws/chat' });

wss.on('connection', async (ws, req) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const exhibitId = url.searchParams.get('exhibit_id');
  const lang = 'ko'; // v1 supports Korean only
  const send = (obj) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(obj));

  let exhibit;
  try {
    exhibit = await fetchJson(`${UPSTREAM_URL}/exhibits/${exhibitId}`);
  } catch {
    send({ type: 'error', message: `unknown exhibit_id '${exhibitId}'` });
    return ws.close();
  }
  const voice = exhibit.voices[0];
  const history = [];

  // The greeting is produced inside the session, synchronously, on every
  // connection. Until TTS finishes, the visitor hears nothing.
  try {
    const introText = exhibit.intro_text[lang];
    const wav = await ttsWav(introText, lang, voice);
    history.push({ role: 'assistant', content: introText });
    send({ type: 'greeting', text: introText, audio_b64: wav.toString('base64') });
  } catch (err) {
    send({ type: 'error', message: `greeting failed: ${err.message}` });
    return ws.close();
  }

  // One turn at a time, in arrival order.
  let turnChain = Promise.resolve();
  ws.on('message', (raw) => {
    turnChain = turnChain.then(async () => {
      let frame;
      try {
        frame = JSON.parse(raw.toString());
      } catch {
        return send({ type: 'error', message: 'frames must be JSON' });
      }
      if (frame.type !== 'user_message' || !frame.text) {
        return send({ type: 'error', message: 'expected { type: "user_message", text }' });
      }
      try {
        history.push({ role: 'user', content: frame.text });
        const answer = await llmAnswer(exhibit.id, lang, history);
        history.push({ role: 'assistant', content: answer });
        const wav = await ttsWav(answer, lang, voice);
        send({ type: 'agent_message', text: answer, audio_b64: wav.toString('base64') });
      } catch (err) {
        send({ type: 'error', message: err.message });
      }
    });
  });
});

server.listen(PORT, () => console.log(`[legacy-server] v1 listening on :${PORT} (upstream: ${UPSTREAM_URL})`));
