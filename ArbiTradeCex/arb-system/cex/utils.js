/**
 * CEX 模块工具函数（精简版，对齐 ArbiTrade-1 接口）
 */
import crypto from 'node:crypto';

export const timeUtils = {
  now() {
    return Date.now();
  },
  nowSeconds() {
    return Math.floor(Date.now() / 1000);
  },
  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
};

export const cryptoUtils = {
  hmacSha256(message, secret) {
    return crypto.createHmac('sha256', secret).update(message).digest('hex');
  },
  hmacSha512(message, secret) {
    return crypto.createHmac('sha512', secret).update(message).digest('hex');
  },
  sha512Hex(text) {
    return crypto.createHash('sha512').update(text || '').digest('hex');
  },
  randomString(length = 16) {
    return crypto.randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length);
  }
};

export const validationUtils = {
  isValidSide(side) {
    const s = String(side || '').toLowerCase();
    return s === 'buy' || s === 'sell';
  },
  isValidOrderType(type) {
    const t = String(type || '').toLowerCase();
    return t === 'market' || t === 'limit';
  }
};

export const mathUtils = {
  toNumber(value, defaultValue = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : defaultValue;
  }
};

export default { timeUtils, cryptoUtils, validationUtils, mathUtils };
