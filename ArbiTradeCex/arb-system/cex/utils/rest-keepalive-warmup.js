/**
 * 定时 silent getBalance，仅 warming REST keep-alive，不写 AccountCache。
 */
export class RestKeepAliveWarmup {
  /**
   * @param {object} opts
   * @param {import('../manager.js').CexManager} opts.cexManager
   * @param {string[]} opts.providers
   * @param {number} opts.intervalMs
   * @param {boolean} [opts.logFailures]
   */
  constructor({ cexManager, providers = [], intervalMs = 45000, logFailures = false } = {}) {
    this.cexManager = cexManager;
    this.providers = [...new Set(
      (providers || []).map((p) => String(p || '').trim().toLowerCase()).filter(Boolean)
    )];
    this.intervalMs = Math.max(0, Number(intervalMs) || 0);
    this.logFailures = logFailures;
    this._timer = null;
  }

  start() {
    if (this._timer || this.intervalMs <= 0 || !this.cexManager || this.providers.length === 0) {
      return false;
    }
    this._timer = setInterval(() => {
      this.pulse().catch(() => {});
    }, this.intervalMs);
    if (typeof this._timer.unref === 'function') {
      this._timer.unref();
    }
    return true;
  }

  stop() {
    if (!this._timer) return;
    clearInterval(this._timer);
    this._timer = null;
  }

  async pulse() {
    await Promise.all(this.providers.map((provider) => this.#warmProvider(provider)));
  }

  async #warmProvider(provider) {
    try {
      await this.cexManager.getBalance(provider, { silent: true });
    } catch (err) {
      if (this.logFailures) {
        console.warn(`[RestWarmup] ${provider} getBalance failed: ${err.message}`);
      }
    }
  }
}

export default RestKeepAliveWarmup;
