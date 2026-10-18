#!/usr/bin/env node
/**
 * goofish-mcp admin module
 *  - 防爆破：鉴权失败 IP 计数 + 锁定（内存）
 *  - OAuth /authorize 守卫：需 API key，堵"自动批准"公网裸奔洞
 *  - /admin Web 界面（静态页 public/admin.html，样式复刻 ant-toolkit）：
 *      登录 / 状态 / 扫码登录闲鱼 / OAuth token 查看吊销 / 清除登录态
 *  - GET /admin/api/status：JSON 状态接口（前端 fetch 渲染）
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

const DATA_DIR = process.env.GOOFISH_DATA_DIR || '/home/ant/service/goofish-mcp/data';
const COOKIE_FILE = path.join(DATA_DIR, 'session-cookie.txt');
const PUBLIC_DIR = path.join(__dirname, 'public');
// 演示模式（本地 mock goofish-client 时置 1）：启用模拟扫码确认端点
const DEMO = process.env.GOOFISH_DEMO === '1';
const DEMO_CONFIRM_FILE = path.join(DATA_DIR, 'mock-qr-confirmed');

// ---- 防爆破（内存级） ----
const RL_MAX_FAILS = Number(process.env.GOOFISH_RATE_MAX_FAILS || 10);
const RL_WINDOW_MS = Number(process.env.GOOFISH_RATE_WINDOW_MS || 10 * 60 * 1000);
const RL_LOCK_MS = Number(process.env.GOOFISH_RATE_LOCK_MS || 15 * 60 * 1000);
const failMap = new Map(); // ip -> { fails: [], lockUntil }

function clientIp(req) {
  const xf = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xf || req.socket?.remoteAddress || 'unknown';
}

function isLocked(ip) {
  const e = failMap.get(ip);
  if (!e) return false;
  if (e.lockUntil && e.lockUntil > Date.now()) return true;
  if (e.lockUntil && e.lockUntil <= Date.now()) { failMap.delete(ip); }
  return false;
}

function recordFail(ip) {
  let e = failMap.get(ip) || { fails: [], lockUntil: 0 };
  const now = Date.now();
  e.fails = e.fails.filter((t) => now - t < RL_WINDOW_MS);
  e.fails.push(now);
  if (e.fails.length >= RL_MAX_FAILS) {
    e.lockUntil = now + RL_LOCK_MS;
    e.fails = [];
    console.error(`admin: IP ${ip} locked for ${RL_LOCK_MS / 60000}min after ${RL_MAX_FAILS} failures`);
  }
  failMap.set(ip, e);
}

function recordSuccess(ip) { failMap.delete(ip); }

// admin 会话 cookie：HMAC(apiKey + date) 签名，无状态
function sessionToken(apiKey) {
  return crypto.createHmac('sha256', apiKey).update('admin-session:' + new Date().toISOString().slice(0, 10)).digest('hex');
}
function validSession(req, apiKey) {
  const c = (req.headers.cookie || '').match(/gf_admin=([a-f0-9]{64})/);
  return !!(c && c[1] === sessionToken(apiKey));
}

function setupAdmin(app, { apiKey, oauthProvider, rebuildClient, clientInfo, getClient }) {
  const admin = express.Router();
  admin.use(express.urlencoded({ extended: false }));
  admin.use(express.json());

  if (!apiKey) {
    console.error('admin: GOOFISH_API_KEY not set, admin UI disabled');
    // 未配置 key 时仅提供静态资源（无后台功能）
    app.use(express.static(PUBLIC_DIR));
    return admin;
  }

  // ---- 登录页（GET /admin/login，公开） ----
  admin.get('/login', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
  });

  // 登录（form post）：成功进后台，失败回登录页带 err 参数
  admin.post('/login', (req, res) => {
    if (isLocked(clientIp(req))) {
      return res.status(429).send('尝试次数过多，IP 已被临时锁定，请稍后再试');
    }
    const key = (req.body && req.body.key) || '';
    if (key !== apiKey) {
      recordFail(clientIp(req));
      return res.redirect('/admin/login?err=1');
    }
    recordSuccess(clientIp(req));
    res.setHeader('Set-Cookie', `gf_admin=${sessionToken(apiKey)}; HttpOnly; SameSite=Lax; Max-Age=86400; Path=/admin`);
    res.redirect('/admin');
  });

  // brute-force guard for admin routes
  admin.use((req, res, next) => {
    if (isLocked(clientIp(req)) && !validSession(req, apiKey)) {
      return res.status(429).send('尝试次数过多，IP 已被临时锁定，请稍后再试');
    }
    next();
  });

  // auth check for everything else（API 401 JSON，页面跳登录页）
  admin.use((req, res, next) => {
    if (validSession(req, apiKey)) return next();
    if (req.path.startsWith('/api/') || req.path.startsWith('/qr/')) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    return res.redirect('/admin/login');
  });

  // dashboard（静态页，数据由 /admin/api/status 提供）
  admin.get('/', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'admin.html'));
  });

  // JSON 状态：登录态 + OAuth tokens + demo 标志
  admin.get('/api/status', (req, res) => {
    let tokens = [];
    try {
      const st = oauthProvider.state || {};
      tokens = Object.entries(st.tokens || {}).map(([k, v]) => ({
        id: k.slice(0, 8) + '…',
        clientId: v.clientId,
        scopes: (v.scopes || []).join(','),
        expiresAt: v.expiresAt ? new Date(v.expiresAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '-',
      }));
    } catch (e) { /* ignore */ }
    res.json({
      hasCookie: fs.existsSync(COOKIE_FILE),
      cookieMtime: fs.existsSync(COOKIE_FILE) ? fs.statSync(COOKIE_FILE).mtime.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '-',
      loginInfo: clientInfo(),
      tokens,
      demo: DEMO,
    });
  });

  // 退出 admin 会话
  admin.post('/logout', (req, res) => {
    res.setHeader('Set-Cookie', 'gf_admin=; HttpOnly; SameSite=Lax; Max-Age=0; Path=/admin');
    res.json({ ok: true });
  });

  // 清除闲鱼登录态（删 cookie + 重建 client）
  admin.post('/logout-xianyu', (req, res) => {
    try { fs.unlinkSync(COOKIE_FILE); } catch (e) {}
    rebuildClient();
    res.json({ ok: true });
  });

  // 吊销 oauth token
  admin.post('/revoke-token', (req, res) => {
    const id = (req.body && req.body.id) || '';
    try {
      const st = oauthProvider.state;
      const full = Object.keys(st.tokens || {}).find((k) => k.startsWith(id.replace('…', '')));
      if (full) { delete st.tokens[full]; oauthProvider.persist(); }
    } catch (e) { console.error('admin revoke:', e.message); }
    res.json({ ok: true });
  });

  // ---- 扫码登录 ----
  let qrSession = null; // { t, ck, startedAt }
  admin.post('/qr/start', async (req, res) => {
    try {
      // 用运行时传入的 client 工厂，保证与 MCP 同一登录态
      const c = getClient();
      const r = await c.api.passport.qr.generate();
      if (!r?.content?.success) throw new Error('生成失败');
      const { t, ck, codeContent } = r.content.data;
      qrSession = { t, ck, startedAt: Date.now(), codeContent };
      if (DEMO) { try { fs.unlinkSync(DEMO_CONFIRM_FILE); } catch (e) {} }
      res.json({ ok: true, qr: codeContent });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  admin.get('/qr/status', async (req, res) => {
    try {
      if (!qrSession) return res.json({ ok: false, error: 'no session' });
      if (Date.now() - qrSession.startedAt > 3 * 60 * 1000) return res.json({ ok: true, status: 'EXPIRED' });
      const c = getClient();
      const r = await c.api.passport.qr.query({ t: qrSession.t, ck: qrSession.ck });
      const status = r?.content?.data?.qrCodeStatus;
      if (status === 'CONFIRMED') {
        const cookie = c.getCookiePassport();
        c.updateCookieMtop(cookie);
        fs.mkdirSync(path.dirname(COOKIE_FILE), { recursive: true });
        fs.writeFileSync(COOKIE_FILE, cookie);
        rebuildClient();
        qrSession = null;
        return res.json({ ok: true, status: 'CONFIRMED' });
      }
      res.json({ ok: true, status: status || 'UNKNOWN' });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // ---- 演示模式：模拟扫码确认（仅 mock 环境可用） ----
  admin.post('/api/demo/confirm', (req, res) => {
    if (!DEMO) return res.status(404).json({ ok: false, error: 'not in demo mode' });
    try {
      fs.mkdirSync(path.dirname(DEMO_CONFIRM_FILE), { recursive: true });
      fs.writeFileSync(DEMO_CONFIRM_FILE, String(Date.now()));
      res.json({ ok: true });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  app.use('/admin', admin);

  // 静态资源（app.css / login.html / admin.html）
  app.use(express.static(PUBLIC_DIR));

  return admin;
}

/**
 * OAuth /authorize GET 守卫：须持 API key 或 admin 会话，堵"自动批准"公网裸奔洞。
 * 必须在 OAuth 路由（mcpAuthRouter）之前挂载到 app 才能拦截 /authorize。
 */
function mountAuthorizeGuard(app, apiKey) {
  app.get('/authorize', (req, res, next) => {
    const ok = validSession(req, apiKey) || (req.query.key === apiKey) || matchesApiKeyRaw(req);
    if (!ok) {
      return res.status(401).send('OAuth authorize 需要鉴权：请在请求中携带 API key（?key= 或 Authorization 头），或先登录 /admin');
    }
    next();
  });
}

  // ---- 演示模式：模拟扫码确认（仅 mock 环境可用） ----

function matchesApiKeyRaw(req) {
  const apiKey = (process.env.GOOFISH_API_KEY || '').trim();
  if (!apiKey) return false;
  const h = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim() ||
    (req.headers['x-api-key'] || '').trim();
  return h === apiKey;
}

module.exports = { setupAdmin, mountAuthorizeGuard, isLocked, recordFail, recordSuccess, clientIp, validSession, sessionToken, COOKIE_FILE };
