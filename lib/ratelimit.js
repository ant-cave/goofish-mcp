/* SPDX-License-Identifier: MIT */
/**
 * 防爆破（内存级）：鉴权失败按 IP 计数，超限临时锁定。
 * 锁定仅存内存，重启清空。
 */
const MAX_FAILS = Number(process.env.GOOFISH_RATE_MAX_FAILS || 10);
const WINDOW_MS = Number(process.env.GOOFISH_RATE_WINDOW_MS || 10 * 60 * 1000);
const LOCK_MS = Number(process.env.GOOFISH_RATE_LOCK_MS || 15 * 60 * 1000);

const failMap = new Map(); // ip -> { fails: [], lockUntil }

function clientIp(req) {
  const xf = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xf || req.socket?.remoteAddress || 'unknown';
}

function isLocked(ip) {
  const e = failMap.get(ip);
  if (!e) return false;
  if (e.lockUntil && e.lockUntil > Date.now()) return true;
  if (e.lockUntil && e.lockUntil <= Date.now()) failMap.delete(ip);
  return false;
}

function recordFail(ip) {
  let e = failMap.get(ip) || { fails: [], lockUntil: 0 };
  const now = Date.now();
  e.fails = e.fails.filter((t) => now - t < WINDOW_MS);
  e.fails.push(now);
  if (e.fails.length >= MAX_FAILS) {
    e.lockUntil = now + LOCK_MS;
    e.fails = [];
    console.error(`ratelimit: IP ${ip} locked for ${LOCK_MS / 60000}min after ${MAX_FAILS} failures`);
  }
  failMap.set(ip, e);
}

function recordSuccess(ip) { failMap.delete(ip); }

module.exports = { clientIp, isLocked, recordFail, recordSuccess };
