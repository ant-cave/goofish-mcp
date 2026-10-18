/* SPDX-License-Identifier: MIT */
/**
 * 管理面板逻辑：Tab / 统计 / 概览（登录态+Tokens+接入）/ 调用日志 / API Keys / 设置
 * 依赖 public/js/app.js 的 window.App 共用层。
 */
(function () {
  'use strict';
  var App = window.App;
  var $ = App.$, esc = App.esc, fmtTime = App.fmtTime, fmtMs = App.fmtMs;

  /* ================= Tab ================= */
  var TAB_KEY = 'goofish-admin-tab';
  var tabs = Array.prototype.slice.call(document.querySelectorAll('.tab'));
  function switchTab(name) {
    tabs.forEach(function (t) {
      var active = t.getAttribute('data-tab') === name;
      t.classList.toggle('active', active);
      var panel = document.getElementById('panel-' + t.getAttribute('data-tab'));
      if (panel) panel.hidden = !active;
    });
    try { localStorage.setItem(TAB_KEY, name); } catch (e) { /* ignore */ }
    if (name === 'logs') loadLogs(1);
    if (name === 'keys') loadKeys();
  }
  tabs.forEach(function (t) {
    t.addEventListener('click', function () { switchTab(t.getAttribute('data-tab')); });
  });

  /* ================= 统计 ================= */
  var logState = { offset: 0, limit: 20, page: 1, total: 0, auto: false, timer: null };

  function loadStats() {
    App.api('/admin/api/stats?days=7').then(function (r) {
      var s = r.data;
      $('#stTotal').textContent = s.total;
      $('#stTotalExtra').textContent = '失败 ' + s.failCount + ' 次';
      $('#stRate').textContent = s.successRate + '%';
      $('#stRateExtra').textContent = '成功 ' + s.okCount + ' / ' + s.total;
      $('#stToday').textContent = s.todayCount;
      $('#stAvg').textContent = fmtMs(s.avgMs);
      $('#stAvgExtra').textContent = 'MCP 请求平均';
      // 工具下拉选项（来自统计）
      var sel = $('#logTool');
      var cur = sel.value;
      var opts = ['<option value="">全部工具</option>'];
      (s.byTool || []).forEach(function (t) {
        opts.push('<option value="' + esc(t.tool) + '">' + esc(t.tool) + ' (' + t.count + ')</option>');
      });
      sel.innerHTML = opts.join('');
      sel.value = cur;
    });
  }

  /* ================= 状态（概览） ================= */
  function loadStatus() {
    App.api('/admin/api/status').then(function (r) {
      var st = r.data;
      $('#demoBanner').hidden = !st.demo;

      var badge = $('#loginBadge');
      if (st.hasCookie) {
        badge.textContent = '✓ 已登录';
        badge.classList.remove('is-off');
        $('#cookieMeta').textContent = 'cookie 更新于 ' + st.cookieMtime;
      } else {
        badge.textContent = '✗ 未登录';
        badge.classList.add('is-off');
        $('#cookieMeta').textContent = '';
      }
      $('#anonTip').hidden = !!st.hasCookie;

      $('#tokenCount').textContent = st.tokens.length;
      $('#tokenTableWrap').hidden = st.tokens.length === 0;
      $('#tokenEmpty').hidden = st.tokens.length !== 0;
      $('#tokenRows').innerHTML = st.tokens.map(function (t) {
        return '<tr>' +
          '<td class="mono">' + esc(t.id) + '</td>' +
          '<td class="mono">' + esc(t.clientId) + '</td>' +
          '<td class="mono">' + esc(t.scopes) + '</td>' +
          '<td class="mono">' + esc(t.expiresAt) + '</td>' +
          '<td class="actions"><button class="btn btn-ghost btn-sm" data-revoke="' + esc(t.id) + '">吊销</button></td>' +
          '</tr>';
      }).join('') || '';
      Array.prototype.forEach.call($('#tokenRows').querySelectorAll('[data-revoke]'), function (btn) {
        btn.addEventListener('click', function () {
          App.post('/admin/revoke-token', { id: btn.getAttribute('data-revoke') }).then(function (res) {
            App.toast(res.data.revoked ? 'token 已吊销' : 'token 不存在或已失效');
            loadStatus();
            loadStats();
          });
        });
      });

      $('#adminKeyMask').textContent = st.adminKeyMask || '(未配置)';
      $('#tabKeyCount').textContent = st.clientKeyEnabled + '/' + st.clientKeyCount;
    });
  }

  /* ================= 扫码登录 ================= */
  var qrTimer = null;
  $('#qrStartBtn').addEventListener('click', function () {
    var btn = this;
    btn.disabled = true;
    App.post('/admin/qr/start').then(function (r) {
      btn.disabled = false;
      if (!r.data.ok) { App.toast('二维码生成失败: ' + (r.data.error || '未知错误'), 'err'); return; }
      $('#qrBox').hidden = false;
      $('#qrStatus').textContent = '生成中…';
      var box = $('#qrImg');
      box.innerHTML = '';
      if (window.QRCode) {
        new QRCode(box, { text: r.data.qr, width: 220, height: 220 });
      } else {
        box.innerHTML = '<code class="qr-fallback">' + esc(r.data.qr) + '</code>';
      }
      $('#qrStatus').textContent = '请用闲鱼 APP 扫码';
      $('#demoConfirmBtn').hidden = false;
      clearInterval(qrTimer);
      qrTimer = setInterval(function () {
        App.api('/admin/qr/status').then(function (res) {
          var s = res.data;
          if (!s.ok) return;
          if (s.status === 'CONFIRMED') {
            clearInterval(qrTimer);
            $('#qrStatus').textContent = '已确认，正在刷新…';
            setTimeout(function () {
              $('#qrBox').hidden = true;
              $('#demoConfirmBtn').hidden = true;
              loadStatus();
              App.toast('闲鱼登录成功');
            }, 800);
          } else if (['EXPIRED', 'CANCELED', 'ERROR'].indexOf(s.status) >= 0) {
            clearInterval(qrTimer);
            $('#qrStatus').textContent = '状态: ' + s.status;
            $('#demoConfirmBtn').hidden = true;
          } else {
            $('#qrStatus').textContent = '状态: ' + (s.status || 'UNKNOWN');
          }
        });
      }, 3000);
    });
  });

  $('#demoConfirmBtn').addEventListener('click', function () {
    var btn = this;
    btn.disabled = true;
    App.post('/admin/api/demo/confirm').then(function () {
      btn.disabled = false;
      App.toast('已模拟扫码确认，等待状态刷新…');
    });
  });

  $('#clearSessionBtn').addEventListener('click', function () {
    App.post('/admin/logout-xianyu').then(function () {
      App.toast('登录态已清除');
      loadStatus();
    });
  });

  /* ================= MCP 接入信息 ================= */
  var endpoint = location.origin + '/mcp';
  $('#endpointBox').textContent = endpoint;
  $('#configBox').textContent = JSON.stringify({
    mcpServers: {
      goofish: {
        url: endpoint,
        transport: 'streamable-http',
        headers: { Authorization: 'Bearer <your-api-key>' },
      },
    },
  }, null, 2);
  Array.prototype.forEach.call(document.querySelectorAll('[data-copy]'), function (btn) {
    btn.addEventListener('click', function () {
      App.copy($(btn.getAttribute('data-copy')).textContent);
    });
  });

  /* ================= 调用日志 ================= */
  function logFilter() {
    return {
      kind: $('#logKind').value,
      ok: $('#logOk').value,
      tool: $('#logTool').value,
      q: $('#logQ').value.trim(),
    };
  }

  function loadLogs(page) {
    var f = logFilter();
    if (typeof page === 'number' && page > 0) {
      logState.page = page;
      logState.offset = (page - 1) * logState.limit;
    } else if (typeof page === 'number') {
      // 防御：页码必须 >=1（switchTab 等调用方传 0 时回落到第一页）
      logState.page = 1;
      logState.offset = 0;
    }
    var qs = 'limit=' + logState.limit + '&offset=' + logState.offset + '&days=2';
    if (f.kind) qs += '&kind=' + encodeURIComponent(f.kind);
    if (f.ok) qs += '&ok=' + f.ok;
    if (f.tool) qs += '&tool=' + encodeURIComponent(f.tool);
    if (f.q) qs += '&q=' + encodeURIComponent(f.q);
    App.api('/admin/api/logs?' + qs).then(function (r) {
      var d = r.data;
      logState.total = d.total || 0;
      $('#logTotal').textContent = logState.total + ' 条';
      $('#tabLogCount').textContent = logState.total ? String(logState.total) : '';
      renderLogs(d.items || []);
      renderPager();
      $('#logEmpty').hidden = (d.items || []).length > 0;
    });
  }

  function logResultBadge(row) {
    return row.ok
      ? '<span class="badge solid">成功</span>'
      : '<span class="badge plain">失败</span>';
  }
  function logKindBadge(row) {
    return row.kind === 'admin'
      ? '<span class="badge">管理</span>'
      : '<span class="badge">MCP</span>';
  }
  function logOpText(row) {
    if (row.tool) return esc(row.tool);
    return esc(row.action || '-');
  }

  function renderLogs(rows) {
    // 桌面表格
    $('#logRows').innerHTML = rows.map(function (row) {
      return '<tr data-logid="' + esc(row.ts) + '">' +
        '<td class="mono">' + esc(fmtTime(row.ts)) + '</td>' +
        '<td>' + logKindBadge(row) + '</td>' +
        '<td>' + logOpText(row) + '</td>' +
        '<td class="mono" title="' + esc(row.keyName || '') + '">' + esc(row.keyName || '-') + '</td>' +
        '<td class="mono">' + esc(row.ip) + '</td>' +
        '<td class="num mono">' + esc(fmtMs(row.ms)) + '</td>' +
        '<td>' + logResultBadge(row) + '</td>' +
        '<td class="actions"><button class="btn btn-ghost btn-sm" data-detail="1">详情</button></td>' +
        '</tr>';
    }).join('') || '';
    Array.prototype.forEach.call($('#logRows').querySelectorAll('[data-detail]'), function (btn) {
      btn.addEventListener('click', function () {
        var tr = btn.closest('tr');
        var next = tr.nextElementSibling;
        if (next && next.classList.contains('log-detail-row')) { next.remove(); return; }
        var row = rows.find(function (r) { return String(r.ts) === tr.getAttribute('data-logid'); });
        var el = document.createElement('tr');
        el.className = 'log-detail-row';
        el.innerHTML = '<td colspan="8">' + logDetailHtml(row) + '</td>';
        tr.parentNode.insertBefore(el, tr.nextSibling);
      });
    });

    // 移动端卡片
    $('#logMobileRows').innerHTML = rows.map(function (row) {
      return '<div class="mobile-card">' +
        '<div class="mc-head">' + logKindBadge(row) + logResultBadge(row) +
          '<span class="mc-title">' + logOpText(row) + '</span></div>' +
        '<div class="mc-row"><span class="mc-meta">' + esc(fmtTime(row.ts)) + '</span>' +
          '<span class="mc-meta">' + esc(row.ip) + '</span>' +
          '<span class="mc-meta">' + esc(fmtMs(row.ms)) + '</span></div>' +
        '<div class="mc-row"><span class="mc-meta">Key: ' + esc(row.keyName || '-') + '</span></div>' +
        (row.ok ? '' : '<div class="mc-row" style="color:var(--text)">' + esc(row.error || '') + '</div>') +
        '<div class="mc-actions"><button class="btn btn-ghost btn-sm" data-mdetail="1">详情</button></div>' +
        '<div class="log-detail" hidden style="margin-top:0.25rem;border:1px solid var(--border);border-radius:0.125rem">' +
          logDetailHtml(row, true) + '</div>' +
        '</div>';
    }).join('') || '';
    Array.prototype.forEach.call($('#logMobileRows').querySelectorAll('[data-mdetail]'), function (btn) {
      btn.addEventListener('click', function () {
        var box = btn.closest('.mobile-card').querySelector('.log-detail');
        box.hidden = !box.hidden;
        btn.textContent = box.hidden ? '详情' : '收起';
      });
    });
  }

  function logDetailHtml(row, plain) {
    var rows = [];
    rows.push('<div class="ld-row"><b>时间</b> ' + esc(row.ts) + '</div>');
    rows.push('<div class="ld-row"><b>类型</b> ' + esc(row.kind) + ' · <b>操作</b> ' + esc(row.action || '-') +
      (row.tool ? ' · <b>工具</b> ' + esc(row.tool) : '') + '</div>');
    if (row.auth) rows.push('<div class="ld-row"><b>鉴权</b> ' + esc(row.auth) + ' · <b>Key</b> ' + esc(row.keyName || '-') + '</div>');
    rows.push('<div class="ld-row"><b>IP</b> ' + esc(row.ip) + ' · <b>耗时</b> ' + esc(fmtMs(row.ms)) + ' · <b>结果</b> ' + (row.ok ? '成功' : '失败') + '</div>');
    if (row.detail) rows.push('<pre>' + esc(prettyJson(row.detail)) + '</pre>');
    if (row.error) rows.push('<pre>' + esc(row.error) + '</pre>');
    return (plain ? '' : '<div class="log-detail">') + rows.join('') + (plain ? '' : '</div>');
  }
  function prettyJson(s) {
    try { return JSON.stringify(JSON.parse(s), null, 2); } catch (e) { return String(s); }
  }

  function renderPager() {
    var total = logState.total;
    var pages = Math.max(1, Math.ceil(total / logState.limit));
    var page = Math.min(logState.page, pages);
    logState.page = page;
    var btns = [];
    btns.push('<button class="pg-btn" data-pg="' + (page - 1) + '"' + (page <= 1 ? ' disabled' : '') + '>上一页</button>');
    var start = Math.max(1, page - 3), end = Math.min(pages, start + 6);
    start = Math.max(1, end - 6);
    if (start > 1) {
      btns.push('<button class="pg-btn" data-pg="1">1</button>');
      if (start > 2) btns.push('<span style="padding:0 0.25rem;color:var(--text-4)">…</span>');
    }
    for (var i = start; i <= end; i++) {
      btns.push('<button class="pg-btn' + (i === page ? ' active' : '') + '" data-pg="' + i + '">' + i + '</button>');
    }
    if (end < pages) {
      if (end < pages - 1) btns.push('<span style="padding:0 0.25rem;color:var(--text-4)">…</span>');
      btns.push('<button class="pg-btn" data-pg="' + pages + '">' + pages + '</button>');
    }
    btns.push('<button class="pg-btn" data-pg="' + (page + 1) + '"' + (page >= pages ? ' disabled' : '') + '>下一页</button>');
    $('#logPager').innerHTML =
      '<span>共 ' + total + ' 条 · 第 ' + page + ' / ' + pages + ' 页</span>' +
      '<span class="pg-btns">' + btns.join('') + '</span>';
    Array.prototype.forEach.call($('#logPager').querySelectorAll('[data-pg]'), function (btn) {
      btn.addEventListener('click', function () {
        var p = parseInt(btn.getAttribute('data-pg'), 10);
        if (p >= 1 && p <= pages) loadLogs(p);
      });
    });
  }

  $('#logRefreshBtn').addEventListener('click', function () { loadLogs(1); });
  ['#logKind', '#logOk', '#logTool'].forEach(function (sel) {
    $(sel).addEventListener('change', function () { loadLogs(1); });
  });
  var qTimer = null;
  $('#logQ').addEventListener('input', function () {
    clearTimeout(qTimer);
    qTimer = setTimeout(function () { loadLogs(1); }, 300);
  });

  // 自动刷新（10s）
  $('#logAutoBtn').addEventListener('click', function () {
    logState.auto = !logState.auto;
    this.textContent = '自动刷新：' + (logState.auto ? '开（10s）' : '关');
    clearInterval(logState.timer);
    if (logState.auto) {
      logState.timer = setInterval(function () { loadLogs(); }, 10000);
      App.toast('已开启自动刷新（10 秒）');
    }
  });

  // 导出 CSV（导出当前筛选的全部匹配，最多 500 条）
  $('#logExportBtn').addEventListener('click', function () {
    var f = logFilter();
    var qs = 'limit=500&offset=0&days=2';
    if (f.kind) qs += '&kind=' + encodeURIComponent(f.kind);
    if (f.ok) qs += '&ok=' + f.ok;
    if (f.tool) qs += '&tool=' + encodeURIComponent(f.tool);
    if (f.q) qs += '&q=' + encodeURIComponent(f.q);
    App.api('/admin/api/logs?' + qs).then(function (r) {
      var rows = (r.data.items || []).map(function (row) {
        return [
          row.ts, row.kind, row.action || '', row.tool || '', row.auth || '', row.keyName || '',
          row.ip, row.ms == null ? '' : row.ms, row.ok ? 'success' : 'fail',
          row.detail || '', row.error || '',
        ];
      });
      App.exportCsv('goofish-mcp-logs-' + new Date().toISOString().slice(0, 10) + '.csv',
        ['时间', '类型', '操作', '工具', '鉴权', 'Key', 'IP', '耗时ms', '结果', '参数', '错误'], rows);
      App.toast('已导出 ' + rows.length + ' 条');
    });
  });

  /* ================= API Keys ================= */
  function loadKeys() {
    App.api('/admin/api/keys').then(function (r) {
      var keys = r.data.keys || [];
      $('#keyCount').textContent = keys.length;
      $('#keyEmpty').hidden = keys.length > 0;
      $('#keyTableWrap').hidden = keys.length === 0;
      $('#keyMobileWrap').hidden = keys.length === 0;
      renderKeys(keys);
      loadStatus();
    });
  }

  function keyMask(k) {
    k = String(k || '');
    if (k.length <= 12) return k;
    return k.slice(0, 7) + '••••••••' + k.slice(-4);
  }

  function renderKeys(keys) {
    var rowHtml = keys.map(function (k) {
      return '<tr data-keyid="' + esc(k.id) + '">' +
        '<td style="font-weight:500">' + esc(k.name) + '</td>' +
        '<td class="mono"><span data-mask>' + esc(keyMask(k.key)) + '</span>' +
          '<span data-full hidden>' + esc(k.key) + '</span></td>' +
        '<td style="color:var(--text-3);font-size:0.75rem">' + esc(k.note || '-') + '</td>' +
        '<td>' + (k.enabled ? '<span class="badge solid">启用</span>' : '<span class="badge plain">禁用</span>') + '</td>' +
        '<td class="mono">' + esc(k.lastUsedAt ? fmtTime(k.lastUsedAt) : '从未') + '</td>' +
        '<td class="actions">' +
          '<button class="btn btn-ghost btn-sm" data-eye="1">' + (k.enabled ? '查看' : '查看') + '</button>' +
          '<button class="btn btn-ghost btn-sm" data-copy-key="1">复制</button>' +
          '<button class="btn btn-ghost btn-sm" data-toggle="1">' + (k.enabled ? '禁用' : '启用') + '</button>' +
          '<button class="btn btn-ghost btn-sm" data-del="1">删除</button>' +
        '</td>' +
        '</tr>';
    }).join('');
    $('#keyRows').innerHTML = rowHtml;

    var cardHtml = keys.map(function (k) {
      return '<div class="mobile-card" data-keyid="' + esc(k.id) + '">' +
        '<div class="mc-head"><span class="mc-title">' + esc(k.name) + '</span>' +
          (k.enabled ? '<span class="badge solid">启用</span>' : '<span class="badge plain">禁用</span>') + '</div>' +
        '<div class="mc-row"><span class="mc-meta" data-mask>' + esc(keyMask(k.key)) + '</span></div>' +
        '<div class="mc-row"><span class="mc-meta">' + esc(k.note || '') + '</span>' +
          '<span class="mc-meta">最近: ' + esc(k.lastUsedAt ? fmtTime(k.lastUsedAt) : '从未') + '</span></div>' +
        '<div class="mc-actions">' +
          '<button class="btn btn-ghost btn-sm" data-copy-key="1">复制</button>' +
          '<button class="btn btn-ghost btn-sm" data-toggle="1">' + (k.enabled ? '禁用' : '启用') + '</button>' +
          '<button class="btn btn-ghost btn-sm" data-del="1">删除</button>' +
        '</div>' +
        '</div>';
    }).join('');
    $('#keyMobileRows').innerHTML = cardHtml;

    Array.prototype.forEach.call(document.querySelectorAll('#keyRows [data-eye], #keyMobileRows [data-eye]'), function (btn) {
      btn.addEventListener('click', function () {
        var card = btn.closest('[data-keyid]');
        var mask = card.querySelector('[data-mask]');
        var full = card.querySelector('[data-full]');
        if (!full) return;
        var show = full.hidden;
        full.hidden = !show;
        mask.hidden = show;
        btn.textContent = show ? '隐藏' : '查看';
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll('#keyRows [data-copy-key], #keyMobileRows [data-copy-key]'), function (btn) {
      btn.addEventListener('click', function () {
        var card = btn.closest('[data-keyid]');
        var id = card.getAttribute('data-keyid');
        var rec = keys.find(function (k) { return k.id === id; });
        if (rec) App.copy(rec.key, 'Key 已复制');
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll('#keyRows [data-toggle], #keyMobileRows [data-toggle]'), function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.closest('[data-keyid]').getAttribute('data-keyid');
        var rec = keys.find(function (k) { return k.id === id; });
        App.post('/admin/api/keys/' + encodeURIComponent(id) + '/toggle', { enabled: !rec.enabled }).then(function (res) {
          if (res.data.ok) { App.toast('已' + (res.data.key.enabled ? '启用' : '禁用') + ' ' + rec.name); loadKeys(); }
          else App.toast(res.data.error || '操作失败', 'err');
        });
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll('#keyRows [data-del], #keyMobileRows [data-del]'), function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.closest('[data-keyid]').getAttribute('data-keyid');
        var rec = keys.find(function (k) { return k.id === id; });
        App.openModal(
          '<div class="modal-title">删除 API Key</div>' +
          '<p style="font-size:0.8125rem;color:var(--text-2)">确认删除 <b>' + esc(rec.name) + '</b>（' + esc(keyMask(rec.key)) + '）？删除后使用该 Key 的请求将立即失效，不可恢复。</p>' +
          '<div class="modal-actions">' +
            '<button class="btn btn-ghost" data-close>取消</button>' +
            '<button class="btn btn-primary" data-confirm>确认删除</button>' +
          '</div>',
          function () {
            $('[data-close]').addEventListener('click', App.closeModal);
            $('[data-confirm]').addEventListener('click', function () {
              App.post('/admin/api/keys/' + encodeURIComponent(id) + '/delete').then(function (res) {
                App.closeModal();
                if (res.data.ok) { App.toast('已删除'); loadKeys(); }
                else App.toast(res.data.error || '删除失败', 'err');
              });
            });
          }
        );
      });
    });
  }

  // 创建 Key
  $('#createKeyBtn').addEventListener('click', function () {
    App.openModal(
      '<div class="modal-title">创建 API Key</div>' +
      '<div class="modal-field"><label class="field-label">名称（必填，如 openclaw / chatgpt）</label>' +
        '<input class="input" id="nkName" placeholder="用途名称" /></div>' +
      '<div class="modal-field"><label class="field-label">备注（选填）</label>' +
        '<input class="input" id="nkNote" placeholder="备注信息" /></div>' +
      '<div class="modal-field"><label class="field-label">自定义 Key（选填，留空自动生成 sk- 前缀随机串）</label>' +
        '<input class="input mono" id="nkKey" placeholder="sk-..." /></div>' +
      '<div class="modal-actions">' +
        '<button class="btn btn-ghost" data-close>取消</button>' +
        '<button class="btn btn-primary" data-create>创建</button>' +
      '</div>',
      function () {
        $('[data-close]').addEventListener('click', App.closeModal);
        $('[data-create]').addEventListener('click', function () {
          var name = $('#nkName').value.trim();
          if (!name) { App.toast('请填写名称', 'err'); return; }
          var btn = this;
          btn.disabled = true;
          App.post('/admin/api/keys', {
            name: name,
            note: $('#nkNote').value.trim(),
            key: $('#nkKey').value.trim(),
          }).then(function (res) {
            btn.disabled = false;
            if (!res.data.ok) { App.toast(res.data.error || '创建失败', 'err'); return; }
            var rec = res.data.key;
            App.openModal(
              '<div class="modal-title">Key 创建成功</div>' +
              '<p style="font-size:0.75rem;color:var(--text-3);margin-bottom:0.5rem">请立即复制保存，刷新页面后将只显示掩码。</p>' +
              '<div class="code-row"><div class="code-block" id="nkFull">' + esc(rec.key) + '</div>' +
                '<button class="btn btn-ghost btn-sm" data-copyfull>复制</button></div>' +
              '<div class="modal-actions"><button class="btn btn-primary" data-done>完成</button></div>',
              function () {
                $('[data-copyfull]').addEventListener('click', function () { App.copy(rec.key); });
                $('[data-done]').addEventListener('click', function () { App.closeModal(); loadKeys(); loadStats(); });
              }
            );
          });
        });
      }
    );
  });

  /* ================= 设置：管理密钥 ================= */
  function randKey() {
    var arr = new Uint32Array(4);
    (window.crypto || window.msCrypto).getRandomValues(arr);
    return 'sk-admin-' + Array.prototype.map.call(arr, function (n) { return n.toString(36); }).join('').slice(0, 20);
  }
  $('#genAdminKeyBtn').addEventListener('click', function () {
    var k = randKey();
    $('#newAdminKey').value = k;
    $('#newAdminKey2').value = k;
  });
  $('#saveAdminKeyBtn').addEventListener('click', function () {
    var k1 = $('#newAdminKey').value.trim();
    var k2 = $('#newAdminKey2').value.trim();
    if (k1.length < 8) { App.toast('密钥至少 8 位', 'err'); return; }
    if (k1 !== k2) { App.toast('两次输入不一致', 'err'); return; }
    var btn = this;
    btn.disabled = true;
    App.post('/admin/api/admin-key', { key: k1 }).then(function (res) {
      btn.disabled = false;
      if (!res.data.ok) { App.toast(res.data.error || '保存失败', 'err'); return; }
      App.toast('管理密钥已更新，请重新登录');
      setTimeout(function () { location.href = '/admin/login'; }, 800);
    });
  });

  /* ================= 登出 ================= */
  $('#logoutBtn').addEventListener('click', function () {
    App.post('/admin/logout').then(function () { location.href = '/admin/login'; });
  });

  /* ================= 启动 ================= */
  var initTab = 'overview';
  try { initTab = localStorage.getItem(TAB_KEY) || 'overview'; } catch (e) { /* ignore */ }
  if (!document.getElementById('panel-' + initTab)) initTab = 'overview';
  switchTab(initTab);
  loadStats();
  loadStatus();
})();
