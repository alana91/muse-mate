class SingleFlight {
  constructor() {
    this.inFlight = new Map();
  }

  run(key, factory) {
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const work = Promise.resolve().then(factory);
    this.inFlight.set(key, work);
    work.then(
      () => this.remove(key, work),
      () => this.remove(key, work)
    );
    return work;
  }

  remove(key, work) {
    if (this.inFlight.get(key) === work) this.inFlight.delete(key);
  }
}

module.exports = { SingleFlight };
