// mock-upstream: fake content DB + LLM + TTS for the MuseMate take-home.
// Candidates must treat this service as a black box. DO NOT MODIFY.
//
// Latency is intentional — it simulates real LLM/TTS providers.

const http = require('http');

const PORT = Number(process.env.PORT || 9000);

const LLM_INITIAL_DELAY_MS = 1200;
const LLM_CHUNK_DELAY_MS = 120;
const TTS_BASE_DELAY_MS = 1500;
const TTS_PER_CHAR_MS = 5;

// Set FAIL_RATE (0..1) to make /llm/chat and /tts randomly return 500 —
// useful for testing how your system degrades under upstream failures.
const FAIL_RATE = Math.min(Math.max(Number(process.env.FAIL_RATE || 0), 0), 1);

// Call counters, exposed at GET /stats. Use them to verify how many upstream
// calls your implementation actually makes (cache hits, request dedup, …).
const stats = { llm_calls: 0, tts_calls: 0 };

const EXHIBITS = {
  'moon-jar': {
    id: 'moon-jar',
    name: { ko: '달항아리', en: 'Moon Jar', ja: '月の壺' },
    supported_langs: ['ko', 'en', 'ja'],
    voices: ['hana', 'alex'],
    intro_text: {
      ko: '안녕하세요, 저는 도슨트 뮤즈입니다. 지금 보고 계신 달항아리는 18세기 조선 백자의 정수로, 두 개의 반구를 이어 붙여 만든 넉넉하고 자연스러운 곡선이 특징입니다. 궁금한 점이 있으면 무엇이든 물어보세요.',
      en: "Hello, I'm Muse, your docent. The Moon Jar before you is a masterpiece of 18th-century Joseon white porcelain, made by joining two hemispheres into one generous, natural curve. Ask me anything you're curious about.",
      ja: 'こんにちは、ドーセントのミューズです。目の前の月の壺は18世紀朝鮮白磁の傑作で、二つの半球をつなぎ合わせた、おおらかで自然な曲線が特徴です。気になることがあれば何でも聞いてください。'
    },
    facts: {
      ko: [
        '달항아리는 물레로 한 번에 만들기엔 너무 커서, 위아래 반구를 따로 빚어 이어 붙였습니다. 그래서 이음새 부근이 살짝 비대칭인데, 그 불완전함이 오히려 매력으로 꼽힙니다.',
        '유약의 은은한 우윳빛은 철분이 적은 태토와 장작 가마의 불길이 만들어낸 우연의 색입니다. 같은 색은 두 번 나오지 않는다고 합니다.',
        '달항아리라는 이름은 20세기에 미술사학자들이 붙인 것으로, 보름달을 닮았다 하여 그렇게 불리게 되었습니다.'
      ],
      en: [
        'The jar was too large to throw in one piece, so the potter shaped two hemispheres and joined them — the slight asymmetry at the seam is considered part of its charm.',
        'Its soft milky glaze comes from low-iron clay and the unpredictable flames of a wood-fired kiln. No two jars ever come out the same color.',
        'The name "Moon Jar" was coined by art historians in the 20th century, for its resemblance to a full moon.'
      ],
      ja: [
        'この壺は一度に成形するには大きすぎたため、上下の半球を別々に作って接合しました。継ぎ目のわずかな非対称が、むしろ魅力とされています。',
        '柔らかな乳白色の釉薬は、鉄分の少ない土と薪窯の炎が生んだ偶然の色です。同じ色は二度と出ないと言われます。',
        '「月の壺」という名前は20世紀に美術史家が付けたもので、満月に似ていることに由来します。'
      ]
    }
  },
  'gold-crown': {
    id: 'gold-crown',
    name: { ko: '금관', en: 'Gold Crown', ja: '金冠' },
    supported_langs: ['ko', 'en'],
    voices: ['hana', 'alex'],
    intro_text: {
      ko: '안녕하세요, 저는 도슨트 뮤즈입니다. 이 금관은 5세기 신라 왕실의 위엄을 보여주는 걸작으로, 나뭇가지와 사슴뿔 모양의 장식이 하늘과 땅을 잇는 상징으로 해석됩니다. 편하게 질문해 주세요.',
      en: "Hello, I'm Muse, your docent. This gold crown is a 5th-century masterpiece of the Silla royal court — its tree-branch and antler ornaments are read as symbols linking heaven and earth. Feel free to ask me anything."
    },
    facts: {
      ko: [
        '금관의 나뭇가지 장식은 出(출) 자 모양으로, 세 단으로 뻗어 오르는 형태가 신성한 나무를 상징한다고 봅니다.',
        '금관에 달린 곱은옥(곡옥)은 생명과 풍요를 상징하며, 비취로 만든 것이 많습니다.',
        '실제로 쓰기에는 매우 얇고 약해서, 의례용이나 부장용으로 만들어졌다는 견해가 유력합니다.'
      ],
      en: [
        'The upright ornaments form the Chinese character 出, rising in three tiers — thought to represent a sacred tree.',
        'The comma-shaped jade beads (gogok) hanging from the crown symbolize life and abundance.',
        'The crown is far too thin and fragile for regular wear; most scholars believe it was ceremonial or funerary.'
      ]
    }
  }
};

// -------- helpers --------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function json(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': buf.length,
    'access-control-allow-origin': '*'
  });
  res.end(buf);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}'));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

// Generates a fake speech waveform (warbling sine) — duration scales with text length.
function synthWav(text, lang, voice) {
  const sampleRate = 16000;
  const seconds = Math.min(1.2 + text.length * 0.045, 8);
  const n = Math.floor(sampleRate * seconds);
  const baseFreq = ({ ko: 300, en: 240, ja: 360 }[lang] || 300) * (voice === 'alex' ? 0.75 : 1);
  const pcm = Buffer.alloc(n * 2);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const freq = baseFreq + 40 * Math.sin(2 * Math.PI * 2.3 * t);
    phase += (2 * Math.PI * freq) / sampleRate;
    const cadence = 0.55 + 0.45 * Math.max(0, Math.sin(2 * Math.PI * 3.1 * t));
    const env = Math.min(1, t * 8, (seconds - t) * 8) * 0.25 * cadence;
    pcm.writeInt16LE(Math.round(Math.sin(phase) * env * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

// -------- routes --------

async function handleLlmChat(req, res) {
  stats.llm_calls += 1;
  if (Math.random() < FAIL_RATE) return json(res, 500, { error: 'upstream unavailable (injected failure)' });
  const body = await readBody(req);
  const { exhibit_id, lang, messages } = body;
  const exhibit = EXHIBITS[exhibit_id];
  if (!exhibit) return json(res, 404, { error: 'unknown exhibit_id' });
  if (!exhibit.supported_langs.includes(lang)) {
    return json(res, 400, { error: `unsupported lang '${lang}' for this exhibit`, supported: exhibit.supported_langs });
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    return json(res, 400, { error: 'messages must be a non-empty array' });
  }

  const userTurns = messages.filter((m) => m && m.role === 'user').length;
  const facts = exhibit.facts[lang];
  const answer = facts[(Math.max(userTurns, 1) - 1) % facts.length];

  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-cache',
    'access-control-allow-origin': '*'
  });
  await sleep(LLM_INITIAL_DELAY_MS);
  const words = answer.split(' ');
  for (let i = 0; i < words.length; i++) {
    res.write(JSON.stringify({ delta: (i === 0 ? '' : ' ') + words[i] }) + '\n');
    await sleep(LLM_CHUNK_DELAY_MS);
  }
  res.write(JSON.stringify({ done: true }) + '\n');
  res.end();
}

async function handleTts(req, res) {
  stats.tts_calls += 1;
  if (Math.random() < FAIL_RATE) return json(res, 500, { error: 'upstream unavailable (injected failure)' });
  const body = await readBody(req);
  const { text, lang, voice = 'hana' } = body;
  if (!text || typeof text !== 'string') return json(res, 400, { error: 'text is required' });
  if (!['ko', 'en', 'ja'].includes(lang)) return json(res, 400, { error: `unsupported lang '${lang}'` });
  if (!['hana', 'alex'].includes(voice)) return json(res, 400, { error: `unknown voice '${voice}'` });

  await sleep(TTS_BASE_DELAY_MS + text.length * TTS_PER_CHAR_MS);
  const wav = synthWav(text, lang, voice);
  res.writeHead(200, {
    'content-type': 'audio/wav',
    'content-length': wav.length,
    'access-control-allow-origin': '*'
  });
  res.end(wav);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const route = `${req.method} ${url.pathname}`;

  Promise.resolve()
    .then(() => {
      if (route === 'GET /health') return json(res, 200, { ok: true });
      if (route === 'GET /stats') return json(res, 200, stats);
      if (route === 'POST /stats/reset') {
        stats.llm_calls = 0;
        stats.tts_calls = 0;
        return json(res, 200, stats);
      }
      if (route === 'GET /exhibits') {
        return json(res, 200, Object.values(EXHIBITS).map(({ facts, ...rest }) => rest));
      }
      const detail = url.pathname.match(/^\/exhibits\/([\w-]+)$/);
      if (req.method === 'GET' && detail) {
        const exhibit = EXHIBITS[detail[1]];
        if (!exhibit) return json(res, 404, { error: 'unknown exhibit_id' });
        const { facts, ...rest } = exhibit;
        return json(res, 200, rest);
      }
      if (route === 'POST /llm/chat') return handleLlmChat(req, res);
      if (route === 'POST /tts') return handleTts(req, res);
      return json(res, 404, { error: 'not found' });
    })
    .catch((err) => json(res, 400, { error: err.message }));
});

server.listen(PORT, () => console.log(`[mock-upstream] listening on :${PORT}`));
