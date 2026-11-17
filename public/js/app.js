/*
 * ReqLab — main application logic.
 *
 * Ties the UI to the request model, the backend proxy, and the persisted store
 * (collections / environments / history). No build step, no framework.
 */
(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const { escapeHtml, highlightJSON } = window.RL_highlight;

  const uid = () =>
    (Date.now().toString(36) + Math.random().toString(36).slice(2, 8)).toUpperCase();

  const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
  const RAW_CONTENT_TYPES = {
    json: 'application/json',
    text: 'text/plain',
    xml: 'application/xml',
    html: 'text/html',
    javascript: 'application/javascript',
  };
  const TABS_KEY = 'reqlab_tabs_v1';
  const STORE_KEY = 'reqlab_store_v1';

  // ── State ───────────────────────────────────────────────────────────────
  const state = {
    tabs: [],
    activeTabId: null,
    collections: [],
    environments: [],
    history: [],
    activeEnvId: null,
    activeReqTab: 'params',
    activeRespTab: 'pretty',
  };

  function newRequest(over = {}) {
    return Object.assign(
      {
        method: 'GET',
        url: '',
        params: [],
        headers: [],
        auth: { type: 'none', token: '', username: '', password: '', key: '', value: '', addTo: 'header' },
        body: { mode: 'none', raw: '', rawType: 'json', formData: [], urlencoded: [] },
      },
      over
    );
  }

  // ── Cleaning data that comes from a file or from storage ────────────────
  // Imported files (and anything saved from them) are untrusted: give every
  // field the expected type so a broken or hostile file can't break the page.
  const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
  const METHOD_TOKEN = /^[A-Z][A-Z0-9_-]{0,31}$/;

  function normalizeRows(list) {
    if (!Array.isArray(list)) return [];
    return list
      .filter((row) => row && typeof row === 'object')
      .map((row) => ({ key: str(row.key), value: str(row.value), enabled: row.enabled !== false }));
  }

  function normalizeRequest(raw) {
    const req = newRequest();
    if (!raw || typeof raw !== 'object') return req;
    const method = str(raw.method).trim().toUpperCase();
    req.method = METHOD_TOKEN.test(method) ? method : 'GET';
    req.url = str(raw.url);
    req.params = normalizeRows(raw.params);
    req.headers = normalizeRows(raw.headers);
    const auth = raw.auth && typeof raw.auth === 'object' ? raw.auth : {};
    for (const k of Object.keys(req.auth)) if (auth[k] != null) req.auth[k] = str(auth[k]);
    if (!['none', 'bearer', 'basic', 'apikey'].includes(req.auth.type)) req.auth.type = 'none';
    if (req.auth.addTo !== 'query') req.auth.addTo = 'header';
    const body = raw.body && typeof raw.body === 'object' ? raw.body : {};
    req.body.mode = ['none', 'raw', 'urlencoded', 'form-data'].includes(body.mode) ? body.mode : 'none';
    req.body.raw = str(body.raw);
    req.body.rawType = Object.prototype.hasOwnProperty.call(RAW_CONTENT_TYPES, body.rawType) ? body.rawType : 'json';
    req.body.formData = normalizeRows(body.formData);
    req.body.urlencoded = normalizeRows(body.urlencoded);
    return req;
  }

  // `freshIds` gives imported items new ids, so importing the same file twice can't mix them up.
  function normalizeCollection(raw, freshIds) {
    const c = raw && typeof raw === 'object' ? raw : {};
    return {
      id: (!freshIds && str(c.id)) || uid(),
      name: str(c.name) || 'Imported',
      requests: (Array.isArray(c.requests) ? c.requests : [])
        .filter((r) => r && typeof r === 'object')
        .map((r) => ({
          id: (!freshIds && str(r.id)) || uid(),
          name: str(r.name) || 'Request',
          request: normalizeRequest(r.request),
        })),
    };
  }

  function normalizeEnvironment(raw, freshIds) {
    const e = raw && typeof raw === 'object' ? raw : {};
    return {
      id: (!freshIds && str(e.id)) || uid(),
      name: str(e.name) || 'Environment',
      variables: normalizeRows(e.variables),
    };
  }

  function normalizeHistoryItem(raw) {
    const h = raw && typeof raw === 'object' ? raw : {};
    const request = normalizeRequest(h.request);
    return {
      id: str(h.id) || uid(),
      ts: Number(h.ts) || Date.now(),
      method: request.method,
      url: str(h.url),
      status: Number.isInteger(h.status) ? h.status : null,
      ok: !!h.ok,
      request,
    };
  }

  function newTab(request, meta = {}) {
    return {
      id: uid(),
      name: meta.name || 'Untitled Request',
      dirty: false,
      collectionId: meta.collectionId || null,
      requestId: meta.requestId || null,
      request: request || newRequest(),
      response: null,
    };
  }

  const activeTab = () => state.tabs.find((t) => t.id === state.activeTabId);
  const activeReq = () => activeTab() && activeTab().request;
  const activeEnv = () => state.environments.find((e) => e.id === state.activeEnvId);
  const varMap = () => window.RL_vars.mapFromEnv(activeEnv());

  // ── Toast ───────────────────────────────────────────────────────────────
  function toast(title, msg, type) {
    const el = document.createElement('div');
    el.className = 'toast ' + (type || '');
    el.innerHTML = '<div class="t-title"></div>' + (msg ? '<div class="t-msg"></div>' : '');
    el.querySelector('.t-title').textContent = title;
    if (msg) el.querySelector('.t-msg').textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 250);
    }, 3600);
  }

  // ── Persistence ─────────────────────────────────────────────────────────
  // ReqLab keeps ALL of your data (collections, environments, history, tabs)
  // in THIS browser only — it is never sent to the server to be stored on disk.
  // That means tokens/secrets you use never land on the hosted server (e.g.
  // Render); they stay on your own machine, like a local desktop app.
  let saveTimer = null;
  function persistStore() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(
          STORE_KEY,
          JSON.stringify({
            collections: state.collections,
            environments: state.environments,
            history: state.history,
          })
        );
      } catch (_e) {
        /* ignore quota errors */
      }
    }, 250);
  }

  function persistTabs() {
    try {
      const slim = {
        activeTabId: state.activeTabId,
        activeEnvId: state.activeEnvId,
        tabs: state.tabs.map((t) => ({
          id: t.id,
          name: t.name,
          dirty: t.dirty,
          collectionId: t.collectionId,
          requestId: t.requestId,
          request: t.request,
        })),
      };
      localStorage.setItem(TABS_KEY, JSON.stringify(slim));
    } catch (_e) {
      /* ignore quota errors */
    }
  }

  // ── Key/value editor (reused everywhere) ────────────────────────────────
  function renderKV(container, rows, onChange) {
    container.innerHTML = '';

    const build = (row, index, isNew) => {
      const el = document.createElement('div');
      el.className = 'kv-row' + (isNew ? ' kv-new' : '');

      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.className = 'kv-chk';
      chk.checked = row.enabled !== false;
      if (isNew) chk.style.visibility = 'hidden';

      const key = document.createElement('input');
      key.type = 'text';
      key.className = 'kv-key';
      key.placeholder = 'Key';
      key.value = row.key || '';

      const val = document.createElement('input');
      val.type = 'text';
      val.className = 'kv-val';
      val.placeholder = 'Value';
      val.value = row.value || '';

      const del = document.createElement('button');
      del.className = 'kv-del';
      del.textContent = '×';
      if (isNew) del.style.visibility = 'hidden';

      chk.addEventListener('change', () => {
        row.enabled = chk.checked;
        onChange();
      });

      const promote = (fromEl) => {
        row.enabled = true;
        rows.push(row);
        onChange();
        const isKey = fromEl.classList.contains('kv-key');
        const caret = fromEl.selectionStart;
        renderKV(container, rows, onChange);
        const newRowEl = container.children[rows.length - 1];
        const target = newRowEl.querySelector(isKey ? '.kv-key' : '.kv-val');
        if (target) {
          target.focus();
          try {
            target.setSelectionRange(caret, caret);
          } catch (_e) {}
        }
      };

      key.addEventListener('input', () => {
        row.key = key.value;
        if (isNew) promote(key);
        else onChange();
      });
      val.addEventListener('input', () => {
        row.value = val.value;
        if (isNew) promote(val);
        else onChange();
      });
      del.addEventListener('click', () => {
        rows.splice(index, 1);
        onChange();
        renderKV(container, rows, onChange);
      });

      el.append(chk, key, val, del);
      return el;
    };

    rows.forEach((row, i) => container.appendChild(build(row, i, false)));
    container.appendChild(build({ key: '', value: '', enabled: true }, rows.length, true));
  }

  // ── Method styling ──────────────────────────────────────────────────────
  const methodClass = (m) => 'm-' + String(m || 'get').toLowerCase().replace(/[^a-z]/g, '');

  // ── Tab bar ─────────────────────────────────────────────────────────────
  function renderTabBar() {
    const bar = $('#tabBar');
    bar.innerHTML = '';
    state.tabs.forEach((tab) => {
      const el = document.createElement('div');
      el.className = 'rtab' + (tab.id === state.activeTabId ? ' active' : '');
      const method = tab.request.method;
      el.innerHTML =
        `<span class="rtab-method ${methodClass(method)}">${escapeHtml(method)}</span>` +
        `<span class="rtab-name">${escapeHtml(tab.name)}</span>` +
        (tab.dirty ? '<span class="dirty" title="Unsaved"></span>' : '') +
        '<span class="rtab-close" title="Close">✕</span>';
      el.addEventListener('click', (e) => {
        if (e.target.classList.contains('rtab-close')) {
          closeTab(tab.id);
        } else {
          switchTab(tab.id);
        }
      });
      bar.appendChild(el);
    });
    const add = document.createElement('button');
    add.className = 'newtab';
    add.textContent = '＋';
    add.title = 'New request';
    add.addEventListener('click', () => {
      const t = newTab(newRequest());
      state.tabs.push(t);
      switchTab(t.id);
    });
    bar.appendChild(add);
  }

  function switchTab(id) {
    state.activeTabId = id;
    renderTabBar();
    loadEditorFromTab();
    persistTabs();
  }

  function closeTab(id) {
    const idx = state.tabs.findIndex((t) => t.id === id);
    if (idx === -1) return;
    state.tabs.splice(idx, 1);
    if (state.tabs.length === 0) state.tabs.push(newTab(newRequest()));
    if (state.activeTabId === id) {
      state.activeTabId = state.tabs[Math.max(0, idx - 1)].id;
      loadEditorFromTab();
    }
    renderTabBar();
    persistTabs();
  }

  function markDirty() {
    const tab = activeTab();
    if (tab && !tab.dirty) {
      tab.dirty = true;
      renderTabBar();
    }
    persistTabs();
  }

  // ── Load editor from active tab ─────────────────────────────────────────
  function loadEditorFromTab() {
    const req = activeReq();
    if (!req) return;

    $('#methodSelect').value = req.method;
    $('#urlInput').value = req.url;

    renderKV($('#paramsEditor'), req.params, () => {
      syncURLFromParams();
      updateCounts();
      markDirty();
    });
    renderKV($('#headersEditor'), req.headers, () => {
      updateCounts();
      markDirty();
    });

    // Auth
    $('#authType').value = req.auth.type;
    renderAuthFields();

    // Body
    const mode = req.body.mode || 'none';
    $$('input[name="bodyMode"]').forEach((r) => (r.checked = r.value === mode));
    $('#bodyRawType').value = req.body.rawType || 'json';
    $('#bodyRaw').value = req.body.raw || '';
    renderKV($('#urlencodedEditor'), req.body.urlencoded, () => {
      updateCounts();
      markDirty();
    });
    renderKV($('#formDataEditor'), req.body.formData, () => {
      updateCounts();
      markDirty();
    });
    showBodyMode(mode);

    // Response
    if (activeTab().response) renderResponse(activeTab().response);
    else clearResponse();

    updateCounts();
  }

  function updateCounts() {
    const req = activeReq();
    if (!req) return;
    const pc = req.params.filter((r) => r.enabled !== false && r.key).length;
    const hc = req.headers.filter((r) => r.enabled !== false && r.key).length;
    $('#paramsCount').textContent = pc || '';
    $('#headersCount').textContent = hc || '';
    $('#bodyDot').classList.toggle('on', (req.body.mode || 'none') !== 'none');
  }

  // ── URL ↔ params sync ───────────────────────────────────────────────────
  function encodePreserveVars(str) {
    return String(str)
      .split(/(\{\{[^}]+\}\})/)
      .map((part) => (/^\{\{/.test(part) ? part : encodeURIComponent(part)))
      .join('');
  }
  function decodeSafe(str) {
    try {
      return decodeURIComponent(str.replace(/\+/g, ' '));
    } catch (_e) {
      return str;
    }
  }

  function syncURLFromParams() {
    const req = activeReq();
    const base = req.url.split('?')[0];
    const pairs = req.params
      .filter((r) => r.enabled !== false && (r.key || r.value))
      .map((r) => encodePreserveVars(r.key) + '=' + encodePreserveVars(r.value));
    req.url = base + (pairs.length ? '?' + pairs.join('&') : '');
    $('#urlInput').value = req.url;
  }

  function syncParamsFromURL() {
    const req = activeReq();
    const qIndex = req.url.indexOf('?');
    const rows = [];
    if (qIndex !== -1) {
      const query = req.url.slice(qIndex + 1);
      for (const pair of query.split('&')) {
        if (!pair) continue;
        const eq = pair.indexOf('=');
        const k = eq === -1 ? pair : pair.slice(0, eq);
        const v = eq === -1 ? '' : pair.slice(eq + 1);
        rows.push({ key: decodeSafe(k), value: decodeSafe(v), enabled: true });
      }
    }
    req.params = rows;
    renderKV($('#paramsEditor'), req.params, () => {
      syncURLFromParams();
      updateCounts();
      markDirty();
    });
    updateCounts();
  }

  // ── Auth fields ─────────────────────────────────────────────────────────
  function renderAuthFields() {
    const req = activeReq();
    const type = req.auth.type;
    const wrap = $('#authFields');
    wrap.innerHTML = '';

    const field = (labelText, inputEl) => {
      const f = document.createElement('div');
      f.className = 'field';
      const l = document.createElement('label');
      l.textContent = labelText;
      f.append(l, inputEl);
      return f;
    };
    const makeInput = (value, onInput, placeholder, isPassword) => {
      const i = document.createElement('input');
      i.type = isPassword ? 'password' : 'text';
      i.value = value || '';
      if (placeholder) i.placeholder = placeholder;
      i.addEventListener('input', () => {
        onInput(i.value);
        markDirty();
      });
      return i;
    };

    if (type === 'bearer') {
      wrap.appendChild(
        field('Token', makeInput(req.auth.token, (v) => (req.auth.token = v), 'Token or {{token}}'))
      );
    } else if (type === 'basic') {
      wrap.appendChild(
        field('Username', makeInput(req.auth.username, (v) => (req.auth.username = v), 'Username'))
      );
      wrap.appendChild(
        field('Password', makeInput(req.auth.password, (v) => (req.auth.password = v), 'Password', true))
      );
    } else if (type === 'apikey') {
      wrap.appendChild(field('Key', makeInput(req.auth.key, (v) => (req.auth.key = v), 'e.g. X-API-Key')));
      wrap.appendChild(field('Value', makeInput(req.auth.value, (v) => (req.auth.value = v), 'Value or {{apiKey}}')));
      const sel = document.createElement('select');
      ['header', 'query'].forEach((opt) => {
        const o = document.createElement('option');
        o.value = opt;
        o.textContent = 'Add to ' + (opt === 'header' ? 'Header' : 'Query Params');
        sel.appendChild(o);
      });
      sel.value = req.auth.addTo || 'header';
      sel.addEventListener('change', () => {
        req.auth.addTo = sel.value;
        markDirty();
      });
      wrap.appendChild(field('Add to', sel));
    } else {
      const e = document.createElement('div');
      e.className = 'empty small';
      e.textContent = 'This request does not use authorization.';
      wrap.appendChild(e);
    }
  }

  // ── Body mode visibility ────────────────────────────────────────────────
  function showBodyMode(mode) {
    $('#bodyRawWrap').classList.toggle('hidden', mode !== 'raw');
    $('#bodyUrlWrap').classList.toggle('hidden', mode !== 'urlencoded');
    $('#bodyFormWrap').classList.toggle('hidden', mode !== 'form-data');
    $('#bodyNoneWrap').classList.toggle('hidden', mode !== 'none');
    $('#bodyRawType').style.display = mode === 'raw' ? '' : 'none';
    $('#beautifyBtn').style.display = mode === 'raw' ? '' : 'none';
  }

  // ── Build the effective request (resolved + assembled) ──────────────────
  function buildEffective(req, map) {
    const resolve = (s) => window.RL_vars.resolve(s, map);
    let url = resolve(req.url);

    const headers = {};
    req.headers
      .filter((h) => h.enabled !== false && h.key)
      .forEach((h) => (headers[resolve(h.key)] = resolve(h.value)));

    // Authorization
    const auth = req.auth;
    if (auth.type === 'bearer' && auth.token) {
      headers['Authorization'] = 'Bearer ' + resolve(auth.token);
    } else if (auth.type === 'basic') {
      const creds = resolve(auth.username) + ':' + resolve(auth.password);
      headers['Authorization'] = 'Basic ' + b64(creds);
    } else if (auth.type === 'apikey' && auth.key) {
      if (auth.addTo === 'query') {
        url += (url.includes('?') ? '&' : '?') + encodeURIComponent(resolve(auth.key)) + '=' + encodeURIComponent(resolve(auth.value));
      } else {
        headers[resolve(auth.key)] = resolve(auth.value);
      }
    }

    // Body
    let body;
    const hasCT = Object.keys(headers).some((k) => k.toLowerCase() === 'content-type');
    const mode = req.body.mode || 'none';
    if (mode === 'raw' && req.body.raw) {
      body = resolve(req.body.raw);
      if (!hasCT) headers['Content-Type'] = RAW_CONTENT_TYPES[req.body.rawType] || 'text/plain';
    } else if (mode === 'urlencoded') {
      const pairs = req.body.urlencoded
        .filter((r) => r.enabled !== false && r.key)
        .map((r) => encodeURIComponent(resolve(r.key)) + '=' + encodeURIComponent(resolve(r.value)));
      body = pairs.join('&');
      if (!hasCT) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    } else if (mode === 'form-data') {
      const boundary = '----ReqLabBoundary' + uid();
      const parts = req.body.formData
        .filter((r) => r.enabled !== false && r.key)
        .map(
          (r) =>
            `--${boundary}\r\nContent-Disposition: form-data; name="${resolve(r.key)}"\r\n\r\n${resolve(r.value)}\r\n`
        );
      if (parts.length) {
        body = parts.join('') + `--${boundary}--\r\n`;
        if (!hasCT) headers['Content-Type'] = `multipart/form-data; boundary=${boundary}`;
      }
    }

    return { method: req.method, url, headers, body };
  }

  function b64(str) {
    try {
      return btoa(unescape(encodeURIComponent(str)));
    } catch (_e) {
      return btoa(str);
    }
  }

  // ── Send ────────────────────────────────────────────────────────────────
  async function sendRequest() {
    const tab = activeTab();
    const req = tab.request;
    if (!req.url.trim()) {
      toast('No URL', 'Enter a request URL first.', 'error');
      return;
    }

    const eff = buildEffective(req, varMap());
    const btn = $('#sendBtn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>';

    try {
      const resp = await window.RL_api.proxy({
        method: eff.method,
        url: eff.url,
        headers: eff.headers,
        body: eff.body,
      });
      tab.response = resp;
      renderResponse(resp);
      addHistory(req, resp);
      persistTabs();
    } catch (err) {
      const resp = { error: 'Could not reach the ReqLab server: ' + err.message };
      tab.response = resp;
      renderResponse(resp);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Send';
    }
  }

  // ── Response rendering ──────────────────────────────────────────────────
  function clearResponse() {
    $('#respPlaceholder').style.display = '';
    ['#respPretty', '#respRaw', '#respPreview', '#respHeaders'].forEach((s) => {
      $(s).classList.remove('active');
      $(s).innerHTML = '';
    });
    $('#respStatus').textContent = '';
    $('#respStatus').className = 'meta-status';
    $('#respTime').textContent = '';
    $('#respSize').textContent = '';
    $('#respHeadersCount').textContent = '';
    $('#copyRespBtn').hidden = true;
  }

  function humanSize(bytes) {
    if (bytes == null) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(2) + ' MB';
  }

  function statusClass(status) {
    if (!status) return 's-err';
    if (status < 300) return 's-2xx';
    if (status < 400) return 's-3xx';
    if (status < 500) return 's-4xx';
    return 's-5xx';
  }

  function renderResponse(resp) {
    $('#respPlaceholder').style.display = 'none';

    // Error (network / proxy) — no HTTP status.
    if (resp.error && resp.status === undefined) {
      $('#respStatus').textContent = 'Error';
      $('#respStatus').className = 'meta-status s-err';
      $('#respTime').textContent = resp.time != null ? resp.time + ' ms' : '';
      $('#respSize').textContent = '';
      $('#respHeadersCount').textContent = '';
      $('#copyRespBtn').hidden = true;
      ['#respRaw', '#respPreview', '#respHeaders'].forEach((s) => {
        $(s).classList.remove('active');
        $(s).innerHTML = '';
      });
      const pretty = $('#respPretty');
      pretty.classList.add('active');
      pretty.innerHTML = `<div class="banner">⚠️ ${escapeHtml(resp.error)}</div>`;
      return;
    }

    $('#respStatus').textContent = resp.status + ' ' + (resp.statusText || '');
    $('#respStatus').className = 'meta-status ' + statusClass(resp.status);
    $('#respTime').textContent = (resp.time != null ? resp.time : 0) + ' ms';
    $('#respSize').textContent = humanSize(resp.size);
    $('#copyRespBtn').hidden = false;

    const headers = resp.headers || {};
    $('#respHeadersCount').textContent = '(' + Object.keys(headers).length + ')';

    // Headers tab
    const htable = Object.entries(headers)
      .map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`)
      .join('');
    $('#respHeaders').innerHTML = `<table class="htable"><tbody>${htable}</tbody></table>`;

    const body = resp.isBinary ? '' : resp.body || '';
    const ct = resp.contentType || '';

    // Pretty
    const pretty = $('#respPretty');
    if (resp.isBinary) {
      pretty.innerHTML = '<div class="banner warn">Binary response — see the Preview tab.</div>';
    } else if (looksJSON(body, ct)) {
      try {
        pretty.innerHTML = highlightJSON(JSON.stringify(JSON.parse(body), null, 2));
      } catch (_e) {
        pretty.textContent = body;
      }
    } else {
      pretty.textContent = body;
    }
    if (resp.truncated) {
      pretty.innerHTML =
        '<div class="banner warn">Response truncated for display (too large).</div>' + pretty.innerHTML;
    }

    // Raw
    $('#respRaw').textContent = resp.isBinary ? '[binary data]' : body;

    // Preview
    const preview = $('#respPreview');
    preview.innerHTML = '';
    if (resp.isBinary && /^image\//.test(ct) && resp.bodyBase64) {
      const img = document.createElement('img');
      img.src = `data:${ct};base64,${resp.bodyBase64}`;
      preview.appendChild(img);
    } else if (/html/.test(ct)) {
      const iframe = document.createElement('iframe');
      iframe.setAttribute('sandbox', ''); // fully locked: render HTML/CSS, no scripts
      iframe.srcdoc = body;
      preview.appendChild(iframe);
    } else {
      preview.innerHTML = '<div class="empty small">No preview available for this content type.</div>';
    }

    showRespTab(state.activeRespTab);
  }

  function looksJSON(body, ct) {
    if (/json/.test(ct)) return true;
    const t = (body || '').trim();
    return (t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'));
  }

  function showRespTab(name) {
    state.activeRespTab = name;
    $$('.resp-tab').forEach((t) => t.classList.toggle('active', t.dataset.resp === name));
    const map = { pretty: '#respPretty', raw: '#respRaw', preview: '#respPreview', headers: '#respHeaders' };
    Object.entries(map).forEach(([key, sel]) => $(sel).classList.toggle('active', key === name));
  }

  // ── History ─────────────────────────────────────────────────────────────
  function addHistory(req, resp) {
    state.history.unshift({
      id: uid(),
      ts: Date.now(),
      method: req.method,
      // Store the UNRESOLVED url (keeps {{variables}} as-is) so secrets that
      // a variable resolves to — e.g. an API key in the query string — are
      // never written to history.
      url: req.url,
      status: resp.status || null,
      ok: !!resp.ok,
      request: JSON.parse(JSON.stringify(req)),
    });
    if (state.history.length > 100) state.history = state.history.slice(0, 100);
    renderHistory();
    persistStore();
  }

  function renderHistory() {
    const list = $('#historyList');
    list.innerHTML = '';
    if (!state.history.length) {
      list.innerHTML = '<div class="empty">No requests yet.</div>';
      return;
    }
    state.history.forEach((h) => {
      const el = document.createElement('div');
      el.className = 'hist-item';
      const statusTxt = h.status ? h.status : 'ERR';
      el.innerHTML =
        `<span class="m ${methodClass(h.method)}">${escapeHtml(h.method)}</span>` +
        `<span class="label" title="${escapeHtml(h.url)}">${escapeHtml(stripProtocol(h.url))}</span>` +
        `<span class="hist-status ${statusClass(h.status)}">${escapeHtml(statusTxt)}</span>`;
      el.addEventListener('click', () => openRequestInTab(h.request, deriveName(h.request)));
      list.appendChild(el);
    });
  }

  const stripProtocol = (u) => String(u).replace(/^https?:\/\//, '');
  function deriveName(req) {
    try {
      const u = new URL(window.RL_vars.resolve(req.url, varMap()));
      return req.method + ' ' + (u.pathname === '/' ? u.hostname : u.pathname);
    } catch (_e) {
      return req.method + ' request';
    }
  }

  function openRequestInTab(request, name) {
    const t = newTab(JSON.parse(JSON.stringify(request)), { name });
    state.tabs.push(t);
    switchTab(t.id);
  }

  // ── Collections ─────────────────────────────────────────────────────────
  function renderCollections() {
    const tree = $('#collectionsTree');
    tree.innerHTML = '';
    if (!state.collections.length) {
      tree.innerHTML = '<div class="empty">No collections yet.<br/>Save a request to create one.</div>';
      return;
    }
    state.collections.forEach((coll) => {
      const wrap = document.createElement('div');
      wrap.className = 'coll';
      const head = document.createElement('div');
      head.className = 'coll-head';
      head.innerHTML =
        '<span class="caret">▼</span>' +
        `<span class="coll-name">${escapeHtml(coll.name)}</span>` +
        `<span class="coll-count small muted">${coll.requests.length}</span>` +
        '<span class="coll-actions">' +
        '<button class="btn ghost tiny" data-act="rename">✎</button>' +
        '<button class="btn ghost tiny" data-act="del">🗑</button>' +
        '</span>';
      head.addEventListener('click', (e) => {
        const act = e.target.dataset.act;
        if (act === 'rename') {
          const name = prompt('Rename collection', coll.name);
          if (name) {
            coll.name = name.trim();
            renderCollections();
            persistStore();
          }
        } else if (act === 'del') {
          if (confirm(`Delete collection "${coll.name}" and its ${coll.requests.length} request(s)?`)) {
            state.collections = state.collections.filter((c) => c.id !== coll.id);
            renderCollections();
            persistStore();
          }
        } else {
          wrap.classList.toggle('collapsed');
        }
      });

      const reqs = document.createElement('div');
      reqs.className = 'coll-requests';
      coll.requests.forEach((saved) => {
        const item = document.createElement('div');
        item.className = 'req-item';
        item.innerHTML =
          `<span class="m ${methodClass(saved.request.method)}">${escapeHtml(saved.request.method)}</span>` +
          `<span class="label">${escapeHtml(saved.name)}</span>` +
          '<button class="btn ghost tiny item-del">🗑</button>';
        item.addEventListener('click', (e) => {
          if (e.target.classList.contains('item-del')) {
            coll.requests = coll.requests.filter((r) => r.id !== saved.id);
            renderCollections();
            persistStore();
          } else {
            const t = newTab(JSON.parse(JSON.stringify(saved.request)), {
              name: saved.name,
              collectionId: coll.id,
              requestId: saved.id,
            });
            state.tabs.push(t);
            switchTab(t.id);
          }
        });
        reqs.appendChild(item);
      });

      wrap.append(head, reqs);
      tree.appendChild(wrap);
    });
  }

  // ── Save modal ──────────────────────────────────────────────────────────
  function openSaveModal() {
    const tab = activeTab();
    $('#saveName').value = tab.name && tab.name !== 'Untitled Request' ? tab.name : deriveName(tab.request);
    const sel = $('#saveCollection');
    sel.innerHTML = '';
    state.collections.forEach((c) => {
      const o = document.createElement('option');
      o.value = c.id;
      o.textContent = c.name;
      sel.appendChild(o);
    });
    const o = document.createElement('option');
    o.value = '__new__';
    o.textContent = '➕ New collection…';
    sel.appendChild(o);
    if (tab.collectionId && state.collections.some((c) => c.id === tab.collectionId)) {
      sel.value = tab.collectionId;
    }
    toggleNewCollectionField();
    $('#saveModal').classList.remove('hidden');
    $('#saveName').focus();
  }

  function toggleNewCollectionField() {
    $('#newCollectionField').classList.toggle('hidden', $('#saveCollection').value !== '__new__');
  }

  function confirmSave() {
    const tab = activeTab();
    const name = $('#saveName').value.trim() || 'Untitled Request';
    let collectionId = $('#saveCollection').value;

    if (collectionId === '__new__') {
      const cname = $('#newCollectionName').value.trim();
      if (!cname) {
        toast('Name required', 'Enter a name for the new collection.', 'error');
        return;
      }
      const coll = { id: uid(), name: cname, requests: [] };
      state.collections.push(coll);
      collectionId = coll.id;
    }

    const coll = state.collections.find((c) => c.id === collectionId);
    const snapshot = JSON.parse(JSON.stringify(tab.request));

    let saved = tab.requestId && coll.requests.find((r) => r.id === tab.requestId);
    if (saved) {
      saved.name = name;
      saved.request = snapshot;
    } else {
      saved = { id: uid(), name, request: snapshot };
      coll.requests.push(saved);
    }

    tab.name = name;
    tab.collectionId = coll.id;
    tab.requestId = saved.id;
    tab.dirty = false;

    renderTabBar();
    renderCollections();
    persistStore();
    persistTabs();
    $('#saveModal').classList.add('hidden');
    toast('Saved', `“${name}” saved to ${coll.name}.`, 'success');
  }

  // ── Environments ────────────────────────────────────────────────────────
  function renderEnvSelect() {
    const sel = $('#envSelect');
    sel.innerHTML = '';
    const none = document.createElement('option');
    none.value = '';
    none.textContent = 'No environment';
    sel.appendChild(none);
    state.environments.forEach((env) => {
      const o = document.createElement('option');
      o.value = env.id;
      o.textContent = env.name;
      sel.appendChild(o);
    });
    sel.value = state.activeEnvId || '';
  }

  let editingEnvId = null;
  function openEnvModal() {
    editingEnvId = state.activeEnvId || (state.environments[0] && state.environments[0].id) || null;
    renderEnvList();
    renderEnvEdit();
    $('#envModal').classList.remove('hidden');
  }

  function renderEnvList() {
    const list = $('#envList');
    list.innerHTML = '';
    if (!state.environments.length) {
      list.innerHTML = '<div class="empty small">No environments.</div>';
    }
    state.environments.forEach((env) => {
      const el = document.createElement('div');
      el.className = 'env-list-item' + (env.id === editingEnvId ? ' active' : '');
      el.innerHTML = `<span>${escapeHtml(env.name)}</span><span class="small muted">${env.variables.length}</span>`;
      el.addEventListener('click', () => {
        editingEnvId = env.id;
        renderEnvList();
        renderEnvEdit();
      });
      list.appendChild(el);
    });
  }

  function renderEnvEdit() {
    const env = state.environments.find((e) => e.id === editingEnvId);
    $('#envEditEmpty').classList.toggle('hidden', !!env);
    $('#envEditBody').classList.toggle('hidden', !env);
    if (!env) return;
    $('#envNameInput').value = env.name;
    $('#envNameInput').oninput = () => {
      env.name = $('#envNameInput').value;
      renderEnvList();
      renderEnvSelect();
      persistStore();
    };
    renderKV($('#envVarsEditor'), env.variables, () => persistStore());
  }

  // ── Code generation ─────────────────────────────────────────────────────
  function openCodeModal() {
    updateCodeOutput();
    $('#codeModal').classList.remove('hidden');
  }
  function updateCodeOutput() {
    const eff = buildEffective(activeReq(), varMap());
    $('#codeOutput').textContent = window.RL_codegen.generate($('#codeLang').value, eff);
  }

  // ── Import / Export ─────────────────────────────────────────────────────
  function exportData() {
    const payload = {
      reqlab: true,
      version: 1,
      exportedAt: new Date().toISOString(),
      collections: state.collections,
      environments: state.environments,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'reqlab-export.json';
    a.click();
    URL.revokeObjectURL(a.href);
    toast('Exported', 'Collections & environments downloaded.', 'success');
  }

  function importData(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (data && data.reqlab) {
          mergeImport(data.collections || [], data.environments || []);
          toast('Imported', 'ReqLab export merged.', 'success');
        } else if (data && data.info && Array.isArray(data.item)) {
          const coll = convertPostman(data);
          state.collections.push(coll);
          renderCollections();
          persistStore();
          toast('Imported', `Postman collection “${coll.name}” added.`, 'success');
        } else {
          toast('Unrecognized file', 'Not a ReqLab or Postman v2 collection.', 'error');
        }
      } catch (err) {
        toast('Import failed', err.message, 'error');
      }
    };
    reader.readAsText(file);
  }

  function mergeImport(collections, environments) {
    if (!Array.isArray(collections) || !Array.isArray(environments)) {
      throw new Error('The file has no list of collections or environments.');
    }
    state.collections.push(...collections.map((c) => normalizeCollection(c, true)));
    state.environments.push(...environments.map((e) => normalizeEnvironment(e, true)));
    renderCollections();
    renderEnvSelect();
    persistStore();
  }

  function convertPostman(doc) {
    const coll = { id: uid(), name: (doc.info && doc.info.name) || 'Imported', requests: [] };
    const walk = (items, prefix) => {
      (Array.isArray(items) ? items : []).forEach((item) => {
        if (!item || typeof item !== 'object') return;
        if (Array.isArray(item.item)) {
          walk(item.item, prefix ? prefix + ' / ' + item.name : item.name);
        } else if (item.request) {
          coll.requests.push({
            id: uid(),
            name: (prefix ? prefix + ' / ' : '') + (item.name || 'Request'),
            request: mapPostmanRequest(item.request),
          });
        }
      });
    };
    walk(doc.item, '');
    return normalizeCollection(coll, true);
  }

  function mapPostmanRequest(pr) {
    const req = newRequest();
    req.method = str(pr.method || 'GET').toUpperCase();
    req.url = typeof pr.url === 'string' ? pr.url : str(pr.url && pr.url.raw);
    if (Array.isArray(pr.header)) {
      req.headers = pr.header
        .filter((h) => h && !h.disabled)
        .map((h) => ({ key: h.key, value: h.value, enabled: true }));
    }
    if (pr.body) {
      if (pr.body.mode === 'raw') {
        req.body.mode = 'raw';
        req.body.raw = pr.body.raw || '';
        const lang = pr.body.options && pr.body.options.raw && pr.body.options.raw.language;
        req.body.rawType = lang === 'json' ? 'json' : lang || 'text';
      } else if (pr.body.mode === 'urlencoded') {
        req.body.mode = 'urlencoded';
        req.body.urlencoded = (pr.body.urlencoded || []).filter(Boolean).map((p) => ({
          key: p.key,
          value: p.value,
          enabled: !p.disabled,
        }));
      } else if (pr.body.mode === 'formdata') {
        req.body.mode = 'form-data';
        req.body.formData = (pr.body.formdata || [])
          .filter((p) => p && p.type !== 'file')
          .map((p) => ({ key: p.key, value: p.value, enabled: !p.disabled }));
      }
    }
    // Sync params from URL
    const qi = req.url.indexOf('?');
    if (qi !== -1) {
      req.params = req.url
        .slice(qi + 1)
        .split('&')
        .filter(Boolean)
        .map((pair) => {
          const eq = pair.indexOf('=');
          return {
            key: decodeSafe(eq === -1 ? pair : pair.slice(0, eq)),
            value: eq === -1 ? '' : decodeSafe(pair.slice(eq + 1)),
            enabled: true,
          };
        });
    }
    return req;
  }

  // ── Wire up events ──────────────────────────────────────────────────────
  function bindEvents() {
    // Method / URL
    $('#methodSelect').addEventListener('change', () => {
      activeReq().method = $('#methodSelect').value;
      renderTabBar();
      markDirty();
    });
    $('#urlInput').addEventListener('input', () => {
      activeReq().url = $('#urlInput').value;
      syncParamsFromURL();
      markDirty();
    });

    // Send / Save / Code
    $('#sendBtn').addEventListener('click', sendRequest);
    $('#saveBtn').addEventListener('click', openSaveModal);
    $('#codeBtn').addEventListener('click', openCodeModal);
    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        sendRequest();
      }
    });

    // Request sub-tabs
    $$('.req-tab').forEach((t) =>
      t.addEventListener('click', () => {
        state.activeReqTab = t.dataset.req;
        $$('.req-tab').forEach((x) => x.classList.toggle('active', x === t));
        const map = { params: '#paramsPanel', auth: '#authPanel', headers: '#headersPanel', body: '#bodyPanel' };
        Object.entries(map).forEach(([k, sel]) => $(sel).classList.toggle('active', k === t.dataset.req));
      })
    );

    // Response sub-tabs
    $$('.resp-tab').forEach((t) => t.addEventListener('click', () => showRespTab(t.dataset.resp)));
    $('#copyRespBtn').addEventListener('click', () => {
      const resp = activeTab().response;
      if (resp && resp.body != null) {
        navigator.clipboard.writeText(resp.body).then(() => toast('Copied', '', 'success'));
      }
    });

    // Auth
    $('#authType').addEventListener('change', () => {
      activeReq().auth.type = $('#authType').value;
      renderAuthFields();
      markDirty();
    });

    // Body
    $$('input[name="bodyMode"]').forEach((r) =>
      r.addEventListener('change', () => {
        activeReq().body.mode = r.value;
        showBodyMode(r.value);
        updateCounts();
        markDirty();
      })
    );
    $('#bodyRawType').addEventListener('change', () => {
      activeReq().body.rawType = $('#bodyRawType').value;
      markDirty();
    });
    $('#bodyRaw').addEventListener('input', () => {
      activeReq().body.raw = $('#bodyRaw').value;
      markDirty();
    });
    $('#beautifyBtn').addEventListener('click', () => {
      try {
        const pretty = JSON.stringify(JSON.parse($('#bodyRaw').value), null, 2);
        $('#bodyRaw').value = pretty;
        activeReq().body.raw = pretty;
        markDirty();
      } catch (_e) {
        toast('Invalid JSON', 'Could not beautify the body.', 'error');
      }
    });

    // Sidebar tabs
    $$('.side-tab').forEach((t) =>
      t.addEventListener('click', () => {
        $$('.side-tab').forEach((x) => x.classList.toggle('active', x === t));
        $('#collectionsPanel').classList.toggle('active', t.dataset.side === 'collections');
        $('#historyPanel').classList.toggle('active', t.dataset.side === 'history');
      })
    );

    // Collections / history
    $('#newCollectionBtn').addEventListener('click', () => {
      const name = prompt('New collection name');
      if (name && name.trim()) {
        state.collections.push({ id: uid(), name: name.trim(), requests: [] });
        renderCollections();
        persistStore();
      }
    });
    $('#clearHistoryBtn').addEventListener('click', () => {
      if (confirm('Clear all request history?')) {
        state.history = [];
        renderHistory();
        persistStore();
      }
    });

    // Save modal
    $('#saveCollection').addEventListener('change', toggleNewCollectionField);
    $('#saveConfirm').addEventListener('click', confirmSave);
    $('#saveCancel').addEventListener('click', () => $('#saveModal').classList.add('hidden'));

    // Env
    $('#envSelect').addEventListener('change', () => {
      state.activeEnvId = $('#envSelect').value || null;
      persistTabs();
    });
    $('#manageEnvBtn').addEventListener('click', openEnvModal);
    $('#newEnvBtn').addEventListener('click', () => {
      const env = { id: uid(), name: 'New Environment', variables: [] };
      state.environments.push(env);
      editingEnvId = env.id;
      renderEnvList();
      renderEnvEdit();
      renderEnvSelect();
      persistStore();
    });
    $('#deleteEnvBtn').addEventListener('click', () => {
      if (!editingEnvId) return;
      state.environments = state.environments.filter((e) => e.id !== editingEnvId);
      if (state.activeEnvId === editingEnvId) state.activeEnvId = null;
      editingEnvId = state.environments[0] && state.environments[0].id;
      renderEnvList();
      renderEnvEdit();
      renderEnvSelect();
      persistStore();
    });
    $('#envSaveBtn').addEventListener('click', () => $('#envModal').classList.add('hidden'));
    $('#envCloseBtn').addEventListener('click', () => $('#envModal').classList.add('hidden'));

    // Code modal
    $('#codeLang').addEventListener('change', updateCodeOutput);
    $('#copyCodeBtn').addEventListener('click', () => {
      navigator.clipboard.writeText($('#codeOutput').textContent).then(() => toast('Copied', '', 'success'));
    });
    $('#codeCloseBtn').addEventListener('click', () => $('#codeModal').classList.add('hidden'));

    // Import / export
    $('#exportBtn').addEventListener('click', exportData);
    $('#importBtn').addEventListener('click', () => $('#importFile').click());
    $('#importFile').addEventListener('change', (e) => {
      if (e.target.files[0]) importData(e.target.files[0]);
      e.target.value = '';
    });

    // Backdrop click closes modals
    $$('.modal-backdrop').forEach((m) =>
      m.addEventListener('click', (e) => {
        if (e.target === m) m.classList.add('hidden');
      })
    );

    // Divider drag (resize request/response split)
    setupDivider();
  }

  function setupDivider() {
    const divider = $('#divider');
    const reqPane = $('#requestPane');
    let dragging = false;
    divider.addEventListener('mousedown', () => {
      dragging = true;
      document.body.style.userSelect = 'none';
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const main = $('.main').getBoundingClientRect();
      const top = e.clientY - main.top - 44; /* approx tabbar height */
      const h = Math.max(120, Math.min(top, main.height - 160));
      reqPane.style.flex = '0 0 ' + h + 'px';
    });
    window.addEventListener('mouseup', () => {
      dragging = false;
      document.body.style.userSelect = '';
    });
  }

  // ── Init ────────────────────────────────────────────────────────────────
  async function init() {
    bindEvents();

    // Hydrate from THIS browser's localStorage (never from the server).
    const list = (v) => (Array.isArray(v) ? v : []);
    try {
      const store = JSON.parse(localStorage.getItem(STORE_KEY)) || {};
      state.collections = list(store.collections).map((c) => normalizeCollection(c));
      state.environments = list(store.environments).map((e) => normalizeEnvironment(e));
      state.history = list(store.history).map((h) => normalizeHistoryItem(h));
    } catch (_e) {
      /* start empty */
    }

    // Restore open tabs (or create a sample request the first time).
    let restored = null;
    try {
      restored = JSON.parse(localStorage.getItem(TABS_KEY));
    } catch (_e) {}
    const restoredTabs = list(restored && restored.tabs)
      .filter((t) => t && typeof t === 'object')
      .map((t) => ({
        id: str(t.id) || uid(),
        name: str(t.name) || 'Untitled Request',
        dirty: !!t.dirty,
        collectionId: t.collectionId ? str(t.collectionId) : null,
        requestId: t.requestId ? str(t.requestId) : null,
        request: normalizeRequest(t.request),
        response: null,
      }));

    if (restoredTabs.length) {
      state.tabs = restoredTabs;
      state.activeTabId = restoredTabs.some((t) => t.id === restored.activeTabId)
        ? restored.activeTabId
        : restoredTabs[0].id;
      state.activeEnvId = state.environments.some((e) => e.id === restored.activeEnvId) ? restored.activeEnvId : null;
    } else {
      const sample = newRequest({
        method: 'GET',
        url: 'https://jsonplaceholder.typicode.com/todos/1',
      });
      state.tabs = [newTab(sample, { name: 'Sample — Get a todo' })];
      state.activeTabId = state.tabs[0].id;
    }

    renderEnvSelect();
    renderCollections();
    renderHistory();
    renderTabBar();
    loadEditorFromTab();

    // When this copy has a password, show a "Sign out" button.
    window.RL_api
      .session()
      .then((session) => {
        if (!session || !session.auth) return;
        const form = $('#signOutForm');
        form.hidden = false;
        if (session.user) form.title = 'Signed in as ' + session.user;
      })
      .catch(() => {});
  }

  init();
})();
