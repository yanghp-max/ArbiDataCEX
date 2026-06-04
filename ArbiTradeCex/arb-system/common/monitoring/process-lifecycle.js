/**
 * 进程生命周期与内存心跳日志。
 *
 * 说明：SIGKILL（含 Linux OOM Killer）无法在进程内捕获或写日志。
 * 本模块会记录可捕获信号、异常退出，并定期写入内存快照，便于事后对照阿里云 ECS 上的 Killed。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function readLinuxMemAvailableMb() {
  try {
    const text = fs.readFileSync('/proc/meminfo', 'utf8');
    const m = text.match(/MemAvailable:\s+(\d+)\s+kB/i);
    return m ? Math.round(Number(m[1]) / 1024) : null;
  } catch {
    return null;
  }
}

function snapshotMem() {
  const mu = process.memoryUsage();
  return {
    rssMb: Math.round(mu.rss / 1024 / 1024),
    heapUsedMb: Math.round(mu.heapUsed / 1024 / 1024),
    heapTotalMb: Math.round(mu.heapTotal / 1024 / 1024),
    externalMb: Math.round(mu.external / 1024 / 1024),
    arrayBuffersMb: Math.round((mu.arrayBuffers || 0) / 1024 / 1024),
    sysMemAvailableMb: readLinuxMemAvailableMb()
  };
}

function appendJsonl(filePath, row) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function writeLastExit(filePath, row) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(row, null, 2)}\n`, 'utf8');
}

export function startProcessLifecycleLogging(options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const logPath = options.logPath
    ? (path.isAbsolute(options.logPath) ? options.logPath : path.resolve(rootDir, options.logPath))
    : path.resolve(rootDir, 'logs/process-health.jsonl');
  const lastExitPath = options.lastExitPath
    ? (path.isAbsolute(options.lastExitPath) ? options.lastExitPath : path.resolve(rootDir, options.lastExitPath))
    : path.resolve(rootDir, 'logs/last-exit.json');
  const intervalMs = Number(options.intervalMs) > 0 ? Number(options.intervalMs) : 30000;
  const logToConsole = options.logToConsole !== false;
  const startedAt = Date.now();
  let heartbeatTimer = null;
  let stopping = false;

  const emit = (event, detail = {}) => {
    const row = {
      ts: Date.now(),
      iso: new Date().toISOString(),
      event,
      pid: process.pid,
      ppid: process.ppid,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      platform: `${os.platform()}/${os.release()}`,
      node: process.version,
      mem: snapshotMem(),
      ...detail
    };
    if (logToConsole) {
      console.log('[lifecycle]', JSON.stringify(row));
    }
    try {
      appendJsonl(logPath, row);
    } catch (err) {
      console.error('[lifecycle] failed to write log:', err.message);
    }
    return row;
  };

  const readPreviousExit = () => {
    try {
      const text = fs.readFileSync(lastExitPath, 'utf8');
      return JSON.parse(text);
    } catch {
      return null;
    }
  };

  const prev = readPreviousExit();
  if (prev) {
    const gapMin = prev.ts ? Math.round((Date.now() - prev.ts) / 60000) : null;
    console.warn(
      `[lifecycle] previous run ended: event=${prev.event} signal=${prev.signal ?? 'n/a'} `
      + `code=${prev.exitCode ?? 'n/a'} rssMb=${prev.mem?.rssMb ?? 'n/a'} `
      + `${gapMin != null ? `(${gapMin} min ago)` : ''}`
    );
    if (prev.hint) console.warn(`[lifecycle] hint: ${prev.hint}`);
  }

  emit('START', {
    meta: options.meta ?? null,
    argv: process.argv.slice(2),
    note: 'SIGKILL/OOM cannot be logged in-process; if terminal shows only "Killed", check ECS dmesg or last HEARTBEAT rssMb'
  });

  heartbeatTimer = setInterval(() => {
    emit('HEARTBEAT');
  }, intervalMs);
  if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();

  const onSignal = (signal) => {
    if (stopping) return;
    stopping = true;
    const row = emit('SIGNAL', { signal });
    writeLastExit(lastExitPath, {
      ...row,
      exitCode: null,
      hint: 'graceful shutdown in progress'
    });
  };

  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  process.on('SIGHUP', () => {
    emit('SIGNAL', { signal: 'SIGHUP', hint: 'often SSH disconnect if not using nohup/systemd' });
  });

  process.on('uncaughtException', (err) => {
    const row = emit('UNCAUGHT_EXCEPTION', { message: err.message, stack: err.stack });
    writeLastExit(lastExitPath, { ...row, exitCode: 1 });
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    emit('UNHANDLED_REJECTION', {
      message: reason?.message || String(reason),
      stack: reason?.stack
    });
  });

  process.on('exit', (code) => {
    const row = {
      ts: Date.now(),
      iso: new Date().toISOString(),
      event: 'EXIT',
      pid: process.pid,
      exitCode: code,
      signal: null,
      mem: snapshotMem(),
      uptimeSec: Math.round((Date.now() - startedAt) / 1000)
    };
    try {
      appendJsonl(logPath, row);
      writeLastExit(lastExitPath, {
        ...row,
        hint: code === 137
          ? 'exit 137 often means SIGKILL (OOM or kill -9); on Alibaba Cloud ECS: sudo dmesg -T | grep -i oom'
          : (code === 0 ? 'normal exit' : `exit code ${code}`)
      });
    } catch {
      // exit handler must stay sync
    }
  });

  return {
    logPath,
    lastExitPath,
    logEvent: emit,
    stop() {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    },
    markShutdown(detail = {}) {
      stopping = true;
      const row = emit('SHUTDOWN', detail);
      writeLastExit(lastExitPath, {
        ...row,
        exitCode: 0,
        hint: 'graceful shutdown completed'
      });
      this.stop();
    }
  };
}

export default { startProcessLifecycleLogging };
