/**
 * Dashboard HTTP + WebSocket 服务
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { WebSocketServer } from 'ws';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.map': 'application/json'
};

export class DashboardServer {
  constructor({ port = 3456, publicDir }) {
    this.port = port;
    this.publicDir = publicDir;
    this.httpServer = null;
    this.wss = null;
    this.clients = new Set();
  }

  async start() {
    this.httpServer = http.createServer((req, res) => {
      this.#handleHttp(req, res).catch((err) => {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(err.message);
      });
    });

    this.wss = new WebSocketServer({ server: this.httpServer });
    this.wss.on('connection', (ws) => {
      this.clients.add(ws);
      if (this.onClientConnect) this.onClientConnect(ws);
      ws.on('close', () => this.clients.delete(ws));
    });

    await new Promise((resolve, reject) => {
      const onError = (err) => {
        if (err?.code === 'EADDRINUSE') {
          reject(new Error(
            `Dashboard port ${this.port} already in use (EADDRINUSE). `
            + `Stop the other process or change dashboard.port in config.json. `
            + `Windows: netstat -ano | findstr :${this.port}  then  taskkill /PID <pid> /F`
          ));
          return;
        }
        reject(err);
      };
      this.httpServer.once('error', onError);
      this.httpServer.listen(this.port, () => {
        this.httpServer.removeListener('error', onError);
        resolve();
      });
    });
  }

  async stop() {
    for (const ws of this.clients) ws.close();
    this.clients.clear();
    await new Promise((resolve) => {
      this.wss?.close(() => resolve());
    });
    await new Promise((resolve) => {
      this.httpServer?.close(() => resolve());
    });
  }

  hasClients() {
    return this.clients.size > 0;
  }

  broadcast(msg) {
    if (!this.clients.size) return;
    const raw = JSON.stringify(msg);
    for (const ws of this.clients) {
      if (ws.readyState !== ws.OPEN) continue;
      // 客户端消费不过来时跳过推送，避免 ws 内部队列无限膨胀
      if (ws.bufferedAmount > 2_000_000) continue;
      ws.send(raw);
    }
  }

  async #handleAccountApi(req, res, action) {
    const send = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };
    try {
      if (!this.accountApi) {
        send(503, { ok: false, error: 'account_api_unavailable' });
        return;
      }
      if (action === 'snapshot') {
        const data = await this.accountApi.refreshSnapshot();
        send(200, { ok: true, data });
        return;
      }
      if (action === 'baseline') {
        const data = this.accountApi.setBaseline();
        send(200, { ok: true, data });
        return;
      }
      if (action === 'reload-config') {
        const data = await this.accountApi.reloadConfig();
        send(200, { ok: true, data });
        return;
      }
      send(404, { ok: false, error: 'not_found' });
    } catch (err) {
      send(500, { ok: false, error: err.message || String(err) });
    }
  }

  async #handleHttp(req, res) {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);

    if (url.pathname === '/api/account/snapshot' && req.method === 'POST') {
      await this.#handleAccountApi(req, res, 'snapshot');
      return;
    }
    if (url.pathname === '/api/account/baseline' && req.method === 'POST') {
      await this.#handleAccountApi(req, res, 'baseline');
      return;
    }
    if (url.pathname === '/api/config/reload' && req.method === 'POST') {
      await this.#handleAccountApi(req, res, 'reload-config');
      return;
    }
    let rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^[/\\]+/, '');
    rel = path.normalize(rel).replace(/^(\.\.([/\\]|$))+/, '');
    const publicRoot = path.resolve(this.publicDir);
    const abs = path.resolve(publicRoot, rel);
    if (abs !== publicRoot && !abs.startsWith(`${publicRoot}${path.sep}`)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    try {
      const data = await fs.readFile(abs);
      const ext = path.extname(abs);
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': 'no-store, no-cache, must-revalidate'
      });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end('Not Found');
    }
  }
}

export default DashboardServer;
