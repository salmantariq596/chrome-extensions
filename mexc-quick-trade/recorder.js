/* MEXC Quick Trade — data recorder (diagnostic, read-only)
 * Runs inside the MEXC page. It only LISTENS to data the page already receives (WebSocket messages and
 * order/position API responses). It sends nothing anywhere: the recording stays in memory until you press
 * "Stop & save", which downloads a file on your computer.
 * Logins, tokens, signatures, user/account ids, emails and phone numbers are removed; order/position ids are
 * replaced by neutral labels (id1, id2…) so events can still be linked to each other.
 * Off until you press "Record MEXC data" in the panel.
 */
(() => {
  'use strict';
  if (window.__mqrLoaded) return;
  window.__mqrLoaded = true;

  const LIMIT_PER_KIND = 40;          // samples kept per channel / endpoint
  const LIMIT_TOTAL = 4000;
  const RELEVANT = /personal|order|position|posi|plan|stop|trigger|tpsl|profit|loss|fill|trade|liquidat|asset|wallet|balance/i;
  const SENSITIVE = /token|sign|secret|apikey|api_key|auth|cookie|session|passw|email|phone|mobile|^uid$|userid|user_id|memberid|member_id|accountid|account_id|deviceid|device_id|^ip$|address|nickname|realname|idcard/i;
  const ID_KEY = /^id$|_id$|[a-z]Id$|^(orderid|positionid|planid|stopid|tradeid|dealid|clientoid|externaloid)$/;   // case-sensitive on purpose (not 'bid', 'paid')

  let rec = null;
  const labels = new Map();
  const label = v => { const k = String(v); if (!labels.has(k)) labels.set(k, 'id' + (labels.size + 1)); return labels.get(k); };

  function scrub(v, key = '', depth = 0) {
    if (depth > 10) return '…';
    if (SENSITIVE.test(key)) return '[removed]';
    if (v === null || typeof v === 'boolean') return v;
    if (typeof v === 'number') return ID_KEY.test(key) && Math.abs(v) > 99999 ? label(v) : v;
    if (typeof v === 'string') {
      if (ID_KEY.test(key)) return label(v);
      if (/^[A-Za-z0-9+/=_-]{32,}$/.test(v)) return '[long-string]';
      return v.length > 80 ? v.slice(0, 40) + `…[${v.length}]` : v;
    }
    if (Array.isArray(v)) {
      const out = v.slice(0, 6).map(x => scrub(x, key, depth + 1));
      if (v.length > 6) out.push(`…+${v.length - 6} more`);
      return out;
    }
    if (typeof v === 'object') {
      const o = {};
      for (const [k, x] of Object.entries(v)) o[k] = scrub(x, k, depth + 1);
      return o;
    }
    return typeof v;
  }

  const now = () => (rec ? Date.now() - rec.t0 : 0);
  const kindOf = (obj, text) => {
    if (obj && typeof obj === 'object') {
      const c = obj.channel || obj.topic || obj.c || obj.ch || obj.method || obj.event || obj.e || obj.type || obj.op;
      if (c) return String(c).slice(0, 60);
    }
    return text && text.length < 30 ? 'text:' + text : 'unnamed';
  };

  const count = kind => { rec.counts[kind] = (rec.counts[kind] || 0) + 1; };
  function keep(list, kind, item) {
    if (rec.items >= LIMIT_TOTAL) return;
    if ((rec.kept[kind] || 0) >= LIMIT_PER_KIND) return;
    rec.kept[kind] = (rec.kept[kind] || 0) + 1;
    rec.items++;
    list.push(item);
  }

  function onText(host, dir, text) {
    let obj = null;
    try { obj = JSON.parse(text); } catch (_) {}
    const kind = `${host} ${dir} ${kindOf(obj, text)}`;
    const relevant = dir === 'out' || RELEVANT.test(kind) || (text.length < 20000 && RELEVANT.test(text.slice(0, 3000)) && !/push\.(deal|depth|ticker|kline)|sub\.(deal|depth|ticker|kline)/.test(text.slice(0, 200)));
    count(kind);
    if (!relevant) return;
    keep(rec.ws, kind, { t: now(), host, dir, kind, data: obj ? scrub(obj) : (text.length > 300 ? text.slice(0, 300) + '…' : text) });
  }

  function onBinary(host, dir, buf) {
    const bytes = new Uint8Array(buf);
    const head = Array.from(bytes.slice(0, 24)).map(b => b.toString(16).padStart(2, '0')).join(' ');
    let ascii = '';
    for (const b of bytes.slice(0, 400)) ascii += b >= 32 && b < 127 ? String.fromCharCode(b) : '.';
    const relevant = RELEVANT.test(ascii);
    const kind = `${host} ${dir} binary${relevant ? ' (mentions orders/positions)' : ''}`;
    count(kind);
    if (!relevant && (rec.kept[kind] || 0) >= 5) return;
    keep(rec.ws, kind, { t: now(), host, dir, kind, bytes: bytes.length, head, ascii: ascii.replace(/\.{3,}/g, '…').slice(0, 300) });
  }

  // ---------------------------------------------------------------- live prices for the bot
  // The page's own trade/ticker messages (push.deal, push.ticker) also arrive when the tab is in the background, unlike
  // the bot's timers. Each batch's lowest and highest price goes to the panel, so short spikes are never missed.
  function prices(text) {
    if (text.length > 200000 || !/push\.(deal|ticker)/.test(text.slice(0, 120))) return;
    const m = JSON.parse(text);
    const sym = m.symbol || (m.data && m.data.symbol);
    let ps = [];
    if (m.channel === 'push.deal') ps = (Array.isArray(m.data) ? m.data : [m.data]).map(d => d && +d.p);
    else if (m.channel === 'push.ticker' && m.data) ps = [+m.data.lastPrice];
    ps = ps.filter(x => x > 0);
    if (!sym || !ps.length) return;
    window.postMessage({ __mqr: 'px', sym, lo: Math.min(...ps), hi: Math.max(...ps), last: ps[ps.length - 1] }, '*');
  }

  // ---------------------------------------------------------------- WebSocket
  const NativeWS = window.WebSocket;
  function WrappedWS(url, protocols) {
    const ws = protocols === undefined ? new NativeWS(url) : new NativeWS(url, protocols);
    let host = '?';
    try { host = new URL(url, location.href).host; } catch (_) {}
    ws.addEventListener('message', ev => {
      try { if (typeof ev.data === 'string') prices(ev.data); } catch (_) {}
      if (!rec) return;
      try {
        const d = ev.data;
        if (typeof d === 'string') onText(host, 'in', d);
        else if (d instanceof ArrayBuffer) onBinary(host, 'in', d);
        else if (d instanceof Blob) d.arrayBuffer().then(b => rec && onBinary(host, 'in', b)).catch(() => {});
      } catch (_) {}
    });
    const send = ws.send;
    ws.send = function (d) {
      try { if (rec) { if (typeof d === 'string') onText(host, 'out', d); else if (d instanceof ArrayBuffer) onBinary(host, 'out', d); } } catch (_) {}
      return send.apply(this, arguments);
    };
    return ws;
  }
  WrappedWS.prototype = NativeWS.prototype;
  for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) WrappedWS[k] = NativeWS[k];
  window.WebSocket = WrappedWS;

  // ---------------------------------------------------------------- HTTP (fetch + XHR), order/position endpoints only
  const cleanUrl = u => {
    try { const x = new URL(u, location.href); return x.host + x.pathname + (x.search ? '?' + [...x.searchParams.keys()].join('&') : ''); }
    catch (_) { return String(u).split('?')[0]; }
  };
  function onHttp(via, method, url, status, text) {
    if (!rec) return;
    const path = cleanUrl(url);
    if (!RELEVANT.test(path)) return;
    let obj = null;
    try { obj = JSON.parse(text); } catch (_) {}
    count(`${method} ${path}`);
    keep(rec.http, `${method} ${path}`, { t: now(), via, method, path, status, data: obj ? scrub(obj) : String(text || '').slice(0, 200) });
  }

  const nativeFetch = window.fetch;
  window.fetch = function (input, init) {
    const p = nativeFetch.apply(this, arguments);
    if (rec) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const method = (init && init.method) || (input && input.method) || 'GET';
      p.then(res => { if (rec && RELEVANT.test(url)) res.clone().text().then(t => onHttp('fetch', method, url, res.status, t)).catch(() => {}); }).catch(() => {});
    }
    return p;
  };

  const XO = XMLHttpRequest.prototype.open, XS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) { this.__mqr = { method, url: String(url) }; return XO.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function () {
    if (rec && this.__mqr && RELEVANT.test(this.__mqr.url)) {
      this.addEventListener('load', () => { try { onHttp('xhr', this.__mqr.method, this.__mqr.url, this.status, typeof this.response === 'string' ? this.response : this.responseText); } catch (_) {} });
    }
    return XS.apply(this, arguments);
  };

  // ---------------------------------------------------------------- control (from the panel)
  window.addEventListener('message', e => {
    if (e.source !== window || !e.data || e.data.__mqr !== 'cmd') return;
    const reply = (type, payload) => window.postMessage({ __mqr: 'reply', type, payload }, '*');
    if (e.data.cmd === 'start') {
      rec = { t0: Date.now(), ws: [], http: [], counts: {}, kept: {}, items: 0 };
      labels.clear();
      reply('status', { on: true, items: 0, kinds: 0 });
    } else if (e.data.cmd === 'status') {
      reply('status', rec ? { on: true, items: rec.items, kinds: Object.keys(rec.kept).length, secs: Math.round(now() / 1000) } : { on: false });
    } else if (e.data.cmd === 'stop') {
      if (!rec) return reply('data', null);
      const out = {
        tool: 'MEXC Quick Trade recorder 1.0', page: location.host + location.pathname,
        started: new Date(rec.t0).toISOString(), seconds: Math.round(now() / 1000),
        note: 'Tokens, signatures, user/account ids, emails and phones removed. Order/position ids replaced by id1, id2…',
        counts: rec.counts, websocket: rec.ws, http: rec.http,
      };
      rec = null;
      reply('data', JSON.stringify(out, null, 1));
    }
  });
})();
