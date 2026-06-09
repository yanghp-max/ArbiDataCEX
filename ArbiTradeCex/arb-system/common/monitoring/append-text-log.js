/**
 * 追加文本日志（带 ISO 时间戳），供拦单/延迟等需要留痕的输出使用。
 */
import fs from 'node:fs';
import path from 'node:path';

let resolvedLogPath = null;
let mirrorToConsole = true;

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
    try {
      fs.mkdirSync(path.dirname(resolvedLogPath), { recursive: true });
      fs.appendFileSync(resolvedLogPath, `${line}\n`, 'utf8');
    } catch (err) {
      console.error('[append-text-log] write failed:', err.message);
    }
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
