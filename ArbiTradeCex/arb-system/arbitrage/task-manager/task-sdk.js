/**
 * Task SDK（对标 task-sdk.js）
 */
import { TaskManager } from './index.js';
import { loadConfig } from '../../config/global-config.js';

export function createStrategy(options = {}) {
  const config = options.config || loadConfig();
  if (options.symbols) {
    config.strategy.symbols = options.symbols;
  }
  return new TaskManager({
    config,
    tradingEnabled: options.tradingEnabled ?? false
  });
}

export async function startCexCexArbitrage(options = {}) {
  const mgr = createStrategy(options);
  await mgr.start();
  return mgr;
}

export default { createStrategy, startCexCexArbitrage };
