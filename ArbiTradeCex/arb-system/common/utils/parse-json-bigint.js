/**
 * axios 默认 JSON.parse 会丢失超过 2^53 的整数（Gate order_id / trade id）。
 * 将常见 ID 字段在解析前改为字符串。
 */
const BIGINT_ID_FIELDS = new Set([
  'id',
  'order_id',
  'orderId',
  'trade_id',
  'tradeId'
]);

const BIGINT_FIELD_RE = new RegExp(
  `"(${[...BIGINT_ID_FIELDS].join('|')})"\\s*:\\s*(\\d{15,})`,
  'g'
);

export function parseJsonPreserveBigIntIds(text) {
  if (text == null || text === '') return null;
  if (typeof text !== 'string') return text;
  const sanitized = text.replace(BIGINT_FIELD_RE, '"$1":"$2"');
  return JSON.parse(sanitized);
}

export function idToString(value) {
  if (value == null) return '';
  return String(value);
}
