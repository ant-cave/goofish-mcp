/* SPDX-License-Identifier: MIT */
/**
 * 共用层：主题切换 / toast / api 封装 / 格式化 / 复制 / CSV 导出 / modal
 * 视觉与交互保持 ant-toolkit 黑白灰语言。
 */
(function () {
  'use strict';

  /* ---------- 主题（复刻 toolkit theme store：light / dark / system） ---------- */
  var themeToggle = document.getElementById('themeToggle');
  var iconSun = document.getElementById('iconSun');
  var iconMoon = document.getElementById('iconMoon');
  function isDark() { return document.documentElement.classList.contains('dark'); }
  function refreshThemeIcons() {
    if (!themeToggle) return;
    iconSun.hidden = !isDark();
    iconMoon.hidden = isDark();
    themeToggle.title = isDark() ? '切换到亮色模式' : '切换到暗色模式';
  }
  if (themeToggle) {
    themeToggle.addEventListener('click', function () {
      localStorage.setItem('toolkit-theme', isDark() ? 'light' : 'dark');
      document.documentElement.classList.toggle('dark', !isDark());
      refreshThemeIcons();
    });
  }
  refreshThemeIcons();

  /* ---------- 工具 ---------- */
  function $(s) { return document.querySelector(s); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function pad(n) { return String(n).padStart(2, '0'); }
  // ISO -> 本地时间（与服务器时区无关）
  function fmtTime(iso, withSec) {
    if (!iso) return '-';
    var d = new Date(iso);
    if (isNaN(d)) return String(iso);
    var s = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    return withSec === false ? s : s + ':' + pad(d.getSeconds());
  }
  function fmtMs(ms) {
    if (ms == null || isNaN(ms)) return '-';
    return ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : ms + 'ms';
  }
  function shortKey(k) {
    k = String(k || '');
    if (!k) return '-';
    return k.length <= 14 ? k : k.slice(0, 8) + '…' + k.slice(-4);
  }

  /* ---------- api 封装（401 跳登录） ---------- */
  async function api(path, opts) {
    var res = await fetch(path, Object.assign({
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
    }, opts || {}));
    if (res.status === 401 && path.indexOf('/admin/login') !== 0) {
      location.href = '/admin/login';
      throw new Error('unauthorized');
    }
    var data = null;
    try { data = await res.json(); } catch (e) { /* non-json */ }
    return { ok: res.ok, status: res.status, data: data || {} };
  }
  async function post(path, body) {
    return api(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined });
  }

  /* ---------- toast（右下堆叠，错误加重左边框，点击关闭） ---------- */
  var OK_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
  var ERR_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
  function toast(msg, type) {
    var stack = document.getElementById('toastStack');
    if (!stack) return;
    var isErr = type === 'err';
    var el = document.createElement('div');
    el.className = 'toast-item' + (isErr ? ' is-err' : '');
    el.innerHTML = (isErr ? ERR_ICON : OK_ICON) + '<div>' + esc(msg) + '</div>';
    el.addEventListener('click', function () { dismiss(); });
    stack.appendChild(el);
    while (stack.children.length > 4) stack.removeChild(stack.firstElementChild);
    var timer = setTimeout(dismiss, isErr ? 4600 : 3000);
    function dismiss() {
      clearTimeout(timer);
      el.classList.add('is-out');
      setTimeout(function () { el.remove(); }, 250);
    }
  }

  /* ---------- 复制 ---------- */
  function copy(text, okMsg) {
    function ok() { toast(okMsg || '已复制到剪贴板'); }
    function fail() { toast('复制失败，请手动选择复制', 'err'); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(ok, fail);
    } else {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy') ? ok() : fail(); } catch (e) { fail(); }
      document.body.removeChild(ta);
    }
  }

  /* ---------- CSV 导出（前端生成，含 BOM 防 Excel 乱码） ---------- */
  function exportCsv(filename, header, rows) {
    var csvCell = function (v) {
      v = v == null ? '' : String(v);
      return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    };
    var lines = [header.map(csvCell).join(',')];
    for (var r of rows) lines.push(r.map(csvCell).join(','));
    var blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  /* ---------- modal ---------- */
  var modalCleanups = [];
  function openModal(html, onOpen) {
    var box = document.getElementById('modalBox');
    box.innerHTML = html;
    document.getElementById('modal').hidden = false;
    if (onOpen) { var c = onOpen(); if (typeof c === 'function') modalCleanups.push(c); }
  }
  function closeModal() {
    while (modalCleanups.length) { try { modalCleanups.pop()(); } catch (e) { /* ignore */ } }
    document.getElementById('modal').hidden = true;
    document.getElementById('modalBox').innerHTML = '';
  }
  document.getElementById('modal').addEventListener('click', function (e) {
    if (e.target === this) closeModal();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !document.getElementById('modal').hidden) closeModal();
  });

  window.App = {
    $: $, esc: esc, fmtTime: fmtTime, fmtMs: fmtMs, shortKey: shortKey,
    api: api, post: post, toast: toast, copy: copy, exportCsv: exportCsv,
    openModal: openModal, closeModal: closeModal,
  };
})();
