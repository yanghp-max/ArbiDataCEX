/**
 * 追加文本日志（带 ISO 时间戳），供拦单/延迟等需要留痕的输出使用。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';

let resolvedLogPath = null;
let mirrorToConsole = true;
let flushTimer = null;
let flushInFlight = false;
const FILE_FLUSH_INTERVAL_MS = 200;
const FILE_QUEUE_MAX = 5000;
const fileQueue = [];

function ensureFlushTimer() {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    flushFileQueue().catch((err) => {
      console.error('[append-text-log] async flush failed:', err.message);
    });
  }, FILE_FLUSH_INTERVAL_MS);
  if (typeof flushTimer.unref === 'function') {
    flushTimer.unref();
  }
}

async function flushFileQueue() {
  if (!resolvedLogPath || flushInFlight || fileQueue.length === 0) return;
  flushInFlight = true;
  const batch = fileQueue.splice(0, fileQueue.length);
  try {
    await fsp.mkdir(path.dirname(resolvedLogPath), { recursive: true });
    await fsp.appendFile(resolvedLogPath, `${batch.join('\n')}\n`, 'utf8');
  } finally {
    flushInFlight = false;
  }
}

export function configureTextLog({ rootDir, filePath, mirrorConsole = true } = {}) {
  if (!filePath) {
    resolvedLogPath = null;
    mirrorToConsole = mirrorConsole !== false;
    return;
  }
  const root = rootDir || process.cwd();
  resolvedLogPath = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(root, filePath);
  mirrorToConsole = mirrorConsole !== false;
  ensureFlushTimer();
}

export function getTextLogPath() {
  return resolvedLogPath;
}

/**
 * @param {string} message 单行正文（不含时间戳）
 * @param {{ level?: 'log'|'warn'|'error', mirrorConsole?: boolean }} [options]
 */
export function appendTextLog(message, options = {}) {
  const line = `[${new Date().toISOString()}] ${message}`;
  if (resolvedLogPath) {
    if (fileQueue.length >= FILE_QUEUE_MAX) {
      // 极端拥塞时丢弃最旧日志，避免内存膨胀。
      fileQueue.shift();
    }
    fileQueue.push(line);
    ensureFlushTimer();
  }
  const shouldMirror = options.mirrorConsole ?? mirrorToConsole;
  if (shouldMirror) {
    const level = options.level || 'log';
    if (level === 'warn') console.warn(message);
    else if (level === 'error') console.error(message);
    else console.log(message);
  }
}

export default { configureTextLog, appendTextLog, getTextLogPath };
