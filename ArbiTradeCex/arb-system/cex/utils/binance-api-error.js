const BINANCE_ERROR_CN = {
  '-2015': 'API Key 权限不足或 IP 未加白名单（需勾选「合约」权限）',
  '-2019': '保证金不足，Binance 统一账户 U 不够',
  '-1111': '下单数量精度不对，超过 stepSize 允许的小数位',
  '-4164': '订单名义价值太小，低于 Binance 最小成交额',
  '-4061': '持仓模式不匹配（账户若开了双向持仓，需传 positionSide）',
  '-2022': 'reduceOnly 被拒，没有对应仓位可平',
  '-2027': '超过当前杠杆下该币种允许的最大持仓名义价值（需在币安调高杠杆或减小下单量/换币）',
  '-1102': '缺少必填参数',
  '-1021': '时间戳过期，检查服务器时钟',
  '-1003': '请求过于频繁，触发限流'
};

export function describeBinanceApiError(err) {
  const data = err?.response?.data;
  const code = data?.code;
  const msg = data?.msg || err?.message || '未知错误';
  const hint = BINANCE_ERROR_CN[String(code)] || msg;
  return `Binance[${code ?? 'ERR'}] ${hint}`;
}

export default describeBinanceApiError;
