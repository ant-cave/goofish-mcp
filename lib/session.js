/* SPDX-License-Identifier: MIT */
/**
 * admin 会话：HMAC(管理密钥 + 日期) 签名的无状态 cookie。
 * 管理密钥变更后，按旧密钥派生的会话全部失效（安全）。
 */
const crypto = require('crypto');

const COOKIE_NAME = 'gf_admin';
const COOKIE_PATH = '/admin';

function sessionToken(adminKey, day = new Date().toISOString().slice(0, 10)) {
  return crypto.createHmac('sha256', adminKey).update('admin-session:' + day).digest('hex');
}

function validSession(req, getAdminKey) {
  const adminKey = getAdminKey();
  if (!adminKey) return false;
  const c = (req.headers.cookie || '').match(new RegExp('(?:^|; )' + COOKIE_NAME + '=([a-f0-9]{64})'));
  return !!(c && c[1] === sessionToken(adminKey));
}

function setSessionCookie(res, adminKey) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${sessionToken(adminKey)}; HttpOnly; SameSite=Lax; Max-Age=86400; Path=${COOKIE_PATH}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Max-Age=0; Path=${COOKIE_PATH}`);
}

module.exports = { sessionToken, validSession, setSessionCookie, clearSessionCookie, COOKIE_NAME, COOKIE_PATH };
