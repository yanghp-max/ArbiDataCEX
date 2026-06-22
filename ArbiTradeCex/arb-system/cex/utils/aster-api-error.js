/** Aster REST 错误（Binance 兼容 code/msg） */
const ASTER_ERROR_CN = {
  '-2015': 'API Key 权限不足或 IP 未加白名单',
  '-2019': '保证金不足',
  '-1111': '下单数量精度不对，超过 stepSize 允许的小数位',
  '-4164': '订单名义价值太小，低于最小成交额',
  '-4061': '持仓模式不匹配（双向持仓需传 positionSide）',
  '-1106': '双向持仓模式下不能传 reduceOnly',
  '-2022': 'reduceOnly 被拒，没有对应仓位可平或数量超过持仓',
  '-2027': '超过当前杠杆下允许的最大持仓名义价值',
  '-1102': '缺少必填参数',
  '-1021': '时间戳过期，检查服务器时钟',
  '-1003': '请求过于频繁，触发限流',
  '-4014': '价格精度不符合 tickSize',
  '-4015': '下单数量不符合 LOT_SIZE'
};

export function describeAsterApiError(err) {
  const data = err?.response?.data;
  const code = data?.code;
  const msg = data?.msg || err?.message || '未知错误';
  const hint = ASTER_ERROR_CN[String(code)] || msg;
  const http = err?.response?.status;
  const httpTag = http ? ` HTTP ${http}` : '';
  return `Aster[${code ?? 'ERR'}]${httpTag} ${hint}`;
}

export default describeAsterApiError;
