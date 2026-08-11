class GreetingCache {
  constructor({ ttlMs, maxEntries, now = Date.now }) {
    if (!Number.isInteger(ttlMs) || ttlMs <= 0) throw new Error('cache TTL must be a positive integer');
    if (!Number.isInteger(maxEntries) || maxEntries <= 0) throw new Error('cache size must be a positive integer');

    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.now = now;
    this.entries = new Map();
  }

  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return null;

    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return null;
    }

    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.greeting;
  }

  set(key, greeting) {
    const now = this.now();
    this.pruneExpired(now);
    this.entries.delete(key);
    this.entries.set(key, {
      greeting,
      expiresAt: now + this.ttlMs
    });

    while (this.entries.size > this.maxEntries) {
      const leastRecentlyUsedKey = this.entries.keys().next().value;
      this.entries.delete(leastRecentlyUsedKey);
    }
  }

  pruneExpired(now = this.now()) {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }
}

function greetingCacheKey(exhibitId, lang) {
  return `greeting:${exhibitId}:${lang}`;
}

module.exports = { GreetingCache, greetingCacheKey };
