/**
 * CEX 基础适配器接口
 * 基于原代码设计，定义所有交易所适配器的统一接口
 */

import EventEmitter from 'events';
import { Ticker, OrderBook, Order, Balance, Position, EventTypes } from '../types.js';
import { Precision, P } from '../../common/utils/precision.js';
import { getEventBus } from '../../arbitrage/event-bus/index.js';

/**
 * 基础适配器抽象类
 * 所有交易所适配器都需要继承此类并实现抽象方法
 */
export class BaseAdapter extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.type = 'cex';
    this.provider = config.provider || null;
    this.connected = false;
    this.authenticated = false;
    this.subscriptions = new Map(); // symbol -> channels[]
    this.lastPing = 0;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectDelay = 5000;
    
    // WebSocket 连接
    this.ws = null;
    this.wsUrl = config.wsUrl;
    
    // API 请求相关
    this.apiUrl = config.apiUrl;
    this.timeout = config.timeout || 10000;
    
    // 限流控制
    this.requestQueue = [];
    this.lastRequestTime = 0;
    this.requestInterval = Math.ceil(60000 / (config.rateLimit?.requests || 100));
  }

  /**
   * 连接交易所
   */
  async connect() {
    try {
      this.emit(EventTypes.CONNECTED);
      this.connected = true;
      this.reconnectAttempts = 0;
      
      // 启动心跳
      this.startHeartbeat();
      
      console.log(`[${this.config.name}] Connected successfully`);
    } catch (error) {
      console.error(`[${this.config.name}] Connection failed:`, error);
      this.emit(EventTypes.ERROR, error);
      throw error;
    }
  }

  /**
   * 断开连接
   */
  async disconnect() {
    // 标记为正在关闭，避免重连
    this._shuttingDown = true;
    this.connected = false;
    this.authenticated = false;
    
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    
    this.stopHeartbeat();
    this.emit(EventTypes.DISCONNECTED);
    console.log(`[${this.config.name}] Disconnected`);
  }

  /**
   * 订阅实时数据
   * @param {string} symbol - 交易对
   * @param {string[]} channels - 订阅频道 ['ticker', 'orderbook', 'trades']
   */
  async subscribe(symbol, channels = ['ticker']) {
    if (!this.connected) {
      throw new Error('Not connected to exchange');
    }

    // 记录订阅信息
    if (!this.subscriptions.has(symbol)) {
      this.subscriptions.set(symbol, new Set());
    }
    
    const symbolChannels = this.subscriptions.get(symbol);
    channels.forEach(channel => symbolChannels.add(channel));

    console.log(`[${this.config.name}] Subscribed to ${symbol} channels: ${channels.join(', ')}`);
  }

  /**
   * 取消订阅
   * @param {string} symbol - 交易对
   * @param {string[]} channels - 取消订阅的频道
   */
  async unsubscribe(symbol, channels = []) {
    if (!this.subscriptions.has(symbol)) {
      return;
    }

    const symbolChannels = this.subscriptions.get(symbol);
    
    if (channels.length === 0) {
      // 取消所有频道
      this.subscriptions.delete(symbol);
    } else {
      // 取消指定频道
      channels.forEach(channel => symbolChannels.delete(channel));
      if (symbolChannels.size === 0) {
        this.subscriptions.delete(symbol);
      }
    }

    console.log(`[${this.config.name}] Unsubscribed from ${symbol} channels: ${channels.join(', ')}`);
  }

  /**
   * 启动心跳
   */
  startHeartbeat() {
    this.heartbeatInterval = setInterval(() => {
      if (this.connected && this.ws) {
        this.ping();
      }
    }, 30000); // 30秒心跳
  }

  /**
   * 停止心跳
   */
  stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  /**
   * 发送心跳
   */
  ping() {
    this.lastPing = Date.now();
    // 子类实现具体的心跳逻辑
  }

  /**
   * 限流控制
   */
  async rateLimit() {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    
    if (timeSinceLastRequest < this.requestInterval) {
      const delay = this.requestInterval - timeSinceLastRequest;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
    
    this.lastRequestTime = Date.now();
  }

  /**
   * 发送 HTTP 请求
   */
  async request(method, endpoint, params = {}, requiresAuth = false) {
    await this.rateLimit();
    
    let url = `${this.apiUrl}${endpoint}`;
    const options = {
      method: method.toUpperCase(),
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'ARB-System/1.0'
      },
      timeout: this.timeout
    };

    // 添加认证头（子类实现）
    if (requiresAuth) {
      Object.assign(options.headers, await this.getAuthHeaders(method, endpoint, params));
    }

    // 处理请求参数
    if (method.toUpperCase() === 'GET') {
      const query = new URLSearchParams(params).toString();
      if (query) {
        url += '?' + query;
      }
    } else {
      options.body = JSON.stringify(params);
    }

    try {
      const response = await fetch(url, options);
      const data = await response.json().catch(() => ({}));
      
      if (!response.ok) {
        const code = data?.code || data?.errCode;
        const msg = data?.msg || data?.message || response.statusText;
        throw new Error(`HTTP ${response.status}: ${msg}${code ? ` (code=${code})` : ''}`);
      }
      
      return data;
    } catch (error) {
      console.error(`[${this.config.name}] Request failed:`, error);
      throw error;
    }
  }

  // ===== 抽象方法，子类必须实现 =====

  /**
   * 获取认证头信息
   * @param {string} method - HTTP 方法
   * @param {string} endpoint - API 端点
   * @param {object} params - 请求参数
   */
  async getAuthHeaders(method, endpoint, params) {
    throw new Error('getAuthHeaders method must be implemented by subclass');
  }

  /**
   * 建立 WebSocket 连接
   */
  async connectWebSocket() {
    throw new Error('connectWebSocket method must be implemented by subclass');
  }

  /**
   * 处理 WebSocket 消息
   * @param {object} message - WebSocket 消息
   */
  handleWebSocketMessage(message) {
    throw new Error('handleWebSocketMessage method must be implemented by subclass');
  }

  /**
   * 获取交易对列表
   */
  async getSymbols() {
    throw new Error('getSymbols method must be implemented by subclass');
  }

  /**
   * 获取账户余额
   */
  async getBalance() {
    throw new Error('getBalance method must be implemented by subclass');
  }

  /**
   * 获取持仓信息（期货）
   */
  async getPositions() {
    throw new Error('getPositions method must be implemented by subclass');
  }

  /**
   * 获取特定资产的持仓信息（基于原代码设计）
   * @param {string} asset - 资产名称（如 'BTC', 'ETH'）
   * @returns {object|null} 持仓信息 { size: string, ... } 或 null
   */
  getPosition(asset) {
    throw new Error('getPosition method must be implemented by subclass');
  }

  /**
   * 获取特定资产的可用余额（基于原代码设计）
   * @param {string} asset - 资产名称（如 'BTC', 'ETH'）
   * @returns {number} 可用余额
   */
  getAvailable(asset) {
    throw new Error('getAvailable method must be implemented by subclass');
  }

  /**
   * 下单
   * @param {object} orderData - 订单数据
   */
  async placeOrder(orderData) {
    throw new Error('placeOrder method must be implemented by subclass');
  }

  /**
   * 撤销订单
   * @param {string} orderId - 订单ID
   * @param {string} symbol - 交易对
   */
  async cancelOrder(orderId, symbol) {
    throw new Error('cancelOrder method must be implemented by subclass');
  }

  /**
   * 获取订单状态
   * @param {string} orderId - 订单ID
   * @param {string} symbol - 交易对
   */
  async getOrderStatus(orderId, symbol) {
    throw new Error('getOrderStatus method must be implemented by subclass');
  }

  /**
   * 获取订单历史
   * @param {string} symbol - 交易对
   * @param {number} limit - 限制数量
   */
  async getOrderHistory(symbol, limit = 100) {
    throw new Error('getOrderHistory method must be implemented by subclass');
  }

  /**
   * 检查订单参数（预检）
   * @param {object} orderData - 订单数据
   */
  async checkOrder(orderData) {
    throw new Error('checkOrder method must be implemented by subclass');
  }

  // ===== 通用工具方法 =====

  /**
   * 标准化交易对格式
   * @param {string} symbol - 原始交易对
   */
  normalizeSymbol(symbol) {
    // 子类可以重写此方法
    return symbol.toUpperCase().replace('/', '-');
  }

  /**
   * 解析原始交易对格式
   * @param {string} symbol - 标准化交易对
   */
  parseSymbol(symbol) {
    // 子类可以重写此方法
    return symbol.replace('-', '/');
  }

  /**
   * 格式化数字精度
   * @param {number} value - 数值
   * @param {number} precision - 精度
   */
  formatPrecision(value, precision) {
    // 🎯 重要：保持原始数值精度，不做任何格式化截取
    return P.toNumber(P.big(value));
  }

  /**
   * 生成客户端订单ID
   */
  generateClientOrderId() {
    return `arb_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * 验证订单参数
   * @param {object} orderData - 订单数据
   */
  validateOrderData(orderData) {
    const required = ['symbol', 'side', 'type', 'amount'];
    const missing = required.filter(field => !orderData[field]);
    
    if (missing.length > 0) {
      throw new Error(`Missing required fields: ${missing.join(', ')}`);
    }

    if (orderData.type === 'limit' && !orderData.price) {
      throw new Error('Price is required for limit orders');
    }

    if (orderData.amount <= 0) {
      throw new Error('Order amount must be greater than 0');
    }

    if (orderData.price && orderData.price <= 0) {
      throw new Error('Order price must be greater than 0');
    }
  }

  /**
   * 获取交易所名称
   */
  getName() {
    return this.config.name;
  }

  /**
   * 获取连接状态
   */
  isConnected() {
    return this.connected;
  }

  /**
   * 获取认证状态
   */
  isAuthenticated() {
    return this.authenticated;
  }

  /**
   * 从缓存获取指定杠杆倍数下的最大名义价值
   * 默认返回 null（子类可覆盖）
   *
   * @param {string} symbol - 标准化交易对
   * @param {number} leverage - 杠杆倍数
   * @returns {number|null}
   */
  getMaxNotionalForLeverage(symbol, leverage) {
    return null;
  }

  /**
   * 获取指定交易对的 CEX 约束信息（默认返回 null，子类覆盖）
   *
   * @param {string} symbol - 标准化交易对（如 'BTC-USDT'）
   * @returns {{ minQty: number, maxQty: number, stepSize: number, minNotional: number } | null}
   */
  getSymbolConstraints(symbol) {
    return null;
  }

  /**
   * 🎯 发出标准化的仓位更新事件
   * 统一所有适配器的仓位事件格式，便于 AccountStreamWriter 统一处理
   *
   * @param {Array<Position>} positions - 仓位数组
   */
  emitPositionUpdate(positions) {
    const data = {
      adapterId: this.id || this.config.name?.toLowerCase() || 'unknown',  // 适配器ID
      adapterType: this.type || 'cex',                                     // 'cex' 或 'dex'
      exchange: this.config.name,                                          // 交易所名称
      positions: positions || [],                                          // 仓位数组
      timestamp: Date.now()
    };

    // 发出统一格式的 POSITION_UPDATE 事件
    this.emit('POSITION_UPDATE', data);

    // 🎯 同时发出到全局EventBus（供AccountStreamWriter监听）
    try {
      const globalBus = getEventBus();
      globalBus.emit('POSITION_UPDATE', data);
    } catch (error) {
      console.error(`[${this.config.name}] Failed to emit to global EventBus:`, error.message);
    }

    console.log(`[${this.config.name}] Position update emitted: ${positions?.length || 0} positions`);
  }

  /**
   * 🎯 发出标准化的余额更新事件
   * 统一所有适配器的余额事件格式，便于 AccountStreamWriter 统一处理
   *
   * @param {Array<Balance>} balances - 余额数组
   */
  emitBalanceUpdate(balances) {
    const data = {
      adapterId: this.id || this.config.name?.toLowerCase() || 'unknown',  // 适配器ID
      adapterType: this.type || 'cex',                                     // 'cex' 或 'dex'
      exchange: this.config.name,                                          // 交易所名称
      balances: balances || [],                                            // 余额数组
      timestamp: Date.now()
    };

    // 发出统一格式的 BALANCE_UPDATE 事件
    this.emit('BALANCE_UPDATE', data);

    // 🎯 同时发出到全局EventBus（供AccountStreamWriter监听）
    try {
      const globalBus = getEventBus();
      globalBus.emit('BALANCE_UPDATE', data);
    } catch (error) {
      console.error(`[${this.config.name}] Failed to emit balance to global EventBus:`, error.message);
    }

    console.log(`[${this.config.name}] Balance update emitted: ${balances?.length || 0} balances`);
  }
}
