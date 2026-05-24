/**
 * 全局配置加载
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as dotenvConfig } from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

dotenvConfig({ path: path.join(rootDir, '.env') });

let cached = null;

export function loadConfig() {
  if (cached) return cached;
  const configPath = path.join(rootDir, 'config.json');
  const raw = fs.readFileSync(configPath, 'utf8');
  cached = JSON.parse(raw);
  return cached;
}

export function getRootDir() {
  return rootDir;
}

export default { loadConfig, getRootDir };
