#!/usr/bin/env node
/**
 * goofish-mcp admin module
 *  - 防爆破：鉴权失败 IP 计数 + 锁定（内存）
 *  - OAuth /authorize 守卫：需 API key，堵"自动批准"公网裸奔洞
 *  - /admin Web 界面：登录、状态、token 吊销、扫码登录闲鱼
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

const DATA_DIR = process.env.GOOFISH_DATA_DIR || '/home/ant/service/goofish-mcp/data';
const COOKIE_FILE = path.join(DATA_DIR, 'session-cookie.txt');
const QR_PAGE = path.join(__dirname, 'public', 'admin.html');

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
  if (!apiKey) {
    console.error('admin: GOOFISH_API_KEY not set, admin UI disabled');
    return;
  }
  const admin = express.Router();
  admin.use(express.urlencoded({ extended: false }));
  admin.use(express.json());

  // brute-force guard for admin login
  admin.use((req, res, next) => {
    if (isLocked(clientIp(req)) && !validSession(req, apiKey)) {
      return res.status(429).send('尝试次数过多，IP 已被临时锁定，请稍后再试');
    }
    next();
  });

  // login
  admin.post('/login', (req, res) => {
    const key = (req.body && req.body.key) || '';
    if (key !== apiKey) {
      recordFail(clientIp(req));
      return res.status(401).send('密钥错误');
    }
    recordSuccess(clientIp(req));
    res.setHeader('Set-Cookie', `gf_admin=${sessionToken(apiKey)}; HttpOnly; SameSite=Lax; Max-Age=86400; Path=/admin`);
    res.redirect('/admin');
  });

  // auth check for everything else
  admin.use((req, res, next) => {
    if (!validSession(req, apiKey)) return res.status(401).send(loginPage());
    next();
  });

  // dashboard
  admin.get('/', (req, res) => {
    let tokens = [];
    try {
      const st = oauthProvider.state || {};
      tokens = Object.entries(st.tokens || {}).map(([k, v]) => ({
        id: k.slice(0, 8) + '…', clientId: v.clientId, scopes: (v.scopes || []).join(','),
        expiresAt: v.expiresAt ? new Date(v.expiresAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '-',
      }));
    } catch (e) { /* ignore */ }
    res.send(dashboardPage({
      loginInfo: clientInfo(),
      hasCookie: fs.existsSync(COOKIE_FILE),
      cookieMtime: fs.existsSync(COOKIE_FILE) ? fs.statSync(COOKIE_FILE).mtime.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '-',
      tokens,
    }));
  });

  // logout / clear session cookie
  admin.post('/logout-xianyu', (req, res) => {
    try { fs.unlinkSync(COOKIE_FILE); } catch (e) {}
    rebuildClient();
    res.redirect('/admin');
  });

  // revoke oauth token
  admin.post('/revoke-token', (req, res) => {
    const id = (req.body && req.body.id) || '';
    try {
      const st = oauthProvider.state;
      const full = Object.keys(st.tokens || {}).find((k) => k.startsWith(id.replace('…', '')));
      if (full) { delete st.tokens[full]; oauthProvider.persist(); }
    } catch (e) { console.error('admin revoke:', e.message); }
    res.redirect('/admin');
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

  app.use('/admin', admin);

  // ---- OAuth /authorize 守卫：须持 API key 或 admin 会话 ----
  app.get('/authorize', (req, res, next) => {
    const ok = validSession(req, apiKey) || (req.query.key === apiKey) || matchesApiKeyRaw(req);
    if (!ok) {
      return res.status(401).send('OAuth authorize 需要鉴权：请在请求中携带 API key（?key= 或 Authorization 头），或先登录 /admin');
    }
    next();
  });

  return admin;
}

function matchesApiKeyRaw(req) {
  const apiKey = (process.env.GOOFISH_API_KEY || '').trim();
  if (!apiKey) return false;
  const h = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim() ||
    (req.headers['x-api-key'] || '').trim();
  return h === apiKey;
}

module.exports = { setupAdmin, isLocked, recordFail, recordSuccess, clientIp, validSession, sessionToken, COOKIE_FILE };

// ---- HTML 模板 ----
function loginPage() {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>goofish-mcp 登录</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:system-ui;background:#f5f5f5;display:flex;justify-content:center;padding-top:12vh}
.card{background:#fff;padding:2rem;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.08);width:320px}
h1{font-size:1.1rem}input{width:100%;padding:.6rem;margin:.5rem 0;border:1px solid #ddd;border-radius:8px;box-sizing:border-box}
button{width:100%;padding:.6rem;background:#111;color:#fff;border:0;border-radius:8px;cursor:pointer}</style></head>
<body><div class="card"><h1>🔑 goofish-mcp 管理登录</h1>
<form method="post" action="/admin/login"><input type="password" name="key" placeholder="API Key" autofocus><button>登录</button></form></div></body></html>`;
}

function dashboardPage({ loginInfo, hasCookie, cookieMtime, tokens }) {
  const rows = tokens.map((t) =>
    `<tr><td>${t.id}</td><td>${t.clientId}</td><td>${t.scopes}</td><td>${t.expiresAt}</td>
     <td><form method="post" action="/admin/revoke-token" style="margin:0"><input type="hidden" name="id" value="${t.id}"><button>吊销</button></form></td></tr>`).join('');
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>goofish-mcp 管理</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:system-ui;background:#f5f5f5;margin:0;padding:2rem}
.card{background:#fff;padding:1.5rem;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.08);margin-bottom:1rem;max-width:860px}
h1{font-size:1.2rem}h2{font-size:1rem;margin-top:0}
table{width:100%;border-collapse:collapse;font-size:.85rem}td,th{border-bottom:1px solid #eee;padding:.4rem;text-align:left}
button{padding:.35rem .8rem;border:1px solid #ddd;background:#fff;border-radius:6px;cursor:pointer}
button.danger{color:#c00;border-color:#c00}
.ok{color:#0a0}.bad{color:#c00}
#qr img{max-width:220px}#qrStatus{margin-top:.5rem}</style></head><body>
<h1>🛠️ goofish-mcp 管理</h1>
<div class="card"><h2>闲鱼登录态</h2>
<p>${hasCookie ? `<span class="ok">✓ 已有 cookie</span>（更新于 ${cookieMtime}）` : '<span class="bad">✗ 未登录</span>'}
${loginInfo}</p>
<div id="qr"><button onclick="startQR()">📱 扫码登录闲鱼</button>
<button class="danger" onclick="fetch('/admin/logout-xianyu',{method:'POST'}).then(()=>location.reload())">清除登录态</button>
<div id="qrImg" style="margin-top:1rem"></div><div id="qrStatus"></div></div></div>
<div class="card"><h2>OAuth Tokens（${tokens.length}）</h2>
<table><tr><th>ID</th><th>Client</th><th>Scopes</th><th>过期</th><th></th></tr>${rows || '<tr><td colspan=5>无</td></tr>'}</table></div>
<script src="https://cdn.jsdelivr.net/npm/qrcodejs@1.0.0/qrcode.min.js" onerror="window.__noqr=1"></script>
<script>
async function startQR(){
  document.getElementById('qrStatus').textContent='生成中…';
  const r=await fetch('/admin/qr/start',{method:'POST'});
  const d=await r.json();
  if(!d.ok){document.getElementById('qrStatus').textContent='失败: '+d.error;return}
  const box=document.getElementById('qrImg');box.innerHTML='';
  if(window.QRCode){new QRCode(box,{text:d.qr,width:220,height:220})}
  else box.innerHTML='<code style="word-break:break-all">'+d.qr+'</code>';
  document.getElementById('qrStatus').textContent='请用闲鱼APP扫码';
  const timer=setInterval(async()=>{
    const s=await (await fetch('/admin/qr/status')).json();
    document.getElementById('qrStatus').textContent='状态: '+s.status;
    if(['CONFIRMED','EXPIRED','CANCELED','ERROR'].includes(s.status)){
      clearInterval(timer);
      if(s.status==='CONFIRMED') setTimeout(()=>location.reload(),800);
    }
  },3000);
}
</script></body></html>`;
}

module.exports = { setupAdmin, isLocked, recordFail, recordSuccess, clientIp, validSession, sessionToken, COOKIE_FILE };
