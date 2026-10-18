/* SPDX-License-Identifier: MIT */
/**
 * /admin 路由集合（管理后台 API + 页面）
 *  - 页面：GET /admin/login（登录页）、GET /admin（后台，需会话）
 *  - 鉴权：POST /admin/login（管理密钥）→ HMAC 会话 cookie；/api/* 未登录返回 401 JSON
 *  - 接口：status / stats / logs / 管理密钥修改 / 客户端 API Keys CRUD / 扫码登录 / 登出
 *  - 防爆破：登录与 /api 走 lib/ratelimit（失败按 IP 计数锁定）
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const cfg = require('../lib/config.js');
const apikeys = require('../lib/apikeys.js');
const mlog = require('../lib/logger.js');
const rl = require('../lib/ratelimit.js');
const session = require('../lib/session.js');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const DATA_DIR = process.env.GOOFISH_DATA_DIR || '/home/ant/service/goofish-mcp/data';
const COOKIE_FILE = path.join(DATA_DIR, 'session-cookie.txt');
// 演示模式（本地 mock goofish-client 时置 1）：启用模拟扫码确认端点
const DEMO = process.env.GOOFISH_DEMO === '1';
const DEMO_CONFIRM_FILE = path.join(DATA_DIR, 'mock-qr-confirmed');

function setupAdmin(app, { oauthProvider, rebuildClient, clientInfo, getClient }) {
  const admin = express.Router();
  admin.use(express.urlencoded({ extended: false }));
  admin.use(express.json());

  // ---- 登录页与登录（公开） ----
  admin.get('/login', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
  });

  admin.post('/login', (req, res) => {
    const ip = rl.clientIp(req);
    if (rl.isLocked(ip)) {
      return res.status(429).send('尝试次数过多，IP 已被临时锁定，请稍后再试');
    }
    const key = (req.body && req.body.key) || '';
    if (key !== cfg.get()) {
      rl.recordFail(ip);
      mlog.log({ kind: 'admin', ip, action: 'admin login', ok: false, error: 'wrong key' });
      return res.redirect('/admin/login?err=1');
    }
    rl.recordSuccess(ip);
    session.setSessionCookie(res, cfg.get());
    mlog.log({ kind: 'admin', ip, action: 'admin login', ok: true });
    res.redirect('/admin');
  });

  // brute-force guard（未会话且被锁定时拒绝）
  admin.use((req, res, next) => {
    if (rl.isLocked(rl.clientIp(req)) && !session.validSession(req, cfg.get)) {
      return res.status(429).send('尝试次数过多，IP 已被临时锁定，请稍后再试');
    }
    next();
  });

  // 会话校验：API 401 JSON，页面跳登录页
  admin.use((req, res, next) => {
    if (session.validSession(req, cfg.get)) return next();
    if (req.path.startsWith('/api/') || req.path.startsWith('/qr/')) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    return res.redirect('/admin/login');
  });

  // ---- 后台页 ----
  admin.get('/', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'admin.html'));
  });

  // ---- 退出 admin 会话 ----
  admin.post('/logout', (req, res) => {
    session.clearSessionCookie(res);
    mlog.log({ kind: 'admin', ip: rl.clientIp(req), action: 'admin logout', ok: true });
    res.json({ ok: true });
  });

  // ---- 状态 / 统计 / 日志 ----
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
      adminKeyMask: cfg.mask(),
      clientKeyCount: apikeys.list().length,
      clientKeyEnabled: apikeys.list().filter((k) => k.enabled).length,
    });
  });

  admin.get('/api/stats', (req, res) => {
    res.json(mlog.stats(Math.min(7, Math.max(1, Number(req.query.days) || 7))));
  });

  admin.get('/api/logs', (req, res) => {
    const { limit, offset, days, kind, ok, tool, q } = req.query;
    res.json(mlog.query({
      limit: Number(limit) || 50,
      offset: Number(offset) || 0,
      days: Number(days) || 2,
      kind,
      ok: ok === '' || ok == null ? undefined : ok === 'true' || ok === '1',
      tool: tool || undefined,
      q: q || undefined,
    }));
  });

  // ---- 管理密钥（热更新，改后旧会话全部失效） ----
  admin.post('/api/admin-key', (req, res) => {
    try {
      cfg.set((req.body && req.body.key) || '');
      mlog.log({ kind: 'admin', ip: rl.clientIp(req), action: 'update admin key', ok: true });
      res.json({ ok: true, mask: cfg.mask() });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // ---- 客户端 API Keys CRUD ----
  admin.get('/api/keys', (req, res) => {
    res.json({ keys: apikeys.list() });
  });

  admin.post('/api/keys', (req, res) => {
    try {
      const rec = apikeys.create({ name: req.body && req.body.name, note: req.body && req.body.note, key: req.body && req.body.key });
      mlog.log({ kind: 'admin', ip: rl.clientIp(req), action: 'create api key', detail: rec.name, ok: true });
      res.json({ ok: true, key: rec });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  admin.post('/api/keys/:id/toggle', (req, res) => {
    try {
      // 双模式：显式传 enabled 按目标值设置；不传则按当前值翻转（纯 toggle 语义）
      const cur = apikeys.list().find((k) => k.id === req.params.id);
      if (!cur) return res.json({ ok: false, error: 'Key 不存在' });
      const target = req.body && typeof req.body.enabled === 'boolean' ? req.body.enabled : !cur.enabled;
      const rec = apikeys.setEnabled(req.params.id, target);
      mlog.log({ kind: 'admin', ip: rl.clientIp(req), action: 'toggle api key', detail: rec.name + ' -> ' + (rec.enabled ? 'enabled' : 'disabled'), ok: true });
      res.json({ ok: true, key: rec });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  admin.post('/api/keys/:id/delete', (req, res) => {
    try {
      apikeys.remove(req.params.id);
      mlog.log({ kind: 'admin', ip: rl.clientIp(req), action: 'delete api key', detail: req.params.id.slice(0, 8), ok: true });
      res.json({ ok: true });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // ---- 清除闲鱼登录态 ----
  admin.post('/logout-xianyu', (req, res) => {
    try { fs.unlinkSync(COOKIE_FILE); } catch (e) { /* ignore */ }
    rebuildClient();
    mlog.log({ kind: 'admin', ip: rl.clientIp(req), action: 'clear xianyu session', ok: true });
    res.json({ ok: true });
  });

  // ---- OAuth token 吊销 ----
  admin.post('/revoke-token', (req, res) => {
    const id = (req.body && req.body.id) || '';
    try {
      const st = oauthProvider.state;
      const full = Object.keys(st.tokens || {}).find((k) => k.startsWith(id.replace('…', '')));
      if (full) { delete st.tokens[full]; oauthProvider.persist(); }
      mlog.log({ kind: 'admin', ip: rl.clientIp(req), action: 'revoke oauth token', detail: id, ok: !!full });
      res.json({ ok: true, revoked: !!full });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // ---- 扫码登录闲鱼 ----
  let qrSession = null; // { t, ck, startedAt }
  admin.post('/qr/start', async (req, res) => {
    try {
      const c = getClient();
      const r = await c.api.passport.qr.generate();
      if (!r?.content?.success) throw new Error('生成失败');
      const { t, ck, codeContent } = r.content.data;
      qrSession = { t, ck, startedAt: Date.now(), codeContent };
      if (DEMO) { try { fs.unlinkSync(DEMO_CONFIRM_FILE); } catch (e) { /* ignore */ } }
      mlog.log({ kind: 'admin', ip: rl.clientIp(req), action: 'qr login start', ok: true });
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
        mlog.log({ kind: 'admin', ip: rl.clientIp(req), action: 'qr login confirmed', ok: true });
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
      mlog.log({ kind: 'admin', ip: rl.clientIp(req), action: 'demo qr confirm', ok: true });
      res.json({ ok: true });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  app.use('/admin', admin);

  // 静态资源（app.css / login.html / admin.html / js / vendor）
  app.use(express.static(PUBLIC_DIR));
}

/**
 * OAuth /authorize GET 守卫：须持管理密钥或 admin 会话，堵"自动批准"公网裸奔洞。
 * 必须在 OAuth 路由（mcpAuthRouter）之前挂载到 app 才能拦截 /authorize。
 */
function mountAuthorizeGuard(app) {
  app.get('/authorize', (req, res, next) => {
    const adminKey = cfg.get();
    const header = ((req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim()) ||
      ((req.headers['x-api-key'] || '').trim());
    const ok = session.validSession(req, cfg.get) ||
      (adminKey && req.query.key === adminKey) ||
      (adminKey && header === adminKey);
    if (!ok) {
      return res.status(401).send('OAuth authorize 需要鉴权：请在请求中携带管理密钥（?key= 或 Authorization 头），或先登录 /admin');
    }
    next();
  });
}

module.exports = { setupAdmin, mountAuthorizeGuard, COOKIE_FILE };
