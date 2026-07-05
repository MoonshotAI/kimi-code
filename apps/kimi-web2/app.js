/* Kimi Code Web prototype — rendering + interactions (no backend). */
(function () {
  'use strict';
  var S = window.Store;
  var root = document.documentElement;

  /* ----------------------------- i18n (light) --------------------------- */
  var I = {
    zh: {
      search: '搜索会话', newChat: '新建对话', workspaces: '工作区', showMore: '加载更多',
      feedback: '问题与反馈', placeholder: '输入消息…  Enter 发送 · Shift+Enter 换行',
      send: '发送', stop: '打断', settings: '设置', close: '关闭',
      emptyTitle: 'Kimi Code', emptySub: '从设计系统出发，calm、克制、填充式的编程助手。',
      sug1: '帮我捋一下这个仓库的结构', sug2: '把这个页面改成 Kimi 风格', sug3: '解释一下这段代码',
      general: '通用', agent: 'Agent', account: '账户', advanced: '高级',
    },
    en: {
      search: 'Search', newChat: 'New chat', workspaces: 'Workspaces', showMore: 'Show more',
      feedback: 'Feedback', placeholder: 'Message…  Enter to send · Shift+Enter for newline',
      send: 'Send', stop: 'Stop', settings: 'Settings', close: 'Close',
      emptyTitle: 'Kimi Code', emptySub: 'A calm, fill-based coding assistant built from the design system.',
      sug1: 'Walk me through this repo', sug2: 'Restyle this page to Kimi', sug3: 'Explain this code',
      general: 'General', agent: 'Agent', account: 'Account', advanced: 'Advanced',
    },
  };
  function t(k) { return (I[S.state.lang] || I.zh)[k] || I.zh[k] || k; }

  /* ----------------------------- helpers -------------------------------- */
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function icon(id, cls) {
    return '<svg' + (cls ? ' class="' + cls + '"' : '') + '><use href="#' + id + '"/></svg>';
  }
  function $(sel) { return document.querySelector(sel); }

  /* ----------------------------- render: sidebar ------------------------ */
  function renderSidebar() {
    var host = $('.sb-scroll');
    if (host) host.innerHTML = sbListHTML();
  }

  function sbListHTML() {
    var h = '';
    h += '<div class="sec-label"><span>' + esc(t('workspaces')) + '</span>' +
      '<span class="acts">' +
      '<button class="ic-btn" aria-label="折叠/展开" data-act="toggle-all">' + icon('i-chevron-down') + '</button>' +
      '<button class="ic-btn" aria-label="选项" data-act="ws-menu">' + icon('i-dots') + '</button>' +
      '</span></div>';

    S.workspaces.forEach(function (w) {
      var collapsed = !!S.state.collapsed[w.id];
      var sessions = S.sessions.filter(function (s) { return s.ws === w.id; });
      var expanded = !!S.state.expanded[w.id];
      var showCount = expanded ? sessions.length : Math.min(sessions.length, 4);
      h += '<div class="ws" data-ws="' + w.id + '">';
      h += '<button class="ws-head" data-act="toggle-ws" data-ws="' + w.id + '">' +
        icon('i-folder', 'folder') +
        '<span class="ws-name">' + esc(w.name) + '</span>' +
        '<span class="ws-actions">' +
        '<span class="ic-btn" aria-label="添加" data-act="add-ws" data-ws="' + w.id + '">' + icon('i-plus') + '</span>' +
        '<span class="ic-btn" aria-label="更多" data-act="ws-item-menu" data-ws="' + w.id + '">' + icon('i-dots') + '</span>' +
        '</span></button>';
      if (!collapsed) {
        if (w.root) h += '<div class="ws-path">' + esc(w.root) + '</div>';
        sessions.slice(0, showCount).forEach(function (s) { h += sessHTML(s); });
        if (sessions.length > 4) {
          h += '<button class="show-more" data-act="show-more" data-ws="' + w.id + '">' +
            (expanded ? '收起' : esc(t('showMore')) + ' (' + (sessions.length - 4) + ')') + '</button>';
        }
      }
      h += '</div>';
    });
    return h;
  }

  function sessHTML(s) {
    var on = s.id === S.state.currentSessionId;
    var lead = s.busy ? '<span class="lead"><span class="spin"></span></span>'
      : (s.unread || (s.pending && (s.pending.a || s.pending.q)))
        ? '<span class="lead"><span class="dot ' + (s.unread ? 'unread' : 'run') + '"></span></span>'
        : '<span class="lead"></span>';
    var badge = '';
    if (s.pending && s.pending.q) badge += '<span class="badge info" style="margin-left:auto">待回答</span>';
    else if (s.pending && s.pending.a) badge += '<span class="badge warn" style="margin-left:auto">待审批</span>';
    return '<button class="sess' + (on ? ' on' : '') + '" data-act="open-session" data-sid="' + s.id + '">' +
      lead +
      '<span class="t">' + esc(s.title) + '</span>' +
      badge +
      '<span class="time">' + esc(S.relTime(s.ago)) + '</span>' +
      '<span class="ic-btn kebab" aria-label="更多" data-act="sess-menu" data-sid="' + s.id + '">' + icon('i-dots') + '</span>' +
      '</button>';
  }

  /* ----------------------------- render: topbar ------------------------- */
  function renderTopbar() {
    var bar = $('.topbar');
    if (!bar) return;
    var s = S.state.currentSessionId ? S.session(S.state.currentSessionId) : null;
    var w = s ? S.workspace(s.ws) : null;
    var crumb = s
      ? '<span class="ws-ref">' + esc(w ? w.name : '') + '</span><span class="sep">/</span><span class="sess-ref">' + esc(s.title) + '</span>'
      : '<span class="sess-ref">Kimi Code</span>';
    var meta = '';
    if (w && w.branch) {
      meta += '<span class="branch">' + icon('i-git') + esc(w.branch) + '</span>';
      if (w.add || w.del) meta += '<span class="gitstat"><span class="add">+' + w.add + '</span> <span class="del">-' + w.del + '</span></span>';
    }
    meta += '<span class="tb-tools"><button class="ic-btn" aria-label="详情面板" data-act="toggle-panel">' + icon('i-panel') + '</button></span>';
    bar.innerHTML = '<div class="tb-crumb">' + crumb + '</div><div class="tb-meta">' + meta + '</div>';
  }

  /* ----------------------------- render: conversation ------------------- */
  function renderConv() {
    var host = $('.conv-inner');
    if (!host) return;
    var sid = S.state.currentSessionId;
    var blocks = sid ? S.convo(sid) : [];
    if (!sid || !blocks.length) {
      host.innerHTML = emptyHTML();
      return;
    }
    var h = '';
    blocks.forEach(function (b) { h += blockHTML(b); });
    host.innerHTML = h;
  }

  function emptyHTML() {
    var chips = [t('sug1'), t('sug2'), t('sug3')].map(function (c) {
      return '<button class="sug" data-act="sug" data-text="' + esc(c) + '">' + esc(c) + '</button>';
    }).join('');
    return '<div class="empty">' +
      '<div class="empty-logo">' + 'K' + '</div>' +
      '<h1 class="empty-title">' + esc(t('emptyTitle')) + '</h1>' +
      '<p class="empty-sub">' + esc(t('emptySub')) + '</p>' +
      '<div class="empty-chips">' + chips + '</div>' +
      '</div>';
  }

  function blockHTML(b) {
    switch (b.type) {
      case 'user':
        return '<div class="u-turn"><div class="u-bub">' + esc(b.text) + '</div></div>';
      case 'lead':
        return '<div class="a-msg"><p class="lead">' + b.html + '</p></div>';
      case 'prose':
        return '<p class="prose">' + b.html + '</p>';
      case 'think':
        return '<div class="think open" data-collapsible><div class="th-head">' + icon('i-spark', 'spark') + '<span>思考过程</span>' + icon('i-chevron-right', 'chev') + '</div><div class="th-body">' + b.html + '</div></div>';
      case 'code':
        return '<div class="code"><div class="code-head"><span class="code-lang">' + esc(b.lang || '') + '</span><span class="spacer"></span><button class="code-copy" data-act="copy">' + icon('i-copy') + '复制</button></div><pre>' + esc(b.code) + '</pre></div>';
      case 'tool':
        return '<div class="tool' + (b.open ? ' open' : '') + '" data-collapsible><button class="tool-row">' + icon('i-terminal', 'glyph') +
          '<span class="tname">' + esc(b.name) + '</span><span class="targ">' + esc(b.arg || '') + '</span>' +
          '<span class="ok">' + icon('i-check') + esc(b.ok || '') + '</span>' + icon('i-chevron-right', 'chev') + '</button>' +
          (b.body ? '<div class="tool-body"><pre>' + esc(b.body) + '</pre></div>' : '') + '</div>';
      case 'toolGroup':
        var items = (b.items || []).map(function (it) {
          return '<button class="tool-row">' + icon('i-terminal', 'glyph') + '<span class="tname">' + esc(it.name) + '</span><span class="targ">' + esc(it.arg || '') + '</span><span class="ok">' + icon('i-check') + esc(it.ok || '') + '</span></button>';
        }).join('');
        return '<div class="tool-group"><button class="tg-head"><span class="dot"></span><span class="tg-count">' + (b.count || (b.items || []).length) + ' 个工具调用</span><span class="tg-state">' + esc(b.state || '') + '</span><span class="spacer"></span>' + icon('i-chevron-down', 'chev') + '</button><div class="tg-items">' + items + '</div></div>';
      case 'approval':
        return '<div class="action-card"><div class="action-head warn">' + icon('i-alert', 'ic') + '<span class="ttl">' + esc(b.title) + '</span></div>' +
          '<div class="action-body">' + esc(b.body || '') + (b.cmd ? '<code class="cmd">' + esc(b.cmd) + '</code>' : '') + '</div>' +
          '<div class="action-foot"><button class="btn btn-secondary" data-act="reject">拒绝</button><button class="btn btn-primary" data-act="approve">允许</button></div></div>';
      case 'question':
        var opts = (b.options || []).map(function (o) {
          return '<button class="q-opt" data-act="qopt"><span class="k">' + esc(o.k) + '</span><span><span class="qt">' + esc(o.t) + '</span>' + (o.d ? '<span class="qd">' + esc(o.d) + '</span>' : '') + '</span></button>';
        }).join('');
        return '<div class="action-card"><div class="action-head">' + icon('i-help', 'ic') + '<span class="ttl">' + esc(b.title) + '</span></div>' +
          '<div class="action-body">' + esc(b.body || '') + '</div><div class="q-opts">' + opts + '</div></div>';
      case 'status':
        return '<div class="status-line"><span class="dot"></span>' + esc(b.text) + '</div>';
      default:
        return '';
    }
  }

  /* ----------------------------- apply theme/font/lang ------------------ */
  function applyTheme() {
    var mode = S.state.theme;
    if (mode === 'light') root.setAttribute('data-theme', 'light');
    else if (mode === 'dark') root.setAttribute('data-theme', 'dark');
    else root.removeAttribute('data-theme');
  }
  function applyFont() {
    root.style.setProperty('--ui-font-size', S.state.fontSize + 'px');
    document.body.style.fontSize = S.state.fontSize + 'px';
  }
  function applyLang() { root.setAttribute('lang', S.state.lang === 'en' ? 'en' : 'zh-CN'); }

  /* ----------------------------- render all ----------------------------- */
  function renderAll() {
    applyTheme(); applyFont(); applyLang();
    renderSidebar(); renderTopbar(); renderConv();
    syncComposer(); syncComposerToolbar(); renderMobTitle();
  }

  /* ----------------------------- mobile shell --------------------------- */
  function renderMobTitle() {
    var el = document.querySelector('[data-mob-title]');
    if (!el) return;
    var s = S.state.currentSessionId && S.session(S.state.currentSessionId);
    el.textContent = s ? s.title : 'Kimi Code';
  }
  function closeSwitcher() { var b = document.querySelector('.sheet-back'); if (b) b.remove(); }
  function openSwitcher() {
    closeSwitcher();
    var back = document.createElement('div'); back.className = 'sheet-back';
    var sheet = document.createElement('div'); sheet.className = 'sheet';
    sheet.innerHTML = '<div class="sheet-handle"></div><div class="sheet-head"><h3>会话</h3><button class="ic-btn" data-sheet-close aria-label="关闭">' + icon('i-close') + '</button></div><div class="sheet-body" data-sheet-body></div>';
    back.appendChild(sheet); document.body.appendChild(back);
    sheet.querySelector('[data-sheet-body]').innerHTML = sbListHTML();
    requestAnimationFrame(function () { back.classList.add('is-open'); });
  }

  /* ----------------------------- toast ---------------------------------- */
  var toastTimer;
  function toast(msg, kind) {
    var el = $('[data-toast]');
    if (!el) return;
    el.className = 'toast ' + (kind || 'success');
    el.innerHTML = icon(kind === 'error' ? 'i-close' : 'i-check') + esc(msg);
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 1800);
  }

  /* ----------------------------- composer ------------------------------- */
  function syncComposer() {
    var perm = $('.pill.perm');
    if (perm) {
      perm.className = 'pill perm perm-' + S.state.permission;
    }
  }
  function stubReply(text) {
    return '收到。这是一段 stub 助手回复（未接后端）：关于「' + esc(text.slice(0, 24)) + (text.length > 24 ? '…' : '') + '」，我会按 Kimi 的填充式、hairline 分隔的样式继续。';
  }
  function send() {
    var ta = $('.cc-ta');
    var text = (ta.value || '').trim();
    if (!text) return;
    var sid = S.state.currentSessionId;
    if (!sid) {
      // create a new session in the first workspace
      sid = 's' + Date.now();
      var title = text.length > 26 ? text.slice(0, 26) + '…' : text;
      S.sessions.unshift({ id: sid, ws: S.workspaces[0].id, title: title, ago: 1, busy: false, unread: false, pending: { a: 0, q: 0 } });
      S.conversations[sid] = [];
      S.set({ currentSessionId: sid });
    }
    var convo = S.conversations[sid];
    convo.push({ type: 'user', text: text });
    ta.value = ''; fit();
    renderAll();
    scrollBottom();
    var busy = S.session(sid); if (busy) { busy.busy = true; renderSidebar(); }
    // Live mode (live.js): hand the prompt to the real server; the reply
    // streams in over the WS. Falls through to the stub when offline or when
    // the session only exists locally.
    if (window.KimiLive && window.KimiLive.connected && window.KimiLive.send(sid, text)) return;
    setTimeout(function () {
      convo.push({ type: 'lead', html: stubReply(text) });
      var s = S.session(sid); if (s) s.busy = false;
      renderAll(); scrollBottom();
    }, 500);
  }
  function scrollBottom() {
    var c = $('.conv');
    if (c) requestAnimationFrame(function () { c.scrollTop = c.scrollHeight; });
  }

  /* composer auto-grow */
  var ta = $('.cc-ta');
  function fit() {
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, window.innerHeight * 0.4) + 'px';
  }
  if (ta) {
    ta.addEventListener('input', function () {
      fit();
      var v = ta.value;
      if (/^\/\S*$/.test(v)) { renderSlash(v.slice(1)); showPop('slash'); }
      else {
        var m = v.match(/(?:^|\s)@(\S*)$/);
        if (m) { renderMention(m[1]); showPop('mention'); }
        else if (popState.name === 'slash' || popState.name === 'mention') hidePops();
      }
    });
    ta.addEventListener('keydown', function (e) {
      var name = popState.name;
      if (name && (name === 'slash' || name === 'mention')) {
        if (e.key === 'ArrowDown') { e.preventDefault(); setActive(name, popState.active + 1); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); setActive(name, popState.active - 1); return; }
        if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); activatePopItem(name); return; }
        if (e.key === 'Escape') { e.preventDefault(); hidePops(); return; }
      }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    });
    fit();
  }

  /* ----------------------- composer menus ------------------------------- */
  var SLASH = [
    { cmd: 'compact', desc: '压缩当前会话上下文' },
    { cmd: 'clear', desc: '清空当前会话' },
    { cmd: 'model', desc: '切换当前模型' },
    { cmd: 'thinking', desc: '切换思考等级' },
    { cmd: 'plan', desc: '切换计划模式' },
    { cmd: 'swarm', desc: '切换 Swarm 模式' },
    { cmd: 'help', desc: '查看所有命令' },
  ];
  var FILES = ['README.md', 'src/agent.ts', 'src/style.css', 'packages/core/index.ts', 'apps/kimi-web/src/App.vue', 'docs/zh/quickstart.md'];
  var PERMS = [
    { mode: 'manual', label: '手动确认', desc: '每个工具调用都需要确认' },
    { mode: 'auto', label: '自动编辑', desc: '自动编辑文件，其他仍需确认' },
    { mode: 'yolo', label: '自动通过', desc: '自动执行所有工具，不再询问' },
  ];
  var popState = { name: null, items: [], active: 0 };

  function hidePops() {
    popState.name = null;
    [].forEach.call(document.querySelectorAll('.pop'), function (p) { p.hidden = true; });
  }
  function showPop(name) {
    hidePops();
    var el = document.querySelector('[data-pop="' + name + '"]');
    if (el) { el.hidden = false; popState.name = name; popState.active = 0; }
  }
  function setActive(name, idx) {
    var el = document.querySelector('[data-pop="' + name + '"]');
    if (!el) return;
    var items = el.querySelectorAll('.pop-item');
    if (!items.length) return;
    popState.active = ((idx % items.length) + items.length) % items.length;
    [].forEach.call(items, function (it, i) { it.classList.toggle('on', i === popState.active); });
  }
  function renderList(name, items, rowFn) {
    var el = document.querySelector('[data-pop="' + name + '"]');
    if (!el) return;
    el.innerHTML = items.length ? items.map(rowFn).join('') : '<div class="pop-head">无匹配</div>';
    popState.items = items;
    setActive(name, 0);
  }
  function renderSlash(filter) {
    var q = filter.toLowerCase();
    var items = SLASH.filter(function (it) { return it.cmd.indexOf(q) !== -1; });
    renderList('slash', items, function (it) {
      return '<button class="pop-item" data-cmd="' + it.cmd + '"><span class="pi-ic">' + icon('i-terminal') + '</span><span class="pi-t"><span class="pi-name"><span class="cmd">/' + esc(it.cmd) + '</span></span><span class="pi-desc">' + esc(it.desc) + '</span></span></button>';
    });
  }
  function renderMention(filter) {
    var q = filter.toLowerCase();
    var items = FILES.filter(function (f) { return f.toLowerCase().indexOf(q) !== -1; });
    renderList('mention', items, function (f) {
      return '<button class="pop-item" data-file="' + esc(f) + '"><span class="pi-ic">' + icon('i-folder') + '</span><span class="pi-t"><span class="pi-name">' + esc(f) + '</span></span></button>';
    });
  }
  function permLabel(mode) { var p = PERMS.find(function (x) { return x.mode === mode; }); return p ? p.label : mode; }
  function renderPerm() {
    renderList('perm', PERMS, function (p) {
      var on = p.mode === S.state.permission;
      return '<button class="pop-item" data-mode="' + p.mode + '"><span class="pi-t"><span class="pi-name">' + esc(p.label) + '</span><span class="pi-desc">' + esc(p.desc) + '</span></span>' + (on ? icon('i-check', 'pi-check') : '<span class="pi-check"></span>') + '</button>';
    });
  }
  function renderModes() {
    var el = document.querySelector('[data-pop="modes"]');
    if (!el) return;
    function row(key, name, desc, on, disabled) {
      return '<button class="pop-item" data-modekey="' + key + '"' + (disabled ? ' data-disabled="1"' : '') + '><span class="pi-t"><span class="pi-name">' + esc(name) + '</span><span class="pi-desc">' + esc(desc) + '</span></span><span class="sw ' + (on ? 'on' : '') + '" style="flex:none;width:34px;height:20px"><i style="width:14px;height:14px;top:3px;left:3px"></i></span></button>';
    }
    el.innerHTML =
      row('plan', '计划模式', '先规划再执行', S.state.planMode, false) +
      row('swarm', 'Swarm 模式', '多 Agent 协作', S.state.swarmMode, false) +
      row('goal', 'Goal 模式', '由目标驱动（仅展示）', false, true);
  }
  function activatePopItem(name) {
    var el = document.querySelector('[data-pop="' + name + '"]');
    var item = el && el.querySelectorAll('.pop-item')[popState.active];
    if (item) item.click();
  }
  function syncComposerToolbar() {
    var pill = document.querySelector('[data-act="perm-menu"]');
    if (pill) { pill.className = 'pill perm perm-' + S.state.permission; var lab = pill.querySelector('[data-perm-label]'); if (lab) lab.textContent = permLabel(S.state.permission); }
    var tags = document.querySelector('[data-modes-tags]');
    if (tags) { var ts = []; if (S.state.planMode) ts.push('Plan'); if (S.state.swarmMode) ts.push('Swarm'); tags.textContent = ts.join(' · '); }
  }

  /* --------------------- sidebar interactions --------------------------- */
  function closeMenu() {
    var m = document.querySelector('.menu-float');
    if (m) m.remove();
    document.removeEventListener('mousedown', onMenuDoc, true);
    document.removeEventListener('keydown', onMenuKey);
  }
  function onMenuDoc(e) { var m = document.querySelector('.menu-float'); if (m && !m.contains(e.target)) closeMenu(); }
  function onMenuKey(e) { if (e.key === 'Escape') closeMenu(); }
  function openMenu(anchor, items) {
    closeMenu();
    var m = document.createElement('div');
    m.className = 'menu menu-float';
    m.style.position = 'fixed';
    m.innerHTML = items.map(function (it, i) {
      if (it.sep) return '<div class="mi-sep"></div>';
      return '<button class="mi' + (it.danger ? ' danger' : '') + '" data-i="' + i + '"><span class="mi-ic">' + (it.icon ? icon(it.icon) : '') + '</span>' + esc(it.label) + '</button>';
    }).join('');
    document.body.appendChild(m);
    var r = anchor.getBoundingClientRect();
    var mh = m.offsetHeight, mw = m.offsetWidth;
    var top = r.bottom + 4; if (top + mh > innerHeight - 8) top = Math.max(8, r.top - mh - 4);
    var left = r.right - mw; if (left < 8) left = 8;
    m.style.top = Math.round(top) + 'px'; m.style.left = Math.round(left) + 'px';
    m.addEventListener('click', function (e) {
      var b = e.target.closest('.mi'); if (!b) return;
      var it = items[Number(b.getAttribute('data-i'))]; closeMenu();
      if (it && it.onClick) it.onClick();
    });
    setTimeout(function () { document.addEventListener('mousedown', onMenuDoc, true); }, 0);
    document.addEventListener('keydown', onMenuKey);
  }

  function startRename(el, initial, onCommit) {
    var input = document.createElement('input');
    input.className = 'rename-input' + (el.classList.contains('ws-name') ? ' ws-name' : '');
    input.value = initial;
    el.replaceWith(input);
    input.focus(); input.select();
    function finish(commit) {
      var v = input.value.trim();
      if (commit && v) onCommit(v);
      renderAll();
    }
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); renderAll(); }
    });
    input.addEventListener('blur', function () { finish(true); });
  }

  function removeSession(sid) {
    var idx = S.sessions.findIndex(function (s) { return s.id === sid; });
    if (idx >= 0) S.sessions.splice(idx, 1);
    if (S.state.currentSessionId === sid) S.set({ currentSessionId: null }); else renderAll();
  }
  function removeWorkspace(wid) {
    var wi = S.workspaces.findIndex(function (w) { return w.id === wid; });
    if (wi >= 0) S.workspaces.splice(wi, 1);
    for (var i = S.sessions.length - 1; i >= 0; i--) if (S.sessions[i].ws === wid) S.sessions.splice(i, 1);
    if (!S.session(S.state.currentSessionId)) S.set({ currentSessionId: null }); else renderAll();
  }

  function sessMenuItems(sid) {
    var s = S.session(sid); if (!s) return [];
    return [
      { label: '复制会话 ID', icon: 'i-copy', onClick: function () { toast('已复制 ID', 'success'); } },
      { label: '重命名', onClick: function () { var el = document.querySelector('.sess[data-sid="' + sid + '"] .t'); if (el) startRename(el, s.title, function (v) { s.title = v; }); } },
      { label: 'Fork', icon: 'i-git', onClick: function () { toast('已 Fork（stub）', 'success'); } },
      { sep: true },
      { label: '归档', danger: true, onClick: function () { confirm({ title: '归档会话', message: '确定归档「' + s.title + '」？归档后将从列表移除。', okLabel: '归档', onConfirm: function () { removeSession(sid); toast('已归档', 'success'); } }); } },
    ];
  }
  function wsMenuItems(wid) {
    var w = S.workspace(wid); if (!w) return [];
    return [
      { label: '复制路径', icon: 'i-copy', onClick: function () { toast('已复制路径', 'success'); } },
      { label: '重命名', onClick: function () { var el = document.querySelector('.ws[data-ws="' + wid + '"] .ws-name'); if (el) startRename(el, w.name, function (v) { w.name = v; }); } },
      { sep: true },
      { label: '删除工作区', danger: true, onClick: function () { confirm({ title: '删除工作区', message: '确定删除「' + w.name + '」及其全部会话？', okLabel: '删除', onConfirm: function () { removeWorkspace(wid); toast('已删除', 'success'); } }); } },
    ];
  }

  document.addEventListener('dblclick', function (e) {
    var t = e.target.closest('.sess .t');
    if (t) { var row = t.closest('[data-sid]'); var s = row && S.session(row.getAttribute('data-sid')); if (s) startRename(t, s.title, function (v) { s.title = v; }); return; }
    var wn = e.target.closest('.ws-name');
    if (wn) { var ws = wn.closest('[data-ws]'); var w = ws && S.workspace(ws.getAttribute('data-ws')); if (w) startRename(wn, w.name, function (v) { w.name = v; }); }
  });

  /* ----------------------------- modals --------------------------------- */
  function openOverlay(name) { var el = document.querySelector('[data-overlay="' + name + '"]'); if (el) el.classList.add('is-open'); }
  function closeOverlays() { [].forEach.call(document.querySelectorAll('.overlay.is-open'), function (o) { o.classList.remove('is-open'); }); }

  /* ----------------------------- search (⌘K) --------------------------- */
  function renderSearch(q) {
    var list = $('[data-search-list]');
    if (!list) return;
    var query = (q || '').trim().toLowerCase();
    var items = S.sessions.filter(function (s) {
      if (!query) return true;
      return s.title.toLowerCase().indexOf(query) !== -1;
    });
    if (!items.length) { list.innerHTML = '<li class="search-empty">没有匹配的会话</li>'; return; }
    list.innerHTML = items.map(function (s) {
      var w = S.workspace(s.ws);
      return '<li><button class="search-row" data-sid="' + s.id + '"><span class="sr-t">' + esc(s.title) + '</span><span class="sr-ws">' + esc(w ? w.name : '') + ' · ' + esc(S.relTime(s.ago)) + '</span></button></li>';
    }).join('');
  }
  function openSearch() {
    openOverlay('search');
    renderSearch('');
    var inp = $('[data-search-input]');
    if (inp) { inp.value = ''; setTimeout(function () { inp.focus(); }, 0); }
  }

  /* ----------------------------- confirm -------------------------------- */
  var confirmCb = null;
  function confirm(opts) {
    $('[data-confirm-title]').textContent = opts.title || '';
    $('[data-confirm-msg]').textContent = opts.message || '';
    var ok = $('[data-confirm-ok]');
    ok.textContent = opts.okLabel || '确认';
    ok.className = 'btn ' + (opts.danger === false ? 'btn-primary' : 'btn-danger');
    confirmCb = opts.onConfirm || null;
    openOverlay('confirm');
  }

  /* ----------------------------- server auth ---------------------------- */
  function connectToken() {
    var inp = $('[data-token-input]');
    var v = inp && inp.value.trim();
    if (!v) { toast('请输入 Token', 'error'); return; }
    try { localStorage.setItem('kimi2-token', v); } catch (err) {}
    location.reload();
  }

  /* ----------------------------- delegated clicks ----------------------- */
  document.addEventListener('click', function (e) {
    var act = e.target.closest('[data-act]');
    if (act) {
      var a = act.getAttribute('data-act');
      switch (a) {
        case 'open-session':
          S.set({ currentSessionId: act.getAttribute('data-sid') }); scrollBottom(); closeSwitcher(); return;
        case 'toggle-ws':
          var w = act.getAttribute('data-ws'); S.state.collapsed[w] = !S.state.collapsed[w]; S.set({}); return;
        case 'show-more':
          var w2 = act.getAttribute('data-ws'); S.state.expanded[w2] = !S.state.expanded[w2]; S.set({}); return;
        case 'add-ws':
          openOverlay('aw'); return;
        case 'sess-menu':
          openMenu(act, sessMenuItems(act.getAttribute('data-sid'))); return;
        case 'ws-item-menu':
          openMenu(act, wsMenuItems(act.getAttribute('data-ws'))); return;
        case 'copy':
          toast('已复制到剪贴板', 'success'); return;
        case 'sug':
          var inp = $('.cc-ta'); if (inp) { inp.value = act.getAttribute('data-text'); inp.focus(); fit(); } return;
        case 'approve':
          toast('已允许（stub）', 'success'); return;
        case 'reject':
          toast('已拒绝（stub）', 'error'); return;
        case 'qopt':
          toast('已选择（stub）', 'success'); return;
      }
    }

    /* ---- composer menus ---- */
    var cmdBtn = e.target.closest('[data-pop="slash"] .pop-item');
    if (cmdBtn) {
      var cmd = cmdBtn.getAttribute('data-cmd'); hidePops();
      if (cmd === 'model') { var b = document.querySelector('[data-open-models]'); if (b) b.click(); }
      else { ta.value = ''; fit(); toast('已选择 /' + cmd, 'success'); }
      return;
    }
    var fileBtn = e.target.closest('[data-pop="mention"] .pop-item');
    if (fileBtn) { ta.value = ta.value.replace(/@(\S*)$/, fileBtn.getAttribute('data-file') + ' '); fit(); ta.focus(); hidePops(); return; }
    var permBtn = e.target.closest('[data-pop="perm"] .pop-item');
    if (permBtn) { S.set({ permission: permBtn.getAttribute('data-mode') }); hidePops(); return; }
    var modeBtn = e.target.closest('[data-pop="modes"] .pop-item');
    if (modeBtn && !modeBtn.getAttribute('data-disabled')) {
      var k = modeBtn.getAttribute('data-modekey');
      if (k === 'plan') S.set({ planMode: !S.state.planMode });
      else if (k === 'swarm') S.set({ swarmMode: !S.state.swarmMode });
      renderModes(); return;
    }
    if (e.target.closest('[data-act="perm-menu"]')) { renderPerm(); showPop('perm'); return; }
    if (e.target.closest('[data-act="modes-menu"]')) { renderModes(); showPop('modes'); return; }
    if (!e.target.closest('.pop') && !e.target.closest('[data-act="perm-menu"]') && !e.target.closest('[data-act="modes-menu"]')) hidePops();

    /* new chat */
    if (e.target.closest('.sb-new')) { S.set({ currentSessionId: null }); return; }
    /* send / stop */
    if (e.target.closest('.send')) { send(); return; }
    /* mobile */
    if (e.target.closest('[data-act="mob-menu"]')) { openSwitcher(); return; }
    if (e.target.closest('[data-act="mob-new"]')) { S.set({ currentSessionId: null }); closeSwitcher(); return; }
    if (e.target.closest('[data-sheet-close]')) { closeSwitcher(); return; }
    if (e.target.classList && e.target.classList.contains('sheet-back')) { closeSwitcher(); return; }
    /* search row -> open session */
    var srow = e.target.closest('.search-row');
    if (srow) { S.set({ currentSessionId: srow.getAttribute('data-sid') }); closeOverlays(); scrollBottom(); return; }
    /* search box trigger */
    if (e.target.closest('.sb-search')) { openSearch(); return; }
    /* confirm cancel / ok */
    if (e.target.closest('[data-confirm-cancel]')) { closeOverlays(); confirmCb = null; return; }
    if (e.target.closest('[data-confirm-ok]')) { closeOverlays(); var cb = confirmCb; confirmCb = null; if (cb) cb(); return; }
    /* token connect */
    if (e.target.closest('[data-token-connect]')) { connectToken(); return; }
    /* settings gear */
    if (e.target.closest('[data-open-settings]')) { openOverlay('settings'); return; }
    /* close modal */
    if (e.target.closest('[data-close]')) { closeOverlays(); return; }
    /* backdrop */
    if (e.target.classList && e.target.classList.contains('overlay')) { closeOverlays(); return; }

    /* settings segmented (明暗 / 语言) */
    var segBtn = e.target.closest('[data-seg] button');
    if (segBtn) {
      var seg = segBtn.parentNode;
      [].forEach.call(seg.children, function (b) { b.classList.remove('on'); });
      segBtn.classList.add('on');
      var label = segBtn.textContent.trim();
      if (label === '月之亮面') S.set({ theme: 'light' });
      else if (label === '月之暗面') S.set({ theme: 'dark' });
      else if (label === '跟随系统') S.set({ theme: 'system' });
      else if (label === 'English') S.set({ lang: 'en' });
      else if (label === '中文') S.set({ lang: 'zh' });
      return;
    }
    /* settings switch */
    var sw = e.target.closest('[data-sw]');
    if (sw) { sw.classList.toggle('on'); return; }

    /* collapsible think / tool */
    var head = e.target.closest('[data-collapsible] > .th-head, [data-collapsible] > .tool-row');
    if (head) { var box = head.parentNode; if (box.classList.contains('think') || box.classList.contains('tool')) box.classList.toggle('open'); return; }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeOverlays();
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openSearch(); }
  });

  /* search input filtering */
  document.addEventListener('input', function (e) {
    if (e.target.matches('[data-search-input]')) renderSearch(e.target.value);
    if (e.target.matches('[data-fontsize]')) {
      var v = Math.max(12, Math.min(20, parseInt(e.target.value, 10) || 14));
      S.set({ fontSize: v });
    }
  });

  /* ---- shared helpers for feature files (prototype/features/*) ---------- */
  window.KP = {
    Store: S, esc: esc, icon: icon, t: t, toast: toast,
    openOverlay: openOverlay, closeOverlays: closeOverlays, confirm: confirm,
    renderAll: renderAll,
  };

  /* URL helpers */
  var params = new URLSearchParams(location.search);
  if (params.get('theme')) S.state.theme = params.get('theme');
  S.subscribe(renderAll);
  renderAll();
  if (params.get('open')) openOverlay(params.get('open'));
})();
