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

  return { getExhibit, ttsWav };
}

async function readJson(response, code, message) {
  try {
    return await response.json();
  } catch {
    throw new UpstreamError(502, code, message, true);
  }
}

module.exports = { createUpstreamClient, UpstreamError };
