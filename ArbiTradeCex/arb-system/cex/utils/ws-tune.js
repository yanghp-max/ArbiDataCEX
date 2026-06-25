/**
 * Low-latency WebSocket socket tuning (TCP_NODELAY).
 */
export function tuneWebSocket(ws) {
  if (!ws) return;
  const apply = () => {
    try {
      ws._socket?.setNoDelay?.(true);
    } catch {
      // ignore
    }
  };
  if (ws.readyState === 1) apply();
  else ws.once('open', apply);
}

export default { tuneWebSocket };
