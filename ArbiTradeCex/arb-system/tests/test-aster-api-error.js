import assert from 'node:assert/strict';
import { describeAsterApiError } from '../cex/utils/aster-api-error.js';

assert.match(
  describeAsterApiError({
    response: { status: 400, data: { code: -2022, msg: 'ReduceOnly Order is rejected.' } },
    message: 'Request failed with status code 400'
  }),
  /Aster\[-2022\].*reduceOnly/i
);

assert.match(
  describeAsterApiError({
    response: { status: 400, data: { code: -4164, msg: 'Order notional too small' } },
    message: 'Request failed with status code 400'
  }),
  /Aster\[-4164\].*HTTP 400/
);

console.log('test-aster-api-error OK');
