/**
 * Shared HTTP(S) keep-alive agents for exchange REST (reuse TCP/TLS).
 */
import http from 'node:http';
import https from 'node:https';

const agentByOrigin = new Map();

const AGENT_OPTIONS = {
  keepAlive: true,
  maxSockets: 64,
  maxFreeSockets: 16,
  scheduling: 'fifo'
};

function originOf(url) {
  const raw = String(url || '').trim();
  if (!raw) throw new Error('http-agents: url required');
  return new URL(raw.includes('://') ? raw : `https://${raw}`).origin;
}

export function axiosKeepAliveOptions(url) {
  const origin = originOf(url);
  if (!agentByOrigin.has(origin)) {
    const isHttps = origin.startsWith('https:');
    const agent = isHttps
      ? new https.Agent(AGENT_OPTIONS)
      : new http.Agent(AGENT_OPTIONS);
    agentByOrigin.set(origin, {
      httpAgent: isHttps ? undefined : agent,
      httpsAgent: isHttps ? agent : undefined
    });
  }
  return agentByOrigin.get(origin);
}

/** Merge keep-alive agents into an axios config (requires config.url or baseURL). */
export function withKeepAlive(axiosConfig = {}) {
  const url = axiosConfig.url || axiosConfig.baseURL;
  if (!url) return axiosConfig;
  return { ...axiosConfig, ...axiosKeepAliveOptions(url) };
}

export async function warmupHttpKeepAlive(baseUrl, probeFn) {
  if (typeof probeFn === 'function') {
    await probeFn();
    return;
  }
  const { httpsAgent, httpAgent } = axiosKeepAliveOptions(baseUrl);
  const agent = httpsAgent || httpAgent;
  if (!agent) return;
  await new Promise((resolve) => {
    const req = (httpsAgent ? https : http).request({
      agent,
      hostname: new URL(baseUrl.includes('://') ? baseUrl : `https://${baseUrl}`).hostname,
      port: new URL(baseUrl.includes('://') ? baseUrl : `https://${baseUrl}`).port
        || (httpsAgent ? 443 : 80),
      path: '/',
      method: 'HEAD',
      timeout: 5000
    }, (res) => {
      res.resume();
      resolve();
    });
    req.on('error', () => resolve());
    req.on('timeout', () => {
      req.destroy();
      resolve();
    });
    req.end();
  });
}

export default { axiosKeepAliveOptions, withKeepAlive, warmupHttpKeepAlive };
