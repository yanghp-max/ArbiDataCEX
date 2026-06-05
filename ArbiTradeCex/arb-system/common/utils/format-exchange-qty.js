import { floorByStep } from './precision.js';

export function decimalsFromStep(step) {
  const s = String(step);
  if (!s.includes('.')) return 0;
  return s.split('.')[1].length;
}

function trimTrailingZeros(value) {
  if (!value.includes('.')) return value;
  return value.replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, '');
}

/** 按交易所 stepSize 对齐并格式化为合法数量字符串（避免浮点精度拒单） */
export function formatQtyByStep(value, stepSize) {
  if (!Number.isFinite(value) || value <= 0) return '0';
  const step = Number(stepSize);
  if (!Number.isFinite(step) || step <= 0) {
    return trimTrailingZeros(String(value));
  }
  const aligned = floorByStep(value, step);
  const decimals = decimalsFromStep(step);
  return trimTrailingZeros(aligned.toFixed(decimals));
}

export default { formatQtyByStep, decimalsFromStep };
