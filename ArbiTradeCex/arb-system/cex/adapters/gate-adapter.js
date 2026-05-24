/**
 * Gate 公共行情 WS + REST 账户/下单
 */
import WebSocket from 'ws';
import axios from 'axios';
import crypto from 'node:crypto';
import { BaseAdapter } from './base-adapter.js';

export class GateAdapter extends BaseAdapter {
  constructor(config = {}) {
    super({
      name: 'Gate',
      wsUrl: process.env.GATE_FX_WS_URL || 'wss://fx-ws.gateio.ws/v4/ws/usdt',
      restUrl: process.env.GATE_REST_URL || 'https://api.gateio.ws/api/v4',
      ...config
    });
    this.ws = null;
    this.subscribed = [];
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
      this.ws.on('open', async () => {
        if (this.subscribed.length) {
          await this.subscribe(this.subscribed);
        }
        resolve();
      });
      this.ws.on('message', (raw) => this.#onMessage(raw));
      this.ws.on('close', () => {
        this.connected = false;
        setTimeout(() => this.#connectWs().catch(() => {}), 1000);
      });
      this.ws.on('error', reject);
    });
  }

  async subscribe(symbols) {
    this.subscribed = [...symbols];
    if (!this.ws) return;
    const contracts = symbols.map((s) => this.toGateContract(s));
    this.ws.send(JSON.stringify({
      time: Math.floor(Date.now() / 1000),
      channel: 'futures.book_ticker',
      event: 'subscribe',
      payload: contracts
    }));
  }

  #onMessage(raw) {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.channel !== 'futures.book_ticker' || msg.event !== 'update') return;
      const r = msg.result || {};
      const sym = String(r.s || r.contract || '').replace('_', '');
      if (!sym) return;
      this.emit('ticker', {
        symbol: this.normalizeSymbol(sym),
        bid: Number(r.b),
        ask: Number(r.a),
        timestamp: (r.t || Date.now() / 1000) * (r.t > 1e12 ? 1 : 1000),
        localTimestamp: Date.now(),
        source: 'gate'
      });
    } catch {
      // ignore
    }
  }

  async getFundingRate(symbol) {
    const contract = this.toGateContract(symbol);
    const { data } = await axios.get(`${this.config.restUrl}/futures/usdt/funding_rate`, {
      params: { contract, limit: 1 },
      timeout: this.config.timeout
    });
    const item = Array.isArray(data) ? data[data.length - 1] : data;
    return Number(item?.r ?? item?.funding_rate ?? NaN);
  }

  #signV4({ method, path, queryString, body, timestamp }) {
    const secret = process.env.GATE_API_SECRET;
    const bodyHash = crypto.createHash('sha512').update(body || '').digest('hex');
    const payload = `${method}\n${path}\n${queryString}\n${bodyHash}\n${timestamp}`;
    return crypto.createHmac('sha512', secret).update(payload).digest('hex');
  }

  async #signedRequest(method, path, bodyObj = null) {
    const key = process.env.GATE_API_KEY;
    const pathWithPrefix = `/api/v4${path}`;
    const queryString = '';
    const body = bodyObj ? JSON.stringify(bodyObj) : '';
    const timestamp = String(Math.floor(Date.now() / 1000));
    const sign = this.#signV4({ method, path: pathWithPrefix, queryString, body, timestamp });
    const url = `${this.config.restUrl}${path}`;
    const config = {
      method,
      url,
      headers: { KEY: key, Timestamp: timestamp, SIGN: sign, 'Content-Type': 'application/json' },
      timeout: 15000
    };
    if (bodyObj) config.data = bodyObj;
    const { data } = await axios(config);
    return data;
  }

  async getUsdtBalance() {
    const data = await this.#signedRequest('GET', '/unified/accounts');
    const usdt = data?.balances?.USDT || data?.details?.USDT || {};
    const available = Number(usdt.available ?? usdt.available_margin ?? usdt.equity ?? 0);
    return { total: available, available, updatedAtMs: Date.now() };
  }

  async getPositions() {
    const rows = await this.#signedRequest('GET', '/futures/usdt/positions');
    return (rows || [])
      .filter((r) => Math.abs(Number(r.size)) > 0)
      .map((r) => {
        const sym = String(r.contract || '').replace('_', '');
        const size = Number(r.size);
        const multiplier = Number(r.quanto_multiplier || 1);
        return {
          symbol: this.normalizeSymbol(sym),
          qty: size * multiplier,
          contracts: size,
          updatedAtMs: Date.now()
        };
      });
  }

  async placeMarketOrder({ contract, size }) {
    return this.#signedRequest('POST', '/futures/usdt/orders', {
      contract,
      size: Number(size),
      price: '0',
      tif: 'ioc'
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

export default GateAdapter;
