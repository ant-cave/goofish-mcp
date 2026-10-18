#!/usr/bin/env node
/**
 * goofish-mcp — 持久化 OAuth 授权码 provider（内存 + 磁盘 JSON）
 *
 * 支持：
 *  - 动态客户端注册（registerClient）→ 客户端信息持久化
 *  - 授权码发放（authorize，自动批准，免人工登录页）
 *  - 授权码换 token（exchangeAuthorizationCode，PKCE）
 *  - refresh token 换新 token（exchangeRefreshToken）
 *  - token 校验（verifyAccessToken）
 *
 * 数据落盘在 DATA_FILE（默认 /home/ant/service/goofish-mcp/data/oauth.json），
 * 重启不丢。适合作为 ChatGPT 等需要 OAuth 的 MCP 客户端的授权服务器。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_FILE = process.env.GOOFISH_OAUTH_DATA ||
  path.join(process.env.GOOFISH_DATA_DIR || '/home/ant/service/goofish-mcp/data', 'oauth.json');

function load() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('oauth: failed to load data, starting fresh:', e && e.message);
  }
  return { clients: {}, codes: {}, tokens: {}, refreshTokens: {} };
}

function save(state) {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error('oauth: failed to persist:', e && e.message);
  }
}

class PersistentClientsStore {
  constructor(state) {
    this.state = state;
    this.clients = state.clients || (state.clients = {});
  }
  async getClient(clientId) {
    return this.clients[clientId];
  }
  async registerClient(clientMetadata) {
    const clientId = clientMetadata.client_id || crypto.randomUUID();
    const record = { ...clientMetadata, client_id: clientId, client_id_issued_at: clientMetadata.client_id_issued_at || Math.floor(Date.now() / 1000) };
    this.clients[clientId] = record;
    save(this.state);
    return record;
  }
}

class PersistentOAuthProvider {
  constructor() {
    this.state = load();
    this.clientsStore = new PersistentClientsStore(this.state);
    this.codes = this.state.codes;
    this.tokens = this.state.tokens;
    this.refreshTokens = this.state.refreshTokens;
  }

  authorize(client, params, res) {
    const code = crypto.randomUUID();
    this.codes[code] = {
      clientId: client.client_id,
      codeChallenge: params.codeChallenge,
      redirectUri: params.redirectUri,
      scopes: params.scopes || [],
      resource: params.resource ? params.resource.href : undefined,
      expiresAt: Date.now() + 10 * 60 * 1000, // 10 min
    };
    save(this.state);

    const target = new URL(params.redirectUri);
    target.searchParams.set('code', code);
    if (params.state !== undefined) target.searchParams.set('state', params.state);
    res.redirect(302, target.toString());
  }

  async challengeForAuthorizationCode(_client, authorizationCode) {
    const c = this.codes[authorizationCode];
    if (!c || c.expiresAt < Date.now()) throw new Error('Invalid or expired authorization code');
    return c.codeChallenge;
  }

  async exchangeAuthorizationCode(client, authorizationCode, _codeVerifier) {
    const c = this.codes[authorizationCode];
    if (!c || c.expiresAt < Date.now()) throw new Error('Invalid or expired authorization code');
    if (c.clientId !== client.client_id) {
      throw new Error(`Authorization code was not issued to this client (${c.clientId} != ${client.client_id})`);
    }
    delete this.codes[authorizationCode];

    const accessToken = crypto.randomBytes(32).toString('hex');
    const refreshToken = crypto.randomBytes(32).toString('hex');
    const expiresIn = 3600;
    this.tokens[accessToken] = {
      clientId: client.client_id,
      scopes: c.scopes,
      resource: c.resource,
      expiresAt: Date.now() + expiresIn * 1000,
    };
    this.refreshTokens[refreshToken] = {
      clientId: client.client_id,
      scopes: c.scopes,
      resource: c.resource,
      expiresAt: Date.now() + 30 * 24 * 3600 * 1000, // 30 day refresh
    };
    save(this.state);
    return {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: expiresIn,
      scope: c.scopes.join(' '),
      refresh_token: refreshToken,
    };
  }

  async exchangeRefreshToken(client, refreshToken, scopes, resource) {
    const rt = this.refreshTokens[refreshToken];
    if (!rt || rt.clientId !== client.client_id) throw new Error('Invalid refresh token');
    const newAccess = crypto.randomBytes(32).toString('hex');
    this.tokens[newAccess] = {
      clientId: client.client_id,
      scopes: scopes || rt.scopes,
      resource: (resource ? resource.href : undefined) || rt.resource,
      expiresAt: Date.now() + 3600 * 1000,
    };
    save(this.state);
    return {
      access_token: newAccess,
      token_type: 'bearer',
      expires_in: 3600,
      scope: (scopes || rt.scopes).join(' '),
      refresh_token: refreshToken,
    };
  }

  async verifyAccessToken(token) {
    const t = this.tokens[token];
    if (!t || t.expiresAt < Date.now()) throw new Error('Invalid or expired token');
    return {
      token,
      clientId: t.clientId,
      scopes: t.scopes,
      expiresAt: Math.floor(t.expiresAt / 1000),
      resource: t.resource,
    };
  }

  // 令牌撤销（可选，供 /revoke 使用）
  async revokeToken(_client, request) {
    const t = request.token;
    if (this.tokens[t]) { delete this.tokens[t]; save(this.state); }
    if (this.refreshTokens[t]) { delete this.refreshTokens[t]; save(this.state); }
  }
}

module.exports = { PersistentClientsStore, PersistentOAuthProvider };
