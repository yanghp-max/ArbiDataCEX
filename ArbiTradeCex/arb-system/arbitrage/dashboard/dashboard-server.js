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
      this.httpServer.listen(this.port, resolve);
      this.httpServer.on('error', reject);
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

  broadcast(msg) {
    const raw = JSON.stringify(msg);
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN) ws.send(raw);
    }
  }

  async #handleHttp(req, res) {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
    filePath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, '');
    const abs = path.join(this.publicDir, filePath);
    if (!abs.startsWith(this.publicDir)) {
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
