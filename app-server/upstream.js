class UpstreamError extends Error {
  constructor(status, code, message, retryable) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

function createUpstreamClient({ baseUrl, timeoutMs }) {
  async function getExhibit(exhibitId) {
    const response = await request(`/exhibits/${encodeURIComponent(exhibitId)}`);
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new UpstreamError(502, 'UPSTREAM_EXHIBIT_FAILED', 'Exhibit information is temporarily unavailable.', true);
    }
    return readJson(response, 'UPSTREAM_EXHIBIT_FAILED', 'Exhibit information is temporarily unavailable.');
  }

  async function ttsWav({ text, lang, voice }) {
    const response = await request('/tts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, lang, voice })
    });
    if (!response.ok) {
      throw new UpstreamError(502, 'UPSTREAM_TTS_FAILED', 'Greeting audio is temporarily unavailable.', true);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  async function llmAnswer({ exhibitId, lang, messages }) {
    const response = await request('/llm/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ exhibit_id: exhibitId, lang, messages })
    });
    if (!response.ok) {
      throw new UpstreamError(502, 'LLM_UNAVAILABLE', 'Muse is temporarily unavailable.', true);
    }

    const decoder = new TextDecoder();
    let answer = '';
    let carry = '';

    try {
      for await (const chunk of response.body) {
        carry += decoder.decode(chunk, { stream: true });
        ({ carry, answer } = consumeDeltas(carry, answer));
      }
      carry += decoder.decode();
      ({ answer } = consumeDeltas(carry, answer, true));
      return answer;
    } catch (error) {
      if (error instanceof UpstreamError) throw error;
      if (error.name === 'TimeoutError' || error.name === 'AbortError') {
        throw new UpstreamError(504, 'UPSTREAM_TIMEOUT', 'The upstream service timed out.', true);
      }
      throw new UpstreamError(502, 'LLM_UNAVAILABLE', 'Muse is temporarily unavailable.', true);
    }
  }

  async function request(path, init) {
    try {
      return await fetch(`${baseUrl}${path}`, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      if (error.name === 'TimeoutError' || error.name === 'AbortError') {
        throw new UpstreamError(504, 'UPSTREAM_TIMEOUT', 'The upstream service timed out.', true);
      }
      throw new UpstreamError(502, 'UPSTREAM_UNAVAILABLE', 'The upstream service is unavailable.', true);
    }
  }

  return { getExhibit, llmAnswer, ttsWav };
}

function consumeDeltas(input, answer, flush = false) {
  let carry = input;
  let newline;
  while ((newline = carry.indexOf('\n')) >= 0) {
    const line = carry.slice(0, newline).trim();
    carry = carry.slice(newline + 1);
    if (!line) continue;
    answer = appendDelta(line, answer);
  }

  if (flush && carry.trim()) {
    answer = appendDelta(carry.trim(), answer);
    carry = '';
  }

  return { carry, answer };
}

function appendDelta(line, answer) {
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    throw new UpstreamError(502, 'LLM_UNAVAILABLE', 'Muse is temporarily unavailable.', true);
  }
  return typeof frame.delta === 'string' ? answer + frame.delta : answer;
}

async function readJson(response, code, message) {
  try {
    return await response.json();
  } catch {
    throw new UpstreamError(502, code, message, true);
  }
}

module.exports = { createUpstreamClient, UpstreamError };
