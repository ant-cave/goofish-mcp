/* SPDX-License-Identifier: MIT */
/**
 * 客户端 API Keys（MCP 调用凭证，多 key 管理）
 *  - 存储：DATA_DIR/api-keys.json（chmod 600），内存缓存 + 写时落盘
 *  - 每个 key：{ id, name, note, key, enabled, createdAt, lastUsedAt }
 *  - 迁移：首次启动且无 key 文件时，若配置了 GOOFISH_API_KEY，自动生成一个同名默认 key，
 *    老客户端无需改配置即可继续调用
 *  - verify(key)：命中且启用的 key 返回记录（并顺带更新 lastUsedAt），否则 null
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.GOOFISH_DATA_DIR || '/home/ant/service/goofish-mcp/data';
const FILE = path.join(DATA_DIR, 'api-keys.json');

let keys = []; // 内存缓存

function persist() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify({ keys }, null, 2), { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(FILE, 0o600); } catch (e) { /* ignore */ }
}

function init(envKey) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  let loaded = null;
  try { loaded = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { /* ignore */ }
  if (loaded && Array.isArray(loaded.keys)) {
    keys = loaded.keys;
    return;
  }
  // 迁移：env 里的旧 key 转为默认客户端 key
  keys = [];
  if (envKey) {
    keys.push({
      id: crypto.randomUUID(),
      name: 'default',
      note: '由 GOOFISH_API_KEY 自动迁移',
      key: envKey,
      enabled: true,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    });
    persist();
    console.error('apikeys: migrated env GOOFISH_API_KEY to default client key');
  }
}

function list() {
  return keys.map((k) => ({ ...k }));
}

function genKey() {
  return 'sk-' + crypto.randomBytes(24).toString('base64url');
}

function create({ name, note, key }) {
  name = (name || '').trim() || '未命名';
  note = (note || '').trim();
  let k = (key || '').trim();
  if (k) {
    if (k.length < 8) throw new Error('自定义 Key 至少 8 个字符');
    if (keys.some((x) => x.key === k)) throw new Error('Key 已存在');
  } else {
    k = genKey();
  }
  const rec = {
    id: crypto.randomUUID(),
    name,
    note,
    key: k,
    enabled: true,
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
  };
  keys.push(rec);
  persist();
  return { ...rec };
}

function setEnabled(id, enabled) {
  const rec = keys.find((k) => k.id === id);
  if (!rec) throw new Error('Key 不存在');
  rec.enabled = !!enabled;
  persist();
  return { ...rec };
}

function remove(id) {
  const i = keys.findIndex((k) => k.id === id);
  if (i < 0) throw new Error('Key 不存在');
  keys.splice(i, 1);
  persist();
}

/** 命中返回 { id, name }，未命中返回 null；命中即刷新 lastUsedAt（节流落盘） */
const lastTouch = new Map();
function verify(key) {
  if (!key) return null;
  const rec = keys.find((k) => k.key === key && k.enabled);
  if (!rec) return null;
  const now = Date.now();
  const last = lastTouch.get(rec.id) || 0;
  if (now - last > 60 * 1000) {
    lastTouch.set(rec.id, now);
    rec.lastUsedAt = new Date(now).toISOString();
    try { persist(); } catch (e) { /* ignore */ }
  }
  return { id: rec.id, name: rec.name };
}

module.exports = { init, list, create, setEnabled, remove, verify, FILE };
