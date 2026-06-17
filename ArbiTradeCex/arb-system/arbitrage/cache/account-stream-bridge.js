/**
 * 将适配器 BALANCE_UPDATE / POSITION_UPDATE 写入 AccountCache
 */
function exchangeKey(adapter) {
  const id = adapter?.id || adapter?.config?.name?.toLowerCase() || '';
  if (id.includes('binance')) return 'binance';
  if (id.includes('gate')) return 'gate';
  return id;
}

export class AccountStreamBridge {
  constructor({ cexManager, accountCache, symbols = [] } = {}) {
    this.cexManager = cexManager;
    this.accountCache = accountCache;
    this.symbols = symbols;
    this._handlers = [];
  }

  #onBalance(adapter, payload) {
    const ex = exchangeKey(adapter);
    if (!ex) return;
    for (const row of payload.balances || []) {
      if (String(row.currency).toUpperCase() !== 'USDT') continue;
      this.accountCache.mergeBalance(ex, {
        currency: 'USDT',
        total: row.total,
        available: row.available,
        marginUsed: row.marginUsed ?? row.frozen
      });
    }
  }

  #onPosition(adapter, payload) {
    const ex = exchangeKey(adapter);
    if (!ex) return;
    for (const pos of payload.positions || []) {
      this.accountCache.mergePosition(ex, pos.symbol, pos.qty);
    }
  }

  #onWsStatus(exchange, { connected, reliable }) {
    this.accountCache.setWsStatus(exchange, { connected, reliable });
  }

  bindAdapter(adapter) {
    const balHandler = (data) => this.#onBalance(adapter, data);
    const posHandler = (data) => this.#onPosition(adapter, data);
    const onConnected = (payload = {}) => {
      const ex = exchangeKey(adapter);
      if (!ex) return;
      const positionsReady = payload.positionsReady !== false;
      if (ex === 'gate' && !positionsReady) {
        this.#onWsStatus(ex, {
          connected: true,
          reliable: this.accountCache.isReliable(ex)
        });
        return;
      }
      this.#onWsStatus(ex, { connected: true, reliable: true });
    };
    const onDisconnected = () => {
      const ex = exchangeKey(adapter);
      if (ex) this.#onWsStatus(ex, { connected: false, reliable: false });
    };
    adapter.on('BALANCE_UPDATE', balHandler);
    adapter.on('POSITION_UPDATE', posHandler);
    adapter.on('PRIVATE_WS_CONNECTED', onConnected);
    adapter.on('PRIVATE_WS_DISCONNECTED', onDisconnected);
    this._handlers.push({ adapter, balHandler, posHandler, onConnected, onDisconnected });
  }

  async start() {
    for (const adapter of this.cexManager.adapters.values()) {
      if (adapter) this.bindAdapter(adapter);
    }

    try {
      await this.cexManager.startPrivateAccountStreams(this.symbols);
      console.log('[AccountStreamBridge] private account WS started');
    } catch (err) {
      console.error(
        '[AccountStreamBridge] private WS failed, will use REST refresh only:',
        err.message
      );
    }
  }

  async stop() {
    for (const { adapter, balHandler, posHandler, onConnected, onDisconnected } of this._handlers) {
      adapter.off('BALANCE_UPDATE', balHandler);
      adapter.off('POSITION_UPDATE', posHandler);
      if (onConnected) adapter.off('PRIVATE_WS_CONNECTED', onConnected);
      if (onDisconnected) adapter.off('PRIVATE_WS_DISCONNECTED', onDisconnected);
    }
    this._handlers = [];
    await this.cexManager.stopPrivateAccountStreams();
  }
}

export function bindAccountStream(options) {
  return new AccountStreamBridge(options);
}

export default AccountStreamBridge;
