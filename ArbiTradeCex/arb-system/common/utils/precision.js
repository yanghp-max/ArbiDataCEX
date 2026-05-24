export function floorByStep(value, step) {
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) return 0;
  return Math.floor(value / step) * step;
}

export function percentile50(values) {
  if (!values.length) return NaN;
  const arr = [...values].sort((a, b) => a - b);
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}

export function computeMad(values, median) {
  return percentile50(values.map((v) => Math.abs(v - median)));
}
