/* SPDX-License-Identifier: MIT */
/**
 * goofish-mcp API Key 运行时配置
 *  - 存储：DATA_DIR/api-key.txt（明文，chmod 600），支持控制面板热更新，无需重启
 *  - 迁移：文件不存在时以 GOOFISH_API_KEY 环境变量落盘；此后以文件为准（面板优先）
 *  - 改 key 后：基于旧 key 派生的 admin 会话全部失效（HMAC 按天 + key），需重新登录
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.GOOFISH_DATA_DIR || '/home/ant/service/goofish-mcp/data';
const KEY_FILE = path.join(DATA_DIR, 'api-key.txt');
const ENV_KEY = (process.env.GOOFISH_API_KEY || '').trim();

let current = '';

function persist() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(KEY_FILE, current, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(KEY_FILE, 0o600); } catch (e) { /* ignore */ }
}

function init() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  let fromFile = null;
  try { fromFile = fs.readFileSync(KEY_FILE, 'utf8').trim() || null; } catch (e) { /* ignore */ }
  if (fromFile) {
    current = fromFile;
    if (ENV_KEY && ENV_KEY !== fromFile) {
      console.error('config: api key loaded from data file; GOOFISH_API_KEY env differs and is ignored');
    }
  } else if (ENV_KEY) {
    current = ENV_KEY;
    persist();
    console.error('config: api key migrated from env to', KEY_FILE);
  } else {
    current = '';
    console.error('config: no api key configured; /mcp and /admin auth disabled');
  }
}

function get() {
  return current;
}

function set(next) {
  next = (next || '').trim();
  if (next.length < 8) throw new Error('API Key 至少需要 8 个字符');
  if (next.length > 256) throw new Error('API Key 过长（上限 256 字符）');
  if (next === current) throw new Error('新 API Key 与当前相同');
  current = next;
  persist();
  return true;
}

function mask() {
  if (!current) return '';
  if (current.length <= 8) return '••••••••';
  return current.slice(0, 4) + '••••••••' + current.slice(-4);
}

module.exports = { init, get, set, mask, KEY_FILE, DATA_DIR };
