/**
 * Binance Futures 行情适配器（CEX A）
 */
import WebSocket from 'ws';
import axios from 'axios';
import { BaseAdapter } from './base-adapter.js';

export class BinanceAdapter extends BaseAdapter {
  constructor(config = {}) {
    super({
      name: 'Binance',
      wsUrl: 'wss://fstream.binance.com/ws',
      restUrl: 'https://fapi.binance.com',
      ...config
    });
    this.ws = null;
    this.activeSubscriptions = new Set();
    this.subscriptionQueue = [];
    this.processing = false;
  }

  async loadSymbols() {
    const response = await axios.get(`${this.config.restUrl}/fapi/v1/exchangeInfo`, {
      timeout: this.config.timeout
    });
    const set = new Set();
    for (const s of response.data.symbols || []) {
      if (s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT' && s.status === 'TRADING') {
        set.add(String(s.symbol));
      }
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
      this.ws.on('open', () => resolve());
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

  async subscribe(symbols, channels = ['bookTicker']) {
    for (const symbol of symbols) {
      const exSymbol = this.toExchangeSymbol(symbol).toLowerCase();
      for (const ch of channels) {
        this.subscriptionQueue.push(`${exSymbol}@${ch}`);
      }
    }
    await this.processQueue();
  }

  async processQueue() {
    if (this.processing || !this.ws) return;
    this.processing = true;
    while (this.subscriptionQueue.length > 0) {
      const batch = this.subscriptionQueue.splice(0, 10);
      const payload = { method: 'SUBSCRIBE', params: batch, id: Date.now() };
      this.ws.send(JSON.stringify(payload));
      for (const s of batch) this.activeSubscriptions.add(s);
      await new Promise((r) => setTimeout(r, 300));
    }
    this.processing = false;
  }

  handleMessage(raw) {
    try {
      const msg = JSON.parse(raw.toString());
      if (!(msg.s && msg.b !== undefined && msg.a !== undefined)) return;
      const symbol = this.normalizeSymbol(msg.s);
      this.emit('ticker', {
        symbol,
        bid: Number(msg.b),
        ask: Number(msg.a),
        serverTimestamp: msg.E || null,
        localTimestamp: Date.now(),
        source: 'binance'
      });
    } catch {
      // ignore parse error
    }
  }

  async getFundingRate(symbol) {
    const ex = this.toExchangeSymbol(symbol);
    const response = await axios.get(`${this.config.restUrl}/fapi/v1/premiumIndex`, {
      params: { symbol: ex },
      timeout: this.config.timeout
    });
    return Number(response.data.lastFundingRate);
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

export default BinanceAdapter;
