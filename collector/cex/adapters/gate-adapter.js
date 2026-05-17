/**
 * Gate Futures 行情适配器（CEX B）
 */
import WebSocket from 'ws';
import axios from 'axios';
import { BaseAdapter } from './base-adapter.js';

export class GateAdapter extends BaseAdapter {
  constructor(config = {}) {
    super({
      name: 'Gate',
      wsUrl: 'wss://fx-ws.gateio.ws/v4/ws/usdt',
      restUrl: 'https://api.gateio.ws/api/v4',
      ...config
    });
    this.ws = null;
    this.subscribed = [];
  }

  async loadSymbols() {
    const response = await axios.get(`${this.config.restUrl}/futures/usdt/contracts`, {
      timeout: this.config.timeout
    });
    const set = new Set();
    for (const c of response.data || []) {
      const name = c.name || c.contract;
      if (!name || !String(name).endsWith('_USDT')) continue;
      if (c.in_delisting === true) continue;
      set.add(String(name));
    }
    return set;
  }

  async connect() {
    await this.connectWebSocket();
    this.connected = true;
  }

  async connectWebSocket() {
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    await new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.config.wsUrl);
      this.ws.on('open', async () => {
        if (this.subscribed.length > 0) {
          await this.subscribe(this.subscribed, ['book_ticker']);
        }
        resolve();
      });
      this.ws.on('message', (raw) => this.handleMessage(raw));
      this.ws.on('close', () => {
        this.connected = false;
        setTimeout(() => {
          this.connectWebSocket().catch(() => {});
        }, 1000);
      });
      this.ws.on('error', (e) => reject(e));
    });
  }

  async subscribe(symbols, channels = ['book_ticker']) {
    this.subscribed = [...symbols];
    if (!this.ws) return;
    const gateSymbols = symbols.map((s) => s.replace('-', '_'));
    for (const ch of channels) {
      const payload = {
        time: Math.floor(Date.now() / 1000),
        channel: `futures.${ch}`,
        event: 'subscribe',
        payload: gateSymbols
      };
      this.ws.send(JSON.stringify(payload));
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  handleMessage(raw) {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.channel !== 'futures.book_ticker' || msg.event !== 'update') return;
      const r = msg.result || {};
      const symbol = this.normalizeSymbol(String(r.s || r.contract || '').replace('_', ''));
      if (!symbol) return;
      this.emit('ticker', {
        symbol,
        bid: Number(r.b),
        ask: Number(r.a),
        serverTimestamp: r.t || null,
        localTimestamp: Date.now(),
        source: 'gate'
      });
    } catch {
      // ignore parse error
    }
  }

  async getFundingRate(symbol) {
    const gateSymbol = this.toExchangeSymbol(symbol).replace('USDT', '_USDT');
    const response = await axios.get(`${this.config.restUrl}/futures/usdt/funding_rate`, {
      params: { contract: gateSymbol, limit: 1 },
      timeout: this.config.timeout
    });
    const data = response.data;
    const item = Array.isArray(data) ? data[data.length - 1] : data;
    return Number(item?.r ?? item?.funding_rate ?? item?.rate ?? NaN);
  }

  async disconnect() {
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }
}

export default GateAdapter;
