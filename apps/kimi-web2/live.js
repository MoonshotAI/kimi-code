/* Kimi Code Web prototype — live bridge to the REAL kimi-code server.
 *
 * Load order: index.html loads this AFTER app.js — data.js gives Store, app.js
 * does the initial stub render, then this file (when a token exists) replaces
 * the stub data with real workspaces/sessions and streams live events in.
 * Without a token it does nothing and the app stays fully offline/stub.
 *
 * ── Real protocol (extracted from apps/kimi-web/src/api/*, verified via curl) ──
 * Auth: `Authorization: Bearer <token>` on every REST call. Envelope on every
 * response: { code, msg, data, request_id } — code 0 = success, data = payload.
 *
 *  GET  /api/v1/workspaces
 *       → { items: [{ id, root, name, is_git_repo, branch, last_opened_at,
 *                     session_count }], has_more }
 *  GET  /api/v1/sessions?page_size=N
 *       → { items: [{ id, workspace_id, title, created_at, updated_at,
 *                     status: idle|running|awaiting_approval|awaiting_question|aborted,
 *                     archived, last_prompt, metadata:{cwd}, ... }], has_more }
 *       (ordered most-recently-updated first)
 *  GET  /api/v1/sessions/{sid}/messages?page_size=N
 *       → { items: [{ id, session_id, role: user|assistant|tool|system,
 *                     content: [ {type:'text',text} | {type:'thinking',thinking}
 *                              | {type:'tool_use',tool_call_id,tool_name,input}
 *                              | {type:'tool_result',tool_call_id,output,is_error}
 *                              | {type:'image'|'video'|'file', ...} ],
 *                     created_at }], has_more }
 *       (NEWEST FIRST — must reverse for chronological rendering)
 *  POST /api/v1/sessions/{sid}/prompts   body { content: [{type:'text',text}] }
 *       → { prompt_id, user_message_id, status: 'running'|'queued' }
 *
 *  WS   ws(s)://host/api/v1/ws?client_id=<id>
 *       Browser WS cannot set headers → bearer rides in the subprotocol:
 *       `Sec-WebSocket-Protocol: kimi-code.bearer.<token>`.
 *       S→C: server_hello first; then ping (reply {type:'pong',payload:{nonce}}),
 *       ack, resync_required, and per-session frames {type, seq, session_id,
 *       timestamp, payload} — a mix of projected `event.*` frames and RAW
 *       agent-core frames (assistant.delta, thinking.delta, tool.call.started,
 *       tool.result, turn.ended, prompt.completed, session.meta.updated, …).
 *       C→S after server_hello: {type:'client_hello',id,payload:{client_id,
 *       subscriptions:[sid],cursors?}} and {type:'subscribe',id,payload:
 *       {session_ids:[sid]}}. Subscribing WITHOUT cursors = live-only (no
 *       journal replay) — packages/server/src/ws/connection.ts syncSessions().
 *
 * ── CORS finding ──
 * packages/server/src/middleware/origin.ts: cross-origin requests only get
 * `Access-Control-Allow-*` when the full origin is whitelisted via the
 * `KIMI_CODE_CORS_ORIGINS` env (no `*` wildcard). Verified against the live
 * server: a GET with `Origin: http://localhost:8101` returned 200 but NO
 * Access-Control-Allow-Origin header → the browser would block it. Therefore:
 * by default we use the page's own origin (works behind a proxy or when the
 * server serves this app); an explicit `?server=` URL is still attempted
 * directly (requires the whitelist, or a non-browser context). The WS upgrade
 * only rejects a PRESENT-but-disallowed Origin.
 */
(function () {
  'use strict';
  var S = window.Store;

  /* ------------------------- config: server + token --------------------- */
  var params = new URLSearchParams(location.search);
  var qsServer = params.get('server');
  var qsToken = params.get('token');
  if (qsServer) { try { localStorage.setItem('kimi2-server', qsServer); } catch (e) {} }
  if (qsToken) { try { localStorage.setItem('kimi2-token', qsToken); } catch (e) {} }

  var token = qsToken || safeGet('kimi2-token');
  var httpPage = location.protocol.indexOf('http') === 0;
  // file:// without a token stays pure stub; an http(s) page always tries the
  // server — the same origin may be unprotected, and a 401 opens the token
  // dialog (wired in app.js) so the server-hosted build works out of the box.
  if (!token && !httpPage) return;

  // Prefer explicit ?server=; else same-origin (proxy-friendly, no CORS need);
  // else the default local server (e.g. when opened via file://).
  var origin = qsServer || safeGet('kimi2-server')
    || (location.protocol.indexOf('http') === 0 ? location.origin : 'http://127.0.0.1:58627');
  origin = origin.replace(/\/+$/, '');

  function safeGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function api(path) { return origin + '/api/v1' + path; }
  function toast(msg, kind) { if (window.KP && window.KP.toast) window.KP.toast(msg, kind); }

  /* ------------------------------ REST ---------------------------------- */
  function authHeaders(extra) {
    var h = extra || {};
    if (token) h.Authorization = 'Bearer ' + token;
    return h;
  }
  function get(path) {
    return fetch(api(path), { headers: authHeaders() }).then(unwrap);
  }
  function post(path, body) {
    return fetch(api(path), {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body || {}),
    }).then(unwrap);
  }
  function unwrap(res) {
    if (res.status === 401 || res.status === 403) {
      var e = new Error('未授权（需要服务器 Token）');
      e.auth = true;
      throw e;
    }
    return res.json().then(function (env) {
      if (env.code !== 0) throw new Error(env.msg || ('服务端错误 ' + env.code));
      return env.data;
    });
  }

  /* --------------------------- mapping helpers -------------------------- */
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function minutesAgo(iso) {
    var t = Date.parse(iso);
    return isNaN(t) ? 0 : Math.max(0, Math.round((Date.now() - t) / 60000));
  }
  function textToHtml(s) {
    return esc(s).replace(/\n/g, '<br>');
  }
  // One-line summary of a tool's input, like the TUI arg column.
  function argSummary(input) {
    if (input == null) return '';
    if (typeof input === 'string') return input.slice(0, 120);
    var keys = ['command', 'path', 'pattern', 'file_path', 'url', 'query', 'description'];
    for (var i = 0; i < keys.length; i++) {
      if (typeof input[keys[i]] === 'string') return input[keys[i]].slice(0, 120);
    }
    try { return JSON.stringify(input).slice(0, 120); } catch (e) { return ''; }
  }
  function outputText(output) {
    if (output == null) return '';
    if (typeof output === 'string') return output;
    if (typeof output.text === 'string') return output.text;
    try { return JSON.stringify(output, null, 2); } catch (e) { return String(output); }
  }

  function mapSession(w) {
    return {
      id: w.id,
      ws: w.workspace_id || '',
      title: w.title || w.last_prompt || '(无标题)',
      ago: minutesAgo(w.updated_at || w.created_at),
      busy: w.status === 'running',
      unread: false,
      pending: {
        a: w.status === 'awaiting_approval' ? 1 : 0,
        q: w.status === 'awaiting_question' ? 1 : 0,
      },
    };
  }

  /* wire messages (chronological) → Store block list */
  function mapMessages(items) {
    var blocks = [];
    var toolById = {}; // tool_call_id → tool block
    items.forEach(function (m) {
      (m.content || []).forEach(function (c) {
        try { mapContent(m.role, c, blocks, toolById); }
        catch (e) { /* tolerant: skip malformed content */ }
      });
    });
    return blocks;
  }
  function mapContent(role, c, blocks, toolById) {
    switch (c.type) {
      case 'text':
        if (!c.text || !c.text.trim()) return;
        if (role === 'user') {
          // Skip injected wrapper messages (<system-reminder>, <notification>, …)
          if (/^<[a-z_-]+[ >]/.test(c.text.trim())) return;
          blocks.push({ type: 'user', text: c.text });
        } else {
          blocks.push({ type: 'prose', html: textToHtml(c.text) });
        }
        return;
      case 'thinking':
        if (c.thinking && c.thinking.trim()) blocks.push({ type: 'think', html: textToHtml(c.thinking) });
        return;
      case 'tool_use': {
        var tb = { type: 'tool', name: c.tool_name || '工具', arg: argSummary(c.input), ok: '' };
        toolById[c.tool_call_id] = tb;
        blocks.push(tb);
        return;
      }
      case 'tool_result': {
        var t = toolById[c.tool_call_id];
        var body = outputText(c.output).slice(0, 2000);
        if (t) { t.ok = c.is_error ? '出错' : '完成'; t.body = body; }
        return;
      }
      case 'image': blocks.push({ type: 'status', text: '[图片]' }); return;
      case 'video': blocks.push({ type: 'status', text: '[视频]' }); return;
      case 'file': blocks.push({ type: 'status', text: '[文件] ' + (c.name || '') }); return;
      default: return; // unknown content kinds are skipped
    }
  }

  /* --------------------------- throttled render ------------------------- */
  var renderTimer = null;
  function scheduleRender() {
    if (renderTimer) return;
    renderTimer = setTimeout(function () {
      renderTimer = null;
      S.set({}); // triggers app.js renderAll via subscriber
    }, 100); // ≤10 renders/s
  }

  /* --------------------------- initial load ----------------------------- */
  var loadedHistory = {}; // sid → true once messages were fetched
  var live = { connected: false, send: sendPrompt };
  window.KimiLive = live;

  Promise.all([get('/workspaces'), get('/sessions?page_size=60')])
    .then(function (rs) {
      var wss = (rs[0].items || []).map(function (w) {
        return { id: w.id, name: w.name, root: w.root, branch: w.branch || '', add: 0, del: 0 };
      });
      var sess = (rs[1].items || []).map(mapSession);
      // Sessions referencing an unknown workspace get a derived placeholder.
      var known = {};
      wss.forEach(function (w) { known[w.id] = true; });
      sess.forEach(function (s) {
        if (!known[s.ws]) {
          known[s.ws] = true;
          wss.push({ id: s.ws, name: s.ws || '其他', root: '', branch: '', add: 0, del: 0 });
        }
      });
      // Only keep workspaces that actually have visible sessions, most recent first.
      wss.sort(function (a, b) {
        function first(w) { var i = sess.findIndex(function (s) { return s.ws === w.id; }); return i < 0 ? 1e9 : i; }
        return first(a) - first(b);
      });
      S.workspaces.length = 0; Array.prototype.push.apply(S.workspaces, wss);
      S.sessions.length = 0; Array.prototype.push.apply(S.sessions, sess);
      Object.keys(S.conversations).forEach(function (k) { delete S.conversations[k]; });
      live.connected = true;
      connectWs();
      S.set({ currentSessionId: sess.length ? sess[0].id : null, authed: true });
      toast('已连接服务器 ' + origin.replace(/^https?:\/\//, ''), 'success');
    })
    .catch(function (err) {
      if (err && err.auth) {
        // Protected server, no/invalid token → ask for one (app.js persists it
        // to localStorage and reloads).
        console.warn('[live] 服务器需要 Token');
        if (window.KP && window.KP.openOverlay) window.KP.openOverlay('serverauth');
        return;
      }
      console.warn('[live] 连接服务器失败，保持离线模式：', err);
      toast('连接服务器失败，使用离线数据', 'error');
    });

  /* ----------------------- lazy history on session open ----------------- */
  var lastSid = null;
  S.subscribe(function (state) {
    var sid = state.currentSessionId;
    if (sid === lastSid) return;
    lastSid = sid;
    if (!sid || loadedHistory[sid] || !live.connected) return;
    if (!S.session(sid)) return; // locally-created stub session
    loadedHistory[sid] = true;
    subscribeWs(sid);
    get('/sessions/' + encodeURIComponent(sid) + '/messages?page_size=100')
      .then(function (page) {
        var items = (page.items || []).slice().reverse(); // newest-first → chronological
        S.conversations[sid] = mapMessages(items);
        scheduleRender();
      })
      .catch(function (err) {
        S.conversations[sid] = [{ type: 'status', text: '加载历史失败：' + err.message }];
        loadedHistory[sid] = false;
        scheduleRender();
      });
  });

  /* ------------------------------ send ---------------------------------- */
  // Returns true when the prompt was handed to the server (app.js then skips
  // its stub reply); false for sessions the server does not know about.
  function sendPrompt(sid, text) {
    if (!live.connected || !/^session_/.test(String(sid))) return false;
    subscribeWs(sid);
    post('/sessions/' + encodeURIComponent(sid) + '/prompts', {
      content: [{ type: 'text', text: text }],
    }).catch(function (err) {
      var s = S.session(sid);
      if (s) s.busy = false;
      var convo = S.conversations[sid] || (S.conversations[sid] = []);
      convo.push({ type: 'status', text: '发送失败：' + err.message });
      scheduleRender();
      toast('发送失败：' + err.message, 'error');
    });
    return true;
  }

  /* ------------------------------ WebSocket ------------------------------ */
  var ws = null;
  var wsReady = false;
  var wsMsgSeq = 0;
  var subscribed = {}; // sid → true
  var clientId = 'web2_' + Math.random().toString(36).slice(2, 10);
  // Per-session streaming state: the blocks currently being accumulated.
  var streams = {}; // sid → { prose, think, tools: {toolCallId: block} }

  function wsSend(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify(msg)); } catch (e) {}
    }
  }
  function subscribeWs(sid) {
    if (subscribed[sid]) return;
    subscribed[sid] = true;
    // No cursors → live-only subscription, no journal replay.
    if (wsReady) wsSend({ type: 'subscribe', id: 'c_' + (++wsMsgSeq), payload: { session_ids: [sid] } });
  }
  function connectWs() {
    var url = origin.replace(/^http/, 'ws') + '/api/v1/ws?client_id=' + encodeURIComponent(clientId);
    try { ws = new WebSocket(url, token ? ['kimi-code.bearer.' + token] : undefined); }
    catch (e) { console.warn('[live] WS 创建失败：', e); return; }
    ws.onmessage = function (ev) {
      var f;
      try { f = JSON.parse(ev.data); } catch (e) { return; }
      handleFrame(f);
    };
    ws.onclose = function () {
      wsReady = false;
      setTimeout(function () { if (live.connected) connectWs(); }, 3000);
    };
  }

  function handleFrame(f) {
    if (f.type === 'server_hello') {
      wsReady = true;
      wsMsgSeq = 0;
      wsSend({
        type: 'client_hello',
        id: 'c_' + (++wsMsgSeq),
        payload: { client_id: clientId, subscriptions: Object.keys(subscribed) },
      });
      return;
    }
    if (f.type === 'ping') { wsSend({ type: 'pong', payload: { nonce: f.payload && f.payload.nonce } }); return; }
    if (f.type === 'ack' || f.type === 'resync_required' || f.type === 'error') return;
    if (typeof f.session_id !== 'string') return;
    // Both raw agent-core frames and projected `event.*` frames arrive here;
    // strip the prefix and switch on the base name.
    handleEvent(f.type.replace(/^event\./, ''), f.session_id, f.payload || {});
  }

  function stream(sid) {
    return streams[sid] || (streams[sid] = { prose: null, think: null, tools: {} });
  }
  function convo(sid) {
    return S.conversations[sid] || (S.conversations[sid] = []);
  }
  function setBusy(sid, busy) {
    var s = S.session(sid);
    if (s) { s.busy = busy; if (!busy) s.ago = 0; }
  }

  function handleEvent(type, sid, p) {
    var isCurrent = sid === S.state.currentSessionId && loadedHistory[sid];
    var st = stream(sid);
    switch (type) {
      case 'assistant.delta': {
        if (!isCurrent) return;
        // raw: {delta: string} · projected: {delta: {text?, thinking?}}
        var d = typeof p.delta === 'string' ? p.delta : (p.delta && p.delta.text) || '';
        var th = typeof p.delta === 'object' && p.delta ? p.delta.thinking : '';
        if (th) appendThink(sid, st, th);
        if (!d) return;
        if (!st.prose) { st.prose = { type: 'prose', html: '', _raw: '' }; convo(sid).push(st.prose); }
        st.prose._raw += d;
        st.prose.html = textToHtml(st.prose._raw);
        scheduleRender();
        return;
      }
      case 'thinking.delta':
        if (isCurrent && typeof p.delta === 'string') appendThink(sid, st, p.delta);
        return;
      case 'tool.use':
      case 'tool.call.started':
      case 'assistant.tool_use_started':
      case 'tool.started': {
        setBusy(sid, true);
        if (!isCurrent) return;
        var id = p.toolCallId || p.tool_call_id;
        var name = p.name || p.toolName || p.tool_name || '工具';
        if (!id || st.tools[id]) return;
        var tb = { type: 'tool', name: name, arg: argSummary(p.args || p.input), ok: '' };
        st.tools[id] = tb;
        convo(sid).push(tb);
        st.prose = null; st.think = null; // next text starts a fresh block
        scheduleRender();
        return;
      }
      case 'tool.result':
      case 'tool.completed': {
        if (!isCurrent) return;
        var rid = p.toolCallId || p.tool_call_id;
        var t = rid && st.tools[rid];
        if (t) {
          t.ok = (p.isError || p.is_error) ? '出错' : '完成';
          t.body = outputText(p.output).slice(0, 2000);
          scheduleRender();
        }
        return;
      }
      case 'turn.started':
      case 'prompt.submitted':
        setBusy(sid, true);
        st.prose = null; st.think = null;
        scheduleRender();
        return;
      case 'turn.ended':
      case 'prompt.completed':
        setBusy(sid, false);
        st.prose = null; st.think = null; st.tools = {};
        if (isCurrent) convo(sid).push({ type: 'status', text: '已完成本轮 · 等待你的下一条输入' });
        scheduleRender();
        return;
      case 'session.status_changed': {
        setBusy(sid, p.status === 'running');
        var s = S.session(sid);
        if (s) {
          s.pending.a = p.status === 'awaiting_approval' ? 1 : 0;
          s.pending.q = p.status === 'awaiting_question' ? 1 : 0;
        }
        scheduleRender();
        return;
      }
      case 'session.meta.updated': {
        var ss = S.session(sid);
        if (ss && p.patch && typeof p.patch.title === 'string') ss.title = p.patch.title;
        if (ss) ss.ago = 0;
        scheduleRender();
        return;
      }
      default:
        return; // unknown event kinds are ignored
    }
  }
  function appendThink(sid, st, delta) {
    if (!st.think) { st.think = { type: 'think', html: '', _raw: '' }; convo(sid).push(st.think); }
    st.think._raw += delta;
    st.think.html = textToHtml(st.think._raw);
    scheduleRender();
  }
})();
