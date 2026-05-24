/**
 * Binance 公共行情 WS + REST 账户/下单（papi）
 */
import WebSocket from 'ws';
import axios from 'axios';
import crypto from 'node:crypto';
import { BaseAdapter } from './base-adapter.js';

export class BinanceAdapter extends BaseAdapter {
  constructor(config = {}) {
    super({
      name: 'Binance',
      wsUrl: process.env.BINANCE_WS_URL || 'wss://fstream.binance.com/ws',
      restUrl: process.env.BINANCE_REST_URL || 'https://fapi.binance.com',
      papiRestUrl: process.env.BINANCE_PAPI_REST_URL || 'https://papi.binance.com',
      ...config
    });
    this.ws = null;
    this.subscriptionQueue = [];
    this.processing = false;
  }

  async connect() {
    await this.#connectWs();
    this.connected = true;
  }

  async #connectWs() {
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
    }
    await new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.config.wsUrl);
      this.ws.on('open', () => resolve());
      this.ws.on('message', (raw) => this.#onMessage(raw));
      this.ws.on('close', () => {
        this.connected = false;
        setTimeout(() => this.#connectWs().catch(() => {}), 1000);
      });
      this.ws.on('error', reject);
    });
  }

  async subscribe(symbols, channels = ['bookTicker']) {
    for (const symbol of symbols) {
      const ex = this.toExchangeSymbol(symbol).toLowerCase();
      for (const ch of channels) {
        this.subscriptionQueue.push(`${ex}@${ch}`);
      }
    }
    await this.#processQueue();
  }

  async #processQueue() {
    if (this.processing || !this.ws) return;
    this.processing = true;
    while (this.subscriptionQueue.length) {
      const batch = this.subscriptionQueue.splice(0, 10);
      this.ws.send(JSON.stringify({ method: 'SUBSCRIBE', params: batch, id: Date.now() }));
      await new Promise((r) => setTimeout(r, 300));
    }
    this.processing = false;
  }

  #onMessage(raw) {
    try {
      const msg = JSON.parse(raw.toString());
      if (!(msg.s && msg.b != null && msg.a != null)) return;
      this.emit('ticker', {
        symbol: this.normalizeSymbol(msg.s),
        bid: Number(msg.b),
        ask: Number(msg.a),
        timestamp: msg.E || Date.now(),
        localTimestamp: Date.now(),
        source: 'binance'
      });
    } catch {
      // ignore
    }
  }

  async getFundingRate(symbol) {
    const { data } = await axios.get(`${this.config.restUrl}/fapi/v1/premiumIndex`, {
      params: { symbol: this.toExchangeSymbol(symbol) },
      timeout: this.config.timeout
    });
    return Number(data.lastFundingRate);
  }

  #sign(query) {
    const secret = process.env.BINANCE_API_SECRET;
    return crypto.createHmac('sha256', secret).update(query).digest('hex');
  }

  async #signedGet(path, params = {}) {
    const key = process.env.BINANCE_API_KEY;
    const p = new URLSearchParams({ ...params, timestamp: String(Date.now()), recvWindow: '5000' });
    const sig = this.#sign(p.toString());
    const url = `${this.config.papiRestUrl}${path}?${p}&signature=${sig}`;
    const { data } = await axios.get(url, { headers: { 'X-MBX-APIKEY': key }, timeout: 15000 });
    return data;
  }

  async #signedPost(path, params = {}) {
    const key = process.env.BINANCE_API_KEY;
    const p = new URLSearchParams({ ...params, timestamp: String(Date.now()), recvWindow: '5000' });
    const sig = this.#sign(p.toString());
    const url = `${this.config.papiRestUrl}${path}?${p}&signature=${sig}`;
    const { data } = await axios.post(url, null, { headers: { 'X-MBX-APIKEY': key }, timeout: 15000 });
    return data;
  }

  async getUsdtBalance() {
    const rows = await this.#signedGet('/papi/v1/balance');
    const usdt = rows.find((r) => r.asset === 'USDT');
    const total = Number(usdt?.umWalletBalance || 0) + Number(usdt?.crossMarginFree || 0);
    return { total, available: total, updatedAtMs: Date.now() };
  }

  async getPositions() {
    const rows = await this.#signedGet('/papi/v1/um/positionRisk');
    return rows
      .filter((r) => Math.abs(Number(r.positionAmt)) > 0)
      .map((r) => ({
        symbol: this.normalizeSymbol(r.symbol),
        qty: Number(r.positionAmt),
        updatedAtMs: Date.now()
      }));
  }

  async placeMarketOrder({ symbol, side, quantity }) {
    return this.#signedPost('/papi/v1/um/order', {
      symbol: this.toExchangeSymbol(symbol),
      side,
      type: 'MARKET',
      quantity: String(quantity)
    });
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
