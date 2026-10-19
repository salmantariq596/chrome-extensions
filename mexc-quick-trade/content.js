/* MEXC Quick Trade v8.0 — content script
 * Single tab: one limit order (Long/Short) with Entry / TP / SL. Manual fills, Auto places.
 * Grid tab: up to 8 grids at the same time, long and short ("+ New grid"). Every level is a limit entry with its own TP
 *   (entry ± TP gap, or any value set per level) and the grid's SL attached; its loop is linked to that TP.
 *   When a level fills, the next level is placed. When a level's TP is hit, that level is placed again.
 *   SL hit stops the grid. Stop cancels waiting entries; filled levels keep their TP/SL on MEXC.
 */
(() => {
  'use strict';
  if (window.__mqlLoaded) return;
  window.__mqlLoaded = true;

  // ================================================================ config
  const WS_URL = 'wss://contract.mexc.com/edge';      // MEXC public futures feed (no API key, no fees)
  const TESTNET = /testnet/i.test(location.hostname);  // demo prices differ from the real market
  const DEFAULTS = { side: 'long', tab: 'grid', quantity: 20, mode: 'manual', tpsl: true,
                     margin: 'Isolated', pos: null };

  let cfg = { ...DEFAULTS };
  const st = { sym: null, last: null, lastAt: 0, feedAt: 0, pageAt: 0, src: '', dec: null, busy: false, dead: false };
  let grids = [];                                           // grid bots (v9: activation price, long + short per level)
  let gridSeq = 0;                                          // grid numbers #1, #2 …
  // per side: what the bot knows about MEXC's position. k = position size per 1 USDT of order amount (learned on the first fill)
  const TRK0 = { k: null, hi: null, lo: null, seenV: null, seenN: 0, unread: 0, blind: false, bad: false, badMsg: '', recQ: false, auditAt: 0, auditQ: false };
  const trk = { long: { ...TRK0 }, short: { ...TRK0 } };
  let ui = null;
  const gridOn = () => grids.some(g => g.phase !== 'off');
  const curSide = () => cfg.side || 'long';

  // ================================================================ extension context + storage
  let timer = null;
  const alive = () => { try { return !!(chrome.runtime && chrome.runtime.id); } catch (_) { return false; } };
  function markDead() {
    if (st.dead) return;
    st.dead = true;
    clearInterval(timer);
    try { ws && ws.close(); } catch (_) {}
    if (ui) {
      ui.sh.querySelectorAll('button,input').forEach(el => { if (!el.classList.contains('min')) el.disabled = true; });
      status('The extension was updated or reloaded. Refresh this page (F5) to use it.', 'err');
    }
  }
  function storeGet(key, cb) {
    if (!alive()) return markDead();
    try { chrome.storage.local.get(key, d => cb((d && d[key]) || null)); } catch (_) { markDead(); }
  }
  function storeSet(key, val, cb) {
    if (!alive()) return markDead();
    try { chrome.storage.local.set({ [key]: val }, () => cb && cb()); } catch (_) { markDead(); }
  }

  // ================================================================ log (Copy log button)
  const LOG = [];
  function log(msg) {
    const t = new Date().toTimeString().slice(0, 8);
    LOG.push(`${t} ${msg}`);
    if (LOG.length > 300) LOG.shift();
    try { console.log('[QuickLong]', msg); } catch (_) {}
  }

  // ================================================================ helpers
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const num = s => { const m = String(s ?? '').replace(/,/g, '').match(/\d+(?:\.\d+)?/); return m ? parseFloat(m[0]) : NaN; };
  const signedNum = s => { const m = String(s ?? '').replace(/,/g, '').replace(/[−–]/g, '-').match(/[-+]?\d+(?:\.\d+)?/); return m ? parseFloat(m[0]) : NaN; };
  const decs = s => { const m = String(s ?? '').replace(/,/g, '').match(/\.(\d+)/); return m ? m[1].length : 0; };
  const visible = el => !!el && el.isConnected && el.getClientRects().length > 0;
  const getSymbol = () => { const m = location.href.match(/([A-Z0-9]+)_USDT/i); return m ? m[1].toUpperCase() + '_USDT' : null; };
  const isFuturesPage = () => /futures/i.test(location.href) && !!getSymbol();
  const fmt = n => { const d = st.dec ?? 2; return (Math.round(n * 10 ** d) / 10 ** d).toFixed(d); };
  const cleanNum = s => String(s ?? '').replace(/,/g, '').trim();
  const norm = s => String(s ?? '').replace(/\s+/g, ' ').trim();
  const rect = el => el.getBoundingClientRect();
  const samePrice = (a, b) => Math.abs(a - b) <= Math.max(10 ** -(st.dec ?? 2) / 2, Math.abs(b) * 1e-7) + 1e-9;

  function textEls(re, root = document.body) {
    const out = [];
    if (!root) return out;
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) {
      const t = n.nodeValue.trim();
      if (t && t.length < 60 && re.test(t) && visible(n.parentElement)) out.push(n.parentElement);
    }
    return out;
  }

  // ---- speed: MEXC's page holds tens of thousands of texts (order book, trades), so one search through all of them costs
  // several ms. Elements found once are remembered and only re-checked (still on the page, same text) on later looks.
  const memo = new Map();
  function remember(key, check, find) {
    const c = memo.get(key);
    if (c) { try { if (check(c)) return c; } catch (_) {} }
    const v = find();
    if (v) memo.set(key, v); else memo.delete(key);
    return v;
  }
  function lca(a, b) {                                       // smallest element that contains both
    if (!a || !b) return null;
    const up = new Set();
    for (let p = a; p; p = p.parentElement) up.add(p);
    for (let p = b; p; p = p.parentElement) if (up.has(p)) return p;
    return null;
  }

  async function waitFor(fn, ms = 800, step = 10) {
    const end = performance.now() + ms;
    while (performance.now() < end) { const v = await fn(); if (v) return v; await sleep(step); }
    return fn();
  }

  function setValue(input, v) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    input.focus();
    setter.call(input, String(v));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.blur();
  }

  // works for SVG icons too (they have no .click())
  function clickEl(el) {
    const o = { bubbles: true, cancelable: true, view: window };
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup'].forEach(t =>
      el.dispatchEvent(new (t.startsWith('pointer') && window.PointerEvent ? PointerEvent : MouseEvent)(t, o)));
    el.dispatchEvent(new MouseEvent('click', o));
  }

  // ================================================================ sounds
  let actx = null;
  // Chrome lets a page start sound only after the user clicked or pressed a key on it (autoplay rule). Before that the
  // bot doesn't create its sound player (no warning in the console); alerts still show and pop up as notifications.
  const userActive = () => (navigator.userActivation ? navigator.userActivation.hasBeenActive : !!actx);
  function unlockAudio() {
    if (!userActive()) return;
    try { actx = actx || new AudioContext(); if (actx.state === 'suspended') actx.resume(); } catch (_) {}
  }
  const audioReady = () => !!actx && actx.state === 'running';
  for (const ev of ['pointerdown', 'keydown']) document.addEventListener(ev, () => { unlockAudio(); if (ui) render(); }, true);
  const SOUNDS = {
    entry: [[660, .12], [880, .2]],
    tp:    [[784, .1], [988, .1], [1319, .25]],
    sl:    [[440, .2], [330, .35]],
    stop:  [[523, .15], [392, .15], [262, .4]],
    error: [[220, .25], [220, .25], [220, .25]],
    info:  [[880, .08]],
    alarm: [[880, .18], [440, .18], [880, .18], [440, .18], [880, .3]],
  };
  function sound(name) {
    try {
      unlockAudio();
      if (!actx) return;                                     // no click on the page yet: Chrome doesn't allow sound
      let t = actx.currentTime + 0.02;
      for (const [f, d] of SOUNDS[name]) {
        const o = actx.createOscillator(), g = actx.createGain();
        o.type = 'sine'; o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.3, t + 0.015);
        g.gain.exponentialRampToValueAtTime(0.0001, t + d);
        o.connect(g).connect(actx.destination);
        o.start(t); o.stop(t + d + 0.03);
        t += d + 0.06;
      }
    } catch (_) {}
  }

  // ================================================================ alerts
  // Every important event goes to: the Alerts list (kept after a refresh, also shown in viewer windows), a sound by
  // importance, an optional Windows/Mac notification, and — for critical ones — a red banner with an alarm that repeats
  // until you press "Seen". Levels: note (list only) · info · good · warn · crit.
  const ALV = { note: 0, info: 1, good: 2, warn: 3, crit: 4 };
  const A_SOUND = { info: 'info', good: 'tp', warn: 'sl', crit: 'alarm' };
  const A_DEF = { desktop: true, dInfo: false, dGood: true, dWarn: true, dCrit: true, sound: true, farPct: 1 };
  const aCfg = () => ({ ...A_DEF, ...((cfg && cfg.alerts) || {}) });
  let alerts = [], alertSeq = 0, alarmTimer = null, alertsLoaded = false;
  function alertUser(level, msg, opt = {}) {
    const a = { id: Date.now().toString(36) + '-' + (alertSeq++) + Math.random().toString(36).slice(2, 4), t: Date.now(), level, msg,
                bot: opt.bot || null, ack: level !== 'crit', read: false };
    alerts.unshift(a);
    if (alerts.length > 300) alerts.length = 300;
    log(`[alert ${level}] ${opt.bot ? '#' + opt.bot + ' ' : ''}${msg}`);
    const c = aCfg();
    if (c.sound && A_SOUND[level] && !opt.silent) sound(A_SOUND[level]);
    if (c.desktop && { info: c.dInfo, good: c.dGood, warn: c.dWarn, crit: c.dCrit }[level]) notifyDesktop(level, msg, opt.bot);
    if (level === 'crit') startAlarm();
    saveAlerts();
    if (ui) render();
    return a;
  }
  function notifyDesktop(level, msg, bot) {
    try {
      const title = { info: 'Quick Trade', good: 'Quick Trade ✓', warn: 'Quick Trade ⚠', crit: '⛔ Quick Trade — action needed' }[level] + (bot ? ` · bot #${bot}` : '');
      chrome.runtime.sendMessage({ mq: 'notify', level, title, message: msg.slice(0, 300) }, () => void chrome.runtime.lastError);
    } catch (_) {}
  }
  const unacked = () => alerts.filter(a => !a.ack);
  function startAlarm() {
    if (alarmTimer) return;
    alarmTimer = setInterval(() => {
      if (!unacked().length) { clearInterval(alarmTimer); alarmTimer = null; return; }
      if (aCfg().sound) sound('alarm');
    }, 15000);
  }
  function ackAll() {
    alerts.forEach(a => { a.ack = true; });
    clearInterval(alarmTimer); alarmTimer = null;
    saveAlerts(); render();
  }
  let alertSaveT = 0;
  function saveAlerts() {
    clearTimeout(alertSaveT);
    alertSaveT = setTimeout(() => storeSet('mqlAlerts', alerts.slice(0, 200)), 300);
  }
  function mergeAlerts(list) {                               // from storage (other window or after a refresh)
    if (!Array.isArray(list)) return;
    const mine = new Map(alerts.map(a => [a.id, a]));
    for (const a of list) {
      const m = mine.get(a.id);
      if (!m) mine.set(a.id, a);
      else { m.ack = m.ack || a.ack; m.read = m.read || a.read; }
    }
    alerts = [...mine.values()].sort((a, b) => b.t - a.t).slice(0, 300);
    if (unacked().length) startAlarm();
  }

  // ================================================================ MEXC order form
  const sideWord = side => side === 'short' ? 'Short' : 'Long';
  const openRe = side => side === 'short' ? /^Open Short$/i : /^Open Long$/i;
  function findForm(side = curSide(), action = 'open') {
    const re = action === 'close' ? (side === 'short' ? /^Close Short$/i : /^Close Long$/i) : openRe(side);
    return remember(`form:${side}:${action}`,
      f => f.label.isConnected && f.root.isConnected && f.btn.contains(f.label) && f.root.contains(f.btn) && visible(f.btn) &&
           re.test(norm(f.label.textContent)) && !!f.root.querySelector('input'),
      () => findFormNow(side, action));
  }
  function findFormNow(side, action) {
    // prefer real buttons: MEXC's order lists also show words like "Close Long" in their rows
    const labels = textEls(action === 'close' ? (side === 'short' ? /^Close Short$/i : /^Close Long$/i) : openRe(side));
    const label = labels.find(el => el.closest('button,[role="button"]')) ||
                  labels.find(el => !el.closest('tr,[class*="row" i],[class*="table" i]'));
    if (!label) throw new Error(`"${action === 'close' ? 'Close' : 'Open'} ${sideWord(side)}" button not found on MEXC's order panel.`);
    const btn = label.closest('button,[role="button"]') || label;
    let root = btn.parentElement;
    for (let i = 0; i < 15 && root; i++, root = root.parentElement) {
      if (root.querySelector('input') && /Quantity/i.test(root.textContent)) break;
    }
    if (!root) throw new Error('Order form not found on this page.');
    return { btn, root, label };
  }

  const wideMemo = new WeakMap();
  function wideRoot(root) {
    const c = wideMemo.get(root);
    if (c && c.isConnected && c.contains(root)) return c;
    const w = wideRootNow(root);
    wideMemo.set(root, w);
    return w;
  }
  function wideRootNow(root) {
    let p = root;
    for (let i = 0; i < 6 && p.parentElement; i++) {
      if (/Isolated|Cross/i.test(p.textContent) && /\d+\s*[xX×]/.test(p.textContent)) return p;
      p = p.parentElement;
    }
    return p;
  }

  const isTextInput = x => !/checkbox|radio|range|hidden/i.test(x.type) && visible(x);
  const textInputs = root => [...root.querySelectorAll('input')].filter(isTextInput);

  function inputNear(el, exclude = []) {
    for (let p = el, i = 0; p && i < 6; p = p.parentElement, i++) {
      const inp = [...p.querySelectorAll('input')].find(x => !exclude.includes(x) && isTextInput(x));
      if (inp) return inp;
    }
    return null;
  }

  function findTrigInput(root) {
    const lab = textEls(/^Trigger Price/i, root)[0];
    return (lab && inputNear(lab)) || null;
  }

  function findPriceInput(root, exclude = []) {
    const lab = textEls(/^Price(\s*\(.*\))?$/i, root)[0];
    return (lab && inputNear(lab, exclude)) || null;
  }

  function findQtyInput(root, exclude) {
    const lab = textEls(/^Quantity/i, root)[0];
    if (!lab) return null;
    const input = inputNear(lab, exclude);
    const usdt = /USDT/i.test((lab.parentElement || lab).textContent);
    return input ? { input, usdt } : null;
  }

  // leverage the bot expects for a side: a running grid keeps the leverage it was started with
  const wantLev = () => null;                               // v9: no leverage setting — the bot uses whatever MEXC shows
  function readSetup(root, side = curSide()) {
    const w = wideRoot(root);
    const levEl = textEls(/^\d+(\.\d+)?\s*[xX×]$/, w)[0];
    const lev = levEl ? num(levEl.textContent) : null;
    const margin = textEls(/^Isolated$/i, w).length ? 'Isolated' : textEls(/^Cross$/i, w).length ? 'Cross' : null;
    let block = null;
    const want = wantLev(side);
    if (want && lev && lev !== want) block = `MEXC shows ${lev}x leverage, but the panel is set to ${want}x. Change one of them so they match.`;
    else if (margin && margin !== cfg.margin) block = `Margin mode is ${margin}, expected ${cfg.margin}. Change it on MEXC first.`;
    return { lev, margin, block };
  }

  // ----- TP/SL on MEXC's form
  function findTpslToggle(root) {
    const lab = textEls(/^TP\s*\/\s*SL$/i, root)[0];
    if (!lab) return null;
    let cb = null;
    for (let p = lab, i = 0; p && i < 4 && !cb; p = p.parentElement, i++) cb = p.querySelector('input[type="checkbox"],[role="checkbox"]');
    return { lab, cb };
  }

  function clickToggle(t) {
    if (t.cb) t.cb.click();
    else (t.lab.closest('label') || t.lab).click();
  }

  function findTpslInputs(root, exclude, appeared = []) {
    const pool = textInputs(root).filter(x => !exclude.includes(x));
    const byPh = re => pool.find(x => re.test(x.placeholder || '') || re.test(x.getAttribute('aria-label') || ''));
    const byLabel = (re, ex) => { const lab = textEls(re, root)[0]; return lab ? inputNear(lab, ex) : null; };
    let tp = byPh(/take[\s-]*profit|\bTP\b/i) || byLabel(/^(Take[\s-]*Profit|TP)(?!\s*\/)/i, exclude);
    let sl = byPh(/stop[\s-]*loss|\bSL\b/i) || byLabel(/^(Stop[\s-]*Loss|SL)\b/i, [...exclude, tp].filter(Boolean));
    if ((!tp || !sl || tp === sl) && appeared.length >= 2) [tp, sl] = appeared;
    if ((!tp || !sl || tp === sl) && pool.length === 2) [tp, sl] = pool;
    return tp && sl && tp !== sl ? { tp, sl } : null;
  }

  async function syncTpsl(form, want) {
    const exclude = [form.price, form.qty, form.trig].filter(Boolean);
    const t = findTpslToggle(form.root);
    let boxes = findTpslInputs(form.root, exclude);
    if (want) {
      if (!t && !boxes) throw new Error('TP/SL checkbox not found on MEXC.');
      if (!boxes) {
        const before = new Set(textInputs(form.root));
        clickToggle(t);
        boxes = await waitFor(() => {
          const appeared = textInputs(form.root).filter(x => !before.has(x) && !exclude.includes(x));
          return findTpslInputs(form.root, exclude, appeared);
        }, 800);
        if (!boxes) throw new Error('TP/SL boxes did not appear on MEXC. Tick TP/SL on MEXC once and press Check page.');
      }
      return boxes;
    }
    if (boxes && t) {
      clickToggle(t);
      await waitFor(() => !findTpslInputs(form.root, exclude), 600);
      if (findTpslInputs(form.root, exclude)) throw new Error('Could not turn off TP/SL on MEXC. Untick it there.');
    }
    return null;
  }

  const onTriggerForm = r => textEls(/^Trigger Price/i, r).length > 0;
  function formIs(kind) {
    try {
      const r = findForm().root;
      return kind === 'Trigger' ? !!findTrigInput(r) : (!!findPriceInput(r) && !onTriggerForm(r));
    } catch (_) { return false; }
  }

  // Switches MEXC's order tab (Limit / Trigger). Tries the tab, its parent, and a dropdown option.
  async function switchOrderTab(kind, root) {
    if (formIs(kind)) return;
    const area = wideRoot(root);
    const re = kind === 'Trigger' ? /^Trigger$/i : /^Limit$/i;
    const tab = textEls(re, area)[0] || textEls(kind === 'Trigger' ? /^Trigger\b/i : /^Limit\b/i, area).find(el => !/Price|Order\s*\(/i.test(el.textContent));
    if (!tab) throw new Error(`${kind} tab not found on MEXC's order form.`);
    const targets = [tab, tab.closest('[role="tab"],button,li,a'), tab.parentElement].filter((x, i, a) => x && a.indexOf(x) === i);
    log(`tab: switching to ${kind}, found "${norm(tab.textContent)}" <${tab.tagName.toLowerCase()} class="${typeof tab.className === 'string' ? tab.className : ''}">`);
    for (const t of targets) {
      clickEl(t);
      log(`tab: clicked <${t.tagName.toLowerCase()}>`);
      if (await waitFor(() => formIs(kind), 700, 30)) return;
      if (kind === 'Trigger') {                           // "Trigger ▾" may open a small menu
        const opt = textEls(/^Trigger(\s*Order)?$/i).find(el => el !== tab && !tab.contains(el) && !el.contains(tab));
        if (opt) {
          log(`tab: menu option "${norm(opt.textContent)}" clicked`);
          clickEl(opt.closest('[role="menuitem"],li,button') || opt);
          if (await waitFor(() => formIs(kind), 700, 30)) return;
        }
      }
    }
    throw new Error(`Clicked "${norm(tab.textContent)}" but MEXC did not show the ${kind} form.`);
  }

  // kind: 'Limit' or 'Trigger'. Returns the form's boxes and button, after safety checks.
  const isBefore = (a, b) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

  // Trigger form's "Price (USDT)" row. With Market selected MEXC may show text instead of a box,
  // so the box is optional: only an input between the Price label and the Quantity label counts.
  function findTriggerPriceRow(root, trig) {
    const lab = textEls(/^Price(\s*\(.*\))?$/i, root)[0];
    if (!lab) return { lab: null, input: null };
    const qLab = textEls(/^Quantity/i, root)[0];
    const inp = inputNear(lab, [trig].filter(Boolean));
    const ok = inp && isBefore(lab, inp) && (!qLab || isBefore(inp, qLab));
    return { lab, qLab, input: ok ? inp : null };
  }

  // kind: 'Limit' or 'Trigger'. Returns the form's boxes and button, after safety checks.
  async function prepareForm(kind = 'Limit', side = curSide()) {
    await switchOrderTab(kind, findForm(side).root);
    const x = findForm(side);
    const trig = kind === 'Trigger' ? findTrigInput(x.root) : null;
    if (kind === 'Trigger' && !trig) throw new Error('Trigger Price box not found on MEXC.');
    let price, priceLab = null;
    if (kind === 'Trigger') {
      const row = findTriggerPriceRow(x.root, trig);
      if (!row.lab) throw new Error('"Price (USDT)" not found in MEXC\'s Trigger form.');
      price = row.input;
      priceLab = row.lab;
    } else {
      price = findPriceInput(x.root);
      if (!price) throw new Error('Price box not found in MEXC\'s Limit form.');
    }
    const f = { ...x, price, priceLab, trig };
    const setup = readSetup(f.root, side);
    if (setup.block) throw new Error(setup.block);
    const q = findQtyInput(f.root, [f.price, f.trig].filter(Boolean));
    if (!q) throw new Error('Quantity box not found on MEXC.');
    if (!q.usdt) throw new Error('MEXC quantity unit is not USDT. Switch Quantity to USDT on MEXC.');
    return { root: f.root, btn: f.btn, price: f.price, priceLab, trig: f.trig, qty: q.input };
  }

  // Trigger form: is the order price set to Market?
  function triggerIsMarket(form) {
    const root = form.root.isConnected ? form.root : findForm().root;
    const row = findTriggerPriceRow(root, form.trig);
    if (row.input && cleanNum(row.input.value)) return false;            // a limit price is typed
    if (row.input && /best price|market/i.test(row.input.placeholder || '')) return true;
    return textEls(/best price/i, root).some(el => row.lab && isBefore(row.lab, el) && (!row.qLab || isBefore(el, row.qLab)));
  }

  async function ensureMarket(form) {
    if (triggerIsMarket(form)) return;
    const row = findTriggerPriceRow(form.root, form.trig);
    const btn = textEls(/^Market$/i, form.root).find(el => row.lab && isBefore(row.lab, el) && (!row.qLab || isBefore(el, row.qLab)));
    if (!btn) throw new Error('Market button not found next to "Price (USDT)" in the Trigger form.');
    log('trigger: clicking Market');
    clickEl(btn.closest('button,[role="button"]') || btn);
    if (!(await waitFor(() => triggerIsMarket(form), 700, 30))) throw new Error('Could not set the trigger order price to Market.');
  }

  const close = (a, b) => samePrice(num(a), num(b));
  function fieldsMatch(fields) { return fields.every(([el, v]) => el && el.isConnected && close(el.value, v)); }
  function writeFields(fields) { fields.forEach(([el, v]) => setValue(el, v)); }

  // Limit order (panel's Open long / Fill)
  async function fillLimit(o, side) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const form = await prepareForm('Limit', side);
      const boxes = await syncTpsl(form, o.tpsl);
      const fields = [[form.price, o.price], [form.qty, o.qty]];
      if (boxes) fields.push([boxes.tp, o.tp], [boxes.sl, o.sl]);
      writeFields(fields);
      await sleep(attempt ? 150 : 60);
      if (fieldsMatch(fields)) return form;
    }
    throw new Error('MEXC did not keep the values. Press Check page and send me the result.');
  }

  // ================================================================ MEXC bottom panel (positions / orders)
  function tabCount(name) {
    const re = new RegExp('^' + name + '\\s*\\((\\d+)\\)$', 'i');
    const el = remember('tab:' + name, t => visible(t) && re.test(norm(t.textContent)), () => {
      for (const e of textEls(new RegExp('^' + name + '(\\s*\\(\\d+\\))?$', 'i'))) {
        for (const t of [e, e.parentElement]) if (t && re.test(norm(t.textContent))) return t;
      }
      return null;
    });
    return el ? { el, n: parseInt(norm(el.textContent).match(re)[1], 10) } : null;
  }

  async function openBottomTab(name) {
    const t = tabCount(name) || (textEls(new RegExp('^' + name + '$', 'i'))[0] && { el: textEls(new RegExp('^' + name + '$', 'i'))[0] });
    if (!t) throw new Error(`"${name}" tab not found. Keep MEXC's bottom panel visible.`);
    clickEl(t.el);
    await sleep(350);
  }

  // Value printed next to a label, e.g. "Avg Entry Price  86,704.5"
  function valueNear(label, count = 1) {
    for (let p = label.parentElement, i = 0; p && i < 3; p = p.parentElement, i++) {
      const nums = (norm(p.textContent).replace(norm(label.textContent), '').match(/\d[\d,]*(?:\.\d+)?/g) || []).map(num);
      if (nums.length >= count) return nums.slice(0, count);
    }
    return null;
  }

  // Positions tab: entry price and TP/SL of the open position
  function readPosition() {
    let formRoot = null;
    try { formRoot = findForm().root; } catch (_) {}
    const outside = el => !formRoot || !formRoot.contains(el);
    const entryLab = textEls(/^Avg Entry Price$/i).find(outside);
    if (!entryLab) return null;
    const entryV = valueNear(entryLab, 1);
    if (!entryV) return null;
    const out = { entry: entryV[0], side: null };
    // position card: climb until it also holds "Unrealized PNL", then look for the L / S badge
    let card = entryLab;
    for (let i = 0; i < 8 && card.parentElement; i++) { card = card.parentElement; if (/Unrealized PNL/i.test(card.textContent)) break; }
    const badge = textEls(/^(L|S|Long|Short)$/, card)[0];
    if (badge) out.side = /^L/.test(norm(badge.textContent)) ? 'long' : 'short';
    const tpslLab = textEls(/^TP\s*\/\s*SL$/i).find(outside);
    const v = tpslLab && valueNear(tpslLab, 2);
    if (v) { out.tp = v[0]; out.sl = v[1]; }
    return out;
  }

  // Position History: newest row (entry, close price, realized PnL), located by column position
  function readHistoryTop() {
    const head = re => textEls(re)[0];
    const hClose = head(/^Avg Close Price$/i);
    if (!hClose) return null;
    const hy = rect(hClose).top;
    const hEntry = textEls(/^Avg Entry Price$/i).find(e => Math.abs(rect(e).top - hy) < 10);
    const hPnl = textEls(/^Realized PNL$/i).find(e => Math.abs(rect(e).top - hy) < 10);
    const cells = textEls(/\d/);
    const inCol = (h, e) => { const a = rect(h), b = rect(e); return b.top > a.bottom - 1 && b.left < a.right + 6 && b.right > a.left - 6; };
    const top = h => cells.filter(e => inCol(h, e)).sort((x, y) => rect(x).top - rect(y).top);
    const closeCell = top(hClose)[0];
    if (!closeCell) return null;
    const y = rect(closeCell).top;
    const atRow = h => h && top(h).find(e => Math.abs(rect(e).top - y) < 22);
    const e = atRow(hEntry), p = atRow(hPnl);
    return { close: num(closeCell.textContent), entry: e ? num(e.textContent) : NaN, pnl: p ? signedNum(p.textContent) : NaN };
  }

  // ================================================================ MEXC: Open / Close switch and Close form
  const closeRe = side => side === 'short' ? /^Close Short$/i : /^Close Long$/i;

  // the Open / Close pill sits at the top of the trade panel, above the Isolated / 20X row
  function findPill(re) {
    const anchors = textEls(/^(Isolated|Cross)$/i).sort((a, b) => rect(a).top - rect(b).top);
    const a = anchors[0];
    const cands = textEls(re).filter(el => {
      if (!a) return true;
      const r = rect(el), ar = rect(a);
      return r.top < ar.top + 2 && r.top > ar.top - 160 && r.left > ar.left - 120 && r.left < ar.left + 420;
    });
    return cands[0] || null;
  }

  async function switchAction(action, side = curSide()) {
    const ok = () => { try { findForm(side, action); return true; } catch (_) { return false; } };
    if (ok()) return;
    const pill = findPill(action === 'close' ? /^Close$/i : /^Open$/i);
    if (!pill) throw new Error(`"${action === 'close' ? 'Close' : 'Open'}" switch not found at the top of MEXC's order panel.`);
    log(`action: clicking "${norm(pill.textContent)}" pill`);
    clickEl(pill.closest('button,[role="tab"],[role="button"]') || pill);
    if (!(await waitFor(ok, 1200, 30))) {
      clickEl(pill);
      if (!(await waitFor(ok, 1200, 30))) throw new Error(`MEXC did not switch to the ${action === 'close' ? 'Close' : 'Open'} form.`);
    }
  }

  // Close form, Limit tab: returns price box, quantity box (must be USDT) and the Close button
  async function prepareClose(side) {
    await switchAction('close', side);
    let f = findForm(side, 'close');
    if (!findPriceInput(f.root) || onTriggerForm(f.root)) {
      const tab = textEls(/^Limit$/i, wideRoot(f.root))[0];
      if (!tab) throw new Error('Limit tab not found in MEXC\'s Close form.');
      clickEl(tab);
      await waitFor(() => { try { const x = findForm(side, 'close'); return findPriceInput(x.root) && !onTriggerForm(x.root); } catch (_) { return false; } }, 1200, 30);
      f = findForm(side, 'close');
    }
    const price = findPriceInput(f.root);
    if (!price) throw new Error('Price box not found in MEXC\'s Close form (Limit).');
    const q = findQtyInput(f.root, [price]);
    if (!q) throw new Error('Quantity box not found in MEXC\'s Close form.');
    if (!q.usdt) throw new Error('Close form quantity unit is not USDT. Switch it to USDT on MEXC (Close tab → Quantity ▾).');
    return { root: f.root, btn: f.btn, price, qty: q.input };
  }

  // ================================================================ MEXC: Open Orders → Limit Order rows
  const DIRS = {
    'open-long':   /Buy\s*Long|Open\s*Long/i,
    'close-long':  /Close\s*Long|Sell\s*Long/i,
    'open-short':  /Sell\s*Short|Open\s*Short/i,
    'close-short': /Close\s*Short|Buy\s*Short/i,
  };
  const dirKey = (action, side) => `${action}-${side}`;

  // Open Orders → "Limit Order (n)" / "Trigger Order (n)" sub-tab, and the part of the page that holds that list
  const subTab = name => remember('sub:' + name, el => visible(el) && new RegExp('^' + name, 'i').test(norm(el.textContent)),
    () => textEls(new RegExp('^' + name, 'i'))[0] || null);
  const subCount = name => { const el = subTab(name), m = el && norm(el.textContent).match(/\((\d+)\)/); return m ? +m[1] : null; };
  function listRoot(name) {
    const t = tabCount('Open Orders'), sub = subTab(name);
    let r = t && sub ? lca(t.el, sub) : null;
    for (let i = 0; r && i < 2 && r.parentElement && r.parentElement !== document.body; i++) r = r.parentElement;   // a little wider: the rows
    return r || document.body;
  }
  async function showLimitOrders() {
    const sub = () => subTab('Limit Order');
    if (!sub()) { await openBottomTab('Open Orders'); await waitFor(sub, 1000, 50); }
    const s = sub();
    if (!s) throw new Error('"Limit Order" list not found in MEXC\'s Open Orders.');
    clickEl(s);
    await sleep(250);
  }

  // one pass over the Limit Order list: [{ dir, nums, row }]
  function scanOrders() {
    const tab = tabCount('Open Orders');
    if (!tab || !subTab('Limit Order')) return null;
    const out = scanOrdersIn(listRoot('Limit Order'), tab);
    const n = subCount('Limit Order');
    return n != null && out.length < n ? scanOrdersIn(document.body, tab) : out;   // not all rows in that part: whole page
  }
  function scanOrdersIn(root, tab) {
    const floor = rect(tab.el).bottom;
    let formArea = null;
    try { formArea = wideRoot(findForm().root); } catch (_) {}
    const rows = new Map();
    for (const el of textEls(/^[\d,]+(\.\d+)?$/, root)) {
      if (rect(el).top <= floor || (formArea && formArea.contains(el))) continue;
      let row = el, dir = null;
      for (let i = 0; i < 8 && row.parentElement && !dir; i++) {
        row = row.parentElement;
        if (!row.querySelector('svg,img,i')) continue;
        const txt = row.textContent;
        const hits = Object.keys(DIRS).filter(k => DIRS[k].test(txt));
        if (hits.length === 1) dir = hits[0];
        else if (hits.length > 1) break;                    // climbed past a single row
      }
      if (!dir) continue;
      if (!rows.has(row)) rows.set(row, { dir, nums: [], row });
      rows.get(row).nums.push(num(el.textContent));
    }
    return [...rows.values()];
  }

  const findRow = (rows, key, price) => rows && rows.find(r => r.dir === key && r.nums.some(n => samePrice(n, price)));

  async function cancelOrder(key, price) {
    await showLimitOrders();
    const rows = await waitFor(() => scanOrders(), 1500, 100);
    if (!rows) throw new Error('could not read Open Orders → Limit Order');
    const r = findRow(rows, key, price);
    if (!r) return 'none';
    const icons = [...r.row.querySelectorAll('svg,img,i,[class*="icon" i],[class*="delete" i],[class*="trash" i]')]
      .filter(visible).filter(el => !el.parentElement || !el.parentElement.closest('svg'));
    const trash = icons[icons.length - 1];
    if (!trash) throw new Error('Cancel icon not found on the order row.');
    clickEl(trash.closest('button,[role="button"],a') || trash);
    await sleep(400);
    const ok = textEls(/^(Confirm|OK|Yes)$/i).find(el => el.closest('[role="dialog"],[class*="modal" i],[class*="dialog" i]'));
    if (ok) { clickEl(ok.closest('button') || ok); await sleep(300); }
    const gone = await waitFor(() => !findRow(scanOrders(), key, price), 3000, 100);
    if (!gone) throw new Error(`Order at ${price} is still listed after cancelling.`);
    return 'cancelled';
  }

  // ================================================================ live price
  function setLast(v, src) {
    const s = String(v);
    const n = num(s);
    if (!(n > 0)) return;
    if (src === 'live feed') st.feedAt = Date.now();
    else if (Date.now() - st.feedAt < 3000) return;
    if (src === 'page') st.pageAt = Date.now();
    else if (src === 'tab title' && Date.now() - st.pageAt < 3000) return;
    st.dec = Math.max(st.dec ?? 0, decs(s));
    if (n !== st.last) st.changeAt = Date.now();             // the health watch looks at real price changes
    st.last = n;
    st.lastAt = Date.now();
    st.src = src;
    if (iAmBot) trackRanges(n);                              // every price the bot hears counts, not only the 0.3 s checks
    render();
  }
  // MEXC's own trade/ticker stream (forwarded by recorder.js from the page): lowest and highest price of each batch.
  // It also arrives when the tab is in the background, when Chrome slows the bot's timer to once a second or less.
  let lastTickAt = 0;
  window.addEventListener('message', e => {
    if (e.source !== window || !e.data || e.data.__mqr !== 'px') return;
    const d = e.data;
    if (!st.sym || String(d.sym).toUpperCase() !== st.sym.toUpperCase() || !(d.lo > 0) || !(d.hi > 0)) return;
    if (iAmBot) { trackRanges(+d.lo); trackRanges(+d.hi); }
    setLast(String(d.last), 'live feed');
    if (Date.now() - lastTickAt > 1000) tick();              // keeps the bot working when the timer is slowed down
  });

  let ws = null, wsSym = null, wsFails = 0;
  function connectFeed() {
    const sym = getSymbol();
    if (!sym || !isFuturesPage() || TESTNET || st.dead) return;
    if (ws && wsSym === sym && ws.readyState <= 1) return;
    const old = ws;
    ws = null;
    try { old && old.close(); } catch (_) {}
    wsSym = sym;
    let sock, ping;
    try { sock = new WebSocket(WS_URL); } catch (_) { wsFails++; return; }
    ws = sock;
    sock.onopen = () => {
      wsFails = 0;
      sock.send(JSON.stringify({ method: 'sub.deal', param: { symbol: sym } }));
      sock.send(JSON.stringify({ method: 'sub.ticker', param: { symbol: sym } }));
      ping = setInterval(() => sock.readyState === 1 && sock.send('{"method":"ping"}'), 15000);
    };
    sock.onmessage = e => {
      try {
        const m = JSON.parse(e.data);
        if (!m.data || (m.symbol && m.symbol !== sym)) return;
        if (m.channel === 'push.deal') {
          const d = Array.isArray(m.data) ? m.data[m.data.length - 1] : m.data;
          if (d && d.p) setLast(d.p, 'live feed');
        } else if (m.channel === 'push.ticker' && m.data.symbol === sym && m.data.lastPrice) {
          setLast(m.data.lastPrice, 'live feed');
        }
      } catch (_) {}
    };
    sock.onerror = () => {};
    sock.onclose = () => {
      clearInterval(ping);
      if (sock !== ws) return;
      ws = null;
      wsFails++;
      setTimeout(connectFeed, Math.min(30000, 1000 * 2 ** wsFails));
    };
  }

  let pageEl = null;
  function readPagePrice() {
    if (!st.sym) return;
    if (!pageEl || !visible(pageEl)) {
      pageEl = null;
      const symEl = textEls(new RegExp('^' + st.sym.replace('_', '') + '$', 'i'))[0];
      for (let p = symEl && symEl.parentElement, i = 0; p && i < 5 && !pageEl; p = p.parentElement, i++) {
        pageEl = textEls(/^[\d,]+\.\d+$/, p)[0] || null;
      }
    }
    if (pageEl) setLast(pageEl.textContent.trim(), 'page');
  }

  function readTitle() {
    const m = document.title.replace(/,/g, '').match(/\d+\.\d+/);
    if (m) setLast(m[0], 'tab title');
  }

  async function priceFromLastButton() {
    try {
      const { root } = findForm();
      const input = findPriceInput(root);
      const b = input && textEls(/^Last$/i, root)[0];
      if (!b) return;
      b.click();
      await sleep(40);
      if (num(input.value) > 0) { st.feedAt = 0; st.pageAt = 0; setLast(cleanNum(input.value), 'MEXC Last button'); }
    } catch (_) {}
  }

  // ================================================================ single order (Single tab)
  function useMarket(input) {
    if (!(st.last > 0)) return status('No market price yet.', 'err');
    input.value = fmt(st.last);
    saveDraft();
    render();
  }

  function readSingle(side = cfg.side) {
    const price = cleanNum(ui.entry.value), qty = num(ui.qty.value), e = num(price);
    if (!(e > 0)) throw new Error('Enter the entry price.');
    if (!(qty > 0)) throw new Error('Enter a quantity in USDT.');
    const o = { price, qty, tpsl: ui.tpsl.checked };
    if (o.tpsl) {
      const tp = cleanNum(ui.tp.value), sl = cleanNum(ui.sl.value), t = num(tp), s = num(sl);
      if (!(t > 0) || !(s > 0)) throw new Error('Enter TP and SL prices, or turn TP/SL off.');
      if (side === 'long' && !(t > e && s < e)) throw new Error('For a long: TP must be above the entry and SL below it.');
      if (side === 'short' && !(t < e && s > e)) throw new Error('For a short: TP must be below the entry and SL above it.');
      Object.assign(o, { tp, sl });
    }
    return o;
  }

  async function runSingle(submit) {
    if (st.busy || !ui || st.dead) return;
    if (hedgeOn()) return status('The hedge bot is running. Single orders would mix into its positions. Stop it first.', 'warn');
    if (sideBusy(cfg.side)) return status('The grid bot is using the long and short positions. A single order would mix into them. Stop the grid bot first and let its open orders close.', 'warn');
    st.busy = true;
    let sent = false;
    const t0 = performance.now(), side = cfg.side, W = sideWord(side);
    try {
      const o = readSingle(side);
      await switchAction('open', side);
      const form = await fillLimit(o, side);
      const what = `${W.toLowerCase()} ${o.qty} USDT at ${o.price}${o.tpsl ? `, TP ${o.tp}, SL ${o.sl}` : ''}`;
      if (!submit) { status(`Filled ${what}. Now press Open ${W} on MEXC.`, 'ok'); return; }
      (visible(form.btn) ? form.btn : findForm(side).btn).click();
      sent = true;
      status(`Order sent: ${what} (${Math.round(performance.now() - t0)} ms).`, 'ok');
      watchConfirm();
    } catch (e) {
      status((submit ? 'Order NOT sent: ' : '') + e.message, 'err');
    } finally {
      setTimeout(() => { st.busy = false; }, sent ? 800 : 0);
    }
  }

  async function watchConfirm() {
    for (const d of [300, 700]) {
      await sleep(d);
      const dlg = textEls(/^(Confirm|OK)$/i).some(el => el.closest('[role="dialog"],[class*="modal" i],[class*="dialog" i]'));
      if (dlg) { status('MEXC is asking for confirmation. Click Confirm, then turn off order confirmations in MEXC settings.', 'warn'); return; }
    }
  }

  // ================================================================ grid bot (v9): activation price, long + short at every level
  // Setup: direction (Up/Down), activation price = level 1, number of grids, gap. Every level gets a LONG and a SHORT
  // order, each with its own amount, TP and SL. Nothing is placed until the price touches the activation price.
  // Order type, decided each time an order is placed (rule from the client):
  //   long : market ≥ level → LIMIT · market < level → TRIGGER at the level, price = Market
  //   short: market ≤ level → LIMIT · market > level → TRIGGER at the level, price = Market
  // Loop: when a long or short closes at its TP or its SL, the same order (same level, amount, TP, SL) is placed again
  // with the rule above. Stop cancels the bot's waiting orders only; open positions keep their TP/SL on MEXC.
    const SIDES = ['long', 'short'];
  const MAX_BOTS = 5;                                       // grid bots at the same time (same coin)
  // MEXC lists orders by price only, so two bots can't use the same grid price (the bot couldn't tell their orders apart)
  function levelClash(levels, exceptId) {
    for (const g of grids) {
      if (g.id === exceptId || !tracked(g)) continue;
      const hit = levels.find(nl => g.levels.some(lv => samePrice(lv.price, nl.price)));
      if (hit) return `grid ${fmt(hit.price)} is already used by bot ${gTag(g)}. Two bots can't share a grid price — change Grid 1 or the gap.`;
    }
    return '';
  }
  const PRICE_STALE_MS = 5000;
  const tickHalf = () => 10 ** -(st.dec ?? 2) / 2 + 1e-9;
  const pxs = v => Number(v).toLocaleString('en-US', { maximumFractionDigits: st.dec ?? 2 });   // short price for lists
  const SK = side => side === 'long' ? 'l' : 's';
  const kindFor = (side, price, px = st.last) => side === 'long' ? (px >= price - tickHalf() ? 'limit' : 'trigger')
                                                                 : (px <= price + tickHalf() ? 'limit' : 'trigger');

  const roundHint = sl => {                                 // a tip only: round numbers collect many stops (slippage)
    if (!(sl > 0)) return '';
    const step = sl >= 10000 ? 1000 : sl >= 1000 ? 100 : sl >= 100 ? 10 : 1;
    return Math.abs(sl / step - Math.round(sl / step)) < 1e-9 ? 'round number: many stops sit here' : '';
  };

  // ---- editor: the bot being set up. mode 'grid' = long + short at every grid (fields a…),
  //      mode 'one' = one-direction bot: only longs or only shorts (fields o…), with its own loop setting
  const OV_FIELDS = ['qty', 'tp', 'sl'];
  const oneSide = () => (cfg.side === 'short' ? 'short' : 'long');   // the Long / Short switch above the tabs
  function previewBot(mode = 'grid') {
    const d = cfg.draft || {}, O = mode === 'one';
    const dir = (O ? d.oDir : d.aDir) === 'up' ? 'up' : 'down';
    const f = k => ui[(O ? 'o' : 'a') + k];
    const useAct = (O ? d.oUse : d.aUse) !== false;
    // without an activation price the orders are placed at Start: the order type is shown for the current price
    const act = useAct ? num(f('Act').value) : st.last, first = num(f('First').value), n = Math.round(num(f('N').value)), gap = num(f('Gap').value);
    if (useAct && !(act > 0)) throw new Error('Enter the activation price (or untick "Use an activation price").');
    if (!useAct && !(act > 0)) throw new Error('No market price yet.');
    if (!(first > 0)) throw new Error(`Enter the grid 1 price${O ? ' (order price)' : ''}.`);
    if (!(n >= 1 && n <= 10)) throw new Error('Grids must be 1 to 10.');
    if (!(gap > 0) && n > 1) throw new Error('Enter the gap between grids.');
    let sides, defs, loop = null;
    if (O) {
      const side = oneSide(), q = num(ui.oQ.value), tpg = num(ui.oTp.value), slg = num(ui.oSl.value);
      if (!(q > 0)) throw new Error('Enter the amount (USDT).');
      if (!(tpg > 0)) throw new Error('Enter the TP gap.');
      if (!(slg > 0)) throw new Error('Enter the SL gap.');
      const L = side === 'long';
      sides = [side];
      defs = { [side]: price => ({ qty: q, tp: L ? price + tpg : price - tpg, sl: L ? price - slg : price + slg }) };
      loop = { mode: d.oLoop === 'price' ? 'price' : 'tpsl', px: null };
      if (loop.mode === 'price') { loop.px = num(ui.oLp.value); if (!(loop.px > 0)) throw new Error('Enter the loop price (or choose "Loop at TP/SL").'); }
    } else {
      const lq = num(ui.aLq.value), sq = num(ui.aSq.value), ltp = num(ui.aLtp.value), lsl = num(ui.aLsl.value), stp = num(ui.aStp.value), ssl = num(ui.aSsl.value);
      if (!(lq > 0) || !(sq > 0)) throw new Error('Enter the long and short amounts (USDT).');
      if (!(ltp > 0) || !(stp > 0)) throw new Error('Enter the long and short TP gaps.');
      if (!(lsl > 0) || !(ssl > 0)) throw new Error('Enter the long and short stop loss prices.');
      sides = SIDES;
      defs = { long: price => ({ qty: lq, tp: price + ltp, sl: lsl }), short: price => ({ qty: sq, tp: price - stp, sl: ssl }) };
    }
    const step = dir === 'down' ? -1 : 1, ov = (O ? d.oOv : d.aOv) || {}, rows = [];
    for (let i = 1; i <= n; i++) {
      const price = first + step * (gap || 0) * (i - 1), row = { i, price };
      for (const side of sides) {
        const L = side === 'long', def = defs[side](price);
        const o = ov[SK(side) + i] || {}, v = {}, custom = {};
        let err = '', errF = '';
        for (const fld of OV_FIELDS) {
          const typed = o[fld] != null && String(o[fld]).trim() !== '', x = num(cleanNum(o[fld]));
          if (typed && !(x > 0) && !err) { err = `${fld === 'qty' ? 'amount' : fld.toUpperCase()} "${o[fld]}" is not a number`; errF = fld; }
          v[fld] = typed && x > 0 ? x : def[fld];
          custom[fld] = typed && x > 0 && Math.abs(x - def[fld]) > 1e-9;
        }
        if (err) { /* keeps the first error */ }
        else if (!(price > 0)) err = 'level price below zero';
        else if (!(v.qty > 0)) { err = 'amount'; errF = 'qty'; }
        else if (L ? !(v.tp > price + tickHalf()) : !(v.tp > 0 && v.tp < price - tickHalf())) { err = `TP must be ${L ? 'above' : 'below'} ${fmt(price)}`; errF = 'tp'; }
        else if (L ? !(v.sl > 0 && v.sl < price - tickHalf()) : !(v.sl > price + tickHalf())) { err = `SL must be ${L ? 'below' : 'above'} ${fmt(price)}`; errF = 'sl'; }
        row[side] = { ...v, def, custom, err, errF, kind: kindFor(side, price, act) };
      }
      rows.push(row);
    }
    return { mode, dir, act, useAct, first, n, gap, rows, sides, loop };
  }

  function readBot(mode = 'grid') {
    const p = previewBot(mode);
    for (const r of p.rows) for (const side of p.sides) if (r[side].err) throw new Error(`Grid ${r.i} ${side}: ${r[side].err}.`);
    const levels = p.rows.map(r => {
      const lv = { i: r.i, price: r.price, priceStr: fmt(r.price) };
      for (const side of p.sides) {
        const x = r[side];
        lv[side] = { side, qty: x.qty, tp: x.tp, sl: x.sl, tpStr: fmt(x.tp), slStr: fmt(x.sl), custom: x.custom, state: 'idle', tps: 0, sls: 0 };
      }
      return lv;
    });
    return { mode, dir: p.dir, act: p.act, actStr: fmt(p.act), useAct: p.useAct, first: p.first, gap: p.gap, levels, sides: p.sides,
             loop: p.loop ? p.loop.mode : 'tpsl', loopPx: p.loop && p.loop.px, loopPxStr: p.loop && p.loop.px ? fmt(p.loop.px) : null };
  }

  // ================================================================ engine
  // MEXC keeps ONE long and ONE short position, so all longs share one position and all shorts another. The bot keeps
  // each order's own price range (since it was placed, and since it filled) and explains every change of a side's
  // position size with the entries, take profits and stop losses the price actually reached — also several in one move.
  // Anything that doesn't add up pauses the bot with an explanation (no guessing with money).
  const queue = [];
  let working = false, uiLock = 0;
  // actions outside the job queue (Stop, Resume, Re-check) use MEXC's bottom panel too: position checks wait for them
  async function locked(fn) { uiLock++; try { return await fn(); } finally { uiLock--; } }
  function enqueue(g, name, fn, always = false) { queue.push({ g, name, fn, always }); if (!working) work(); }
  async function work() {
    working = true;
    while (queue.length) {
      const job = queue.shift();
      if (!job.always && job.g.phase !== 'run') continue;
      try { await job.fn(); }
      catch (e) { log(`grid #${job.g.n} ${job.name} failed: ${e.message}`); pauseGrid(job.g, `${job.name} failed: ${e.message}`); }
    }
    working = false;
    await backToPositions();
    render();
  }

  // ================================================================ bot window: exactly one MEXC tab runs the bots
  // The tab that starts/resumes a bot becomes the bot window and sends a heartbeat every 2 s.
  // Other MEXC tabs are viewers: they show the bots' live status and send Stop / TP edits to the bot window.
  // If the bot window disappears (closed, crashed, asleep), viewers raise an alarm and can take over with Resume.
  const TAB_ID = (() => {
    try { let v = sessionStorage.getItem('mqlTabId'); if (!v) { v = Math.random().toString(36).slice(2, 10); sessionStorage.setItem('mqlTabId', v); } return v; }
    catch (_) { return Math.random().toString(36).slice(2, 10); }
  })();                                                     // survives a refresh of the same tab
  const BEAT_MS = 2000, DEAD_MS = 8000;
  let leader = { id: null, ts: 0 }, iAmBot = false, lastBeat = 0, deadWarned = false;
  const otherBotAlive = () => !!leader.id && leader.id !== TAB_ID && Date.now() - leader.ts < DEAD_MS;
  function beat() { if (!iAmBot) return; lastBeat = Date.now(); leader = { id: TAB_ID, ts: lastBeat }; storeSet('mqlLeader', leader); }
  async function claimBot() {
    if (iAmBot) return true;
    if (otherBotAlive()) return false;
    iAmBot = true; beat();
    await sleep(400);                                        // two tabs claiming at once: the last write wins
    const cur = await new Promise(r => storeGet('mqlLeader', r));
    if (cur && cur.id !== TAB_ID) { iAmBot = false; leader = cur; return false; }
    deadWarned = false;
    return true;
  }
  function releaseBot() {
    if (!iAmBot || grids.some(tracked) || hedgeOn()) return;
    iAmBot = false; leader = { id: null, ts: 0 };
    storeSet('mqlLeader', leader);
  }
  const saveGrids = () => { if (iAmBot) storeSet('mqlGrids9', { list: grids, trk, seq: gridSeq }); };
  // actions that change a grid run in the bot window; other windows forward them there
  async function viaBot(cmd) {
    if (iAmBot) return true;
    if (otherBotAlive()) { storeSet('mqlCmd', { ...cmd, to: leader.id, ts: Date.now() }); status('Sent to the bot window.', 'ok'); return false; }
    return claimBot();
  }
  try {
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== 'local') return;
      if (ch.mqlLeader) { leader = ch.mqlLeader.newValue || { id: null, ts: 0 }; if (leader.id === TAB_ID && !iAmBot) leader = { id: null, ts: 0 }; }
      if (ch.mqlGrids9 && !iAmBot && ch.mqlGrids9.newValue) {
        const v = ch.mqlGrids9.newValue;
        grids = v.list || []; gridSeq = v.seq || gridSeq;
        for (const sd of ['long', 'short']) if (v.trk && v.trk[sd]) Object.assign(trk[sd], v.trk[sd]);
        render();
      }
      if (ch.mqlHedge7 && !iAmBot && ch.mqlHedge7.newValue) { hedge = ch.mqlHedge7.newValue; render(); }
      if (ch.mqlAlerts && ch.mqlAlerts.newValue) { mergeAlerts(ch.mqlAlerts.newValue); if (ui) render(); }
      const c = ch.mqlCmd && ch.mqlCmd.newValue;
      if (c && iAmBot && c.to === TAB_ID && Date.now() - c.ts < 10000) {
        log(`command from a viewer: ${c.cmd} ${c.id || ''}`);
        if (c.cmd === 'stop') stopGrid(c.id, true);
        if (c.cmd === 'mark') markClosed(c.id, c.i, c.side, true);
        if (c.cmd === 'hstop') stopHedge();
      }
    });
  } catch (_) {}

  function viewerTick() {                                   // runs in tabs that are not the bot window
    if (iAmBot || !(gridOn() || hedgeOn())) { deadWarned = false; return; }
    if (otherBotAlive()) { deadWarned = false; return; }
    if (deadWarned) return;
    deadWarned = true;
    for (const g of grids) {                                // show them as paused here, ready to take over
      if (g.phase === 'run' || g.phase === 'stopping') { g.phase = 'paused'; eachSlot(g, s => { if (s.state === 'busy' || s.state === 'check') s.state = 'retry'; }); }
    }
    for (const sd of ['long', 'short']) if (sideBusy(sd)) Object.assign(trk[sd], { bad: true, badMsg: 'the bot window was gone' });
    if (hedge.phase === 'run' || hedge.phase === 'stopping') hedge.phase = 'paused';
    alertUser('crit', 'The bot window is gone (closed, crashed or asleep): the bots are NOT being managed. TP/SL on MEXC stay active. Press Resume in this window to take over.');
    status('⚠ The bot window is gone (closed, crashed or asleep). The bots are NOT being managed. TP/SL on MEXC are still active. Press Resume here to take over.', 'err');
    render();
  }

  // When YOU click another bottom tab (Open Orders, History…), the bot leaves it there for LOOK_MS.
  // Only real clicks count (the bot's own clicks are not "trusted" events). TP/SL stay on MEXC meanwhile;
  // fills/TPs that happen are picked up when the Positions tab is back (price highs/lows keep being tracked).
  const LOOK_MS = 60000;
  let lookUntil = 0;
  const looking = () => Date.now() < lookUntil;
  document.addEventListener('click', e => {
    if (!e.isTrusted || !iAmBot || !(grids.some(tracked) || hedgeOn())) return;
    const t = norm((e.target && e.target.textContent) || '');
    if (t.length > 40) return;
    if (/^Positions\s*\(\d+\)$/i.test(t)) { lookUntil = 0; render(); return; }
    if (/^(Open Orders|Position History|Order & Trade History|Assets|Limit Order|TP\/SL Order|Trigger Order|Trailing Stop)/i.test(t)) {
      lookUntil = Date.now() + LOOK_MS;
      status(`You opened "${t.replace(/\(\d+\)$/, '')}". The bot leaves this tab for ${LOOK_MS / 1000}s, then returns to Positions. TP/SL stay active on MEXC.`, 'warn');
      render();
    }
  }, true);
  async function backToPositions() { if (!looking()) await openBottomTab('Positions').catch(() => {}); }

  // ---- bookkeeping helpers
  const gTag = g => `#${g.n}${g.mode === 'one' ? ' ' + (g.levels[0].long ? 'LONG' : 'SHORT') : ''} ${g.dir === 'up' ? '▲' : '▼'} ${pxs(g.levels[0].price)}${g.noAct ? '' : ` (act. ${pxs(g.act)})`}`;
  function gridMsg(g, msg, kind = 'ok', level = kind === 'err' ? 'crit' : kind === 'warn' ? 'warn' : 'note') {
    g.note = msg; status(`${isOne(g) ? 'Bot' : 'Grid'} ${gTag(g)}: ${msg}`, kind);
    alertUser(level, msg, { bot: g.n });
    saveGrids(); render();
  }
  const gById = id => grids.find(g => g.id === id);
  // a one-direction bot has only its own side at every grid (lv.long or lv.short)
  const gSides = g => SIDES.filter(sd => g.levels[0] && g.levels[0][sd]);
  function eachSlot(g, fn) { for (const lv of g.levels) for (const side of SIDES) if (lv[side]) fn(lv[side], lv, side); }
  const nOpen = (g, side) => g.levels.reduce((a, lv) => a + (side ? (lv[side] && lv[side].state === 'filled' ? 1 : 0) : SIDES.filter(sd => lv[sd] && lv[sd].state === 'filled').length), 0);
  // a bot counts for MEXC's positions while it runs, or while some of its orders are still open on MEXC
  function tracked(g) { return g.phase !== 'off' || g.levels.some(lv => SIDES.some(sd => lv[sd] && lv[sd].state === 'filled')); }
  const sideBusy = side => grids.some(g => tracked(g) && gSides(g).includes(side) && (g.phase !== 'off' || g.levels.some(lv => lv[side] && lv[side].state === 'filled')));
  function slotsOf(side, f = tracked) { const out = []; for (const g of grids) if (f(g)) for (const lv of g.levels) if (lv[side]) out.push({ g, lv, s: lv[side] }); return out; }
  const filledQty = side => slotsOf(side).reduce((a, x) => a + (x.s.state === 'filled' ? x.s.qty : 0), 0);
  const minQty = side => { const q = slotsOf(side).map(x => x.s.qty); return q.length ? Math.min(...q) : 1; };

  // Every order keeps its own price range: since it was placed (rLo/rHi → did it fill?) and since it filled
  // (fLo/fHi → did its TP or SL close it?). So a price move from before a fill never counts as that order's TP or SL.
  const reachedEntry = (s, price) => (s.rLo ?? Infinity) <= price + tickHalf() && (s.rHi ?? -Infinity) >= price - tickHalf();
  const reachedTp = (side, s) => side === 'long' ? (s.fHi ?? -Infinity) >= s.tp - tickHalf() : (s.fLo ?? Infinity) <= s.tp + tickHalf();
  const reachedSl = (side, s) => side === 'long' ? (s.fLo ?? Infinity) <= s.sl + tickHalf() : (s.fHi ?? -Infinity) >= s.sl - tickHalf();
  function markFilled(s) { s.state = 'filled'; s.fLo = s.fHi = st.last; }
  function trackRanges(px = st.last) {
    if (!(px > 0)) return;
    for (const g of grids) {
      if (g.phase === 'armed') { g.aLo = Math.min(g.aLo ?? px, px); g.aHi = Math.max(g.aHi ?? px, px); }
      eachSlot(g, s => {
        if (s.state === 'entry' || s.state === 'check') {
          s.rLo = Math.min(s.rLo ?? px, px); s.rHi = Math.max(s.rHi ?? px, px);
          if (s.rt) { s.eLo = Math.min(s.eLo ?? px, px); s.eHi = Math.max(s.eHi ?? px, px); }
        }
        if (s.state === 'filled') { s.fLo = Math.min(s.fLo ?? px, px); s.fHi = Math.max(s.fHi ?? px, px); }
        if (s.state === 'wait') { s.wLo = Math.min(s.wLo ?? px, px); s.wHi = Math.max(s.wHi ?? px, px); }
      });
    }
    SIDES.forEach(side => flagTouched(side, px));            // on every price, also while the bot is placing orders
  }

  // The price reached a waiting order's grid: if the position doesn't change, MEXC's order list tells whether it opened.
  // (It may have opened and closed again, or opened while another order of the same side closed: same size.)
  function flagTouched(side, px = st.last) {
    for (const { g, lv, s } of slotsOf(side, g => g.phase === 'run')) {
      if (s.state !== 'entry' || !(px > 0)) continue;
      if (s.rtWait) {                                        // checked and still waiting: look again after the price came back
        const back = (side === 'long') === (s.kind !== 'trigger') ? px > lv.price + tickHalf() : px < lv.price - tickHalf();
        if (back) s.rtWait = false;
        continue;
      }
      if (s.rt || !reachedEntry(s, lv.price)) continue;
      const L = side === 'long', beyondTp = L ? px >= s.tp - tickHalf() : px <= s.tp + tickHalf(), beyondSl = L ? px <= s.sl + tickHalf() : px >= s.sl - tickHalf();
      s.rt = true; s.rtKind = beyondTp ? 'tp' : beyondSl ? 'sl' : null; s.eLo = s.eHi = px;   // price range since the grid was reached
      log(`grid #${g.n} ${slotName(lv, side)}: price reached the grid${s.rtKind ? ` and then its ${s.rtKind.toUpperCase()}` : ''} — order check queued`);
    }
  }

  // position size (USDT) of one side, from its card on the Positions tab. 0 = no position on that side.
  let sizeLook = { at: -1e9, cards: null }, posRoot = null;
  function readSize(side) {
    const pc = tabCount('Positions');
    if (!pc) return null;
    if (pc.n === 0) return 0;
    if (performance.now() - sizeLook.at > 40) sizeLook = { at: performance.now(), cards: positionCards(pc) };   // long + short in one look
    const cards = sizeLook.cards;
    if (!cards) return null;                                 // Positions tab not showing
    const mine = cards.filter(c => c.side === side);
    if (mine.length === 1) return mine[0].size;
    if (cards.every(c => c.side)) return 0;                  // all cards identified, none on this side
    return null;                                             // cannot tell long from short
  }
  // One card per open position: "L BTCUSDT 20X Isolated" header (L/S badge), then Unrealized PNL, Position, Avg Entry Price…
  // MEXC may put the header outside the block with the numbers, so the bot climbs from the "Position" label to the block
  // with "Unrealized PNL" and then on to the header, never so far that a second card would be included.
  const BADGE = /^(L|S|Long|Short)$/;
  function positionCards(pc) {
    let formRoot = null;
    try { formRoot = wideRoot(findForm().root); if (formRoot.contains(pc.el)) formRoot = null; } catch (_) {}   // too wide: ignore
    const notForm = el => !formRoot || !formRoot.contains(el);
    // look in MEXC's bottom panel first (found once), else the whole page
    let labs = posRoot && posRoot.isConnected && posRoot.contains(pc.el) ? textEls(/^Position$/i, posRoot).filter(notForm) : [];
    let cards = cardsFrom(labs);
    if (cards.all < pc.n) {
      labs = textEls(/^Position$/i).filter(notForm);
      cards = cardsFrom(labs);
      posRoot = cards.list.length ? lca(pc.el, cards.list[0].lab) : null;
    }
    const sym = (st.sym || '').replace('_', '').toUpperCase();
    const list = cards.list.filter(c => !c.pair || !sym || c.pair === sym);   // other coins' positions don't count
    if (!list.length && !cards.all) { readWhy(`Positions (${pc.n}): no position card found (${labs.length} "Position" labels)`); return null; }
    if (list.some(c => !c.side || !(c.size >= 0))) readWhy(`Positions (${pc.n}): ` + list.map(c => `[${c.side || 'side?'} ${c.pair || 'pair?'} ${c.size ?? 'size?'}: "${c.txt}"]`).join(' '));
    return list;
  }
  function cardsFrom(labs) {
    const list = [];
    for (const lab of labs) {
      let card = lab, ok = false;
      for (let i = 0; i < 8 && card.parentElement; i++) { card = card.parentElement; if (/Unrealized PNL/i.test(card.textContent)) { ok = true; break; } }
      if (!ok) continue;                                    // not a position card
      let badge = textEls(BADGE, card)[0];
      for (let i = 0; i < 5 && !badge && card.parentElement && card.parentElement !== document.body; i++) {
        const up = card.parentElement;
        if (textEls(/^Unrealized PNL/i, up).length > 1) break;   // would take in another card
        card = up; badge = textEls(BADGE, card)[0];
      }
      const pe = textEls(/^[A-Z0-9]{2,12}\/?USDT(\s+Perpetual)?$/i, card)[0];
      const pair = pe ? norm(pe.textContent).toUpperCase().replace(/\s*PERPETUAL$/, '').replace('/', '') : null;
      const v = valueNear(lab, 1);
      list.push({ lab, card, side: badge ? (/^L/.test(norm(badge.textContent)) ? 'long' : 'short') : null, size: v ? v[0] : null, pair,
                  txt: norm(card.textContent).slice(0, 90) });
    }
    return { list, all: list.length };
  }
  let whyAt = 0, whyLast = '';
  function readWhy(msg) {                                    // what the bot saw when it couldn't read a position (for Copy log)
    if (msg === whyLast && Date.now() - whyAt < 30000) return;
    whyAt = Date.now(); whyLast = msg;
    log('position reading: ' + msg);
  }

  const orderKey = (g, lv, side) => `${g.id}:${SK(side)}${lv.i}`;
  const slotName = (lv, side) => `${side} ${lv.priceStr}`;

  // place one order with the rule: limit or trigger (price = Market), amount, TP and SL attached
  async function placeSlot(g, lv, side) {
    const s = lv[side];
    if (!(st.last > 0) || Date.now() - st.lastAt > PRICE_STALE_MS) throw new Error('no live price');
    const kind = kindFor(side, lv.price);
    await switchAction('open', side);
    const before = (tabCount('Open Orders') || {}).n ?? 0, k = trk[side].k || 1;
    for (let attempt = 1; attempt <= 3; attempt++) {
      let form, fields;
      if (kind === 'limit') {
        form = await prepareForm('Limit', side);
        const boxes = await syncTpsl(form, true);
        fields = [[form.price, lv.priceStr], [form.qty, s.qty], [boxes.tp, s.tpStr], [boxes.sl, s.slStr]];
      } else {
        await ensureMarket(await prepareForm('Trigger', side));
        form = await prepareForm('Trigger', side);              // fresh boxes after the Market click
        const boxes = await syncTpsl(form, true);
        fields = [[form.trig, lv.priceStr], [form.qty, s.qty], [boxes.tp, s.tpStr], [boxes.sl, s.slStr]];
      }
      writeFields(fields);
      await sleep(attempt === 1 ? 80 : 200);
      if (!fieldsMatch(fields) || (kind === 'trigger' && !triggerIsMarket(form))) { log(`grid #${g.n} ${slotName(lv, side)}: form check failed, attempt ${attempt}`); continue; }
      (visible(form.btn) ? form.btn : findForm(side).btn).click();
      let ok = await waitFor(() => ((tabCount('Open Orders') || {}).n ?? 0) > before || (readSize(side) ?? 0) > k * (filledQty(side) + 0.5 * s.qty), 1500, 50);
      if (!ok) {                                              // the count may not include this kind of order: look in the list itself
        const lists = await readOrderLists().catch(() => null);
        ok = lists && stillWaiting(lists, lv, side, kind);
        await backToPositions();
        if (ok) log(`grid #${g.n} ${slotName(lv, side)}: found in the ${kind} order list`);
      }
      if (!ok) {
        // not on MEXC yet: no pause. The bot looks again in a few seconds and only then places it again (no duplicate)
        Object.assign(s, { state: 'check', kind, checkAt: Date.now() + 4000, checkQ: false, tries: (s.tries || 0) + 1, rLo: st.last, rHi: st.last, rt: false, rtWait: false });
        log(`grid #${g.n} ${slotName(lv, side)}: not shown by MEXC yet (try ${s.tries}) — checking again in a few seconds`);
        saveGrids(); render();
        return;
      }
      Object.assign(s, { state: 'entry', kind, tries: 0, hitE: false, rt: false, rtWait: false, rtKind: null, rLo: st.last, rHi: st.last, assumed: false, unseen: false });
      log(`grid #${g.n} ${slotName(lv, side)}: ${kind} order placed, ${s.qty} USDT, TP ${s.tpStr}, SL ${s.slStr} (market ${fmt(st.last)})`);
      gridMsg(g, `${side} at ${lv.priceStr} placed as ${kind === 'limit' ? 'Limit' : 'Trigger (Market)'} · ${s.qty} USDT · TP ${s.tpStr} · SL ${s.slStr}.`);
      return;
    }
    throw new Error(`MEXC did not keep the ${slotName(lv, side)} order values`);
  }
  // several orders at once: Limit orders first, then Trigger orders (fewer switches of MEXC's form), nearest grid first
  function queueMany(g, list) {
    list.map(([lv, side]) => ({ lv, side, k: kindFor(side, lv.price), d: Math.abs(lv.price - st.last) }))
      .sort((a, b) => (a.k === b.k ? 0 : a.k === 'limit' ? -1 : 1) || (a.side === b.side ? 0 : a.side === 'long' ? -1 : 1) || a.d - b.d)
      .forEach(x => queueSlot(g, x.lv, x.side));
  }
  // an order MEXC didn't show right after the click: look in the lists again; place it again only if it isn't there
  async function verifySlot(g, lv, side) {
    const s = lv[side];
    s.checkQ = false;
    if (s.state !== 'check') return;
    const lists = await readOrderLists().catch(() => null);
    await backToPositions();
    if (s.state !== 'check') return;
    if (!lists) { s.checkAt = Date.now() + 5000; return; }
    for (const kind of ['limit', 'trigger']) if (stillWaiting(lists, lv, side, kind)) {
      Object.assign(s, { state: 'entry', kind, tries: 0 });
      log(`grid #${g.n} ${slotName(lv, side)}: found on MEXC (${kind}) — it was placed`);
      gridMsg(g, `${side} at ${lv.priceStr} is on MEXC (${kind === 'limit' ? 'Limit' : 'Trigger'}).`);
      return;
    }
    if ((s.tries || 0) >= 3) {
      s.state = 'retry';
      return pauseGrid(g, `MEXC did not accept the ${side} order at ${lv.priceStr} after 3 tries (check MEXC for a message, e.g. balance or price limits).`);
    }
    log(`grid #${g.n} ${slotName(lv, side)}: not on MEXC — placing it again`);
    queueSlot(g, lv, side);
  }
  function queueSlot(g, lv, side) { lv[side].state = 'busy'; enqueue(g, `${sideWord(side)} ${lv.priceStr}`, () => placeSlot(g, lv, side)); }

  // the price touched the activation price: place a long and a short at every level, nearest level first
  function activate(g) {
    g.phase = 'run'; g.activated = true;
    if (!g.noAct) gridMsg(g, `activated: the price touched ${g.actStr}. Placing ${g.levels.length * gSides(g).length} orders.`, 'ok', 'good');
    queueMany(g, g.levels.flatMap(lv => gSides(g).map(side => [lv, side])));
  }

  // best combination of items whose (signed) amounts add up to `target`. Items that share a key exclude each other.
  // Ties: fewest items, then the most likely order (rank). target null (first fill, size per USDT not known yet):
  // the combination that makes size ÷ amount closest to 1.
  const MAX_ITEMS = 16;
  function bestSubset(items, target, size) {
    const n = items.length;
    if (!n || n > MAX_ITEMS) return null;
    let best = null;
    for (let m = 1; m < (1 << n); m++) {
      const used = new Set(); let sum = 0, rank = 0, cnt = 0, clash = false;
      for (let j = 0; j < n && !clash; j++) {
        if (!(m & (1 << j))) continue;
        for (const key of items[j].keys) { if (used.has(key)) { clash = true; break; } used.add(key); }
        sum += items[j].qty; rank += items[j].rank; cnt++;
      }
      if (clash || (target == null && !(sum > 0))) continue;
      const err = target == null ? Math.abs(Math.log(size / sum)) : Math.abs(sum - target);
      if (!best || err < best.err - 1e-9 || (Math.abs(err - best.err) <= 1e-9 && (cnt < best.cnt || (cnt === best.cnt && rank < best.rank)))) best = { m, err, sum, rank, cnt };
    }
    if (!best) return null;
    return { items: items.filter((_, j) => best.m & (1 << j)), err: best.err, sum: best.sum };
  }

  // Explains a change of one side's position (dq = change in USDT of order amount, signed) with what the price reached:
  // orders that filled (+), and open orders whose own TP or SL closed them (−). dq null = first fill (size per USDT unknown).
  function resolveChange(side, dq, size) {
    const items = [];
    for (const { g, lv, s } of slotsOf(side)) {
      const keys = [orderKey(g, lv, side)];
      if ((s.state === 'entry' || s.state === 'check') && (g.phase === 'run' || g.phase === 'paused') && reachedEntry(s, lv.price)) items.push({ kind: 'fill', g, lv, s, qty: s.qty, keys });
      if (dq == null || s.state !== 'filled') continue;
      // an order whose fill the price never showed can't be proven to have reached its TP afterwards: never guess that
      if (!s.unseen && reachedTp(side, s)) items.push({ kind: 'tp', g, lv, s, qty: -s.qty, keys });
      if (reachedSl(side, s)) items.push({ kind: 'sl', g, lv, s, qty: -s.qty, keys });
    }
    const order = { fill: 0, tp: 1, sl: 2 };
    items.sort((a, b) => order[a.kind] - order[b.kind] || Math.abs(a.lv.price - st.last) - Math.abs(b.lv.price - st.last)).forEach((it, j) => { it.rank = j; });
    const pick = bestSubset(items, dq, size);
    if (!pick || (dq != null && pick.err > 0.35 * minQty(side))) {
      const what = dq == null ? 'changed' : dq > 0 ? `grew by about ${dq.toFixed(2)} USDT` : `shrank by about ${(-dq).toFixed(2)} USDT`;
      sideAnomaly(side, `the ${side} position ${what}, but that doesn't match the entries, take profits and stop losses the price reached` +
        (items.length > MAX_ITEMS ? ' (too many possibilities after a very fast move)' : '') + '. ' +
        'An order may have been opened, closed or cancelled by hand. Check Positions and Open Orders, use "Mark closed" on orders you closed yourself, then Resume.');
      return false;
    }
    if (dq == null) trk[side].k = size / pick.sum;
    for (const it of pick.items.filter(x => x.kind === 'fill')) {
      markFilled(it.s);
      gridMsg(it.g, `${side} at ${it.lv.priceStr} opened. Its TP ${it.s.tpStr} and SL ${it.s.slStr} are on MEXC.`, 'ok', 'info');
    }
    for (const it of pick.items.filter(x => x.kind !== 'fill')) closeHit(it.g, it.lv, side, it.kind);
    return true;
  }

  // a long or short closed at its TP or SL: count it and place the same order again (the loop)
  function closeHit(g, lv, side, kind) {
    const s = lv[side], L = side === 'long', px = kind === 'tp' ? s.tp : s.sl;
    const pnl = s.qty * (L ? px - lv.price : lv.price - px) / lv.price;
    if (kind === 'tp') { s.tps++; g.tps++; } else { s.sls++; g.sls++; }
    g.pnl += pnl;
    const lvl = kind === 'tp' ? 'good' : 'warn';
    const what = `${side} at ${lv.priceStr}: ${kind === 'tp' ? 'TP' : 'SL'} ${kind === 'tp' ? s.tpStr : s.slStr} hit (≈ ${pnl >= 0 ? '+' : '−'}${Math.abs(pnl).toFixed(4)} USDT).`;
    if (g.phase === 'run' && g.loop === 'price') {      // price loop: placed again once the market touches the loop price
      Object.assign(s, { state: 'wait', wLo: st.last, wHi: st.last });
      gridMsg(g, `${what} It is placed again when the price touches the loop price ${g.loopPxStr}.`, kind === 'tp' ? 'ok' : 'warn', lvl);
    }
    else if (g.phase === 'run') { gridMsg(g, `${what} Placing it again (${kindFor(side, lv.price) === 'limit' ? 'Limit' : 'Trigger'}).`, kind === 'tp' ? 'ok' : 'warn', lvl); queueSlot(g, lv, side); }
    else if (g.phase === 'paused' && g.loop === 'price') { Object.assign(s, { state: 'wait', wLo: st.last, wHi: st.last }); gridMsg(g, `${what} After Resume it waits for the loop price ${g.loopPxStr}.`, 'warn', lvl); }
    else if (g.phase === 'paused') { s.state = 'retry'; gridMsg(g, `${what} It is placed again when you press Resume.`, 'warn', lvl); }
    else { s.state = 'idle'; gridMsg(g, `${what} The bot is stopped, so it is not placed again.`, 'ok', lvl); }
  }

  // something on this side doesn't add up: pause the running bots until it is checked again
  function sideAnomaly(side, msg) {
    const T = trk[side];
    if (T.bad) return;
    if (slotsOf(side).some(x => x.s.assumed)) msg += ' (A waiting order had disappeared from Open Orders: if you cancelled it on MEXC, press "Mark closed" on it.)';
    Object.assign(T, { bad: true, badMsg: msg });
    for (const g of grids) { if (g.phase === 'run') pauseGrid(g, msg, true); else if (tracked(g)) g.note = msg; }
    alertUser('crit', `${sideWord(side)} side paused: ${msg}`);
    status(`${sideWord(side)} side: ${msg}`, 'err');
    saveGrids(); render();
  }

  // Stop: cancels EVERY waiting opening order (Limit and Trigger, long and short) at this bot's grid prices — also orders
  // the bot was still placing — then reads both lists again until none is left. Open positions and their TP/SL stay.
  const sideOfDir = dir => /long$/.test(dir) ? 'long' : 'short';
  async function cancelEntries(g) {
    const isMine = r => (r.dir === 'open-long' || r.dir === 'open-short') && g.levels.some(lv => (r.price != null ? [r.price] : r.nums).some(n => samePrice(n, lv.price)));
    const priceOf = r => r.price != null ? r.price : g.levels.find(lv => r.nums.some(n => samePrice(n, lv.price))).price;
    let first = null, left = [], err = '';
    const seen = new Set();                                  // orders the bot saw (and cancelled) in any look
    for (let pass = 1; pass <= 3; pass++) {
      const lists = await readOrderLists();
      if (!lists) { err = 'could not read Open Orders (Limit / Trigger Order)'; continue; }
      err = '';
      if (!first) first = lists;
      const lim = lists.lim.filter(isMine), trg = lists.trg.filter(isMine);
      eachSlot(g, (s, lv, side) => { if (stillWaiting(lists, lv, side, 'limit') || stillWaiting(lists, lv, side, 'trigger')) seen.add(s); });
      left = [...lim.map(r => `${sideOfDir(r.dir)} Limit ${fmt(priceOf(r))}`), ...trg.map(r => `${sideOfDir(r.dir)} Trigger ${fmt(r.price)}`)];
      if (!left.length) break;
      log(`grid #${g.n} stop, pass ${pass}: cancelling ${left.join(', ')}`);
      for (const r of lim) { try { await cancelOrder(r.dir, priceOf(r)); } catch (e) { log(`cancel failed: ${e.message}`); } }
      for (const r of trg) { try { await cancelTrigger(sideOfDir(r.dir), r.price); } catch (e) { log(`cancel failed: ${e.message}`); } }
      if (pass === 3) { const again = await readOrderLists(); left = again ? [...again.lim.filter(isMine).map(r => `${sideOfDir(r.dir)} Limit ${fmt(priceOf(r))}`), ...again.trg.filter(isMine).map(r => `${sideOfDir(r.dir)} Trigger ${fmt(r.price)}`)] : left; }
    }
    // bookkeeping: a waiting order that was no longer in the lists at the first look most likely opened (the position check confirms)
    eachSlot(g, (s, lv, side) => {
      if ((s.state === 'entry' || s.state === 'check') && first && !seen.has(s)) {
        const seen = reachedEntry(s, lv.price);
        markFilled(s); s.assumed = true; s.unseen = !seen;
        log(`grid #${g.n} ${slotName(lv, side)}: no waiting order found when stopping → treated as opened, checking the position`);
      } else if (s.state !== 'filled') s.state = 'idle';
    });
    await backToPositions();
    if (err) return `${err}. Cancel the bot's orders by hand in Open Orders (Limit Order and Trigger Order).`;
    return left.length ? `Still on MEXC after 3 tries: ${left.join(', ')}. Cancel them by hand in Open Orders.` : '';
  }

  function sideTick(side) {
    const T = trk[side], all = slotsOf(side);
    if (!all.length) { T.bad = false; return; }
    const bots = grids.filter(g => tracked(g) && g.phase !== 'armed');
    if (!bots.length) return;
    const run = bots.filter(g => g.phase === 'run');
    if (bots.some(g => g.sym && g.sym !== st.sym)) { run.forEach(g => pauseGrid(g, `the page shows ${st.sym}, but this bot trades ${g.sym}. Go back to ${g.sym}.`)); return; }
    if (T.bad) return;
    if (working || uiLock || looking()) return;            // you are looking at another bottom tab: read Positions afterwards
    const size = readSize(side);
    if (size == null) {
      if (++T.unread % 20 === 1) openBottomTab('Positions').catch(() => {});
      if (T.unread === 30 || (T.unread > 30 && T.unread % 200 === 0)) {   // ~10 s blind, then every minute
        T.blind = true;
        alertUser('crit', `Can't read the ${side} position on MEXC's Positions tab: fills, TPs and SLs are not seen right now (MEXC keeps every TP/SL). Click Positions at the bottom.`);
        status(`⚠ The bot can't read the ${side} position on MEXC's Positions tab, so it doesn't see fills, TPs or SLs right now ` +
          '(MEXC keeps every TP/SL). Click the Positions tab at the bottom. If this stays, press Copy log and send it to the developer.', 'err');
        render();
      }
      return;
    }
    if (T.blind) { T.blind = false; status(`${sideWord(side)} position can be read again.`, 'ok'); alertUser('good', `${sideWord(side)} position can be read again.`); }
    T.unread = 0;
    const mq = minQty(side), k = T.k;
    if (T.seenV !== null && Math.abs(size - T.seenV) <= 0.125 * (k || 1) * mq) T.seenN++; else { T.seenV = size; T.seenN = 1; }
    if (T.seenN < 2) return;                                 // same reading twice in a row
    const fq = filledQty(side);
    if (!k && fq > 0 && size > 0) T.k = size / fq;
    const matches = T.k ? Math.abs(size / T.k - fq) < 0.5 * mq : !(size > 0) && fq === 0;
    if (matches) {
      confirmAssumed(side);
      if (looking() || T.recQ || T.auditQ) return;
      // the position agrees with the bot. Orders that may have opened and closed unseen (round trip), and every 90 s
      // all waiting orders, are compared with MEXC's order lists (a fill and a close elsewhere can cancel out in size).
      if (slotsOf(side, g => g.phase === 'run').some(x => x.s.state === 'entry' && x.s.rt)) {
        T.recQ = true; enqueue(run[0] || bots[0], 'Round-trip check', () => roundTripCheck(side), true); return;
      }
      if (Date.now() - T.auditAt > 90000 && slotsOf(side, g => g.phase === 'run').some(x => x.s.state === 'entry')) {
        T.auditQ = true; enqueue(run[0] || bots[0], 'Order check', () => auditSide(side), true); return;
      }
      return;
    }
    if (!T.k && !(size > 0) && !(fq > 0)) return;
    // size per USDT unknown: a first fill learns it (null); no position while the bot expects some = all of it closed (−fq)
    const changed = resolveChange(side, T.k ? size / T.k - fq : size > 0 ? null : -fq, size);
    if (!changed) return;
    confirmAssumed(side);
    const fq2 = filledQty(side);
    if (fq2 > 0 && size > 0) T.k = size / fq2;               // keeps k accurate as the price moves
    saveGrids();
  }

  // orders the order check treated as filled: the position agrees
  function confirmAssumed(side) {
    for (const { g, lv, s } of slotsOf(side)) if (s.assumed) { s.assumed = false; s.unseen = false; log(`grid #${g.n} ${slotName(lv, side)}: fill confirmed by the position`); }
  }

  // reads MEXC's Limit Order and Trigger Order lists (null = not readable)
  async function readOrderLists() {
    await showLimitOrders();
    const lim = await waitFor(() => scanOrders(), 1500, 100);
    await showTriggerOrders();
    const trg = await waitFor(() => scanTriggers(), 1500, 100);
    return lim && trg ? { lim, trg } : null;
  }
  const stillWaiting = (lists, lv, side, kind) => kind === 'trigger' ? !!findTrig(lists.trg, side, lv.price) : !!findRow(lists.lim, dirKey('open', side), lv.price);

  async function roundTripCheck(side) {
    const T = trk[side];
    T.recQ = false;
    if (looking() || T.bad) return;
    try {
      const sz = readSize(side), fq = filledQty(side);
      if (sz == null || (T.k ? Math.abs(sz / T.k - fq) >= 0.5 * minQty(side) : sz > 0)) return;   // size changed: normal handling does it
      const cand = slotsOf(side, g => g.phase === 'run').filter(x => x.s.state === 'entry' && x.s.rt);
      if (!cand.length) return;
      const lists = await readOrderLists();
      if (!lists) throw new Error('could not read Open Orders');
      for (const { g, lv, s } of cand) {
        s.rt = false;
        if (stillWaiting(lists, lv, side, s.kind)) { s.rtWait = true; log(`grid #${g.n} ${slotName(lv, side)}: still waiting (price touched it without a fill)`); continue; }
        // order gone, position unchanged: it opened, and it or another order of this side closed (same size). It counts as
        // opened when the grid was reached; the position check that follows finds the TP or SL the price reached since
        // then (its own or another order's), or pauses the bot if nothing explains it.
        markFilled(s);
        s.fLo = Math.min(s.eLo ?? st.last, st.last); s.fHi = Math.max(s.eHi ?? st.last, st.last);
        s.assumed = true; s.unseen = false;
        log(`grid #${g.n} ${slotName(lv, side)}: opened (order gone, position unchanged) — checking which order closed`);
        Object.assign(T, { seenV: null, seenN: 0 });
      }
      saveGrids();
    } catch (e) {
      status(`${sideWord(side)} side: round-trip check failed (${e.message}). The bot keeps watching.`, 'warn');
    }
    await backToPositions();
  }

  async function auditSide(side) {
    const T = trk[side];
    T.auditQ = false; T.auditAt = Date.now();
    if (looking() || T.bad) return;
    const cand = slotsOf(side, g => g.phase === 'run' || g.phase === 'paused').filter(x => x.s.state === 'entry' && !x.s.rt);
    if (!cand.length) return;
    try {
      const lists = await readOrderLists();
      if (!lists) throw new Error('could not read Open Orders');
      for (const { g, lv, s } of cand) {
        if (stillWaiting(lists, lv, side, s.kind)) continue;
        // order gone: it filled (maybe in a spike the price feed didn't show). The position check that follows must agree;
        // if the numbers don't add up (e.g. it was cancelled by hand) the bot pauses.
        const seen = reachedEntry(s, lv.price);
        markFilled(s); s.assumed = true; s.unseen = !seen;
        log(`grid #${g.n} ${slotName(lv, side)}: order gone${seen ? '' : ' (price spike not seen)'} → treated as filled, checking the position`);
        gridMsg(g, `${side} at ${lv.priceStr}: order no longer waiting — treated as opened; checking it against the position.`);
      }
      Object.assign(T, { seenV: null, seenN: 0 });
      saveGrids();
    } catch (e) {
      status(`${sideWord(side)} side: order check failed (${e.message}). The bot keeps watching.`, 'warn');
    }
    await backToPositions();
  }

  function gridTick() {
    if (working || uiLock || !iAmBot) return;
    for (const g of grids) if (g.phase === 'run') eachSlot(g, (s, lv, side) => {
      if (s.state === 'check' && !s.checkQ && Date.now() >= (s.checkAt || 0)) { s.checkQ = true; enqueue(g, `Check ${side} ${lv.priceStr}`, () => verifySlot(g, lv, side)); }
      if (s.state === 'wait' && g.loopPx > 0 && s.wLo <= g.loopPx + tickHalf() && s.wHi >= g.loopPx - tickHalf()) {
        gridMsg(g, `the price touched the loop price ${g.loopPxStr}: placing ${side} at ${lv.priceStr} again.`, 'ok', 'info');
        queueSlot(g, lv, side);
      }
    });
    if (working) return;
    for (const g of grids) {                                // waiting for the activation price
      if (g.phase !== 'armed' || !(st.last > 0)) continue;
      if (g.sym && g.sym !== st.sym) continue;
      if (g.aLo <= g.act + tickHalf() && g.aHi >= g.act - tickHalf()) return activate(g);
    }
    sideTick('long');
    if (!working && !uiLock) sideTick('short');
  }

  // ================================================================ grid bot: start / stop / resume
  const botWord = g => (g && g.mode === 'one' ? `${g.levels[0] && g.levels[0].long ? 'Long' : 'Short'} bot` : 'Grid');
  async function startGrid(mode = 'grid') {
    unlockAudio();
    if (hedgeOn()) return status('Stop the hedge bot first: it uses the same long and short positions.', 'err');
    if (grids.filter(g => g.phase !== 'off').length >= MAX_BOTS) return status(`Up to ${MAX_BOTS} grid bots at the same time.`, 'err');
    if (grids.some(g => g.phase === 'paused' || g.phase === 'stopping')) return status('A grid bot is paused (or stopping). Resume or stop it first, then start a new one.', 'err');
    let r;
    try { r = readBot(mode); } catch (e) { return status(`${mode === 'one' ? 'One-direction' : 'Grid'} bot: ${e.message}`, 'err'); }
    const clash = levelClash(r.levels);
    if (clash) return status(`${mode === 'one' ? 'One-direction' : 'Grid'} bot: ${clash}`, 'err');
    if (!(st.last > 0)) return status('No market price yet.', 'err');
    if (!(await claimBot())) return status('The bots run in another MEXC window (the bot window). Start the grid there.', 'warn');
    await waitFor(() => !working, 8000, 100);
    if (!grids.some(tracked)) {                              // first bot: a clean start
      const sizes = await locked(async () => { await backToPositions(); await sleep(150); return SIDES.map(readSize); });
      if (sizes.some(v => v == null)) { releaseBot(); return status('Open MEXC\'s Positions tab at the bottom first (the bot reads the long and short positions there).', 'err'); }
      if (sizes.some(v => v > 0)) { releaseBot(); return status('Close the open positions first: the grid bot needs a clean start (it tracks every long and short it opens).', 'err'); }
      for (const side of SIDES) Object.assign(trk[side], { bad: false, badMsg: '', seenV: null, seenN: 0, auditAt: Date.now() });
    } else {                                                 // more bots: MEXC's positions must match what the running bots expect
      const err = await locked(() => resyncAll());
      if (err) return status(`Can't start another bot yet: ${err}`, 'err');
    }
    gridSeq++;
    const g = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5), n: gridSeq, phase: 'armed', activated: false, sym: st.sym,
                mode, dir: r.dir, act: r.act, actStr: r.actStr, noAct: !r.useAct, first: r.first, gap: r.gap, levels: r.levels, loop: r.loop, loopPx: r.loopPx, loopPxStr: r.loopPxStr,
                cfg: editorSnapshot(mode), aLo: st.last, aHi: st.last, tps: 0, sls: 0, pnl: 0, note: '', started: Date.now() };
    grids.push(g);
    ui.openGrid = g.id;
    if (mode === 'one') { cfg.oEdit = false; cfg.draft.oOv = {}; } else { cfg.gEdit = false; cfg.draft.aOv = {}; }   // per-grid values belonged to this bot
    saveDraft();
    const nCustom = r.levels.reduce((a, lv) => a + SIDES.filter(sd => lv[sd] && Object.values(lv[sd].custom).some(Boolean)).length, 0);
    const what = `${mode === 'one' ? r.sides[0] + 's only, ' : ''}${r.levels.length} grid(s) ${r.dir === 'down' ? 'down' : 'up'} from ${r.levels[0].priceStr}, gap ${pxs(r.gap)}` +
      `${nCustom ? `, ${nCustom} order(s) with custom values` : ''}${mode === 'one' ? (r.loop === 'price' ? `, loop at price ${r.loopPxStr}` : ', loop at TP/SL') : ''}`;
    if (!r.useAct) {                                          // no activation price: the orders go to MEXC now
      Object.assign(g, { act: st.last, actStr: fmt(st.last) });
      gridMsg(g, `started without an activation price: ${what}. Placing the orders now (market ${fmt(st.last)}).`, 'ok', 'info');
      return activate(g);
    }
    gridMsg(g, `armed: ${what}. Waiting for the price (now ${fmt(st.last)}) to touch ${r.actStr}.`);
    if (samePrice(st.last, r.act)) activate(g);
  }

  async function stopGrid(id, sure) {
    const g = gById(id);
    if (!g || g.phase === 'off' || g.phase === 'stopping') return;
    if (!sure && !confirm(`Stop grid bot ${gTag(g)}?\nAll its waiting orders (Limit and Trigger) are cancelled. Open positions stay open with their TP/SL.`)) return;
    if (!(await viaBot({ cmd: 'stop', id }))) return;
    if (g.phase === 'armed' || (g.phase === 'paused' && !g.activated)) return finishGrid(g, 'stopped before activation. Nothing was placed.');
    const wasPaused = g.phase === 'paused';
    g.phase = 'stopping';
    render();
    await waitFor(() => !working, 8000, 100);
    const problems = await locked(() => cancelEntries(g));
    const open = nOpen(g);
    let msg = problems ? 'stopped.' : 'stopped. All its waiting orders (Limit and Trigger) are cancelled.';
    if (open) msg += ` ${open} open position order(s) stay open with their TP and SL on MEXC; the bot keeps tracking them.`;
    if (wasPaused) msg += ' Check MEXC\'s Positions and Open Orders before trading again.';
    finishGrid(g, msg + (problems ? ' ' + problems : ''), problems ? 'err' : 'ok');
  }

  // the editor's values, kept with the bot so it can be edited while it waits for its activation price
  const FIELDS_OF = mode => (mode === 'one' ? OFIELDS : GFIELDS);
  function editorSnapshot(mode = 'grid') {
    const d = cfg.draft || {}, O = mode === 'one';
    const snap = Object.fromEntries(FIELDS_OF(mode).map(f => [f, ui[f].value]));
    if (O) return { ...snap, oDir: d.oDir === 'up' ? 'up' : 'down', oSide: oneSide(), oLoop: d.oLoop === 'price' ? 'price' : 'tpsl', oUse: d.oUse !== false, oOv: JSON.parse(JSON.stringify(d.oOv || {})) };
    return { ...snap, aDir: d.aDir === 'up' ? 'up' : 'down', aUse: d.aUse !== false, aOv: JSON.parse(JSON.stringify(d.aOv || {})) };
  }
  const editable = g => !g.activated && (g.phase === 'armed' || g.phase === 'paused');
  const editKey = mode => (mode === 'one' ? 'oEditId' : 'gEditId');
  function editGrid(id) {
    const g = gById(id);
    if (!g || !editable(g)) return status('Only a bot that is still waiting for its activation price can be edited.', 'warn');
    if (!iAmBot && otherBotAlive()) return status('Edit it in the bot window.', 'warn');
    const mode = g.mode === 'one' ? 'one' : 'grid', K = editKey(mode);
    if (!cfg[K]) cfg[mode === 'one' ? 'oPrevDraft' : 'gPrevDraft'] = JSON.parse(JSON.stringify(cfg.draft || {}));
    const c = g.cfg || {};
    cfg[K] = id; cfg[mode === 'one' ? 'oEdit' : 'gEdit'] = true; cfg.tab = mode === 'one' ? 'one' : 'grid';
    cfg.draft = { ...cfg.draft, ...JSON.parse(JSON.stringify(c)) };
    if (mode === 'one') cfg.side = c.oSide || (g.levels[0].short ? 'short' : 'long');
    if (!g.cfg && mode === 'grid') cfg.draft = { ...cfg.draft, aAct: g.actStr, aFirst: g.levels[0].priceStr, aN: String(g.levels.length), aGap: String(g.gap), aDir: g.dir };
    FIELDS_OF(mode).forEach(f => { if (cfg.draft[f] != null) ui[f].value = cfg.draft[f]; });
    ui.aUse.checked = cfg.draft.aUse !== false; ui.oUse.checked = cfg.draft.oUse !== false;
    render(true);
    (mode === 'one' ? ui.oEditor : ui.gEditor).scrollIntoView({ block: 'nearest' });
  }
  function endEdit(mode = 'grid') {
    const K = editKey(mode), P = mode === 'one' ? 'oPrevDraft' : 'gPrevDraft';
    if (!cfg[K]) return;
    cfg[K] = null;
    if (cfg[P]) { cfg.draft = cfg[P]; cfg[P] = null; loadDraft(); }
    cfg[mode === 'one' ? 'oEdit' : 'gEdit'] = false;
    saveDraft(); render(true);
  }
  async function saveEdit(mode = 'grid') {
    const g = gById(cfg[editKey(mode)]);
    if (!g || !editable(g)) { endEdit(mode); return status('That bot is no longer waiting for its activation price; it was not changed.', 'err'); }
    let r;
    try { r = readBot(mode); } catch (e) { return status(`Bot: ${e.message}`, 'err'); }
    const clash = levelClash(r.levels, g.id);
    if (clash) return status(`Bot: ${clash}`, 'err');
    if (!(await claimBot())) return status('The bots run in another MEXC window (the bot window). Edit it there.', 'warn');
    const was = `${g.actStr} / grid 1 ${g.levels[0].priceStr}`;
    Object.assign(g, { dir: r.dir, act: r.act, actStr: r.actStr, noAct: !r.useAct, first: r.first, gap: r.gap, levels: r.levels, loop: r.loop, loopPx: r.loopPx, loopPxStr: r.loopPxStr,
                       cfg: editorSnapshot(mode), phase: 'armed', aLo: st.last, aHi: st.last, note: '' });
    endEdit(mode);
    if (!r.useAct) {
      Object.assign(g, { act: st.last, actStr: fmt(st.last) });
      gridMsg(g, `edited: no activation price any more — placing the orders now (market ${fmt(st.last)}).`, 'ok', 'info');
      return activate(g);
    }
    gridMsg(g, `edited (was ${was}): ${r.levels.length} grid(s) ${r.dir} from ${r.levels[0].priceStr}, gap ${pxs(r.gap)}. Waiting for the price to touch ${r.actStr}.`, 'ok', 'info');
    if (samePrice(st.last, r.act)) activate(g);
  }

  async function stopAll(mode) {
    const act = grids.filter(g => g.phase !== 'off' && g.phase !== 'stopping' && (!mode || (mode === 'one') === isOne(g)));
    if (!act.length) return;
    if (!confirm(`Stop all ${act.length} ${mode === 'one' ? 'one-direction' : 'grid'} bot(s)?\nTheir waiting orders are cancelled. Open positions stay open with their TP/SL.`)) return;
    for (const g of act) await stopGrid(g.id, true);
  }

  function finishGrid(g, msg, kind = 'ok') {
    g.phase = 'off';
    eachSlot(g, s => { if (s.state === 'busy' || s.state === 'retry' || s.state === 'check' || s.state === 'wait') s.state = 'idle'; });
    gridMsg(g, msg, kind, kind === 'err' ? 'crit' : 'info');
    releaseBot();
  }

  function pauseGrid(g, msg, quiet) {
    if (g.phase !== 'run' && g.phase !== 'armed') return;
    g.phase = 'paused';
    eachSlot(g, s => { if (s.state === 'busy' || s.state === 'check') s.state = 'retry'; });
    gridMsg(g, msg + ' Press Resume to continue, or Stop.', 'err', quiet ? 'note' : 'crit');
  }

  // compares MEXC's position on one side with the bot's open orders of that side; clears the side's pause when they match
  async function resyncSide(side) {
    const T = trk[side], size = readSize(side);
    if (size == null) return 'Can\'t read the Positions tab. Keep the bottom panel visible.';
    const fq = filledQty(side), mq = minQty(side), n = slotsOf(side).filter(x => x.s.state === 'filled').length;
    let ok;
    if (fq === 0) ok = !(size > 0);
    else if (!(size > 0)) ok = false;
    else if (T.k) ok = Math.abs(size / T.k - fq) < 0.5 * mq;
    else { T.k = size / fq; ok = true; }
    if (!ok) {
      return `MEXC shows ${size > 0 ? size + ' USDT' : 'no'} ${side} position, but the bot expects ${n ? n + ' open ' + side + '(s)' : 'none'}. ` +
        (size > 0 ? 'Fix it on MEXC, or use "Mark closed" on orders you closed yourself, then try again.'
                  : 'If those closed (TP, SL or by hand), press "Mark closed" on them, then try again.');
    }
    Object.assign(T, { bad: false, badMsg: '', seenV: null, seenN: 0 });
    return '';
  }
  async function resyncAll() {
    lookUntil = 0;
    await openBottomTab('Positions').catch(() => {});
    await sleep(300);
    const errs = [];
    for (const side of SIDES) { const e = await resyncSide(side); if (e) errs.push(e); }
    saveGrids();
    return errs.join(' ');
  }

  async function resumeGrid(id) {
    unlockAudio();
    const g = gById(id);
    if (!g || (g.phase !== 'paused' && g.phase !== 'off')) return;
    if (hedgeOn()) return status('Stop the hedge bot first: it uses the same long and short positions.', 'err');
    const clash = levelClash(g.levels, g.id);
    if (clash) return status(`Grid ${gTag(g)}: can't resume, ${clash}`, 'err');
    if (g.phase === 'off' && grids.filter(x => x.phase !== 'off').length >= MAX_BOTS) return status(`Up to ${MAX_BOTS} grid bots at the same time.`, 'err');
    if (!(await claimBot())) return status('The bots run in another MEXC window (the bot window). Press Resume there.', 'warn');
    const wasOff = g.phase === 'off';
    if (wasOff) {                                           // a stopped bot: its not-open orders are placed again (after the checks below)
      eachSlot(g, s => { if (s.state !== 'filled') s.state = 'retry'; });
      g.phase = 'paused';
    }
    if (!g.activated) {                                     // paused while still waiting for the activation price
      Object.assign(g, { phase: 'armed', aLo: st.last, aHi: st.last });
      return gridMsg(g, `armed again: waiting for the price to touch ${g.actStr}.`);
    }
    await waitFor(() => !working, 8000, 100);
    const err = await locked(async () => {
      // first MEXC's order lists: a waiting order that is gone has opened (e.g. while the bot couldn't read the positions);
      // an order that was being placed when the bot paused (or left after a stop) may already be there
      const lists = await readOrderLists();
      if (!lists) return 'Could not read Open Orders (Limit / Trigger Order) to check the orders. Try Resume again.';
      eachSlot(g, (s, lv, side) => {
        if (s.state === 'entry' && !stillWaiting(lists, lv, side, 'limit') && !stillWaiting(lists, lv, side, 'trigger')) {
          const seen = reachedEntry(s, lv.price);
          markFilled(s); s.assumed = true; s.unseen = !seen;
          log(`grid #${g.n} ${slotName(lv, side)}: no longer waiting on MEXC → counted as opened`);
        }
        if (s.state === 'retry') for (const kind of ['limit', 'trigger']) if (stillWaiting(lists, lv, side, kind)) Object.assign(s, { state: 'entry', kind, rLo: st.last, rHi: st.last });
      });
      // then explain any difference with the take profits and stop losses the price reached since (as while running)
      await backToPositions(); await sleep(300);
      for (const side of SIDES) {
        const T = trk[side], size = readSize(side), fq = filledQty(side);
        if (size == null) continue;
        const dq = T.k ? size / T.k - fq : size > 0 ? null : -fq;
        if (dq != null && Math.abs(dq) >= 0.5 * minQty(side)) { T.bad = false; resolveChange(side, dq, size); }
      }
      const e = await resyncAll();
      if (e) return e + ' (Orders that are no longer waiting on MEXC were counted as opened.)';
      for (const side of SIDES) confirmAssumed(side);
      return '';
    });
    if (err) {
      if (wasOff) { g.phase = 'off'; eachSlot(g, s => { if (s.state === 'retry') s.state = 'idle'; }); saveGrids(); render(); }
      return status(`Grid ${gTag(g)}: ${err}`, 'err');
    }
    g.phase = 'run';
    gridMsg(g, 'resumed. Both positions were checked against MEXC.');
    const todo = [];
    eachSlot(g, (s, lv, side) => { if (s.state === 'retry' || s.state === 'idle') todo.push([lv, side]); });
    queueMany(g, todo);
  }

  // ↻ Refresh: reads MEXC's Positions and Open Orders and corrects every bot's records. It places and cancels nothing itself
  // (a running bot then continues normally, e.g. places again a trade that closed).
  async function refreshBots() {
    unlockAudio();
    if (!grids.some(tracked)) return status('No bots to check.', 'ok');
    if (!(await claimBot())) return status('The bots run in another MEXC window (the bot window). Press Refresh there.', 'warn');
    status('Refresh: reading MEXC\'s Positions and Open Orders…', 'ok');
    await waitFor(() => !working, 8000, 100);
    const found = [], extra = [];
    const err = await locked(async () => {
      lookUntil = 0;
      const lists = await readOrderLists();
      if (!lists) return 'Could not read Open Orders (Limit / Trigger Order). Keep MEXC\'s bottom panel visible and try again.';
      for (const g of grids) if (tracked(g)) eachSlot(g, (s, lv, side) => {
        const kindThere = ['limit', 'trigger'].find(k => stillWaiting(lists, lv, side, k));
        if ((s.state === 'entry' || s.state === 'check') && !kindThere) {
          markFilled(s); s.assumed = true; s.unseen = !reachedEntry(s, lv.price);
          found.push(`#${g.n} ${side} ${lv.priceStr} opened`);
        } else if ((s.state === 'check' || s.state === 'retry') && kindThere) {
          Object.assign(s, { state: 'entry', kind: kindThere, tries: 0 });
          found.push(`#${g.n} ${side} ${lv.priceStr} is waiting on MEXC`);
        } else if (s.state === 'idle' && kindThere) extra.push(`#${g.n} ${side} ${lv.priceStr} (${kindThere})`);
      });
      await backToPositions(); await sleep(300);
      for (const side of SIDES) {
        const T = trk[side], size = readSize(side), fq = filledQty(side);
        if (size == null) continue;
        const dq = T.k ? size / T.k - fq : size > 0 ? null : -fq;
        if (dq != null && Math.abs(dq) >= 0.5 * minQty(side)) { T.bad = false; resolveChange(side, dq, size); }
      }
      return resyncAll();
    });
    for (const side of SIDES) confirmAssumed(side);
    saveGrids(); render();
    if (err) {
      for (const g of grids) if (g.phase === 'run') pauseGrid(g, 'Refresh found a difference with MEXC: ' + err, true);
      return alertUser('crit', 'Refresh: ' + err + (found.length ? ' Found: ' + found.join('; ') + '.' : ''));
    }
    if (extra.length) alertUser('warn', `Refresh: these orders are on MEXC but their bot doesn't use them (stopped bot?): ${extra.join(', ')}. Cancel them on MEXC if you don't want them.`);
    alertUser('good', 'Refresh: the bots match MEXC.' + (found.length ? ' Corrected: ' + found.join('; ') + '.' : ' Nothing to correct.'));
  }

  // for a stopped bot that still has open orders (or after a refresh)
  async function recheckSides() {
    if (!(await claimBot())) return status('The bots run in another MEXC window (the bot window). Re-check there.', 'warn');
    await waitFor(() => !working, 8000, 100);
    const err = await locked(() => resyncAll());
    if (err) return status(err, 'err');
    status('Long and short positions match MEXC. Tracking continues.', 'ok');
    render();
  }

  // the user closed an open long/short by hand (or MEXC closed it while nobody watched)
  async function markClosed(id, i, side, fromViewer) {
    const g = gById(id), lv = g && g.levels.find(l => l.i === i), s = lv && lv[side];
    if (!s || s.state !== 'filled') return;
    if (!fromViewer && !confirm(`Mark grid ${gTag(g)}: ${side} at ${lv.priceStr} as closed?\nOnly do this if it is no longer open on MEXC.`)) return;
    if (!(await viaBot({ cmd: 'mark', id, i, side }))) return;
    s.state = g.phase === 'paused' ? 'retry' : 'idle'; s.assumed = false; s.unseen = false;
    gridMsg(g, `${side} at ${lv.priceStr} marked as closed${g.phase === 'paused' ? '; it is placed again when you press Resume' : ''}.`);
  }

  function removeGrid(id) {
    const g = gById(id);
    if (!g || g.phase !== 'off') return;
    if (nOpen(g)) return status(`Grid ${gTag(g)} still has open orders on MEXC. Remove it after they close (or "Mark closed").`, 'warn');
    grids = grids.filter(x => x.id !== id);
    if (ui.openGrid === id) ui.openGrid = null;
    saveGrids(); render();
  }
  function clearStopped(mode) {
    const n = grids.length;
    grids = grids.filter(g => tracked(g) || (mode && (mode === 'one') !== isOne(g)));
    saveGrids(); render();
    status(n - grids.length ? `Removed ${n - grids.length} stopped bot(s).` : 'No stopped bots to remove.', 'ok');
  }

  // ================================================================ tests and checks
  // fills MEXC's Limit form (long) and Trigger form (short) with TP and SL, without ordering anything
  async function testForms() {
    if (st.busy || working) return;
    st.busy = true;
    const p = st.last || 100, out = [];
    try {
      await switchAction('open', 'long');
      const f1 = await prepareForm('Limit', 'long'), b1 = await syncTpsl(f1, true);
      const v1 = [[f1.price, fmt(p * 0.99)], [f1.qty, '20'], [b1.tp, fmt(p)], [b1.sl, fmt(p * 0.97)]];
      writeFields(v1); await sleep(120);
      if (!fieldsMatch(v1)) throw new Error('MEXC did not keep price + amount + TP + SL in the Limit form.');
      out.push('Limit form OK');
      await switchAction('open', 'short');
      await ensureMarket(await prepareForm('Trigger', 'short'));
      const f2 = await prepareForm('Trigger', 'short'), b2 = await syncTpsl(f2, true);
      const v2 = [[f2.trig, fmt(p * 0.99)], [f2.qty, '20'], [b2.tp, fmt(p * 0.98)], [b2.sl, fmt(p * 1.01)]];
      writeFields(v2); await sleep(120);
      if (!fieldsMatch(v2) || !triggerIsMarket(f2)) throw new Error('MEXC did not keep trigger price + Market + amount + TP + SL in the Trigger form.');
      out.push('Trigger form (Market) OK');
      await prepareForm('Limit', 'long').catch(() => {});
      const lists = await readOrderLists();
      out.push(lists ? `order lists readable (${lists.lim.length} limit, ${lists.trg.length} trigger)` : 'order lists NOT readable');
      await openBottomTab('Positions').catch(() => {});
      await sleep(200);
      const sz = SIDES.map(readSize);
      out.push(`positions readable: ${sz.every(v => v != null) ? 'yes' : 'NO (open the Positions tab)'}`);
      status('Test: ' + out.join(' · ') + '. Nothing was ordered.', lists && sz.every(v => v != null) ? 'ok' : 'warn');
    } catch (e) {
      status('Test FAILED: ' + e.message + (out.length ? ` (${out.join(', ')})` : '') + ' Press Copy log and send it to the developer.', 'err');
    } finally { st.busy = false; }
  }

  function checkPage() {
    const lines = [];
    try {
      const { root } = findForm('long', 'open');
      const p = onTriggerForm(root) ? null : findPriceInput(root);
      const q = findQtyInput(root, [p].filter(Boolean));
      lines.push(`Order form: found · Price box: ${p ? 'found' : 'not found (Trigger tab?)'} · Quantity: ${q ? (q.usdt ? 'USDT' : 'NOT USDT') : 'not found'}`);
      const s = readSetup(root);
      lines.push(`MEXC leverage: ${s.lev ? s.lev + 'x' : '?'}, margin: ${s.margin || '?'}`);
      const pc = tabCount('Positions'), oo = tabCount('Open Orders');
      lines.push(`Positions: ${pc ? pc.n : 'tab not found'}, open orders: ${oo ? oo.n : 'tab not found'}`);
      for (const sd of SIDES) {
        const v = readSize(sd), T = trk[sd];
        lines.push(`${sideWord(sd)} position: ${v == null ? 'not readable' : v + ' USDT'}` +
          (grids.some(tracked) ? ` · bot expects ${filledQty(sd)} USDT of open ${sd}s${T.k ? ` (×${T.k.toFixed(3)})` : ''}${T.bad ? ' · PAUSED' : ''}` : ''));
      }
      lines.push(`Price source: ${st.last ? st.src : 'none yet'}`);
      status(lines.join('\n'), s.block ? 'warn' : 'ok');
    } catch (e) {
      lines.push(e.message);
      status(lines.join('\n'), 'err');
    }
  }

  // ================================================================ HEDGE BOT (v7)
  // Long and short at the same entry, same amount, each with its own SL (entry ∓ SL gap) attached.
  // Entries are MEXC Trigger orders (trigger = entry, execution = Market), so both open together at the entry
  // whichever side of it the market is on. TP is added by hand on MEXC after a position opens.
  // When a side's SL is hit, the same trigger order is placed again for that side. Repeats until Stop.
  // A side closed by TP or by hand is NOT re-opened (it waits; press "Re-arm" to open it again).
  // "Apply values" changes entry / SL gap / amount for the next re-entries and replaces waiting trigger orders.
  const HEDGE0 = { phase: 'off', sym: null, lev: null, entry: null, entryStr: '', gap: null, qty: null, note: '',
                   sides: { long: { state: 'idle', sls: 0, pnl: 0 }, short: { state: 'idle', sls: 0, pnl: 0 } } };
  let hedge = JSON.parse(JSON.stringify(HEDGE0));
  const hedgeOn = () => hedge.phase !== 'off';
  const hSL = (side, h = hedge) => side === 'long' ? h.entry - h.gap : h.entry + h.gap;
  const saveHedge = () => { if (iAmBot) storeSet('mqlHedge7', hedge); };
  function hMsg(msg, kind = 'ok') {
    hedge.note = msg; status('Hedge: ' + msg, kind);
    alertUser(kind === 'err' ? 'crit' : kind === 'warn' ? 'warn' : 'note', 'Hedge: ' + msg);
    saveHedge(); render();
  }

  const hq = [];
  let hWorking = false;
  function hEnqueue(name, fn) { hq.push({ name, fn }); if (!hWorking) hWork(); }
  async function hWork() {
    hWorking = true;
    while (hq.length) {
      const job = hq.shift();
      if (hedge.phase !== 'run' && !job.always) continue;
      try { await job.fn(); }
      catch (e) { log(`hedge ${job.name} failed: ${e.message}`); hPause(`${job.name} failed: ${e.message}`); }
    }
    hWorking = false;
    await backToPositions();
    render();
  }

  // one side's position card: size, TP and SL as shown on MEXC (null = not readable)
  function readSideCard(side) {
    const size = readSize(side);
    if (size == null || size === 0) return { size, tp: null, sl: null, slMissing: false };
    const pc = tabCount('Positions'), cards = pc && positionCards(pc);
    for (const { card, side: s } of cards || []) {
      if (s !== side) continue;
      const tl = textEls(/^TP\s*\/\s*SL$/i, card)[0];
      if (!tl) return { size, tp: null, sl: null, slMissing: false };
      let txt = '';
      for (let p = tl.parentElement, i = 0; p && i < 3 && !/\//.test(txt.replace(/TP\s*\/\s*SL/i, '')); p = p.parentElement, i++) txt = norm(p.textContent);
      const parts = txt.replace(/TP\s*\/\s*SL/i, '').split('/');
      const tp = num(parts[0]), sl = num(parts[1]);
      return { size, tp: tp > 0 ? tp : null, sl: sl > 0 ? sl : null, slMissing: parts.length >= 2 && !(sl > 0) };
    }
    return { size, tp: null, sl: null, slMissing: false };
  }

  // Open Orders → Trigger Order rows: [{ dir, price, row }]
  async function showTriggerOrders() {
    const sub = () => subTab('Trigger Order');
    if (!sub()) { await openBottomTab('Open Orders'); await waitFor(sub, 1000, 50); }
    const s = sub();
    if (!s) throw new Error('"Trigger Order" list not found in MEXC\'s Open Orders.');
    clickEl(s);
    await sleep(300);
  }
  const TRIG_RE = /^(?:Last|Mark|Fair|Index)\s*Price\s*(?:[<>≤≥]=?|=)\s*([\d,]+(?:\.\d+)?)(?:\s*USDT)?$/i;
  function trigCells(root = document.body) {
    const out = new Set();
    for (const el of textEls(/(Last|Mark|Fair|Index)\s*Price/i, root)) {
      for (let e = el, i = 0; e && i < 3; e = e.parentElement, i++) {
        const t = norm(e.textContent);
        if (t.length > 60) break;
        if (TRIG_RE.test(t)) { out.add(e); break; }
      }
    }
    return [...out].filter(e => ![...out].some(o => o !== e && e.contains(o)));   // innermost element per row
  }
  function scanTriggers() {
    if (!subTab('Trigger Order')) return null;
    const out = scanTriggersIn(listRoot('Trigger Order'));
    const n = subCount('Trigger Order');
    return n != null && out.length < n ? scanTriggersIn(document.body) : out;
  }
  function scanTriggersIn(root) {
    const out = [];
    for (const c of trigCells(root)) {
      let row = c, dir = null;
      for (let i = 0; i < 8 && row.parentElement && !dir; i++) {
        row = row.parentElement;
        const hits = Object.keys(DIRS).filter(k => DIRS[k].test(row.textContent));
        if (hits.length === 1) dir = hits[0]; else if (hits.length > 1) break;
      }
      if (dir) out.push({ dir, price: num(norm(c.textContent).match(TRIG_RE)[1]), row });
    }
    return out;
  }
  const findTrig = (rows, side, price) => rows && rows.find(r => r.dir === dirKey('open', side) && samePrice(r.price, price));

  async function cancelTrigger(side, price) {
    await showTriggerOrders();
    const rows = await waitFor(() => scanTriggers(), 1500, 100);
    if (!rows) throw new Error('could not read Open Orders → Trigger Order');
    const r = findTrig(rows, side, price);
    if (!r) return 'none';
    const icons = [...r.row.querySelectorAll('svg,img,i,[class*="icon" i],[class*="delete" i],[class*="trash" i]')]
      .filter(visible).filter(el => !el.parentElement || !el.parentElement.closest('svg'));
    const trash = icons[icons.length - 1];
    if (!trash) throw new Error('Cancel icon not found on the trigger order row.');
    clickEl(trash.closest('button,[role="button"],a') || trash);
    await sleep(400);
    const ok = textEls(/^(Confirm|OK|Yes)$/i).find(el => el.closest('[role="dialog"],[class*="modal" i],[class*="dialog" i]'));
    if (ok) { clickEl(ok.closest('button') || ok); await sleep(300); }
    const gone = await waitFor(() => !findTrig(scanTriggers(), side, price), 3000, 100);
    if (!gone) throw new Error(`${side} trigger order at ${fmt(price)} is still listed after cancelling.`);
    return 'cancelled';
  }

  // trigger = entry, execution = Market, amount, SL attached, TP empty
  async function placeHedgeTrigger(side, h = hedge) {
    const sd = h.sides[side];
    const slStr = fmt(hSL(side, h));
    await switchAction('open', side);
    const before = (tabCount('Open Orders') || {}).n ?? 0;
    for (let attempt = 1; attempt <= 3; attempt++) {
      await ensureMarket(await prepareForm('Trigger', side));
      const form = await prepareForm('Trigger', side);           // fresh boxes after the Market click
      const boxes = await syncTpsl(form, true);
      const fields = [[form.trig, h.entryStr], [form.qty, h.qty], [boxes.sl, slStr]];
      writeFields(fields);
      setValue(boxes.tp, '');
      await sleep(attempt === 1 ? 80 : 200);
      if (!fieldsMatch(fields) || cleanNum(boxes.tp.value) || !triggerIsMarket(form)) { log(`hedge ${side}: form check failed, attempt ${attempt}`); continue; }
      (visible(form.btn) ? form.btn : findForm(side).btn).click();
      const ok = await waitFor(() => ((tabCount('Open Orders') || {}).n ?? 0) > before || (readSize(side) ?? 0) > 0, 4000, 100);
      if (!ok) throw new Error(`MEXC did not show the ${side} trigger order (trigger ${h.entryStr}, market, SL ${slStr})`);
      Object.assign(sd, { state: 'waiting', trigAt: h.entry, wHi: st.last, wLo: st.last, rtQueued: false });
      log(`hedge ${side}: trigger ${h.entryStr} placed, market, ${h.qty} USDT, SL ${slStr}`);
      hMsg(`${side} trigger placed: at ${h.entryStr} open ${side} at market, ${h.qty} USDT, SL ${slStr}.`);
      return;
    }
    throw new Error(`MEXC did not keep the ${side} trigger values (trigger ${h.entryStr}, ${h.qty} USDT, SL ${slStr})`);
  }
  function hQueuePlace(side) { hedge.sides[side].state = 'busy'; hEnqueue(`${sideWord(side)} trigger`, () => placeHedgeTrigger(side)); }

  function hOnOpened(side) {
    const sd = hedge.sides[side];
    Object.assign(sd, { state: 'open', lo: st.last, hi: st.last, warnedSl: false, openedAt: Date.now() });
    sound('entry');
    hMsg(`${side} opened (trigger ${hedge.entryStr}). SL ${fmt(hSL(side))} is set. Add your TP on MEXC — keep the SL.`);
  }

  function hOnClosed(side) {
    const sd = hedge.sides[side], L = side === 'long', sl = hSL(side), tol = tickHalf() + hedge.gap * 0.02;
    const reachedSl = L ? sd.lo <= sl + tol : sd.hi >= sl - tol;
    const nowLossSide = L ? st.last < hedge.entry : st.last > hedge.entry;
    if (reachedSl && nowLossSide) {
      const loss = hedge.qty * hedge.gap / hedge.entry;
      sd.sls++; sd.pnl -= loss;
      sound('sl');
      hMsg(`${side} SL ${fmt(sl)} hit (≈ −${loss.toFixed(4)} USDT before fees). Re-placing the ${side} trigger at ${hedge.entryStr}.`, 'warn');
      hQueuePlace(side);
    } else {
      sd.state = 'closed';
      sound('tp');
      hMsg(`${side} closed at about ${fmt(st.last)} (TP or by hand). Not re-opened. Press "Re-arm ${side}" to place its trigger again.`, 'ok');
    }
  }

  // trigger fired and SL hit between two looks: position never seen. Check the trigger list.
  async function hRoundTrip(side) {
    const sd = hedge.sides[side];
    sd.rtQueued = false;
    if (looking() || (readSize(side) ?? 1) !== 0) return;
    await showTriggerOrders();
    const rows = scanTriggers();
    if (!rows) throw new Error('could not read Open Orders → Trigger Order');
    if (findTrig(rows, side, sd.trigAt ?? hedge.entry)) {         // still waiting: the price only passed by
      sd.wHi = sd.wLo = st.last; sd.rtQueued = false;
      await backToPositions(); return;
    }
    const loss = hedge.qty * hedge.gap / hedge.entry;
    sd.sls++; sd.pnl -= loss;
    sound('sl');
    hMsg(`${side} opened and hit its SL between two checks (≈ −${loss.toFixed(4)} USDT). Re-placing its trigger.`, 'warn');
    await placeHedgeTrigger(side);
  }

  function hTickSide(side) {
    const sd = hedge.sides[side], L = side === 'long';
    if (st.last > 0) { sd.hi = Math.max(sd.hi ?? st.last, st.last); sd.lo = Math.min(sd.lo ?? st.last, st.last); }
    const card = readSideCard(side);
    if (card.size == null) return 'unread';
    if (card.size === sd.seenV) sd.seenN = (sd.seenN || 0) + 1; else { sd.seenV = card.size; sd.seenN = 1; }
    if (sd.state === 'waiting' && st.last > 0) {               // fast-spike watch: price range since the trigger was placed
      const at = sd.trigAt ?? hedge.entry, slp = hSL(side);
      sd.wHi = Math.max(sd.wHi ?? st.last, st.last); sd.wLo = Math.min(sd.wLo ?? st.last, st.last);
      const coveredEntry = sd.wLo <= at + tickHalf() && sd.wHi >= at - tickHalf();
      const coveredSl = L ? sd.wLo <= slp + tickHalf() : sd.wHi >= slp - tickHalf();
      if (coveredEntry && coveredSl && !sd.rtQueued && card.size === 0 && !looking()) { sd.rtQueued = true; hEnqueue(`${sideWord(side)} spike check`, () => hRoundTrip(side)); }
    }
    if (sd.seenN < 2) return;
    if (sd.state === 'waiting' && card.size > 0) return hOnOpened(side);
    if (sd.state === 'open' && card.size === 0) return hOnClosed(side);
    if (sd.state === 'open' && card.slMissing && !sd.warnedSl) {
      sd.warnedSl = true; sound('error');
      hMsg(`⚠ The ${side} position shows NO stop loss on MEXC. Adding the TP may have removed it. Set SL ${fmt(hSL(side))} again on MEXC.`, 'err');
    }
  }

  function hedgeTick() {
    if (!iAmBot || hedge.phase !== 'run' || hWorking || uiLock) return;
    if (st.sym !== hedge.sym) return hPause(`the page shows ${st.sym}, but the hedge trades ${hedge.sym}. Go back to ${hedge.sym}.`);
    let unread = 0;
    for (const side of ['long', 'short']) {
      if (hTickSide(side) === 'unread') unread++;
      if (hWorking) return;                                 // a queued check is using the bottom panel now
    }
    if (unread) { if (looking()) return; if (++hedge.unread % 20 === 1) openBottomTab('Positions').catch(() => {}); if (hedge.unread === 60) status('Hedge: can\'t read the long/short positions. Keep the bottom panel on Positions. Check page and Copy log.', 'warn'); }
    else hedge.unread = 0;
  }

  function readHedge() {
    const e = num(ui.hEntry.value), gap = num(ui.hGap.value), qty = num(ui.hQty.value);
    if (!(e > 0) || !(gap > 0) || !(qty > 0)) throw new Error('Fill in entry price, SL gap and amount.');
    if (!(e - gap > 0)) throw new Error('SL gap is larger than the entry price.');
    return { entry: e, entryStr: fmt(e), gap, qty };
  }

  async function startHedge() {
    unlockAudio();
    if (hedgeOn()) return;
    if (grids.some(tracked)) return status('Stop the grids first (and let their open levels close): the hedge bot uses the same long and short positions.', 'err');
    let v;
    try { v = readHedge(); } catch (e) { return status('Hedge: ' + e.message, 'err'); }
    if (!(st.last > 0)) return status('No market price yet.', 'err');
    if (samePrice(st.last, v.entry)) return status('The entry equals the current price. Use a price above or below the market.', 'err');
    const sL = readSize('long'), sS = readSize('short');
    if (sL == null || sS == null) return status('Open MEXC\'s Positions tab at the bottom first.', 'err');
    if (sL > 0 || sS > 0) return status('Close open positions first. The hedge bot needs a clean start.', 'err');
    if (!(await claimBot())) return status('Bots run in another MEXC window (the bot window). Start the hedge there.', 'warn');
    const lev = (() => { try { return readSetup(findForm('long').root, 'long').lev; } catch (_) { return null; } })();   // shown only
    hedge = { ...JSON.parse(JSON.stringify(HEDGE0)), phase: 'run', sym: st.sym, lev, ...v, unread: 0 };
    hMsg(`started${lev ? ` (MEXC ${lev}x)` : ''}: long and short at ${v.entryStr}, ${v.qty} USDT each, SL ${fmt(hSL('long'))} / ${fmt(hSL('short'))}.`);
    hQueuePlace('long');
    hQueuePlace('short');
  }

  async function applyHedge() {
    if (hedge.phase !== 'run') return status('Apply works while the hedge is running. Use Start for a new hedge.', 'warn');
    let v;
    try { v = readHedge(); } catch (e) { return status('Hedge: ' + e.message, 'err'); }
    if (!confirm(`Use entry ${v.entryStr}, SL gap ${v.gap}, ${v.qty} USDT from now on?\nWaiting trigger orders are replaced. Open positions keep their current SL.`)) return;
    hEnqueue('Apply values', async () => {
      const old = { entry: hedge.entry };
      Object.assign(hedge, v);
      for (const side of ['long', 'short']) {
        const sd = hedge.sides[side];
        if (sd.state !== 'waiting') continue;
        await cancelTrigger(side, sd.trigAt ?? old.entry);
        await placeHedgeTrigger(side);
      }
      await backToPositions();
      hMsg(`new values in use: entry ${hedge.entryStr}, SL gap ${hedge.gap}, ${hedge.qty} USDT. Open positions keep their own SL.`);
    });
  }

  function rearm(side) {
    if (hedge.phase !== 'run') return;
    const sd = hedge.sides[side];
    if (sd.state !== 'closed' && sd.state !== 'idle') return;
    if (((readSize(side)) ?? 1) > 0) return status(`The ${side} position is still open.`, 'warn');
    hQueuePlace(side);
  }

  async function stopHedge() {
    if (!hedgeOn() || hedge.phase === 'stopping') return;
    if (!iAmBot) {
      if (otherBotAlive()) { storeSet('mqlCmd', { to: leader.id, cmd: 'hstop', ts: Date.now() }); return status('Stop sent to the bot window (hedge).', 'ok'); }
      if (!(await claimBot())) return status('Could not reach the bot window.', 'err');
    }
    hedge.phase = 'stopping';
    render();
    await waitFor(() => !hWorking, 8000, 100);
    const bad = [];
    for (const side of ['long', 'short']) {
      const sd = hedge.sides[side];
      try { await cancelTrigger(side, sd.trigAt ?? hedge.entry); if (sd.state === 'waiting' || sd.state === 'busy') sd.state = 'idle'; }
      catch (e) { bad.push(`${side}: ${e.message}`); }
    }
    await backToPositions();
    const open = ['long', 'short'].filter(sd => (readSize(sd) ?? 0) > 0);
    hedge.phase = 'off';
    sound(bad.length ? 'error' : 'stop');
    hMsg('stopped. Waiting trigger orders cancelled.' + (open.length ? ` Open ${open.join(' and ')} position(s) stay open with their SL.` : '') +
      (bad.length ? ` Could not cancel: ${bad.join('; ')} Cancel by hand in Open Orders → Trigger Order.` : ''), bad.length ? 'err' : 'ok');
    releaseBot();
  }

  function hPause(msg) {
    if (hedge.phase !== 'run') return;
    hedge.phase = 'paused';
    hq.length = 0;
    for (const side of ['long', 'short']) if (hedge.sides[side].state === 'busy') hedge.sides[side].state = 'retry';
    hMsg(msg + ' Press Resume to continue, or Stop.', 'err');
  }

  // Resume: rebuild each side from MEXC (position open? trigger order waiting?)
  async function resumeHedge() {
    unlockAudio();
    if (hedge.phase !== 'paused') return;
    if (!(await claimBot())) return status('Bots run in another MEXC window (the bot window). Press Resume there.', 'warn');
    lookUntil = 0;
    let rows = null;
    try { await showTriggerOrders(); rows = scanTriggers(); } catch (e) { return status(e.message, 'err'); }
    await openBottomTab('Positions').catch(() => {});
    await sleep(300);
    const todo = [];
    for (const side of ['long', 'short']) {
      const sd = hedge.sides[side], size = readSize(side);
      if (size == null) return status('Can\'t read the Positions tab. Keep the bottom panel visible.', 'err');
      sd.seenV = null; sd.seenN = 0; sd.hi = sd.lo = st.last;
      if (size > 0) { sd.state = 'open'; continue; }
      if (findTrig(rows, side, sd.trigAt ?? hedge.entry)) { sd.state = 'waiting'; continue; }
      if (sd.state === 'open') { todo.push(['closed', side]); continue; }   // closed while paused
      if (sd.state === 'closed' || sd.state === 'idle') continue;
      todo.push(['place', side]);
    }
    hedge.phase = 'run';
    hMsg('resumed. Both sides were re-read from MEXC.');
    for (const [what, side] of todo) { if (what === 'place') hQueuePlace(side); else hOnClosed(side); }
  }

  async function testHedge() {
    if (st.busy || hWorking) return;
    st.busy = true;
    try {
      const v = readHedge(), side = cfg.side;
      const h = { ...v, sides: { long: {}, short: {} } };
      await switchAction('open', side);
      await ensureMarket(await prepareForm('Trigger', side));
      const form = await prepareForm('Trigger', side);
      const boxes = await syncTpsl(form, true);
      const fields = [[form.trig, h.entryStr], [form.qty, h.qty], [boxes.sl, fmt(hSL(side, h))]];
      writeFields(fields); setValue(boxes.tp, '');
      await sleep(150);
      if (!fieldsMatch(fields) || !triggerIsMarket(form)) throw new Error('MEXC did not keep trigger price, Market, amount and SL in the Trigger form.');
      await showTriggerOrders();
      const rows = scanTriggers();
      await openBottomTab('Positions').catch(() => {});
      status(`Test OK (${side}): MEXC's Trigger form is filled (trigger ${h.entryStr}, Market, ${h.qty} USDT, SL ${fmt(hSL(side, h))}). ` +
        `Trigger Order list readable: ${rows ? 'yes, ' + rows.length + ' row(s)' : 'NO'}. Nothing was ordered.`, rows ? 'ok' : 'warn');
    } catch (e) {
      status('Test FAILED: ' + e.message + ' Press Copy log and send it to the developer.', 'err');
    } finally { st.busy = false; }
  }

  // ================================================================ panel UI
  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
    .card { width: 300px; max-height: calc(100vh - 20px); overflow-y: auto; background: #232731; color: #e6e8ec;
            border: 1px solid #3a4050; border-radius: 10px; box-shadow: 0 10px 30px rgba(0,0,0,.45); font-size: 12.5px; }
    .card.running { border-color: #f0b90b; }
    .head { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; gap: 6px; padding: 7px 8px 7px 10px;
            background: #1b1e26; cursor: grab; user-select: none; touch-action: none; }
    .head:active { cursor: grabbing; }
    .title { font-weight: 600; font-size: 13px; white-space: nowrap; }
    .sym { color: #8d94a3; flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .rbadge { display: none; color: #f0b90b; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 110px; }
    .card.running .rbadge { display: inline; }
    .hbtn { flex: none; width: 28px; height: 26px; display: grid; place-items: center; background: #2b303c; border: 0;
            border-radius: 6px; color: #c9ced8; font-size: 15px; line-height: 1; cursor: pointer; }
    .hbtn:hover { background: #3a4050; color: #fff; }
    .hprice { display: none; font-weight: 600; font-variant-numeric: tabular-nums; color: #e6e8ec; }
    .card.small .hprice { display: inline; }
    .card.small { width: auto !important; height: auto !important; min-width: 236px; }
    .card.small.has-bots { min-width: 352px; }
    .rz { position: absolute; z-index: 2; }
    .rz-r { top: 40px; right: -4px; width: 8px; bottom: 16px; cursor: ew-resize; }
    .rz-b { left: 16px; right: 16px; bottom: -4px; height: 8px; cursor: ns-resize; }
    .rz-c { right: 0; bottom: 0; width: 18px; height: 18px; cursor: nwse-resize; border-bottom-right-radius: 10px;
            background: linear-gradient(135deg, transparent 50%, #5a6273 50%, #5a6273 58%, transparent 58%, transparent 70%, #5a6273 70%, #5a6273 78%, transparent 78%); }
    .rz-c:hover { background-color: #2b303c; }
    :host(.small-view) .rz { display: none; }
    .unit { align-self: center; color: #8d94a3; padding: 0 4px; }
    .bubble { position: fixed; z-index: 2147483646; width: 52px; height: 52px; border-radius: 50%; border: 2px solid #3a4050;
              background: #1b1e26; color: #fff; font: 700 14px -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
              box-shadow: 0 6px 20px rgba(0,0,0,.5); cursor: pointer; display: grid; place-items: center; user-select: none; touch-action: none; }
    .bubble:hover { border-color: #8d94a3; }
    .bubble.running { border-color: #f0b90b; }
    .bubble.alarm { border-color: #f6465d; animation: pulse 1s infinite; }
    .bubble .dot { position: absolute; top: 3px; right: 3px; width: 11px; height: 11px; border-radius: 50%; background: #f0b90b; display: none; }
    .bubble.running .dot { display: block; }
    @keyframes pulse { 50% { box-shadow: 0 0 0 7px rgba(246,70,93,.35); } }
    .body { padding: 10px; display: grid; gap: 9px; }
    .card.small .body { display: none; }
    .tick { display: flex; align-items: baseline; justify-content: space-between; }
    .last { font-size: 20px; font-weight: 600; font-variant-numeric: tabular-nums; }
    .src { color: #8d94a3; font-size: 11px; }
    .grid2 { display: grid; grid-template-columns: 1fr minmax(120px, 48%); gap: 6px 8px; align-items: center; }
    label { color: #b4bac6; display: flex; flex-direction: column; gap: 1px; }
    label small { color: #7b8291; font-size: 10.5px; font-variant-numeric: tabular-nums; }
    label small.warn { color: #f0b90b; }
    .pair { display: flex; gap: 4px; }
    input[type="text"] { width: 100%; min-width: 0; background: #171a21; border: 1px solid #3a4050; color: #fff; border-radius: 6px;
            padding: 6px 8px; font-size: 13px; font-variant-numeric: tabular-nums; text-align: right; outline: none; }
    input[type="text"]:focus { border-color: #8d94a3; }
    input:disabled, button:disabled { opacity: .5; cursor: default; }
    .mkt { flex: none; border: 0; background: #343a48; color: #fff; border-radius: 6px; padding: 0 7px; font-size: 11px; cursor: pointer; }
    .sect { border-top: 1px solid #323846; padding-top: 9px; display: grid; gap: 6px; }
    .switch { display: flex; align-items: center; gap: 8px; cursor: pointer; color: #e6e8ec; flex-direction: row; }
    .switch input { accent-color: #2ebd85; width: 15px; height: 15px; margin: 0; }
    .tp small { color: #2ebd85; } .sl small { color: #f6465d; }
    .off { display: none !important; }
    .checks { display: flex; gap: 6px; flex-wrap: wrap; }
    .chip { padding: 2px 7px; border-radius: 5px; background: #2b303c; color: #b4bac6; font-size: 11px; }
    .chip.good { color: #2ebd85; } .chip.bad { color: #f6465d; background: #f6465d1f; }
    .seg { display: grid; grid-template-columns: 1fr 1fr; background: #171a21; border-radius: 7px; padding: 3px; }
    .seg button { border: 0; background: none; color: #8d94a3; padding: 6px; border-radius: 5px; cursor: pointer; font-size: 12px; }
    .seg button.on { background: #343a48; color: #fff; }
    .side button { font-weight: 600; font-size: 13px; padding: 7px; }
    .side button.on[data-side="long"] { background: #2ebd85; color: #0d1f17; }
    .side button.on[data-side="short"] { background: #f6465d; color: #fff; }
    .tabs { display: flex; gap: 12px; border-bottom: 1px solid #323846; }
    .tabs button { background: none; border: 0; color: #8d94a3; padding: 4px 0 7px; font-size: 13px; font-weight: 600; cursor: pointer; border-bottom: 2px solid transparent; }
    .tabs button.on { color: #fff; border-bottom-color: #f0b90b; }
    #go { border-radius: 7px; padding: 10px; font-size: 14px; font-weight: 600; cursor: pointer;
          border: 1px solid var(--c); background: transparent; color: var(--c); }
    .card.auto #go { background: var(--c); color: var(--on); }
    #go small { display: block; font-weight: 400; font-size: 10.5px; opacity: .75; margin-top: 2px; }
    .levels { background: #1b1e26; border-radius: 7px; padding: 6px 8px; display: grid; gap: 2px; font-size: 11.5px;
              font-variant-numeric: tabular-nums; color: #b4bac6; }
    .levels .lv { display: grid; grid-template-columns: 22px 1fr auto; gap: 6px; }
    .levels .lv b { color: #fff; font-weight: 600; }
    .st-idle { color: #7b8291; } .st-filled { color: #2ebd85; } .st-retry { color: #f6465d; } .st-entry { color: #8ab4ff; } .st-tp { color: #2ebd85; } .st-pending { color: #f0b90b; } .st-busy { color: #c9ced8; }
    .stats { font-size: 11.5px; color: #b4bac6; font-variant-numeric: tabular-nums; }
    .stats b { color: #fff; }
    .gbtns { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
    .gbtns button { border: 0; border-radius: 6px; padding: 8px; font-size: 12.5px; font-weight: 600; cursor: pointer; }
    #gstart, #ostart { background: #f0b90b; color: #1d1a10; }
    .gbtns .sec { background: #343a48; color: #fff; }
    /* grids: top bar, editor, cards */
    .gtop { display: flex; align-items: center; gap: 8px; }
    .gtop .ttl { flex: 1; font-weight: 600; color: #e6e8ec; }
    .gtop .ttl small { color: #7b8291; font-weight: 400; margin-left: 4px; }
    .newbtn { border: 1px dashed #6b7385; background: transparent; color: #f0b90b; border-radius: 6px; padding: 5px 10px;
              font-size: 12px; font-weight: 600; cursor: pointer; white-space: nowrap; }
    .newbtn:hover:not(:disabled) { border-color: #f0b90b; background: #f0b90b14; }
    .editor { border: 1px solid #3a4050; border-radius: 8px; padding: 8px; display: grid; gap: 7px; background: #1f232c; }
    .edhead { display: flex; align-items: center; gap: 6px; }
    .edhead b { flex: 1; font-size: 12.5px; }
    .tag { display: inline-block; min-width: 18px; padding: 1px 5px; border-radius: 4px; font-size: 10.5px; font-weight: 700; text-align: center; }
    .tag.long { background: #2ebd8526; color: #2ebd85; } .tag.short { background: #f6465d26; color: #f6465d; } .tag.hedge { background: #8ab4ff26; color: #8ab4ff; }
    .glist { display: grid; gap: 6px; }
    .gsec { color: #7b8291; font-size: 10.5px; text-transform: none; margin: 2px 0 -2px 2px; }
    .gcard { border: 1px solid #323846; border-radius: 8px; background: #1f232c; overflow: hidden; }
    .gcard.open { border-color: #4a5266; }
    .gcard.paused { border-color: #f6465d; }
    .ghead { display: grid; grid-template-columns: auto auto minmax(0,1fr) auto 12px; gap: 3px 6px; align-items: center;
             padding: 7px 8px; cursor: pointer; font-variant-numeric: tabular-nums; }
    .ghead .sub { grid-column: 2 / 6; display: flex; gap: 8px; align-items: center; font-size: 11px; color: #8d94a3; }
    .ghead .sub .pnl { margin-left: auto; }
    .ghead:hover { background: #262b35; }
    .ghead .n { color: #8d94a3; font-size: 11px; }
    .rng { color: #c9ced8; font-size: 11.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .pill { font-size: 10.5px; padding: 1px 6px; border-radius: 99px; background: #2b303c; color: #b4bac6; white-space: nowrap; text-align: center; }
    .pill.run { background: #2ebd8522; color: #2ebd85; } .pill.paused { background: #f6465d22; color: #f6465d; }
    .pill.stopping { background: #f0b90b22; color: #f0b90b; } .pill.off { color: #7b8291; } .pill.openlv { background: #f0b90b18; color: #f0b90b; }
    .chev { color: #7b8291; font-size: 10px; text-align: right; }
    .gbody { border-top: 1px solid #323846; padding: 7px 8px; display: grid; gap: 6px; }
    table.lvt { width: 100%; border-collapse: collapse; font-size: 11.5px; font-variant-numeric: tabular-nums; }
    .lvt th { text-align: left; color: #7b8291; font-weight: 500; padding: 2px 3px; font-size: 10.5px; white-space: nowrap; }
    .lvt td { padding: 3px; border-top: 1px solid #2a2f3a; color: #c9ced8; white-space: nowrap; vertical-align: middle; }
    .lvt td b { color: #fff; font-weight: 600; }
    .lvt input[type="text"] { padding: 3px 6px; font-size: 12px; width: 96px; }
    .lvt input.custom { border-color: #f0b90b88; }
    .cust { color: #f0b90b; font-size: 10px; margin-left: 3px; }
    .ib { border: 0; background: #2b303c; color: #c9ced8; border-radius: 4px; padding: 1px 6px; font-size: 11px; cursor: pointer; line-height: 1.5; }
    .ib:hover { color: #fff; background: #3a4050; }
    .gact { display: flex; gap: 6px; flex-wrap: wrap; }
    .gact button { border: 0; border-radius: 6px; padding: 6px 12px; font-size: 12px; font-weight: 600; cursor: pointer; background: #2b303c; color: #c9ced8; }
    .gact .stop { background: #f6465d; color: #fff; } .gact .resume { background: #2ebd85; color: #0d1f17; }
    /* grid bot v9 */
    .seg.dir button.on[data-dir="up"] { background: #2ebd8533; color: #2ebd85; font-weight: 600; }
    .seg.dir button.on[data-dir="down"] { background: #f6465d33; color: #f6465d; font-weight: 600; }
    .sidehead { font-size: 11.5px; font-weight: 600; color: #c9ced8; margin: 2px 0 -2px; display: flex; gap: 6px; align-items: center; }
    .levels.ed { padding: 4px 5px; }
    .lvt.edt { table-layout: fixed; }
    .lvt.edt th:nth-child(1), .lvt.edt td:nth-child(1) { width: 22px; }
    .lvt.edt th:nth-child(5) { width: 46px; } .lvt.edt td:nth-child(5) { font-size: 10.5px; }
    .lvt.edt input[type="text"] { width: 100%; padding: 3px 4px; font-size: 11.5px; }
    .lvt.edt tr.lvh td { color: #8d94a3; font-size: 10.5px; padding-top: 6px; border-top: 1px solid #323846; }
    .lvt input.bad { border-color: #f6465d; }
    .tag.dir { background: #f0b90b22; color: #f0b90b; }
    .pill.armed { background: #8ab4ff22; color: #8ab4ff; }
    .gfoot { padding: 0 8px 7px; }
    .gfoot .gact button { padding: 4px 12px; font-size: 11.5px; }
    .edhead .ib { margin-left: auto; }
    .editor.editing { border-color: #8ab4ff; }
    .switch.actsw { grid-column: 1 / -1; font-size: 12px; }
    span.actsw { display: none; }
    .lvt td.slot { white-space: normal; vertical-align: top; line-height: 1.3; }
    .lvt td.slot small { display: block; color: #7b8291; font-size: 10px; }
    .lvt td.slot .ib { margin-top: 2px; }
    /* alerts */
    .alarmbar { display: flex; gap: 8px; align-items: center; padding: 7px 10px; background: #f6465d; color: #fff; font-size: 12px; line-height: 1.3; }
    .alarmbar[hidden] { display: none; }
    .alarmbar #alarmTxt { flex: 1; min-width: 0; }
    .alarmbar button { flex: none; border: 0; border-radius: 5px; background: #fff; color: #b3122a; font-weight: 700; padding: 5px 12px; cursor: pointer; }
    .abadge { display: inline-block; min-width: 0; margin-left: 4px; padding: 0 5px; border-radius: 99px; background: #343a48; color: #fff; font-size: 10px; line-height: 15px; }
    .abadge:empty { display: none; }
    .abadge.bad { background: #f6465d; }
    .aact { display: flex; gap: 6px; flex-wrap: wrap; }
    .alist { display: grid; gap: 2px; max-height: 340px; overflow-y: auto; background: #1b1e26; border-radius: 7px; padding: 4px; }
    .arow { display: grid; grid-template-columns: 52px 52px 1fr; gap: 6px; padding: 4px 5px; border-radius: 5px; font-size: 11.5px; line-height: 1.35; color: #c9ced8; }
    .arow .at { color: #7b8291; font-variant-numeric: tabular-nums; }
    .arow .al { font-size: 10px; font-weight: 700; text-transform: uppercase; }
    .arow.unread { background: #262b35; }
    .lv-note .al { color: #7b8291; } .lv-info .al { color: #8ab4ff; } .lv-good .al { color: #2ebd85; } .lv-warn .al { color: #f0b90b; }
    .lv-crit .al { color: #f6465d; } .arow.lv-crit { background: #f6465d1a; }
    .aset summary { cursor: pointer; color: #b4bac6; font-size: 12px; margin: 2px 0 6px; }
    .aset { display: grid; gap: 6px; }
    .achk { display: grid; gap: 3px; padding-left: 23px; }
    .achk label { flex-direction: row; gap: 6px; align-items: center; font-size: 11.5px; }
    .note { font-size: 11px; color: #8d94a3; line-height: 1.35; }
    .note.err { color: #f6465d; }
    .muted { color: #7b8291; }
    .pos { color: #2ebd85; } .neg { color: #f6465d; }
    /* minimised dashboard */
    .mini { display: none; padding: 4px 6px 7px; }
    .card.small .mini { display: grid; gap: 1px; }
    .mrow { display: grid; grid-template-columns: 24px 26px minmax(0,1fr) 34px 58px 70px; gap: 6px; align-items: center;
            padding: 4px; border-radius: 5px; font-size: 11.5px; font-variant-numeric: tabular-nums; cursor: pointer; }
    .mrow:hover { background: #2b303c; }
    .mrow.mhead { color: #7b8291; font-size: 10px; cursor: default; padding-bottom: 1px; }
    .mrow.mhead:hover { background: none; }
    .mrow > :nth-child(4), .mrow > :nth-child(5) { text-align: right; }
    .msep { border-top: 1px solid #2a2f3a; margin: 2px 0; }
    .row { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
    .row button { background: #2b303c; border: 0; color: #c9ced8; border-radius: 6px; padding: 6px; font-size: 11.5px; cursor: pointer; }
    .row button:hover:not(:disabled), .seg button:hover { color: #fff; }
    button:focus-visible { outline: 2px solid #8d94a3; outline-offset: 1px; }
    .status { white-space: pre-line; font-size: 11.5px; line-height: 1.4; color: #8d94a3; min-height: 16px; }
    .status.ok { color: #2ebd85; } .status.err { color: #f6465d; } .status.warn { color: #f0b90b; }
    [hidden] { display: none !important; }
  `;

  const HTML = `
    <div class="card">
      <div class="head" title="Drag to move · double-click to minimise">
        <span class="title">Quick Trade</span><span class="sym"></span><span class="hprice"></span><span class="rbadge"></span>
        <button class="hbtn" id="bMin" title="Minimise / expand (double-click the header)">▾</button>
        <button class="hbtn" id="bHide" title="Hide to a small button (Alt+Q)">✕</button>
      </div>
      <div class="alarmbar" id="alarmBar" hidden><span class="aic">⛔</span><span id="alarmTxt"></span><button id="alarmAck" title="Stops the repeating alarm">Seen</button></div>
      <div class="mini" id="mini"></div>
      <div class="body">
        <div class="tick"><span class="last">—</span><span class="src">waiting for price</span></div>
        <div class="seg side"><button data-side="long">Long</button><button data-side="short">Short</button></div>
        <div class="tabs"><button data-tab="grid">Grid</button><button data-tab="one">One-direction</button><button data-tab="alerts">Alerts<span class="abadge" id="aBadge"></span></button></div>

        <div id="pGrid" class="sect" style="border:0;padding:0">
          <div class="gtop"><span class="ttl" id="gCount">Grid bots</span><button class="ib" id="gRefresh" title="Read MEXC's Positions and Open Orders again and correct the bots' records (places and cancels nothing)">↻ Refresh</button><button class="ib" id="gStopAll" title="Stop every grid bot: cancels all their waiting orders">Stop all</button><button class="newbtn" id="gNew" title="Set up and start another grid bot">+ New grid bot</button></div>
          <div class="editor" id="gEditor">
            <div class="edhead"><b id="gEdTitle">New grid bot</b><button class="ib" id="gEdClose" title="Close without starting">✕</button></div>
            <div class="seg dir"><button data-dir="up" title="Levels go up from the activation price">▲ Up</button><button data-dir="down" title="Levels go down from the activation price">▼ Down</button></div>
            <div class="grid2">
              <label class="switch actsw"><input type="checkbox" id="aUse"> Use an activation price</label><span class="actsw"></span>
              <label for="aAct" class="actrow-a">Activation price<small id="aActHint">orders are placed when the price touches it</small></label>
              <div class="pair actrow-a"><input type="text" id="aAct" inputmode="decimal"><button class="mkt" id="aMkt">Mkt</button></div>
              <label for="aFirst">Grid 1 price<small id="aFirstHint">first grid level</small></label>
              <div class="pair"><input type="text" id="aFirst" inputmode="decimal"><button class="mkt" id="aSame" title="Use the activation price as grid 1">=Act</button></div>
              <label for="aN">Grids<small>1 to 10</small></label><input type="text" id="aN" inputmode="numeric">
              <label for="aGap">Gap<small>between grids</small></label><input type="text" id="aGap" inputmode="decimal">
            </div>
            <div class="sidehead"><span class="tag long">L</span> Long at every grid</div>
            <div class="grid2">
              <label for="aLq">Amount<small>USDT</small></label><input type="text" id="aLq" inputmode="decimal">
              <label for="aLtp" class="tp">TP gap<small>TP = grid + gap</small></label><input type="text" id="aLtp" inputmode="decimal">
              <label for="aLsl" class="sl">Stop loss<small id="aLslHint">price, below the grids</small></label><input type="text" id="aLsl" inputmode="decimal">
            </div>
            <div class="sidehead"><span class="tag short">S</span> Short at every grid</div>
            <div class="grid2">
              <label for="aSq">Amount<small>USDT</small></label><input type="text" id="aSq" inputmode="decimal">
              <label for="aStp" class="tp">TP gap<small>TP = grid − gap</small></label><input type="text" id="aStp" inputmode="decimal">
              <label for="aSsl" class="sl">Stop loss<small id="aSslHint">price, above the grids</small></label><input type="text" id="aSsl" inputmode="decimal">
            </div>
            <div class="levels ed" id="aLevels"></div>
            <div class="note err" id="gEdErr"></div>
            <div class="gbtns"><button id="gstart">Start grid</button><button id="gtest" class="sec">Test order forms</button></div>
          </div>
          <div class="glist" id="gList"></div>
          <div class="stats" id="gLook" hidden><span id="gLookTxt"></span> <button class="mkt" id="gBack">Back now</button></div>
          <div class="row"><button id="help">How to use</button><button id="gClear">Clear stopped</button></div>
        </div>

        <div id="pOne" class="sect" style="border:0;padding:0">
          <div class="gtop"><span class="ttl" id="oCount">One-direction bots</span><button class="ib" id="oRefresh" title="Read MEXC's Positions and Open Orders again and correct the bots' records (places and cancels nothing)">↻ Refresh</button><button class="ib" id="oStopAll" title="Stop every one-direction bot">Stop all</button><button class="newbtn" id="oNew" title="Set up and start another one-direction bot">+ New bot</button></div>
          <div class="editor" id="oEditor">
            <div class="edhead"><b id="oEdTitle">New one-direction bot</b><button class="ib" id="oEdClose" title="Close without starting">✕</button></div>
            <div class="note">Long or Short: use the switch above the tabs. Grids go ▲ Up or ▼ Down from grid 1.</div>
            <div class="seg dir odir"><button data-odir="up" title="Grids go up from grid 1">▲ Up</button><button data-odir="down" title="Grids go down from grid 1">▼ Down</button></div>
            <div class="grid2">
              <label class="switch actsw"><input type="checkbox" id="oUse"> Use an activation price</label><span class="actsw"></span>
              <label for="oAct" class="actrow-o">Activation price<small id="oActHint">orders are placed when the price touches it</small></label>
              <div class="pair actrow-o"><input type="text" id="oAct" inputmode="decimal"><button class="mkt" id="oMkt">Mkt</button></div>
              <label for="oFirst">Order price<small id="oFirstHint">= grid 1</small></label>
              <div class="pair"><input type="text" id="oFirst" inputmode="decimal"><button class="mkt" id="oSame" title="Use the activation price as the order price">=Act</button></div>
              <label for="oN">Grids<small>1 to 10</small></label><input type="text" id="oN" inputmode="numeric">
              <label for="oGap">Gap<small>between grids</small></label><input type="text" id="oGap" inputmode="decimal">
              <label for="oQ">Amount<small>USDT per grid</small></label><input type="text" id="oQ" inputmode="decimal">
              <label for="oTp" class="tp">TP gap<small id="oTpHint">from each grid</small></label><input type="text" id="oTp" inputmode="decimal">
              <label for="oSl" class="sl">SL gap<small id="oSlHint">from each grid</small></label><input type="text" id="oSl" inputmode="decimal">
            </div>
            <div class="sidehead">Loop: when a trade closes at TP or SL</div>
            <div class="seg oloop"><button data-loop="tpsl" title="Place the same order again right away">Again at once</button><button data-loop="price" title="Place it again when the market touches the loop price">At a loop price</button></div>
            <div class="grid2" id="oLpRow"><label for="oLp">Loop price<small id="oLpHint">placed again when the price touches it</small></label><input type="text" id="oLp" inputmode="decimal"></div>
            <div class="levels ed" id="oLevels"></div>
            <div class="note err" id="oEdErr"></div>
            <div class="gbtns"><button id="ostart" class="startbtn">Start bot</button><button id="otest" class="sec">Test order forms</button></div>
          </div>
          <div class="glist" id="oList"></div>
          <div class="row"><button id="oHelp">How to use</button><button id="oClear">Clear stopped</button></div>
        </div>

        <div id="pAlerts" class="sect" style="border:0;padding:0">
          <div class="aact"><button class="ib" id="aRead">Mark all read</button><button class="ib" id="aClear">Clear list</button><button class="ib" id="aTest">Test alert</button></div>
          <div class="alist" id="aList"></div>
          <details class="aset"><summary>Alert settings</summary>
            <label class="switch"><input type="checkbox" id="asSound"> Sounds</label>
            <label class="switch"><input type="checkbox" id="asDesk"> Windows/Mac notifications for:</label>
            <div class="achk"><label><input type="checkbox" id="asCrit"> Critical (bot paused, can't read…)</label><label><input type="checkbox" id="asWarn"> Warnings and stop losses</label>
              <label><input type="checkbox" id="asGood"> Take profits and activations</label><label><input type="checkbox" id="asInfo"> Fills (orders that opened)</label></div>
            <div class="grid2"><label for="asFar">Waiting bot far away<small>alert when the price is this % from its activation</small></label><input type="text" id="asFar" inputmode="decimal"></div>
          </details>
        </div>

        <div id="pHedge" class="sect" style="border:0;padding:0">
          <div class="grid2">
            <label for="hEntry">Entry price<small id="hEntryHint">long + short open here</small></label>
            <div class="pair"><input type="text" id="hEntry" inputmode="decimal"><button class="mkt" id="hMkt">Mkt</button></div>
            <label for="hGap" class="sl">SL gap<small id="hGapHint">SL distance from entry</small></label><input type="text" id="hGap" inputmode="decimal">
            <label for="hQty">Amount<small>USDT per side</small></label><input type="text" id="hQty" inputmode="decimal">
          </div>
          <div class="levels" id="hBox"></div>
          <div class="stats" id="hStats"></div>
          <div class="gbtns"><button id="hstart">Start hedge</button><button id="hresume" hidden>Resume</button><button id="hstop">Stop hedge</button></div>
          <div class="row"><button id="happly">Apply new values</button><button id="htest">Test trigger form</button></div>
          <div class="row"><button id="hrearmL">Re-arm long</button><button id="hrearmS">Re-arm short</button></div>
        </div>

        <div id="pSingle" class="sect" style="border:0;padding:0">
          <div class="grid2">
            <label for="entry">Entry price<small>limit order</small></label>
            <div class="pair"><input type="text" id="entry" inputmode="decimal"><button class="mkt" id="sMkt">Mkt</button></div>
            <label for="qty">Quantity<small>USDT</small></label><input type="text" id="qty" inputmode="decimal">
          </div>
          <label class="switch"><input type="checkbox" id="tpsl"> Take profit / Stop loss</label>
          <div class="grid2" id="tpslGrid">
            <label for="tp" class="tp">TP price<small id="tpHint">&nbsp;</small></label><input type="text" id="tp" inputmode="decimal">
            <label for="sl" class="sl">SL price<small id="slHint">&nbsp;</small></label><input type="text" id="sl" inputmode="decimal">
          </div>
          <div class="seg"><button data-mode="manual">Manual</button><button data-mode="auto">Auto</button></div>
          <button id="go"></button>
        </div>

        <div class="checks"><span class="chip" id="lev">MEXC leverage ?</span><span class="chip" id="mm">Margin ?</span></div>
        <div class="row"><button id="reset">Reset values</button><button id="check">Check page</button></div>
        <div class="row"><button id="copylog">Copy log</button><button id="rec">Record MEXC data</button></div>
        <div class="status"></div>
      </div>
    </div>`;

  // Panel values are saved automatically (survive a refresh). "Reset values" clears them.
  // Per-grid custom amount / TP / SL of the grid bot are kept in draft.aOv ({ l1: { qty, tp, sl }, s1: … }).
  const GFIELDS = ['aAct', 'aFirst', 'aN', 'aGap', 'aLq', 'aLtp', 'aLsl', 'aSq', 'aStp', 'aSsl'];
  const SFIELDS = ['entry', 'qty', 'tp', 'sl', 'hEntry', 'hGap', 'hQty'];
  const OFIELDS = ['oAct', 'oFirst', 'oN', 'oGap', 'oQ', 'oTp', 'oSl', 'oLp'];
  const BLANK = { aAct: '', aFirst: '', aN: '3', aGap: '200', aLq: '20', aLtp: '100', aLsl: '', aSq: '20', aStp: '100', aSsl: '', aDir: 'down', aOv: {},
                  oAct: '', oFirst: '', oN: '3', oGap: '100', oQ: '20', oTp: '100', oSl: '300', oLp: '', oDir: 'up', oLoop: 'tpsl', oOv: {},
                  entry: '', qty: '20', tp: '', sl: '', hEntry: '', hGap: '50', hQty: '1000', tpsl: true };
  function saveDraft() {
    if (!ui) return;
    const d = cfg.draft || {};
    cfg.draft = { ...Object.fromEntries([...GFIELDS, ...OFIELDS, ...SFIELDS].map(f => [f, ui[f].value])), tpsl: ui.tpsl.checked, aDir: d.aDir === 'up' ? 'up' : 'down', aOv: d.aOv || {},
                  oDir: d.oDir === 'down' ? 'down' : 'up', oLoop: d.oLoop === 'price' ? 'price' : 'tpsl', oOv: d.oOv || {},
                  aUse: ui.aUse.checked, oUse: ui.oUse.checked };
    clearTimeout(saveDraft.t);
    saveDraft.t = setTimeout(() => storeGet('mql', saved => storeSet('mql', { ...(saved || DEFAULTS), draft: cfg.draft, side: cfg.side, tab: cfg.tab, mode: cfg.mode, gEdit: !!cfg.gEdit, oEdit: !!cfg.oEdit })), 400);
  }
  function loadDraft() {
    const d = { ...BLANK, ...(cfg.draft || {}) };
    if (!cfg.draft) { d.qty = String(cfg.quantity ?? d.qty); d.tpsl = cfg.tpsl !== false; }
    if (d.aFirst == null || d.aFirst === '') d.aFirst = d.aAct && d.aG1 != null && d.aG1 !== '' ? String(num(d.aAct) + (d.aDir === 'up' ? 1 : -1) * num(d.aG1)) : '';
    [...GFIELDS, ...OFIELDS, ...SFIELDS].forEach(f => { ui[f].value = d[f] ?? ''; });
    ui.tpsl.checked = !!d.tpsl;
    ui.aUse.checked = d.aUse !== false; ui.oUse.checked = d.oUse !== false;   // default: with an activation price
    const okOv = o => (o && typeof o === 'object' && !Array.isArray(o) ? o : {});
    cfg.draft = { ...d, aDir: d.aDir === 'up' ? 'up' : 'down', aOv: JSON.parse(JSON.stringify(okOv(d.aOv))), oOv: JSON.parse(JSON.stringify(okOv(d.oOv))) };
  }
  function resetValues() {
    if (!confirm('Reset all panel values (grid bot, single order, hedge) to defaults?\nRunning bots are not changed.')) return;
    cfg.draft = { ...BLANK, aOv: {}, oOv: {} };
    loadDraft();
    saveDraft();
    render(true);
    status('Values reset to defaults.', 'ok');
  }

  function buildUI() {
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;z-index:2147483646;top:110px;right:360px;';
    const sh = host.attachShadow({ mode: 'open' });
    sh.innerHTML = `<style>${CSS}</style>${HTML}<div class="rz rz-r" title="Drag to change width"></div><div class="rz rz-b" title="Drag to change height"></div><div class="rz rz-c" title="Drag to resize · double-click for default size"></div>`;
    const bhost = document.createElement('div');            // the round button lives outside the panel, so it stays visible when the panel is hidden
    const bsh = bhost.attachShadow({ mode: 'open' });
    bsh.innerHTML = `<style>:host { all: initial; } [hidden] { display: none !important; } ${CSS.slice(CSS.indexOf('.bubble'), CSS.indexOf('@keyframes'))} @keyframes pulse { 50% { box-shadow: 0 0 0 7px rgba(246,70,93,.35); } }</style>` +
      '<div class="bubble" id="bubble" hidden title="Quick Trade — click to open (Alt+Q). Drag to move.">QT<span class="dot"></span></div>';
    document.documentElement.appendChild(bhost);
    document.documentElement.appendChild(host);
    const $ = s => sh.querySelector(s);
    ui = { host, sh, card: $('.card'), bubble: bsh.querySelector('#bubble'), hprice: $('.hprice'), bMin: $('#bMin'), rbadge: $('.rbadge'), sym: $('.sym'), last: $('.last'), src: $('.src'),
           pGrid: $('#pGrid'), pSingle: $('#pSingle'), pHedge: $('#pHedge'), pAlerts: $('#pAlerts'), pOne: $('#pOne'),
           oAct: $('#oAct'), oActHint: $('#oActHint'), oFirst: $('#oFirst'), oFirstHint: $('#oFirstHint'), oN: $('#oN'), oGap: $('#oGap'), oQ: $('#oQ'),
           oTp: $('#oTp'), oTpHint: $('#oTpHint'), oSl: $('#oSl'), oSlHint: $('#oSlHint'), oLp: $('#oLp'), oLpHint: $('#oLpHint'), oLpRow: $('#oLpRow'),
           oLevels: $('#oLevels'), oEditor: $('#oEditor'), oEdTitle: $('#oEdTitle'), oEdClose: $('#oEdClose'), oEdErr: $('#oEdErr'), ostart: $('#ostart'),
           oList: $('#oList'), oNew: $('#oNew'), oStopAll: $('#oStopAll'), oCount: $('#oCount'), oClear: $('#oClear'),
           odirs: sh.querySelectorAll('[data-odir]'), oloops: sh.querySelectorAll('[data-loop]'),
           aUse: $('#aUse'), oUse: $('#oUse'), actRowsA: sh.querySelectorAll('.actrow-a'), actRowsO: sh.querySelectorAll('.actrow-o'), aList: $('#aList'), aBadge: $('#aBadge'),
           alarmBar: $('#alarmBar'), alarmTxt: $('#alarmTxt'),
           hEntry: $('#hEntry'), hGap: $('#hGap'), hQty: $('#hQty'), hBox: $('#hBox'), hStats: $('#hStats'), hEntryHint: $('#hEntryHint'),
           hstart: $('#hstart'), hresume: $('#hresume'), hstop: $('#hstop'), happly: $('#happly'), hrearmL: $('#hrearmL'), hrearmS: $('#hrearmS'),
           aAct: $('#aAct'), aActHint: $('#aActHint'), aFirst: $('#aFirst'), aFirstHint: $('#aFirstHint'), aN: $('#aN'), aGap: $('#aGap'), aLq: $('#aLq'), aLtp: $('#aLtp'), aLsl: $('#aLsl'), aLslHint: $('#aLslHint'),
           aSq: $('#aSq'), aStp: $('#aStp'), aSsl: $('#aSsl'), aSslHint: $('#aSslHint'), aLevels: $('#aLevels'), dirs: sh.querySelectorAll('[data-dir]'),
           gLook: $('#gLook'), gLookTxt: $('#gLookTxt'), gstart: $('#gstart'), gEditor: $('#gEditor'), gEdTitle: $('#gEdTitle'), gEdErr: $('#gEdErr'),
           gList: $('#gList'), gClear: $('#gClear'), mini: $('#mini'), sideSeg: $('.seg.side'),
           gNew: $('#gNew'), gStopAll: $('#gStopAll'), gCount: $('#gCount'), gEdClose: $('#gEdClose'),
           openGrid: undefined,
           entry: $('#entry'), qty: $('#qty'), tpsl: $('#tpsl'), tpslGrid: $('#tpslGrid'), tp: $('#tp'), sl: $('#sl'),
           tpHint: $('#tpHint'), slHint: $('#slHint'), go: $('#go'), sMkt: $('#sMkt'),
           lev: $('#lev'), mm: $('#mm'), status: $('.status'),
           modes: sh.querySelectorAll('[data-mode]'), sides: sh.querySelectorAll('[data-side]'), tabs: sh.querySelectorAll('[data-tab]') };

    loadDraft();

    sh.addEventListener('pointerdown', unlockAudio, true);
    sh.querySelectorAll('input').forEach(el => el.addEventListener('input', () => { saveDraft(); render(); }));   // inputs that exist now (not the tables)
    ui.tpsl.addEventListener('change', () => { saveDraft(); render(); });
    $('#reset').addEventListener('click', resetValues);
    $('#aMkt').addEventListener('click', () => useMarket(ui.aAct));
    ui.dirs.forEach(b => b.addEventListener('click', () => { cfg.draft.aDir = b.dataset.dir; saveDraft(); render(true); }));
    ui.sMkt.addEventListener('click', () => useMarket(ui.entry));
    ui.sides.forEach(b => b.addEventListener('click', () => {
      if (b.dataset.side === cfg.side) return;
      cfg.side = b.dataset.side;                            // values stay as typed
      saveDraft();
      render(true);
    }));
    ui.tabs.forEach(b => b.addEventListener('click', () => { cfg.tab = b.dataset.tab; render(); }));
    $('#alarmAck').addEventListener('click', () => { unlockAudio(); ackAll(); });
    $('#aRead').addEventListener('click', () => { alerts.forEach(a => { a.read = true; a.ack = true; }); ackAll(); });
    $('#aClear').addEventListener('click', () => { if (!confirm('Clear the alert list?')) return; alerts = []; ackAll(); });
    $('#aTest').addEventListener('click', () => { unlockAudio(); alertUser('warn', 'Test alert: this is how a warning looks, sounds and pops up.'); });
    const AS = { asSound: 'sound', asDesk: 'desktop', asCrit: 'dCrit', asWarn: 'dWarn', asGood: 'dGood', asInfo: 'dInfo' };
    const ac = aCfg();
    for (const [id, k] of Object.entries(AS)) { $('#' + id).checked = !!ac[k]; $('#' + id).addEventListener('change', e => saveAlertCfg({ [k]: e.target.checked })); }
    $('#asFar').value = String(ac.farPct);
    $('#asFar').addEventListener('change', e => saveAlertCfg({ farPct: Math.max(0, num(cleanNum(e.target.value)) || 0) }));
    ui.modes.forEach(b => b.addEventListener('click', () => { cfg.mode = b.dataset.mode; render(); }));
    ui.go.addEventListener('click', () => runSingle(cfg.mode === 'auto'));
    ui.gstart.addEventListener('click', () => (cfg.gEditId ? saveEdit('grid') : startGrid('grid')));
    ui.gClear.addEventListener('click', () => clearStopped('grid'));
    ui.gNew.addEventListener('click', () => { cfg.gEdit = true; saveDraft(); render(true); ui.gEditor.scrollIntoView({ block: 'nearest' }); ui.aAct.focus(); });
    ui.gEdClose.addEventListener('click', () => { if (cfg.gEditId) return endEdit('grid'); cfg.gEdit = false; saveDraft(); render(true); });
    ui.gStopAll.addEventListener('click', () => stopAll('grid'));
    ui.oStopAll.addEventListener('click', () => stopAll('one'));
    $('#oRefresh').addEventListener('click', refreshBots);
    ui.ostart.addEventListener('click', () => (cfg.oEditId ? saveEdit('one') : startGrid('one')));
    $('#otest').addEventListener('click', testForms);
    ui.oNew.addEventListener('click', () => { cfg.oEdit = true; saveDraft(); render(true); ui.oEditor.scrollIntoView({ block: 'nearest' }); ui.oAct.focus(); });
    ui.oEdClose.addEventListener('click', () => { if (cfg.oEditId) return endEdit('one'); cfg.oEdit = false; saveDraft(); render(true); });
    ui.oClear.addEventListener('click', () => clearStopped('one'));
    $('#oMkt').addEventListener('click', () => useMarket(ui.oAct));
    for (const [btn, src, dst] of [['#aSame', 'aAct', 'aFirst'], ['#oSame', 'oAct', 'oFirst']]) $(btn).addEventListener('click', () => {
      if (!(num(ui[src].value) > 0)) return status('Enter the activation price first.', 'err');
      ui[dst].value = cleanNum(ui[src].value); saveDraft(); render(true);
    });
    ui.odirs.forEach(b => b.addEventListener('click', () => { cfg.draft.oDir = b.dataset.odir; saveDraft(); render(true); }));
    ui.oloops.forEach(b => b.addEventListener('click', () => { cfg.draft.oLoop = b.dataset.loop; saveDraft(); render(true); }));
    for (const [box, key] of [[ui.aUse, 'aUse'], [ui.oUse, 'oUse']]) box.addEventListener('change', () => { cfg.draft[key] = box.checked; saveDraft(); render(true); });
    $('#oHelp').addEventListener('click', () => status([
      'One-direction bot:',
      '1. Choose Long or Short (switch above the tabs) and ▲ Up / ▼ Down (which way the grids go from grid 1).',
      '2. Activation price, Order price (= grid 1), Grids, Gap, Amount, TP gap, SL gap. Change any grid in the table.',
      '3. Loop: "Again at once" = after TP or SL the same order is placed again right away; "At a loop price" = it waits until the price touches the loop price.',
      '4. Every order is Limit or Trigger (Market) by the same rule as the grid bot. Stop cancels waiting orders; positions keep their TP/SL.'].join('\n'), 'ok'));
    $('#gRefresh').addEventListener('click', refreshBots);
    wireGridTables();
    ui.hstart.addEventListener('click', startHedge);
    ui.hstop.addEventListener('click', stopHedge);
    ui.hresume.addEventListener('click', resumeHedge);
    ui.happly.addEventListener('click', applyHedge);
    ui.hrearmL.addEventListener('click', () => rearm('long'));
    ui.hrearmS.addEventListener('click', () => rearm('short'));
    $('#htest').addEventListener('click', testHedge);
    $('#hMkt').addEventListener('click', () => useMarket(ui.hEntry));
    $('#gBack').addEventListener('click', () => { lookUntil = 0; openBottomTab('Positions').catch(() => {}); render(); });
    $('#gtest').addEventListener('click', testForms);
    $('#check').addEventListener('click', checkPage);
    ui.rec = $('#rec');
    ui.rec.addEventListener('click', () => {
      if (!recState.on) {
        window.postMessage({ __mqr: 'cmd', cmd: 'start' }, '*');
        status('Recording MEXC data (read-only, stays on this computer). Now place a small order with TP/SL, let it fill and close, then press "Stop & save".', 'ok');
      } else window.postMessage({ __mqr: 'cmd', cmd: 'stop' }, '*');
    });
    $('#help').addEventListener('click', () => status([
      'Grid bot in 6 steps:',
      '1. MEXC: Hedge mode, Isolated, your leverage, quantity USDT, TP/SL by Price, confirmations off. No open positions.',
      '2. Open the Positions tab at the bottom. Press Test order forms: it must say OK for Limit, Trigger, lists and positions.',
      '3. Choose Up or Down, Activation price, Grid 1 gap (Up: above, Down: below the activation price), Grids, Gap.',
      '4. Long and Short: amount, TP gap and stop loss price. Change any grid\'s amount/TP/SL in the table (yellow = custom).',
      '5. Start grid: nothing is placed until the price touches the activation price. Then a long and a short at every grid.',
      '6. Every TP or SL places the same order again (Limit or Trigger by the rule). Stop cancels all its waiting orders; positions stay.',
      '7. "+ New grid bot" starts another bot (up to 5, grid prices must differ). Resume restarts a stopped bot.',
      'Keep this tab visible and the bottom panel on Positions.'].join('\n'), 'ok'));
    $('#copylog').addEventListener('click', async () => {
      let v = '';
      try { v = chrome.runtime.getManifest().version; } catch (_) {}
      const text = `Quick Trade ${v} | ${location.href}\n` + LOG.join('\n');
      try { await navigator.clipboard.writeText(text); status('Log copied. Paste it in the chat with the developer.', 'ok'); }
      catch (_) {
        const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); status('Log copied. Paste it in the chat with the developer.', 'ok'); }
        catch (__) { status('Could not copy automatically. Open DevTools Console and look for [QuickLong] lines.', 'warn'); }
        ta.remove();
      }
    });
    if ($('#save')) $('#save').addEventListener('click', () => {
      saveDraft();
      Object.assign(cfg, { quantity: num(ui.qty.value) || cfg.quantity, tpsl: ui.tpsl.checked });
      storeSet('mql', cfg, () => status('Saved. (Values are also saved automatically as you type.)', 'ok'));
    });

    ui.bMin.addEventListener('click', () => setView(cfg.view === 'small' ? 'full' : 'small'));
    $('#bHide').addEventListener('click', () => setView('hidden'));
    $('.head').addEventListener('dblclick', e => { if (!e.target.closest('button')) setView(cfg.view === 'small' ? 'full' : 'small'); });
    makeDraggable($('.head'), host, 'pos');
    makeResizable(sh.querySelector('.rz-r'), true, false);
    makeResizable(sh.querySelector('.rz-b'), false, true);
    makeResizable(sh.querySelector('.rz-c'), true, true);
    sh.querySelector('.rz-c').addEventListener('dblclick', () => { cfg.size = null; applySize(); saveSize(); });
    applySize();
    makeDraggable(ui.bubble, ui.bubble, 'bpos', () => setView(cfg.lastView || 'full'));
    addEventListener('resize', () => { applySize(); keepOnScreen(host); keepOnScreen(ui.bubble); });
    setView(cfg.view || 'full', true);
    render();
  }

  // ---- panel views: full · small (header only) · hidden (round "QT" button)
  function setView(v, init) {
    if (!ui) return;
    if (v !== 'hidden') cfg.lastView = v;
    cfg.view = v;
    ui.card.classList.toggle('small', v === 'small');
    ui.host.classList.toggle('small-view', v === 'small');
    ui.host.style.display = v === 'hidden' ? 'none' : '';
    ui.bubble.hidden = v !== 'hidden';
    ui.bMin.textContent = v === 'small' ? '▸' : '▾';
    ui.bMin.title = v === 'small' ? 'Expand (double-click the header)' : 'Minimise (double-click the header)';
    if (!init) storeGet('mql', saved => storeSet('mql', { ...(saved || DEFAULTS), view: cfg.view, lastView: cfg.lastView }));
    requestAnimationFrame(() => { keepOnScreen(ui.host); keepOnScreen(ui.bubble); });
    render(true);
  }

  // ---- panel size (drag the right edge, bottom edge or the corner grip). Saved; double-click the grip to reset.
  const SIZE_MIN = { w: 240, h: 220 }, SIZE_DEF_W = 278;
  function applySize() {
    if (!ui) return;
    const z = cfg.size || {};
    const w = Math.round(Math.max(SIZE_MIN.w, Math.min(innerWidth - 20, z.w || SIZE_DEF_W)));
    ui.card.style.width = w + 'px';
    if (z.h) {
      const h = Math.round(Math.max(SIZE_MIN.h, Math.min(innerHeight - 20, z.h)));
      ui.card.style.height = h + 'px';
      ui.card.style.maxHeight = 'none';
    } else { ui.card.style.height = ''; ui.card.style.maxHeight = ''; }
  }
  function saveSize() { storeGet('mql', saved => storeSet('mql', { ...(saved || DEFAULTS), size: cfg.size })); }
  function makeResizable(handle, horiz, vert) {
    handle.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      const r = ui.card.getBoundingClientRect(), sx = e.clientX, sy = e.clientY;
      try { handle.setPointerCapture(e.pointerId); } catch (_) {}
      const move = ev => {
        const z = { ...(cfg.size || {}) };
        if (horiz) z.w = Math.max(SIZE_MIN.w, Math.min(innerWidth - r.left - 4, r.width + ev.clientX - sx));
        if (vert) z.h = Math.max(SIZE_MIN.h, Math.min(innerHeight - r.top - 4, r.height + ev.clientY - sy));
        cfg.size = z;
        applySize();
      };
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        saveSize();
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    });
  }

  // keeps at least 60 px of the panel / the whole bubble inside the window
  function keepOnScreen(el) {
    if (!el || el.hidden || el.style.display === 'none') return;
    const r = el.getBoundingClientRect();
    if (!r.width) return;
    const x = Math.max(0, Math.min(innerWidth - Math.min(r.width, 60), r.left));
    const y = Math.max(0, Math.min(innerHeight - 40, r.top));
    if (x !== r.left || y !== r.top) Object.assign(el.style, { left: x + 'px', top: y + 'px', right: 'auto', bottom: 'auto' });
  }

  // drag only after the pointer moves 5 px, so ordinary clicks always work
  function makeDraggable(handle, target, key, onClick) {
    if (cfg[key]) Object.assign(target.style, { left: cfg[key].x + 'px', top: cfg[key].y + 'px', right: 'auto', bottom: 'auto' });
    else if (key === 'bpos') Object.assign(target.style, { right: '24px', bottom: '90px' });
    handle.addEventListener('pointerdown', e => {
      if (e.button !== 0 || e.target.closest('button,input')) return;
      const r = target.getBoundingClientRect(), sx = e.clientX, sy = e.clientY;
      let moved = false;
      const move = ev => {
        if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
        if (!moved) { moved = true; try { handle.setPointerCapture(e.pointerId); } catch (_) {} }
        const x = Math.max(0, Math.min(innerWidth - 50, r.left + ev.clientX - sx)), y = Math.max(0, Math.min(innerHeight - 40, r.top + ev.clientY - sy));
        Object.assign(target.style, { left: x + 'px', top: y + 'px', right: 'auto', bottom: 'auto' });
      };
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        if (!moved) { if (onClick) onClick(); return; }
        const r2 = target.getBoundingClientRect();
        cfg[key] = { x: Math.round(r2.left), y: Math.round(r2.top) };
        storeGet('mql', saved => storeSet('mql', { ...(saved || DEFAULTS), [key]: cfg[key] }));
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    });
  }

  // ---- data recorder (recorder.js runs inside the page; it answers through window messages)
  const recState = { on: false, items: 0, secs: 0, seen: false };
  window.addEventListener('message', e => {
    if (e.source !== window || !e.data || e.data.__mqr !== 'reply') return;
    recState.seen = true;
    if (e.data.type === 'status') Object.assign(recState, e.data.payload || { on: false });
    if (e.data.type === 'data') {
      recState.on = false;
      if (!e.data.payload) return status('Nothing was recorded.', 'warn');
      const blob = new Blob([e.data.payload], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `mexc-recording-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`;
      document.body.appendChild(a); a.click(); a.remove();
      status('Recording saved to your Downloads folder. Send that file to the developer.', 'ok');
    }
    renderRec();
  });
  function renderRec() {
    if (!ui || !ui.rec) return;
    ui.rec.textContent = recState.on ? `Stop & save (${recState.items} · ${recState.secs || 0}s)` : 'Record MEXC data';
    ui.rec.style.color = recState.on ? '#f6465d' : '';
  }
  setInterval(() => window.postMessage({ __mqr: 'cmd', cmd: 'status' }, '*'), 1000);

  function status(msg, kind = '') {
    log(`[${kind || 'info'}] ${msg}`);
    if (!ui) return;
    ui.status.textContent = msg;
    ui.status.className = 'status ' + kind;
  }

  const LV_TEXT = { idle: 'not placed', entry: 'waiting', filled: 'OPEN', busy: 'placing…', retry: 'to re-place', check: 'checking MEXC…', wait: 'waits for loop price' };
  const LV_CLS = { idle: 'st-idle', entry: 'st-entry', filled: 'st-filled', busy: 'st-busy', retry: 'st-retry', check: 'st-pending', wait: 'st-pending' };
  const PHASE = { off: 'Off', armed: 'Armed', run: 'Running', paused: 'Paused', stopping: 'Stopping…' };

  function render(force) {
    if (!ui) return;
    const side = curSide(), W = sideWord(side), L = side === 'long';
    const nRun = grids.filter(g => g.phase !== 'off').length, anyBot = nRun > 0 || hedgeOn();
    ui.sym.textContent = st.sym ? st.sym.replace('_', '/') : '';
    ui.last.textContent = st.last ? fmt(st.last) : '—';
    ui.src.textContent = st.last ? st.src : 'waiting for price';
    ui.sides.forEach(b => b.classList.toggle('on', b.dataset.side === side));
    ui.tabs.forEach(b => b.classList.toggle('on', b.dataset.tab === cfg.tab));
    if (!['grid', 'one', 'alerts'].includes(cfg.tab)) cfg.tab = cfg.tab === 'single' ? 'one' : 'grid';   // Single order and Hedge tabs were removed
    ui.pGrid.classList.toggle('off', cfg.tab !== 'grid');
    ui.pSingle.classList.toggle('off', true);
    ui.pHedge.classList.toggle('off', true);
    ui.pAlerts.classList.toggle('off', cfg.tab !== 'alerts');
    ui.pOne.classList.toggle('off', cfg.tab !== 'one');
    renderAlerts();
    renderHedge();
    ui.modes.forEach(b => b.classList.toggle('on', b.dataset.mode === cfg.mode));
    ui.card.style.setProperty('--c', L ? '#2ebd85' : '#f6465d');
    ui.card.style.setProperty('--on', L ? '#0d1f17' : '#fff');
    ui.card.classList.toggle('auto', cfg.mode === 'auto');
    ui.card.classList.toggle('running', anyBot);
    ui.card.classList.toggle('has-bots', anyBot || grids.some(tracked));
    ui.hprice.textContent = st.last ? fmt(st.last) : '';
    const alarm = unacked().length > 0 || grids.some(g => g.phase === 'paused') || trk.long.blind || trk.short.blind || hedge.phase === 'paused' || (anyBot && !iAmBot && !otherBotAlive());
    ui.bubble.classList.toggle('running', anyBot);
    ui.bubble.classList.toggle('alarm', alarm);
    ui.bubble.title = 'Quick Trade' + (st.last ? ' · ' + fmt(st.last) : '') + (nRun ? ' · grid bot on' : '') + (hedgeOn() ? ' · hedge' : '') + ' — click to open (Alt+Q)';
    ui.rbadge.textContent = [nRun > 1 ? `${nRun} grids` : grids.some(g => g.phase === 'armed') ? 'Grid armed' : nRun ? 'Grid' : '', hedgeOn() ? 'Hedge' : '', grids.some(g => g.phase === 'paused') ? 'paused!' : '', trk.long.blind || trk.short.blind ? "can't read positions!" : '']
      .filter(Boolean).join(' · ') + (iAmBot ? ' · BOT' : anyBot ? (otherBotAlive() ? ' · viewer' : ' · no bot!') : '');
    ui.sideSeg.classList.toggle('off', cfg.tab !== 'one');   // Long / Short: only for the one-direction bot
    if (ui.openGrid === undefined) { const t = grids.find(tracked); if (t) ui.openGrid = t.id; }

    // single
    const busySide = sideBusy(side) || hedgeOn();
    ui.tpslGrid.classList.toggle('off', !ui.tpsl.checked);
    const e = num(ui.entry.value), t = num(ui.tp.value), s = num(ui.sl.value);
    const d = x => `${x - e >= 0 ? '+' : '−'}${fmt(Math.abs(x - e))} from entry`;
    ui.tpHint.textContent = e > 0 && t > 0 ? d(t) : (L ? 'above entry' : 'below entry');
    ui.slHint.textContent = e > 0 && s > 0 ? d(s) : (L ? 'below entry' : 'above entry');
    ui.go.innerHTML = busySide ? `${W} side used by a bot<small>A single order would mix into the bot's position</small>`
      : cfg.mode === 'auto' ? `Open ${W.toLowerCase()}<small>Places the limit order immediately · Alt+L</small>`
      : `Fill order form<small>Then you press Open ${W} on MEXC · Alt+L</small>`;
    [ui.entry, ui.qty, ui.tp, ui.sl, ui.tpsl, ui.go, ui.sMkt].forEach(el => { el.disabled = busySide || st.dead; });

    ui.gLook.hidden = !(looking() && iAmBot);
    if (looking()) ui.gLookTxt.textContent = `The bot reads Positions again in ${Math.ceil((lookUntil - Date.now()) / 1000)}s.`;
    renderGrids(force);
  }

  const A_LBL = { note: 'note', info: 'info', good: 'OK', warn: 'warn', crit: 'CRITICAL' };
  const hhmm = t => { const d = new Date(t); return d.toTimeString().slice(0, 8); };
  function renderAlerts() {
    const un = alerts.filter(a => !a.read && a.level !== 'note'), bad = un.some(a => ALV[a.level] >= ALV.warn);
    ui.aBadge.textContent = un.length ? String(un.length > 99 ? '99+' : un.length) : '';
    ui.aBadge.className = 'abadge' + (bad ? ' bad' : '');
    const ua = unacked();
    ui.alarmBar.hidden = !ua.length;
    if (ua.length) ui.alarmTxt.textContent = `${ua.length > 1 ? ua.length + ' critical alerts · latest: ' : ''}${ua[0].bot ? 'Bot #' + ua[0].bot + ': ' : ''}${ua[0].msg}` +
      (aCfg().sound && !audioReady() ? ' 🔇 Click anywhere on the page to turn on alarm sounds.' : '');
    if (cfg.tab !== 'alerts' || ui.card.classList.contains('small')) return;
    setHtml(ui.aList, alerts.length ? alerts.slice(0, 150).map(a =>
      `<div class="arow lv-${a.level}${a.read ? '' : ' unread'}"><span class="at">${hhmm(a.t)}</span><span class="al">${A_LBL[a.level]}</span>` +
      `<span class="am">${a.bot ? `<b>#${a.bot}</b> ` : ''}${escapeHtml(a.msg)}</span></div>`).join('') : '<div class="muted">No alerts yet.</div>');
    if (un.length && document.visibilityState === 'visible') { alerts.forEach(a => { a.read = true; }); saveAlerts(); setTimeout(() => render(), 1500); }
  }
  function saveAlertCfg(patch) {
    cfg.alerts = { ...aCfg(), ...patch };
    storeGet('mql', saved => storeSet('mql', { ...(saved || DEFAULTS), alerts: cfg.alerts }));
    status('Alert settings saved.', 'ok');
  }

  // replace a container's HTML only when it changed, and never while you are typing inside it
  function setHtml(el, html, force) {
    if (el._html === html) return;
    if (!force && el.contains(ui.sh.activeElement)) return;
    el.innerHTML = html;
    el._html = html;
  }

  const PH_CLS = { armed: 'armed', run: 'run', paused: 'paused', stopping: 'stopping', off: 'off' };
  const sgn = v => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(v !== 0 && Math.abs(v) < 0.1 ? 4 : 2)}`;
  const gRange = g => `${pxs(g.levels[0].price)} → ${pxs(g.levels[g.levels.length - 1].price)} ×${g.levels.length}`;
  const dirTag = g => isOne(g) ? `<span class="tag ${g.levels[0].long ? 'long' : 'short'}" title="one-direction bot">${g.levels[0].long ? 'L' : 'S'}${g.dir === 'up' ? '▲' : '▼'}</span>`
    : `<span class="tag dir">${g.dir === 'up' ? '▲' : '▼'}</span>`;
  const sortedGrids = () => [...grids].sort((a, b) => (a.phase === 'off') - (b.phase === 'off') || a.n - b.n);
  function phaseLabel(g) {
    if (g.phase !== 'off') return [PH_CLS[g.phase], PHASE[g.phase].replace('…', '')];
    const o = nOpen(g);
    return o ? ['openlv', `${o} open`] : ['off', 'Stopped'];
  }
  function slotText(s, g) {
    if (s.state === 'entry') return [`${s.kind === 'trigger' ? 'Trigger' : 'Limit'} · waiting`, 'st-entry'];
    if (s.state === 'idle' && g.phase === 'armed') return ['waits for activation', 'st-idle'];
    return [LV_TEXT[s.state] || s.state, LV_CLS[s.state] || ''];
  }

  // the Grid tab (grid bots: long + short) and the One-direction tab (one side) share this code
  const isOne = g => g.mode === 'one';
  function M(mode) {
    const O = mode === 'one';
    return O
      ? { O, editor: ui.oEditor, edClose: ui.oEdClose, newBtn: ui.oNew, stopAll: ui.oStopAll, count: ui.oCount, clear: ui.oClear, edTitle: ui.oEdTitle,
          start: ui.ostart, err: ui.oEdErr, levels: ui.oLevels, list: ui.oList, act: ui.oAct, actHint: ui.oActHint, first: ui.oFirst, firstHint: ui.oFirstHint,
          dirs: ui.odirs, dirKey: 'oDir', dirAttr: 'odir', editKey: 'oEditId', editFlag: 'oEdit', prev: 'oPrevDraft', name: 'one-direction bot', of: isOne }
      : { O, editor: ui.gEditor, edClose: ui.gEdClose, newBtn: ui.gNew, stopAll: ui.gStopAll, count: ui.gCount, clear: ui.gClear, edTitle: ui.gEdTitle,
          start: ui.gstart, err: ui.gEdErr, levels: ui.aLevels, list: ui.gList, act: ui.aAct, actHint: ui.aActHint, first: ui.aFirst, firstHint: ui.aFirstHint,
          dirs: ui.dirs, dirKey: 'aDir', dirAttr: 'dir', editKey: 'gEditId', editFlag: 'gEdit', prev: 'gPrevDraft', name: 'grid bot', of: g => !isOne(g) };
  }
  function renderGrids(force) {
    renderBots('grid', force);
    renderBots('one', force);
    setHtml(ui.mini, miniHtml(), true);
  }
  function renderBots(mode, force) {
    const m = M(mode), mine = grids.filter(m.of);
    const nRun = mine.filter(g => g.phase !== 'off').length, nOff = mine.length - nRun;
    const allActive = grids.filter(g => g.phase !== 'off'), blocked = grids.some(g => g.phase === 'paused' || g.phase === 'stopping');
    const editing = cfg[m.editKey] && gById(cfg[m.editKey]);
    if (cfg[m.editKey] && !(editing && editable(editing))) { cfg[m.editKey] = null; if (cfg[m.prev]) { cfg.draft = cfg[m.prev]; cfg[m.prev] = null; loadDraft(); } }
    const edOpen = !!cfg[m.editFlag] || !nRun || !!cfg[m.editKey];
    m.editor.hidden = !edOpen;
    m.edClose.hidden = !nRun && !cfg[m.editKey];
    m.editor.classList.toggle('editing', !!cfg[m.editKey]);
    m.newBtn.hidden = edOpen;
    m.newBtn.disabled = allActive.length >= MAX_BOTS || hedgeOn() || st.dead;
    m.newBtn.title = allActive.length >= MAX_BOTS ? `Up to ${MAX_BOTS} bots at the same time` : `Set up and start another ${m.name}`;
    m.stopAll.hidden = nRun < 2;
    m.count.innerHTML = `${m.O ? 'One-direction bots' : 'Grid bots'} <small>${nRun ? nRun + ' active' : 'none active'}${nOff ? ` · ${nOff} stopped` : ''}</small>`;
    m.clear.disabled = !mine.some(g => !tracked(g));
    m.clear.hidden = !nOff;

    // ---- editor
    const d = cfg.draft || {}, dir = m.O ? (d.oDir === 'down' ? 'down' : 'up') : (d.aDir === 'up' ? 'up' : 'down');
    const useAct = (m.O ? d.oUse : d.aUse) !== false;
    (m.O ? ui.oUse : ui.aUse).checked = useAct;
    (m.O ? ui.actRowsO : ui.actRowsA).forEach(el => { el.hidden = !useAct; });
    m.dirs.forEach(b => b.classList.toggle('on', b.dataset[m.dirAttr] === dir));
    m.edTitle.textContent = cfg[m.editKey] ? `Edit bot #${editing.n} (waits for its activation price)` : `New ${m.O ? oneSide() + ' ' : ''}${m.name} · #${gridSeq + 1}`;
    m.start.textContent = cfg[m.editKey] ? 'Save changes' : m.O ? `Start ${oneSide()} bot` : 'Start grid';
    const av = num(m.act.value);
    m.actHint.textContent = av > 0 && st.last > 0
      ? (samePrice(av, st.last) ? 'at market now' : `waits for the price to ${av < st.last ? 'fall' : 'rise'} to it`)
      : 'orders are placed when the price touches it';
    const fv = num(m.first.value), ref = useAct ? av : st.last, refW = useAct ? 'activation' : 'market';
    m.firstHint.textContent = fv > 0 && ref > 0 ? (samePrice(fv, ref) ? `grid 1 · = ${refW}` : `grid 1 · ${fmt(Math.abs(fv - ref))} ${fv < ref ? 'below' : 'above'} ${refW}`) : (m.O ? '= grid 1' : 'first grid level');
    if (!cfg[m.editKey]) m.start.textContent = useAct ? m.start.textContent : (m.O ? `Start ${oneSide()} bot now` : 'Start grid now');
    if (m.O) {
      const L = oneSide() === 'long', loopP = d.oLoop === 'price';
      ui.oloops.forEach(b => b.classList.toggle('on', b.dataset.loop === (loopP ? 'price' : 'tpsl')));
      ui.oLpRow.hidden = !loopP;
      ui.oTpHint.textContent = `TP = grid ${L ? '+' : '−'} gap`;
      ui.oSlHint.textContent = `SL = grid ${L ? '−' : '+'} gap`;
      const lp = num(ui.oLp.value);
      ui.oLpHint.textContent = lp > 0 && st.last > 0 ? `a closed grid waits until the price touches ${fmt(lp)} (now ${fmt(st.last)})` : 'placed again when the price touches it';
    } else for (const [el, hint] of [[ui.aLsl, ui.aLslHint], [ui.aSsl, ui.aSslHint]]) {
      const rh = roundHint(num(el.value));
      hint.textContent = rh || (el === ui.aLsl ? 'price, below the grids' : 'price, above the grids');
      hint.classList.toggle('warn', !!rh);
    }
    let p = null, err = '';
    try { p = previewBot(mode); } catch (x) { err = x.message; }
    if (p) setHtml(m.levels, editorTable(p), force);
    else setHtml(m.levels, `<div class="st-idle">${escapeHtml(err || 'Fill in the settings.')}</div>`, force);
    let edErr = '';
    if (p) { try { edErr = levelClash(readBot(mode).levels, cfg[m.editKey] || undefined); } catch (x) { edErr = x.message; } }
    if (!edErr && hedgeOn()) edErr = 'Stop the hedge bot first (same long and short positions).';
    if (!edErr && !cfg[m.editKey] && blocked) edErr = 'A bot is paused: resume or stop it before starting another one.';
    if (!edErr && !cfg[m.editKey] && allActive.length >= MAX_BOTS) edErr = `Up to ${MAX_BOTS} bots at the same time.`;
    m.err.textContent = edErr;
    m.start.disabled = !!edErr || !p || st.dead;

    // ---- cards
    setHtml(m.list, sortedGrids().filter(m.of).map(cardHtml).join(''), force);
  }

  function editorTable(p) {
    const ov = (p.mode === 'one' ? cfg.draft.oOv : cfg.draft.aOv) || {};
    let rows = '', anyCustom = false;
    for (const r of p.rows) {
      rows += `<tr class="lvh"><td colspan="5">Grid ${r.i} · <b>${fmt(r.price)}</b>${samePrice(r.price, p.act) ? ' <span class="muted">= activation</span>' : ''}</td></tr>`;
      for (const side of p.sides) {
        const x = r[side], k = SK(side) + r.i, o = ov[k] || {};
        const cell = (f, what) => {
          const typed = o[f] != null && String(o[f]).trim() !== '';
          const val = typed ? String(o[f]) : f === 'qty' ? String(x.def.qty) : fmt(x.def[f]);
          if (x.custom[f]) anyCustom = true;
          return `<td><input type="text" inputmode="decimal" data-ov="${k}.${f}" class="${x.custom[f] ? 'custom' : ''}${x.errF === f ? ' bad' : ''}" value="${escapeHtml(val)}" ` +
            `title="${side} at ${fmt(r.price)}: ${what}. Default ${f === 'qty' ? x.def.qty + ' USDT' : fmt(x.def[f])}."></td>`;
        };
        const kindTxt = x.err ? '⚠' : x.kind === 'limit' ? 'Limit' : 'Trigger';
        rows += `<tr><td><span class="tag ${side}">${side === 'long' ? 'L' : 'S'}</span></td>${cell('qty', 'amount (USDT)')}${cell('tp', 'take profit')}${cell('sl', 'stop loss')}` +
          `<td class="${x.err ? 'neg' : 'muted'}" title="${escapeHtml(x.err || 'Order type when placed at the activation price. Decided again each time it is placed: ' + (side === 'long' ? 'Limit if the price is at or above the grid, else Trigger (Market).' : 'Limit if the price is at or below the grid, else Trigger (Market).'))}">${kindTxt}</td></tr>`;
      }
    }
    return (p.useAct ? `<div class="note">Activation <b>${fmt(p.act)}</b> · Type = order type if placed at the activation price</div>`
      : `<div class="note">No activation price: the orders are placed at Start · Type = order type at the current price (${fmt(p.act)})</div>`) +
      `<table class="lvt edt"><tr><th></th><th>Amount</th><th>TP</th><th>SL</th><th title="Order type at the activation price">Type</th></tr>${rows}</table>` +
      (anyCustom ? '<div class="note">Yellow = changed for that grid. <button class="ib" data-act="ovreset" title="Use the default values for every grid">Reset all to defaults</button></div>' : '');
  }

  function cardHtml(g) {
    const open = ui.openGrid === g.id, [pc, pt] = phaseLabel(g), nL = nOpen(g, 'long'), nS = nOpen(g, 'short'), N = g.levels.length;
    let h = `<div class="gcard${open ? ' open' : ''}${g.phase === 'paused' ? ' paused' : ''}">` +
      `<div class="ghead" data-act="toggle" data-id="${g.id}" title="Show / hide grids">${dirTag(g)}` +
      `<span class="n">#${g.n}</span><span class="rng">${gRange(g)}</span><span class="pill ${pc}">${pt}</span><span class="chev">${open ? '▾' : '▸'}</span>` +
      `<span class="sub"><span>${isOne(g) ? `${g.levels[0].long ? 'LONG' : 'SHORT'} · open ${nL + nS}/${N}` : `open L ${nL}/${N} · S ${nS}/${N}`}</span><span>TP ${g.tps}${g.sls ? ` · SL ${g.sls}` : ''}</span>` +
      `<span class="pnl ${g.pnl >= 0 ? 'pos' : 'neg'}">${sgn(g.pnl)}</span></span></div>`;
    const actions = () => {
      let a = '<div class="gact">';
      if (editable(g)) a += `<button data-act="edit" data-id="${g.id}" title="Change activation price, grids, amounts, TP and SL while it waits">Edit</button>`;
      if (g.phase === 'armed' || g.phase === 'run') a += `<button class="stop" data-act="stop" data-id="${g.id}" title="Cancels all its waiting orders (Limit and Trigger). Open positions stay open with their TP/SL.">Stop</button>`;
      if (g.phase === 'paused') a += `<button class="resume" data-act="resume" data-id="${g.id}">Resume</button><button class="stop" data-act="stop" data-id="${g.id}">Stop</button>`;
      if (g.phase === 'off') a += `<button class="resume" data-act="resume" data-id="${g.id}" title="Start this bot again: its orders that are not open are placed again (it waits for the activation price if it was never activated)">Resume</button>`;
      if (g.activated && g.phase !== 'stopping') a += `<button data-act="recheck" data-id="${g.id}" title="Read MEXC's Positions and Open Orders again and correct the records (places and cancels nothing)">↻ Refresh</button>`;
      if (g.phase === 'off' && !nOpen(g)) a += `<button data-act="remove" data-id="${g.id}">Remove</button>`;
      return a + '</div>';
    };
    if (!open) return h + `<div class="gfoot">${actions()}</div></div>`;
    const cell = (lv, side) => {
      const s = lv[side], [t, c] = slotText(s, g);
      const cust = Object.values(s.custom || {}).some(Boolean) ? '<span class="cust" title="custom values">●</span>' : '';
      const mark = s.state === 'filled' && g.phase !== 'run' && g.phase !== 'stopping'
        ? `<button class="ib" data-act="mark" data-id="${g.id}" data-i="${lv.i}" data-side="${side}" title="Only if this ${side} is no longer open on MEXC">Mark closed</button>` : '';
      return `<td class="slot"><span class="${c}">${t}</span>${cust}<small>${s.qty} · TP ${pxs(s.tp)} · SL ${pxs(s.sl)}</small>` +
        `${s.tps || s.sls ? `<small>TP ${s.tps} · SL ${s.sls}</small>` : ''}${mark}</td>`;
    };
    const sides = gSides(g);
    const rows = g.levels.map(lv => `<tr><td><b>${lv.priceStr}</b></td>${sides.map(sd => cell(lv, sd)).join('')}</tr>`).join('');
    const amt = side => { const q = [...new Set(g.levels.map(lv => lv[side].qty))]; return q.length === 1 ? q[0] + ' USDT' : 'own amount per grid'; };
    const hdr = sides.map(sd => sd === 'long' ? '<th><span class="tag long">L</span> Long</th>' : '<th><span class="tag short">S</span> Short</th>').join('');
    h += `<div class="gbody"><table class="lvt"><tr><th>Grid</th>${hdr}</tr>${rows}</table>` +
      `<div class="stats">${g.noAct ? `No activation price (started at ${g.actStr})` : `Activation <b>${g.actStr}</b>`} · grid 1 <b>${g.levels[0].priceStr}</b> ${g.dir === 'up' ? '▲ up' : '▼ down'} · gap ${pxs(g.gap)} · ${sides.map(sd => `${sideWord(sd)} ${amt(sd)}`).join(' · ')}` +
      (isOne(g) ? ` · loop <b>${g.loop === 'price' ? 'at price ' + g.loopPxStr : 'at TP/SL'}</b>` : '') +
      ` · TP hits <b>${g.tps}</b> · SL hits <b>${g.sls}</b> · est. PnL <b class="${g.pnl >= 0 ? 'pos' : 'neg'}">${sgn(g.pnl)}</b> <span class="muted">(before fees)</span></div>` +
      (g.note ? `<div class="note">${escapeHtml(g.note)}</div>` : '') + actions();
    return h + '</div></div>';
  }

  function miniHtml() {
    const rows = [];
    for (const g of sortedGrids().filter(tracked)) {
      const [pc, pt] = phaseLabel(g);
      rows.push(`<div class="mrow" data-id="${g.id}" title="Grid ${escapeHtml(gTag(g))} · ${gRange(g)} · click to open">` +
        `${dirTag(g)}<span class="muted">#${g.n}</span><span class="rng">${gRange(g)}</span>` +
        `<span title="open longs / shorts">${isOne(g) ? (g.levels[0].long ? 'L' : 'S') + nOpen(g) : nOpen(g, 'long') + '·' + nOpen(g, 'short')}</span><span class="${g.pnl >= 0 ? 'pos' : 'neg'}">${sgn(g.pnl)}</span><span class="pill ${pc}">${pt}</span></div>`);
    }
    if (hedgeOn()) {
      const h = hedge, nO = ['long', 'short'].filter(sd => h.sides[sd].state === 'open').length;
      const pnl = (h.sides.long.pnl || 0) + (h.sides.short.pnl || 0);
      if (rows.length) rows.push('<div class="msep"></div>');
      rows.push(`<div class="mrow" data-hedge="1" title="Hedge bot · click to open"><span class="tag hedge">H</span><span class="muted"></span>` +
        `<span class="rng">${pxs(h.entry)} ±${pxs(h.gap)}</span><span>${nO}/2</span><span class="${pnl >= 0 ? 'pos' : 'neg'}">${sgn(pnl)}</span><span class="pill ${PH_CLS[h.phase] || 'off'}">${PHASE[h.phase].replace('…', '')}</span></div>`);
    }
    if (!rows.length) return '<div class="muted" style="padding:2px 4px">No bots running. Expand ▸ to start one.</div>';
    return `<div class="mrow mhead"><span></span><span>#</span><span>Grids</span><span>Open</span><span>PnL</span><span>Status</span></div>` + rows.join('');
  }

  const escapeHtml = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // typing in the editor's grid table, clicks on the grid cards and the minimised dashboard
  function wireGridTables() {
    for (const [box, mode, key] of [[ui.aLevels, 'grid', 'aOv'], [ui.oLevels, 'one', 'oOv']]) {
      box.addEventListener('input', e => {
        const t = e.target, k0 = t && t.dataset && t.dataset.ov;
        if (!k0) return;
        const [k, f] = k0.split('.');
        const ov = cfg.draft[key] || (cfg.draft[key] = {}), o = ov[k] || (ov[k] = {});
        const raw = t.value.trim(), v = num(cleanNum(raw));
        let def = null;
        try { const r = previewBot(mode).rows.find(x => x.i === +k.slice(1)); def = r[k[0] === 'l' ? 'long' : 'short'].def[f]; } catch (_) {}
        if (!raw || (v > 0 && def != null && Math.abs(v - def) <= 1e-9)) delete o[f];
        else o[f] = raw;                                     // kept as typed: something that is not a number blocks Start
        if (!Object.keys(o).length) delete ov[k];
        t.classList.toggle('custom', !!o[f]);
        saveDraft(); render();
      });
      box.addEventListener('focusout', () => setTimeout(() => render(), 0));
      box.addEventListener('click', e => { if (e.target.closest('[data-act="ovreset"]')) { cfg.draft[key] = {}; saveDraft(); render(true); } });
    }
    for (const list of [ui.gList, ui.oList]) list.addEventListener('click', e => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const id = b.dataset.id, act = b.dataset.act;
      if (act === 'toggle') { ui.openGrid = ui.openGrid === id ? null : id; return render(true); }
      if (act === 'stop') return stopGrid(id);
      if (act === 'resume') return resumeGrid(id);
      if (act === 'remove') return removeGrid(id);
      if (act === 'recheck') return refreshBots();
      if (act === 'edit') return editGrid(id);
      if (act === 'mark') return markClosed(id, +b.dataset.i, b.dataset.side);
    });
    ui.mini.addEventListener('click', e => {
      const r = e.target.closest('.mrow');
      if (!r || r.classList.contains('mhead')) return;
      if (r.dataset.hedge) cfg.tab = 'grid';
      else { const g = gById(r.dataset.id); cfg.tab = g && isOne(g) ? 'one' : 'grid'; ui.openGrid = r.dataset.id; }
      setView('full');
      render(true);
    });
  }

  const HS_TEXT = { idle: 'not placed', busy: 'placing…', waiting: 'trigger waiting', open: 'OPEN · SL set', closed: 'closed (TP/hand) · not re-armed', retry: 'to re-place' };
  function renderHedge() {
    const on = hedgeOn(), h = hedge;
    const e = num(ui.hEntry.value), gap = num(ui.hGap.value), q = num(ui.hQty.value);
    ui.hEntryHint.textContent = e > 0 && st.last > 0 ? `${e < st.last ? 'below' : e > st.last ? 'above' : 'at'} market` : 'long + short open here';
    const rows = [];
    if (on) {
      rows.push(`<div class="lv" style="color:#7b8291"><span></span><span>trigger ${h.entryStr} · market · ${h.qty} USDT${h.lev ? ' · ' + h.lev + 'x' : ''}</span><span></span></div>`);
      for (const side of ['long', 'short']) {
        const sd = h.sides[side];
        rows.push(`<div class="lv"><span style="color:${side === 'long' ? '#2ebd85' : '#f6465d'}">${side === 'long' ? 'L' : 'S'}</span><span>SL <b>${fmt(hSL(side, h))}</b> · SL hits ${sd.sls}</span><span class="st-${sd.state === 'open' ? 'filled' : sd.state === 'waiting' ? 'entry' : sd.state === 'retry' ? 'retry' : 'idle'}">${HS_TEXT[sd.state] || sd.state}</span></div>`);
      }
    } else if (e > 0 && gap > 0) {
      rows.push(`<div class="lv"><span style="color:#2ebd85">L</span><span>at <b>${fmt(e)}</b> · SL <b>${fmt(e - gap)}</b></span><span></span></div>`);
      rows.push(`<div class="lv"><span style="color:#f6465d">S</span><span>at <b>${fmt(e)}</b> · SL <b>${fmt(e + gap)}</b></span><span></span></div>`);
      if (q > 0) rows.push(`<div class="lv" style="color:#7b8291"><span></span><span>each SL ≈ −${(q * gap / e).toFixed(2)} USDT + fees</span><span></span></div>`);
    } else rows.push('<div class="st-idle">Fill in entry price, SL gap and amount.</div>');
    ui.hBox.innerHTML = rows.join('');
    const pnl = (h.sides.long.pnl || 0) + (h.sides.short.pnl || 0);
    ui.hStats.innerHTML = `Hedge · Status <b>${PHASE[h.phase] || h.phase}</b>${on ? ` · SL losses <b style="color:#f6465d">${pnl.toFixed(4)}</b> USDT <span style="color:#7b8291">(before fees, TP profits not counted)</span>` : ''}`;
    ui.hstart.hidden = h.phase === 'paused';
    ui.hresume.hidden = h.phase !== 'paused';
    ui.hstart.disabled = on || st.dead;
    ui.hstop.disabled = !on || h.phase === 'stopping' || st.dead;
    ui.happly.disabled = h.phase !== 'run';
    ui.hrearmL.disabled = !(h.phase === 'run' && ['closed', 'idle'].includes(h.sides.long.state));
    ui.hrearmS.disabled = !(h.phase === 'run' && ['closed', 'idle'].includes(h.sides.short.state));
  }

  function renderSetup() {
    if (!ui) return;
    let s = null;
    try { s = readSetup(findForm().root); } catch (_) { try { s = readSetup(findForm(curSide(), 'close').root); } catch (__) {} }
    const lev = s && s.lev, mm = s && s.margin;
    ui.lev.textContent = lev ? `MEXC ${lev}x` : 'MEXC leverage ?';
    ui.lev.className = 'chip' + (lev ? ' good' : '');
    ui.lev.title = 'The bots use the leverage set on MEXC.';
    ui.mm.textContent = mm || 'Margin ?';
    ui.mm.className = 'chip ' + (mm ? (mm === cfg.margin ? 'good' : 'bad') : '');
  }

  // ================================================================ lifecycle
  window.addEventListener('keydown', e => {
    if (e.altKey && e.code === 'KeyQ' && ui && isFuturesPage()) {
      e.preventDefault(); e.stopPropagation();
      if (cfg.view === 'hidden') setView(cfg.lastView || 'full');
      else setView('hidden');
      return;
    }
    if (!e.altKey || !ui || !isFuturesPage() || e.code !== 'KeyL' || cfg.tab !== 'single') return;
    e.preventDefault(); e.stopPropagation();
    runSingle(cfg.mode === 'auto');
  }, true);

  // health watch (bot window): price feed, window in the background, waiting bots far from their activation price
  const H = { priceBad: false, hiddenSince: 0, hiddenAlerted: false, far: {}, bookSig: null, bookAt: 0, bookBad: false };
  // the whole order book (all prices and quantities), not only the last / fair / index price: if none of it changes for a
  // minute while the window is visible, the MEXC page is frozen or disconnected
  let obBox = null;
  function bookSig() {
    const head = remember('obhead', el => visible(el) && /^Order Book$/i.test(norm(el.textContent)), () => textEls(/^Order Book$/i)[0] || null);
    if (!head) return null;
    if (!(obBox && obBox.isConnected && obBox.contains(head))) {
      obBox = null;
      for (let p = head.parentElement, i = 0; p && i < 8 && p !== document.body; p = p.parentElement, i++) {
        if ((p.textContent.match(/\d[\d,]*\.\d+/g) || []).length >= 20) { obBox = p; break; }
      }
    }
    if (!obBox) return null;
    const t = obBox.textContent;
    let h = 0;
    for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0;
    return t.length + ':' + h;
  }
  const H_NOPRICE = 20000, H_FROZEN = 90000, H_BOOK = 60000;
  function healthTick() {
    if (!iAmBot) return;
    const active = grids.some(g => g.phase === 'armed' || g.phase === 'run' || g.phase === 'paused') || hedgeOn();
    if (!active) { H.priceBad = false; return; }
    // no new price, or the same price for a long time (frozen page / lost connection)
    const age = Date.now() - st.lastAt, still = Date.now() - (st.changeAt || st.lastAt);
    if ((age > H_NOPRICE || still > H_FROZEN) && !H.priceBad) {
      H.priceBad = true;
      alertUser('crit', age > H_NOPRICE
        ? `No price from MEXC for ${Math.round(age / 1000)} s: the bots can't see fills, TPs, SLs or activation prices. Check the internet connection and that this MEXC page is open.`
        : `MEXC's price hasn't changed for ${Math.round(still / 1000)} s (${fmt(st.last)}): the page may be frozen or disconnected. Refresh the MEXC page (F5), then press Resume on paused bots.`);
    } else if (age < 5000 && still < 5000 && H.priceBad) { H.priceBad = false; alertUser('good', 'MEXC prices are coming in again.'); }
    const sig = bookSig();
    if (sig && sig !== H.bookSig) {
      H.bookSig = sig; H.bookAt = Date.now();
      if (H.bookBad) { H.bookBad = false; alertUser('good', 'MEXC\'s order book is moving again.'); }
    } else if (sig && !document.hidden && !H.hiddenSince && Date.now() - H.bookAt > H_BOOK && !H.bookBad) {
      H.bookBad = true;
      alertUser('crit', `MEXC's order book hasn't changed for ${Math.round((Date.now() - H.bookAt) / 1000)} s: the page looks frozen or disconnected. Press F5 to reload the MEXC page, then Resume the paused bots.`);
    }
    if (document.hidden) { H.bookAt = Date.now(); }               // a page in the background may stop drawing: no alarm for that
    if (document.hidden) {
      if (!H.hiddenSince) H.hiddenSince = Date.now();
      if (!H.hiddenAlerted && Date.now() - H.hiddenSince > 15000) {
        H.hiddenAlerted = true;
        alertUser('warn', 'The MEXC bot window is in the background: Chrome slows down the bot\'s clicks there. Keep it visible (its own window, not minimised).');
      }
    } else { H.hiddenSince = 0; H.hiddenAlerted = false; }
    const pct = aCfg().farPct;
    if (pct > 0 && st.last > 0) for (const g of grids) {
      if (g.phase !== 'armed') continue;
      const d = Math.abs(st.last - g.act) / g.act * 100;
      if (d >= pct && Date.now() - (H.far[g.id] || 0) > 30 * 60000) {
        H.far[g.id] = Date.now();
        alertUser('warn', `waits for ${g.actStr}, but the price is ${fmt(st.last)} (${d.toFixed(2)}% away). Press Edit on it to change the activation price.`, { bot: g.n });
      }
    }
  }

  let tickN = 0, hiddenWarned = false;
  function tick() { lastTickAt = Date.now(); try { tickInner(); } catch (e) { log('tick error: ' + (e && e.message)); } }
  function tickInner() {
    if (!alive()) return markDead();
    const show = isFuturesPage();
    if (ui) { ui.host.style.display = show && cfg.view !== 'hidden' ? '' : 'none'; ui.bubble.style.display = show ? '' : 'none'; }
    if (!show) return;
    const sym = getSymbol();
    if (sym !== st.sym) {
      Object.assign(st, { sym, last: null, lastAt: 0, feedAt: 0, pageAt: 0, dec: null });
      pageEl = null; render(); connectFeed();
    }
    if (Date.now() - st.feedAt > 3000) { readPagePrice(); if (Date.now() - st.lastAt > 3000) readTitle(); }
    if (tickN++ % 6 === 0) renderSetup();
    if (iAmBot && Date.now() - lastBeat >= BEAT_MS) beat();
    if (iAmBot) trackRanges();                               // every tick, also while orders are being placed
    if (tickN % 2 === 0 || !hedgeOn()) gridTick();          // grid bot: every 0.3 s (the hedge bot never runs at the same time)
    if (tickN % 2 === 1) hedgeTick();
    if (tickN % 3 === 0) viewerTick();
    if (tickN % 7 === 0) healthTick();
    if (looking() || (lookUntil && !looking())) { if (!looking()) lookUntil = 0; render(); }
    if ((grids.some(g => g.phase === 'run') || hedge.phase === 'run') && iAmBot && document.hidden && !hiddenWarned) {
      hiddenWarned = true;
      status('Bots running: keep this MEXC tab visible. Chrome slows down hidden tabs.', 'warn');
    }
    if (!document.hidden) hiddenWarned = false;
  }

  storeGet('mql', saved => {
    cfg = { ...DEFAULTS, ...(saved || {}) };
    buildUI();
    storeGet('mqlAlerts', list => { mergeAlerts(list); alertsLoaded = true; render(); });
    storeGet('mqlLeader', ld => {
      leader = ld || { id: null, ts: 0 };
      if (leader.id === TAB_ID) { iAmBot = true; beat(); }  // this tab was the bot window before the refresh
      storeGet('mqlGrids9', saved9 => storeGet('mqlGrids8', saved8 => {
        const viewer = otherBotAlive();                     // another MEXC window is running the bots right now
        if (saved9) {
          grids = saved9.list || []; gridSeq = saved9.seq || grids.reduce((a, g) => Math.max(a, g.n || 0), 0);
          for (const sd of SIDES) if (saved9.trk && saved9.trk[sd]) Object.assign(trk[sd], { ...TRK0, k: saved9.trk[sd].k ?? null });
        }
        // grids of version 8 are not carried over (different kind of bot)
        if (saved8 && (saved8.list || []).some(g => g.phase !== 'off' || (g.levels || []).some(l => l.state === 'filled')))
          setTimeout(() => status('Grids from version 8 are not carried over. If they left orders or positions on MEXC, check Positions and Open Orders and close/cancel them by hand.', 'warn'), 500);
        if (!viewer) {
          for (const g of grids) {
            if (g.phase === 'off') continue;
            eachSlot(g, s => { if (s.state === 'busy' || s.state === 'check') s.state = 'retry'; });
            if (g.phase === 'armed' && iAmBot) { g.aLo = g.aHi = null; continue; }   // still waiting for the activation price
            g.phase = 'paused';
            g.note = 'The page was refreshed (or the bot window closed) while it ran. Press Resume, or Stop.';
          }
          for (const sd of SIDES) if (grids.some(g => g.phase === 'paused' && g.activated) && sideBusy(sd)) Object.assign(trk[sd], { bad: true, badMsg: 'the page was refreshed' });
          if (grids.some(g => g.phase === 'paused')) {
            cfg.tab = 'grid';
            status('The page was refreshed while the grid bot was running. It is paused: open it and press Resume (or Stop).', 'warn');
            setTimeout(() => alertUser('crit', `The MEXC page was refreshed (or the bot window closed) while bots were running: ${grids.filter(g => g.phase === 'paused').map(g => '#' + g.n).join(', ')} paused. Press Resume on each (or Stop). TP/SL on MEXC stayed active.`), 1500);
          }
          saveGrids();
        }
        if (viewer) { storeGet('mqlHedge7', hs => { if (hs) { hedge = hs; render(); } }); }
        else storeGet('mqlHedge7', hs => {
          if (!hs) return;
          hedge = { ...JSON.parse(JSON.stringify(HEDGE0)), ...hs };
          if (hs.phase && hs.phase !== 'off') {
            for (const side of ['long', 'short']) if (hedge.sides[side].state === 'busy') hedge.sides[side].state = 'retry';
            hedge.phase = 'paused'; cfg.tab = 'hedge';
            hMsg('the page was refreshed (or the bot window closed) while it was running. Press Resume, or Stop.', 'warn');
          } else { hedge.phase = 'off'; render(); }
        });
        if (viewer) status('This window is a viewer: the bots run in another MEXC window (the bot window). You can trade single orders here.', 'ok');
        render(true);
      }));
    });
    new MutationObserver(readTitle).observe(document.head, { childList: true, subtree: true, characterData: true });
    tick();
    timer = setInterval(tick, 300);
  });
})();
