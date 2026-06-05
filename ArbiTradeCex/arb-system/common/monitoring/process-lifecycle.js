/**
 * 进程生命周期日志（默认静默；仅在异常退出 / 疑似 SIGKILL·OOM 时输出到控制台）。
 *
 * SIGKILL 无法在进程内捕获。通过 run-marker：上次未清除即视为非正常结束。
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

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/** 上次是否为优雅退出（markShutdown 写入 graceful） */
export function isGracefulLastExit(prev) {
  if (!prev) return false;
  return prev.graceful === true
    || (prev.event === 'SHUTDOWN' && (prev.exitCode === 0 || prev.exitCode == null));
}

/** 上次是否疑似被 kill / OOM / 崩溃 */
export function isAbnormalLastExit(prev, hadRunMarker) {
  if (hadRunMarker) return true;
  if (!prev) return false;
  if (isGracefulLastExit(prev)) return false;
  if (prev.exitCode === 137) return true;
  if (prev.event === 'UNCAUGHT_EXCEPTION') return true;
  if (prev.event === 'EXIT' && prev.exitCode != null && prev.exitCode !== 0) return true;
  if (prev.event === 'START' || prev.event === 'HEARTBEAT') return true;
  if (prev.event === 'SIGNAL' && prev.exitCode == null && prev.graceful !== true) return true;
  return false;
}

function writeRunMarker(filePath, row) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(row, null, 2)}\n`, 'utf8');
}

function clearRunMarker(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // ignore
  }
}

export function startProcessLifecycleLogging(options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const logPath = options.logPath
    ? (path.isAbsolute(options.logPath) ? options.logPath : path.resolve(rootDir, options.logPath))
    : path.resolve(rootDir, 'logs/process-health.jsonl');
  const lastExitPath = options.lastExitPath
    ? (path.isAbsolute(options.lastExitPath) ? options.lastExitPath : path.resolve(rootDir, options.lastExitPath))
    : path.resolve(rootDir, 'logs/last-exit.json');
  const runMarkerPath = options.runMarkerPath
    ? (path.isAbsolute(options.runMarkerPath) ? options.runMarkerPath : path.resolve(rootDir, options.runMarkerPath))
    : path.join(path.dirname(lastExitPath), 'process-running.json');
  const intervalMs = Number(options.intervalMs) > 0 ? Number(options.intervalMs) : 30000;
  const persistHeartbeat = options.persistHeartbeat === true;
  const verboseConsole = options.logToConsole === true;
  const startedAt = Date.now();
  let heartbeatTimer = null;
  let stopping = false;

  const emit = (event, detail = {}, { toConsole } = {}) => {
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
    const showConsole = toConsole ?? verboseConsole;
    if (showConsole) {
      console.warn('[lifecycle]', JSON.stringify(row));
    }
    if (detail.persist !== false && event !== 'HEARTBEAT') {
      try {
        appendJsonl(logPath, row);
      } catch (err) {
        console.error('[lifecycle] failed to write log:', err.message);
      }
    } else if (event === 'HEARTBEAT' && persistHeartbeat) {
      try {
        appendJsonl(logPath, row);
      } catch (err) {
        console.error('[lifecycle] failed to write log:', err.message);
      }
    }
    return row;
  };

  const prev = readJsonFile(lastExitPath);
  const staleMarker = readJsonFile(runMarkerPath);
  const hadRunMarker = Boolean(staleMarker);

  if (isAbnormalLastExit(prev, hadRunMarker)) {
    const gapMin = prev?.ts ? Math.round((Date.now() - prev.ts) / 60000) : null;
    emit('PREVIOUS_RUN_ABNORMAL', {
      previous: prev,
      staleRunMarker: staleMarker,
      gapMin,
      hint: 'process did not clear run marker or last exit was not graceful; '
        + 'often SIGKILL/OOM on ECS — check: dmesg -T | grep -i oom; free -h'
    }, { toConsole: true });
  }

  writeRunMarker(runMarkerPath, {
    ts: Date.now(),
    iso: new Date().toISOString(),
    pid: process.pid,
    meta: options.meta ?? null
  });

  emit('START', { meta: options.meta ?? null, argv: process.argv.slice(2) });

  if (persistHeartbeat) {
    heartbeatTimer = setInterval(() => {
      emit('HEARTBEAT');
    }, intervalMs);
    if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();
  }

  const onSignal = (signal) => {
    if (stopping) return;
    stopping = true;
    const row = emit('SIGNAL', { signal });
    writeLastExit(lastExitPath, {
      ...row,
      exitCode: null,
      graceful: false,
      hint: 'shutdown in progress'
    });
  };

  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  process.on('SIGHUP', () => {
    emit('SIGNAL', { signal: 'SIGHUP', hint: 'often SSH disconnect if not using nohup/systemd' });
  });

  process.on('uncaughtException', (err) => {
    const row = emit('UNCAUGHT_EXCEPTION', {
      message: err.message,
      stack: err.stack
    }, { toConsole: true });
    writeLastExit(lastExitPath, { ...row, exitCode: 1, graceful: false });
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    emit('UNHANDLED_REJECTION', {
      message: reason?.message || String(reason),
      stack: reason?.stack
    }, { toConsole: true });
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
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      graceful: stopping && code === 0
    };
    const abnormal = code === 137 || (code !== 0 && !stopping);
    if (abnormal) {
      try {
        console.warn(
          '[lifecycle] abnormal exit code=%s rssMb=%s hint=%s',
          code,
          row.mem?.rssMb ?? 'n/a',
          code === 137
            ? 'exit 137 often SIGKILL/OOM — on ECS: sudo dmesg -T | grep -i oom'
            : `non-zero exit ${code}`
        );
      } catch {
        // ignore
      }
    }
    try {
      if (!stopping || code !== 0) {
        appendJsonl(logPath, row);
        writeLastExit(lastExitPath, {
          ...row,
          hint: code === 137
            ? 'exit 137 often means SIGKILL (OOM or kill -9)'
            : (code === 0 ? 'normal exit' : `exit code ${code}`)
        });
      }
      if (!stopping && code !== 0) {
        // leave run marker for next start
      }
    } catch {
      // exit handler must stay sync
    }
  });

  return {
    logPath,
    lastExitPath,
    runMarkerPath,
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
        graceful: true,
        hint: 'graceful shutdown completed'
      });
      clearRunMarker(runMarkerPath);
      this.stop();
    }
  };
}

export default { startProcessLifecycleLogging, isGracefulLastExit, isAbnormalLastExit };
