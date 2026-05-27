/**
 * 精度处理工具类 - 使用big.js解决JavaScript浮点数精度问题
 * 禁止任何toFixed、toPrecision、Math.round等精度损失操作
 */

import Big from 'big.js';

// 设置Big.js配置
Big.DP = 50;  // 最大小数位数
Big.RM = Big.roundDown;  // 向下舍入（不进行四舍五入）

export class Precision {
  static big(value) {
    if (value === null || value === undefined || value === '') {
      return new Big(0);
    }

    try {
      return new Big(value);
    } catch (error) {
      console.warn(`[Precision] 无效数值: ${value}, 使用0替代`);
      return new Big(0);
    }
  }

  static add(a, b) {
    return this.big(a).plus(this.big(b));
  }

  static subtract(a, b) {
    return this.big(a).minus(this.big(b));
  }

  static multiply(a, b) {
    return this.big(a).times(this.big(b));
  }

  static divide(a, b) {
    const divisor = this.big(b);
    if (divisor.eq(0)) {
      throw new Error('除数不能为0');
    }
    return this.big(a).div(divisor);
  }

  static compare(a, b) {
    return this.big(a).cmp(this.big(b));
  }

  static eq(a, b) {
    return this.big(a).eq(this.big(b));
  }

  static gt(a, b) {
    return this.big(a).gt(this.big(b));
  }

  static gte(a, b) {
    return this.big(a).gte(this.big(b));
  }

  static lt(a, b) {
    return this.big(a).lt(this.big(b));
  }

  static lte(a, b) {
    return this.big(a).lte(this.big(b));
  }

  static abs(value) {
    return this.big(value).abs();
  }

  static neg(value) {
    return this.big(value).neg();
  }

  static toString(value) {
    return this.big(value).toString();
  }

  static toNumber(value) {
    return this.big(value).toNumber();
  }

  static isZero(value) {
    return this.big(value).eq(0);
  }

  static isPositive(value) {
    return this.big(value).gt(0);
  }

  static isNegative(value) {
    return this.big(value).lt(0);
  }

  static formatForDisplay(value, decimals = 8) {
    const bigValue = this.big(value);
    const str = bigValue.toString();

    if (!str.includes('.')) {
      return str;
    }

    const [integer, decimal] = str.split('.');
    if (decimal.length <= decimals) {
      return str;
    }

    return `${integer}.${decimal.substring(0, decimals)}`;
  }

  static percentage(value, total) {
    if (this.isZero(total)) {
      return this.big(0);
    }
    return this.divide(this.multiply(value, 100), total);
  }

  static spreadPercentage(priceA, priceB) {
    if (this.isZero(priceB)) {
      return this.big(0);
    }
    return this.percentage(this.subtract(priceA, priceB), priceB);
  }

  static sum(values) {
    let result = this.big(0);
    for (const value of values) {
      result = result.plus(this.big(value));
    }
    return result;
  }

  static average(values) {
    if (!values || values.length === 0) {
      return this.big(0);
    }
    return this.divide(this.sum(values), values.length);
  }

  static inRange(value, min, max) {
    const bigValue = this.big(value);
    return bigValue.gte(this.big(min)) && bigValue.lte(this.big(max));
  }

  static max(...values) {
    let result = this.big(values[0]);
    for (let i = 1; i < values.length; i++) {
      const current = this.big(values[i]);
      if (current.gt(result)) {
        result = current;
      }
    }
    return result;
  }

  static min(...values) {
    let result = this.big(values[0]);
    for (let i = 1; i < values.length; i++) {
      const current = this.big(values[i]);
      if (current.lt(result)) {
        result = current;
      }
    }
    return result;
  }

  static compound(principal, rate, periods) {
    const bigPrincipal = this.big(principal);
    const bigRate = this.big(rate);
    const bigPeriods = this.big(periods);

    let result = this.big(1).plus(bigRate);
    let power = this.big(1);

    for (let i = 0; i < bigPeriods.toNumber(); i++) {
      power = power.times(result);
    }

    return bigPrincipal.times(power);
  }

  static isReasonable(value, maxAbsValue) {
    return this.lte(this.abs(value), this.big(maxAbsValue));
  }
}

export const P = Precision;
export const { big, add, subtract, multiply, divide, toString: precisionToString } = Precision;

export default Precision;

/** 套利策略辅助（保留原有导出） */
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
