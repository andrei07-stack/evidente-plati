/* Evidențe plăți – PWA
 * Model: bunuri (mașini, locuințe) + evidențe (RCA, ITP, facturi…) legate opțional de un bun.
 * Date: Google Drive (appDataFolder, fișier evidente.json) + copie locală în browser.
 * Notificări: evenimente într-un calendar Google dedicat, cu reminder-e pop-up / email.
 */
(() => {
  'use strict';

  const CFG = window.APP_CONFIG || {};
  const DEMO = !CFG.GOOGLE_CLIENT_ID;
  const LS_DATA = 'evidente.data.v1';
  const LS_UI = 'evidente.ui';
  const SS_TOKEN = 'evidente.token.v1';
  const LS_CONNECTED = 'evidente.connected';
  const DRIVE_FILE = 'evidente.json';
  const SCOPES = [
    'https://www.googleapis.com/auth/drive.appdata',
    'https://www.googleapis.com/auth/calendar.app.created',
  ].join(' ');

  const CATEGORII = [
    { id: 'RCA', ico: '🚗', rec: 12 },
    { id: 'CASCO', ico: '🛡️', rec: 12 },
    { id: 'ITP', ico: '🔧', rec: 12 },
    { id: 'Rovinietă', ico: '🛣️', rec: 12 },
    { id: 'Asigurare locuință', ico: '🏠', rec: 12 },
    { id: 'Factură', ico: '🧾', rec: 1 },
    { id: 'Amendă', ico: '⚠️', rec: 0 },
    { id: 'Impozit', ico: '🏛️', rec: 12 },
    { id: 'Revizie', ico: '🛠️', rec: 12 },
    { id: 'Abonament', ico: '🔁', rec: 1 },
    { id: 'Altele', ico: '📌', rec: 0 },
  ];
  const catOf = (id) => CATEGORII.find((c) => c.id === id) || CATEGORII[CATEGORII.length - 1];
  // Perioade de valabilitate: număr = luni, „Nd” = zile (ex. rovinietă 7 / 30 / 90 de zile).
  const PERIOADE = [
    ['0', 'Nu se repetă'], ['1d', '1 zi'], ['7d', '7 zile'], ['30d', '30 de zile'], ['90d', '90 de zile'],
    ['1', '1 lună'], ['3', '3 luni'], ['6', '6 luni'], ['12', '1 an'], ['24', '2 ani'],
  ];
  const PER_LABEL = Object.fromEntries(PERIOADE);
  const recLabel = (code) => (code && String(code) !== '0' && PER_LABEL[String(code)] ? 'la ' + PER_LABEL[String(code)] : '');
  const REC_LABEL = new Proxy({}, { get: (_, k) => recLabel(k) });
  // Ce perioade se propun la „Plătit”, în funcție de categorie.
  const PER_CAT = {
    'Rovinietă': ['1d', '7d', '30d', '90d', '12'],
    'Factură': ['1', '3', '6', '12'],
    'Abonament': ['1', '3', '6', '12'],
    'ITP': ['6', '12', '24'],
  };
  const perFor = (cat) => PER_CAT[cat] || ['1', '3', '6', '12', '24'];
  function addPeriod(iso, code) {
    const c = String(code);
    return c.endsWith('d') ? addDays(iso, parseInt(c, 10)) : addMonths(iso, Number(c));
  }
  const isRecurring = (it) => String(it.recurenta || '0') !== '0';

  // Ce documente are în mod normal fiecare tip de bun (apar ca „lipsă” în fișa bunului).
  const TIPURI = {
    masina: { ico: '🚗', label: 'Mașină', docs: ['RCA', 'ITP', 'Rovinietă', 'CASCO'] },
    locuinta: { ico: '🏠', label: 'Locuință', docs: ['Asigurare locuință', 'Impozit'] },
    alt: { ico: '📦', label: 'Altceva', docs: [] },
  };
  const OPTIONALE = new Set(['CASCO']);

  const ACCENTE = [
    { id: 'teal', nume: 'Smarald', l: '#0f766e', d: '#2dd4bf' },
    { id: 'blue', nume: 'Albastru', l: '#1d4ed8', d: '#60a5fa' },
    { id: 'indigo', nume: 'Indigo', l: '#4338ca', d: '#818cf8' },
    { id: 'violet', nume: 'Violet', l: '#6d28d9', d: '#a78bfa' },
    { id: 'rose', nume: 'Vișiniu', l: '#be123c', d: '#fb7185' },
    { id: 'orange', nume: 'Portocaliu', l: '#c2410c', d: '#fb923c' },
    { id: 'green', nume: 'Verde', l: '#15803d', d: '#4ade80' },
    { id: 'slate', nume: 'Grafit', l: '#334155', d: '#cbd5e1' },
  ];

  // ---------- Stare ----------
  let state = null; // inițializat la pornire, după definirea utilitarelor
  const prefs = Object.assign({ view: 'prioritar', accent: 'teal', mode: 'auto' }, loadJson(localStorage, LS_UI) || {});
  const ui = { cat: 'Toate', quick: null, q: '', showPaid: false };
  let token = null;
  let tokenClient = null;
  let syncing = false;
  let pendingSave = null;

  function loadJson(store, key) { try { return JSON.parse(store.getItem(key)); } catch (e) { return null; } }
  function emptyState() {
    return { version: 2, updatedAt: 0, assets: [], items: [], settings: { calendarId: null }, pendingDeletes: [], deleted: [] };
  }
  function loadLocal() {
    const s = loadJson(localStorage, LS_DATA);
    return s && Array.isArray(s.items) ? Object.assign(emptyState(), s) : emptyState();
  }
  function saveLocal() {
    try { localStorage.setItem(LS_DATA, JSON.stringify(state)); } catch (e) { /* ignore */ }
  }
  function savePrefs() {
    try { localStorage.setItem(LS_UI, JSON.stringify(prefs)); } catch (e) { /* ignore */ }
  }
  function commit() {
    state.updatedAt = Date.now();
    // marcaj de timp pe elementele modificate, pentru îmbinarea între dispozitive
    state.items.forEach((i) => { if (i.dirty) i.upd = state.updatedAt; });
    saveLocal();
    render();
    scheduleSync();
  }

  // v1 → v2: câmpul text „obiect” devine bun (mașină / locuință) separat.
  const PLATE_RE = /\b([A-Z]{1,2})[\s-]?(\d{2,3})[\s-]?([A-Z]{3})\b/i;
  function migrate(s) {
    s.assets = Array.isArray(s.assets) ? s.assets : [];
    s.pendingDeletes = s.pendingDeletes || [];
    s.deleted = s.deleted || [];
    s.settings = s.settings || { calendarId: null };
    const carCats = new Set(['RCA', 'CASCO', 'ITP', 'Rovinietă', 'Revizie', 'Amendă']);
    s.items.forEach((i) => {
      if (i.assetId || !i.obiect) return;
      const key = i.obiect.trim().toLowerCase();
      let a = s.assets.find((x) => x._legacy === key);
      if (!a) {
        const m = i.obiect.match(PLATE_RE);
        const tip = m || carCats.has(i.categorie) ? 'masina' : 'locuinta';
        const nume = (m ? i.obiect.replace(m[0], '') : i.obiect).replace(/[\s–-]+$/, '').replace(/^[\s–-]+/, '').trim();
        a = { id: uid(), tip, nume: nume || (tip === 'masina' ? 'Mașină' : i.obiect), numar: m ? `${m[1]} ${m[2]} ${m[3]}`.toUpperCase() : '', _legacy: key };
        s.assets.push(a);
      }
      i.assetId = a.id;
    });
    s.items.forEach((i) => { delete i.obiect; });
    s.assets.forEach((a) => { delete a._legacy; });
    s.version = 2;
    return s;
  }

  // ---------- Utilitare ----------
  const pad = (n) => String(n).padStart(2, '0');
  const isoOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseIso = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const todayIso = () => isoOf(new Date());
  const roDate = (s) => { const [y, m, d] = s.split("-"); return `${d}/${m}/${y}`; };
  const daysLeft = (s) => Math.round((parseIso(s) - parseIso(todayIso())) / 86400000);
  function addMonths(s, n) {
    const d = parseIso(s);
    const day = d.getDate();
    const t = new Date(d.getFullYear(), d.getMonth() + n, 1);
    const last = new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate();
    t.setDate(Math.min(day, last));
    return isoOf(t);
  }
  function addDays(s, n) { const d = parseIso(s); d.setDate(d.getDate() + n); return isoOf(d); }
  const lei = (v) => new Intl.NumberFormat('ro-RO', { maximumFractionDigits: 2 }).format(v) + ' lei';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const monthFmt = new Intl.DateTimeFormat('ro-RO', { month: 'long', year: 'numeric' });
  const wdFmt = new Intl.DateTimeFormat('ro-RO', { weekday: 'short' });

  const assetOf = (i) => state.assets.find((a) => a.id === i.assetId) || null;
  const assetLabel = (a) => (a ? [a.nume, a.numar].filter(Boolean).join(' · ') : '');
  const titleOf = (i) => i.titlu || i.categorie;
  const plateHtml = (n) => (n ? `<span class="plate"><span>${esc(n)}</span></span>` : '');

  function statusOf(it) {
    if (it.status === 'platit') return { cls: 's-paid', text: 'Plătit', rank: 9 };
    const d = daysLeft(it.expira);
    if (d < 0) return { cls: 's-danger', text: `Expirat de ${-d} ${-d === 1 ? 'zi' : 'zile'}`, rank: 0 };
    if (d === 0) return { cls: 's-danger', text: 'Azi', rank: 0 };
    if (d === 1) return { cls: 's-warn', text: 'Mâine', rank: 1 };
    if (d <= 7) return { cls: 's-warn', text: `În ${d} zile`, rank: 1 };
    if (d <= 30) return { cls: 's-info', text: `În ${d} zile`, rank: 2 };
    return { cls: 's-ok', text: `În ${d} zile`, rank: 3 };
  }

  // ---------- Tema ----------
  function applyTheme() {
    const a = ACCENTE.find((x) => x.id === prefs.accent) || ACCENTE[0];
    const root = document.documentElement;
    root.style.setProperty('--accent-l', a.l);
    root.style.setProperty('--accent-d', a.d);
    if (prefs.mode === 'auto') root.removeAttribute('data-mode'); else root.setAttribute('data-mode', prefs.mode);
    const dark = prefs.mode === 'dark' || (prefs.mode === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.querySelector('meta[name=theme-color]').setAttribute('content', dark ? '#161e25' : a.l);
  }

  // ---------- Randare ----------
  const $ = (sel) => document.querySelector(sel);

  function filteredItems({ ignoreQuick = false } = {}) {
    const q = ui.q.trim().toLowerCase();
    return state.items.filter((i) => {
      if (!ui.showPaid && i.status === 'platit') return false;
      if (ui.cat !== 'Toate' && i.categorie !== ui.cat) return false;
      if (ui.quick && !ignoreQuick) {
        if (i.status === 'platit') return false;
        const d = daysLeft(i.expira);
        if (ui.quick === 'expired' && d >= 0) return false;
        if (ui.quick === '7' && (d < 0 || d > 7)) return false;
        if (ui.quick === '30' && (d < 0 || d > 30)) return false;
      }
      if (q) {
        const a = assetOf(i);
        const hay = `${i.titlu} ${i.categorie} ${i.note} ${a ? a.nume + ' ' + a.numar + ' ' + (a.numar || '').replace(/\s/g, '') : ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    }).sort((a, b) => (a.status === 'platit') - (b.status === 'platit') || a.expira.localeCompare(b.expira));
  }

  function render() {
    const active = state.items.filter((i) => i.status !== 'platit');
    const dl = (i) => daysLeft(i.expira);
    $('#stExpired').textContent = active.filter((i) => dl(i) < 0).length;
    $('#st7').textContent = active.filter((i) => dl(i) >= 0 && dl(i) <= 7).length;
    $('#st30').textContent = active.filter((i) => dl(i) >= 0 && dl(i) <= 30).length;
    // Total plătit efectiv (din istoricul plăților confirmate cu ✓), nu estimat.
    const year = todayIso().slice(0, 4);
    const month = todayIso().slice(0, 7);
    const pays = state.items.flatMap((i) => i.istoric || []).filter((h) => h.data && h.suma != null);
    const sumOf = (pref) => pays.filter((h) => h.data.startsWith(pref)).reduce((s, h) => s + (Number(h.suma) || 0), 0);
    $('#stSum').textContent = lei(sumOf(year));
    $('#stSumLbl').textContent = `Plătit în ${year} · luna asta ${lei(sumOf(month))}`;
    document.querySelectorAll('.stat[data-quick]').forEach((b) => b.classList.toggle('active', b.dataset.quick === ui.quick));
    document.querySelectorAll('.views button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === prefs.view)));

    const isAssets = prefs.view === 'bunuri';
    $('#chips').hidden = isAssets;
    $('#paidToggle').hidden = isAssets;

    const used = ['Toate', ...CATEGORII.map((c) => c.id).filter((c) => state.items.some((i) => i.categorie === c))];
    $('#chips').innerHTML = used.map((c) => `<button type="button" class="chip ${c === ui.cat ? 'on' : ''}" data-cat="${esc(c)}">${c === 'Toate' ? 'Toate' : catOf(c).ico + ' ' + esc(c)}</button>`).join('');

    const view = $('#view');
    const empty = $('#empty');
    if (isAssets) {
      view.innerHTML = renderAssets();
      empty.hidden = true;
      return;
    }
    const rows = filteredItems();
    empty.hidden = rows.length > 0;
    empty.innerHTML = state.items.length
      ? 'Nimic nu se potrivește filtrului.'
      : 'Nicio evidență încă. Apasă <strong>+</strong> și începe cu o mașină sau o locuință.';
    view.innerHTML = rows.length ? ({ prioritar: renderPriority, cronologie: renderTimeline, tabel: renderTable }[prefs.view] || renderPriority)(rows) : '';
  }

  function paidBtn(it) {
    return it.status === 'platit'
      ? `<button type="button" class="btn small ghost" data-act="reopen" data-id="${it.id}">Redeschide</button>`
      : `<button type="button" class="btn small ok" data-act="paid" data-id="${it.id}">✓ Plătit</button>`;
  }
  function subLine(it, withCat = true) {
    const a = assetOf(it);
    const parts = [];
    if (withCat && it.titlu) parts.push(esc(it.categorie));
    if (a) parts.push(`${TIPURI[a.tip]?.ico || ''} ${esc(a.nume)}`);
    if (REC_LABEL[it.recurenta]) parts.push(REC_LABEL[it.recurenta]);
    return parts.join(' · ') + (a && a.numar ? ' ' + plateHtml(a.numar) : '');
  }
  const syncFlag = (it) => (!DEMO && it.dirty ? '<span class="sync-flag">nesincronizat</span>' : '');

  // 1) Prioritar – carduri grupate pe urgență
  function renderPriority(rows) {
    const groups = [
      { t: 'Expirate și restante', cls: 's-danger', f: (i) => i.status !== 'platit' && daysLeft(i.expira) <= 0 },
      { t: 'În următoarele 7 zile', f: (i) => i.status !== 'platit' && daysLeft(i.expira) > 0 && daysLeft(i.expira) <= 7 },
      { t: 'Luna aceasta', f: (i) => i.status !== 'platit' && daysLeft(i.expira) > 7 && daysLeft(i.expira) <= 30 },
      { t: 'Mai târziu', f: (i) => i.status !== 'platit' && daysLeft(i.expira) > 30 },
      { t: 'Plătite', f: (i) => i.status === 'platit' },
    ];
    return groups.map((g) => {
      const gi = rows.filter(g.f);
      if (!gi.length) return '';
      return `<div class="section-title ${g.cls || ''}">${g.t} <span class="count">${gi.length}</span></div>
        <div class="list">${gi.map(cardHtml).join('')}</div>`;
    }).join('');
  }
  function cardHtml(it) {
    const st = statusOf(it);
    return `<article class="card ${st.cls}" data-id="${it.id}">
      <div class="ico" aria-hidden="true">${catOf(it.categorie).ico}</div>
      <div class="main">
        <div class="t">${esc(titleOf(it))}</div>
        <div class="sub">${subLine(it)}</div>
        <div class="meta"><span class="badge ${st.cls}">${st.text}</span><span class="date">${roDate(it.expira)}</span>${syncFlag(it)}</div>
      </div>
      <div class="side">${it.suma ? `<span class="sum" title="Ultima sumă plătită"><small>ultima</small> ${lei(Number(it.suma))}</span>` : ''}${paidBtn(it)}</div>
    </article>`;
  }

  // 2) Bunuri – câte un „card de portofel” pe mașină / locuință, cu documentele ei
  function renderAssets() {
    const q = ui.q.trim().toLowerCase();
    const assets = state.assets.filter((a) => !q || `${a.nume} ${a.numar} ${(a.numar || '').replace(/\s/g, '')}`.toLowerCase().includes(q));
    const cards = assets.map(assetCardHtml);
    const loose = state.items.filter((i) => !i.assetId && i.status !== 'platit');
    if (loose.length && !q) {
      cards.push(`<section class="wcard"><div class="whead" style="--accent-l: #475569"><span class="wname">Alte plăți</span><span class="wico">🗂️</span><span class="wsub">Facturi, amenzi, abonamente fără bun asociat</span></div>
        <div class="wrows">${loose.sort((a, b) => a.expira.localeCompare(b.expira)).map(wrowHtml).join('')}</div></section>`);
    }
    if (!q) {
      cards.push('<button type="button" class="wempty" data-new="masina">＋ Adaugă mașină</button>');
      if (!state.assets.some((a) => a.tip === 'locuinta')) cards.push('<button type="button" class="wempty" data-new="locuinta">＋ Adaugă locuință</button>');
    }
    return `<div class="wallet">${cards.join('')}</div>`;
  }
  function assetCardHtml(a) {
    const t = TIPURI[a.tip] || TIPURI.alt;
    const items = state.items.filter((i) => i.assetId === a.id && i.status !== 'platit').sort((x, y) => x.expira.localeCompare(y.expira));
    const rows = [];
    t.docs.forEach((cat) => {
      const its = items.filter((i) => i.categorie === cat);
      if (its.length) its.forEach((i) => rows.push(wrowHtml(i)));
      else rows.push(`<button type="button" class="wrow missing" data-add="${esc(cat)}" data-asset="${a.id}">
          <span class="wi">${catOf(cat).ico}</span>
          <span class="wl"><b>${esc(cat)}</b><small>${OPTIONALE.has(cat) ? 'opțional – neadăugat' : 'lipsește – adaugă data expirării'}</small></span>
          <span class="add">＋ Adaugă</span></button>`);
    });
    items.filter((i) => !t.docs.includes(i.categorie)).forEach((i) => rows.push(wrowHtml(i)));
    rows.push(`<button type="button" class="wrow missing" data-add="" data-asset="${a.id}"><span class="wi">＋</span><span class="wl"><b>Altă evidență</b><small>revizie, amendă, impozit…</small></span><span></span></button>`);

    const worst = items.map(statusOf).sort((x, y) => x.rank - y.rank)[0];
    const missingReq = t.docs.filter((c) => !OPTIONALE.has(c) && !items.some((i) => i.categorie === c)).length;
    let state_ = '✓ Totul în regulă';
    if (worst && worst.rank === 0) state_ = '⛔ Are documente expirate';
    else if (worst && worst.rank === 1) state_ = '⚠️ Expiră ceva în 7 zile';
    else if (missingReq) state_ = `ℹ️ ${missingReq} ${missingReq === 1 ? 'document lipsă' : 'documente lipsă'}`;
    const sub = a.tip === 'masina' ? [a.an, a.vin ? 'VIN …' + a.vin.slice(-6) : ''].filter(Boolean).join(' · ') : a.adresa || '';
    return `<section class="wcard">
      <div class="whead" data-edit-asset="${a.id}" title="Editează">
        <span class="wname">${esc(a.nume)}</span><span class="wico">${t.ico}</span>
        <span class="wsub">${plateHtml(a.numar)} ${esc(sub)}</span>
        <span class="wstate">${state_}</span>
      </div>
      <div class="wrows">${rows.join('')}</div>
    </section>`;
  }
  function wrowHtml(i) {
    const st = statusOf(i);
    const d = daysLeft(i.expira);
    const pct = Math.max(4, Math.min(100, 100 - (d / 365) * 100));
    return `<button type="button" class="wrow ${st.cls}" data-open="${i.id}">
      <span class="wi">${catOf(i.categorie).ico}</span>
      <span class="wl"><b>${esc(titleOf(i))}</b><small>${roDate(i.expira)}${i.suma ? ' · ultima ' + lei(Number(i.suma)) : ''}</small></span>
      <span class="badge ${st.cls}">${st.text}</span>
    </button><div class="wbar ${st.cls}" aria-hidden="true"><i style="width:${pct}%"></i></div>`;
  }

  // 3) Cronologie – axă verticală grupată pe luni
  function renderTimeline(rows) {
    const byMonth = new Map();
    rows.forEach((i) => {
      const k = i.expira.slice(0, 7);
      if (!byMonth.has(k)) byMonth.set(k, []);
      byMonth.get(k).push(i);
    });
    const today = todayIso();
    return `<div class="timeline">${[...byMonth.entries()].map(([k, its]) => {
      return `<div class="tmonth">${monthFmt.format(parseIso(k + '-01'))}<small>${its.length} ${its.length === 1 ? 'scadență' : 'scadențe'}</small></div>
        ${its.map((i) => {
          const st = statusOf(i);
          const d = parseIso(i.expira);
          return `<div class="titem ${st.cls} ${i.expira === today ? 'today' : ''}" data-id="${i.id}">
            <div class="tdate"><b>${d.getDate()}</b><small>${wdFmt.format(d).replace('.', '')}</small></div>
            <div class="tline"></div>
            <div class="tbody">
              <div><div class="t">${catOf(i.categorie).ico} ${esc(titleOf(i))}</div><div class="sub">${subLine(i)} <span class="badge ${st.cls}">${st.text}</span>${syncFlag(i)}</div></div>
              <div class="side">${i.suma ? `<span class="sum" title="Ultima sumă plătită"><small>ultima</small> ${lei(Number(i.suma))}</span>` : ''}${paidBtn(i)}</div>
            </div></div>`;
        }).join('')}`;
    }).join('')}</div>`;
  }

  // 4) Tabel – dens, sortat după scadență
  function renderTable(rows) {
    return `<div class="table-wrap"><table class="grid-t">
      <thead><tr><th></th><th>Evidență</th><th class="hide-sm">Bun</th><th>Scadență</th><th class="hide-sm">Stare</th><th class="num">Ultima plată</th><th></th></tr></thead>
      <tbody>${rows.map((i) => {
        const st = statusOf(i);
        const a = assetOf(i);
        return `<tr class="${st.cls}" data-id="${i.id}">
          <td><span class="sdot" title="${esc(st.text)}"></span></td>
          <td><div class="tt">${catOf(i.categorie).ico} ${esc(titleOf(i))}</div>${i.titlu ? `<div class="date">${esc(i.categorie)}</div>` : ''}</td>
          <td class="hide-sm">${a ? esc(a.nume) + ' ' + plateHtml(a.numar) : '<span class="muted">—</span>'}</td>
          <td><span class="date">${roDate(i.expira)}</span></td>
          <td class="hide-sm"><span class="badge ${st.cls}">${st.text}</span></td>
          <td class="num">${i.suma ? lei(Number(i.suma)) : ''}</td>
          <td>${i.status === 'platit' ? '' : `<button type="button" class="btn small ok" data-act="paid" data-id="${i.id}" title="Plătit">✓</button>`}</td>
        </tr>`;
      }).join('')}</tbody></table></div>`;
  }

  // ---------- Toast ----------
  let toastTimer = null;
  function toast(msg, action) {
    const t = $('#toast');
    t.innerHTML = `<span>${esc(msg)}</span>${action ? `<button type="button">${esc(action.label)}</button>` : ''}`;
    t.hidden = false;
    if (action) t.querySelector('button').onclick = () => { t.hidden = true; action.fn(); };
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, action ? 7000 : 3500);
  }

  // ---------- Câmp de dată zz/ll/aaaa ----------
  // Câmpul nativ <input type=date> afișează formatul după limba browserului (ex. lună/zi/an).
  // Îl ascundem și punem în față un câmp text cu format românesc + buton care deschide calendarul nativ.
  // Valoarea rămâne pe câmpul nativ (ISO aaaa-ll-zz), deci restul codului nu se schimbă.
  function enhanceDate(native) {
    const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    const wrap = document.createElement('span');
    wrap.className = 'dfield';
    const text = document.createElement('input');
    text.type = 'text';
    text.inputMode = 'numeric';
    text.placeholder = 'zz/ll/aaaa';
    text.autocomplete = 'off';
    text.maxLength = 10;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'dbtn';
    btn.setAttribute('aria-label', 'Alege din calendar');
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M7 2v2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2V2h-2v2H9V2H7zm-2 8h14v10H5V10z"/></svg>';
    native.parentNode.insertBefore(wrap, native);
    wrap.append(text, btn, native);
    native.classList.add('dnative');
    native.tabIndex = -1;

    const toText = (iso) => (iso ? iso.split('-').reverse().join('/') : '');
    const show = () => { text.value = toText(proto.get.call(native)); text.classList.remove('bad'); };
    Object.defineProperty(native, 'value', {
      get() { return proto.get.call(native); },
      set(v) { proto.set.call(native, v); show(); },
    });
    native.focus = () => text.focus();

    text.addEventListener('input', () => {
      // inserează automat „/” după zi și lună
      let v = text.value.replace(/[.\-\s]/g, '/').replace(/[^\d/]/g, '');
      if (/^\d{3}$/.test(v)) v = v.slice(0, 2) + '/' + v.slice(2);
      if (/^\d{1,2}\/\d{3}$/.test(v)) v = v.replace(/^(\d{1,2}\/\d{2})(\d)$/, '$1/$2');
      if (/^\d{4,8}$/.test(v)) v = v.replace(/^(\d{2})(\d{2})(\d{0,4})$/, (m, a, b, c) => [a, b, c].filter(Boolean).join('/'));
      text.value = v;
      const m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if (m) {
        const iso = `${m[3]}-${pad(m[2])}-${pad(m[1])}`;
        const d = parseIso(iso);
        const ok = d.getDate() === Number(m[1]) && d.getMonth() + 1 === Number(m[2]);
        text.classList.toggle('bad', !ok);
        if (ok && iso !== proto.get.call(native)) { proto.set.call(native, iso); native.dispatchEvent(new Event('change', { bubbles: true })); }
      } else if (!v && proto.get.call(native)) {
        proto.set.call(native, '');
        native.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    text.addEventListener('blur', () => { if (text.value && !/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(text.value)) text.classList.add('bad'); else if (!text.classList.contains('bad')) show(); });
    native.addEventListener('change', show);
    native.form?.addEventListener('reset', () => setTimeout(show));
    btn.addEventListener('click', () => {
      try { native.showPicker(); } catch (e) { native.click(); }
    });
    show();
  }
  document.querySelectorAll('input[type=date]').forEach(enhanceDate);

  // ---------- Formular evidență ----------
  const dlg = $('#dlgItem');
  const form = $('#formItem');
  form.categorie.innerHTML = CATEGORII.map((c) => `<option value="${esc(c.id)}">${c.ico} ${esc(c.id)}</option>`).join('');
  form.recurenta.innerHTML = PERIOADE.map(([c, l]) => `<option value="${c}">${esc(l)}</option>`).join('');

  function fillAssetSelect(selected) {
    const groups = Object.entries(TIPURI).map(([tip, t]) => {
      const as = state.assets.filter((a) => a.tip === tip);
      return as.length ? `<optgroup label="${t.label}">${as.map((a) => `<option value="${a.id}">${esc(assetLabel(a))}</option>`).join('')}</optgroup>` : '';
    }).join('');
    form.assetId.innerHTML = `<option value="">— fără —</option>${groups}`;
    form.assetId.value = selected || '';
  }

  function openForm(it, preset = {}) {
    form.reset();
    $('#dlgTitle').textContent = it ? 'Editează evidența' : 'Evidență nouă';
    $('#btnDelete').hidden = !it;
    $('#paidBlock').hidden = !!it; // la editare, plățile se confirmă cu „✓ Plătit”
    $('#paidDateWrap').hidden = true;
    $('#paidHint').textContent = '';
    manualExp = false;
    const d = it || Object.assign({ categorie: 'RCA', recurenta: 12 }, preset);
    if (!it && preset.categorie) d.recurenta = catOf(preset.categorie).rec;
    fillAssetSelect(d.assetId);
    form.id.value = d.id || '';
    form.categorie.value = d.categorie;
    form.titlu.value = d.titlu || '';
    form.expira.value = d.expira || '';
    form.suma.value = d.suma ?? '';
    form.recurenta.value = PER_LABEL[String(d.recurenta ?? 0)] ? String(d.recurenta ?? 0) : '0';
    form.note.value = d.note || '';
    $('#amendaHelp').hidden = form.categorie.value !== 'Amendă';
    dlg.showModal();
    if (!it) setTimeout(() => (preset.categorie ? form.expira : form.categorie).focus(), 50);
  }

  form.categorie.addEventListener('change', () => {
    const c = catOf(form.categorie.value);
    if (!form.id.value) form.recurenta.value = String(c.rec);
    $('#amendaHelp').hidden = c.id !== 'Amendă';
    updatePaidBlock();
  });
  $('#btnCalc15').addEventListener('click', () => {
    const v = $('#dataComunicare').value;
    if (v) form.expira.value = addDays(v, 15);
  });

  // La adăugare: dacă e deja plătită și are perioadă, expirarea = data plății + perioada (dacă n-ai scris-o tu de mână).
  let manualExp = false;
  form.expira.addEventListener('change', () => { manualExp = true; updatePaidBlock(); });
  function updatePaidBlock() {
    if (form.id.value) return;
    const v = form.querySelector('input[name=platit]:checked')?.value;
    $('#paidDateWrap').hidden = v !== 'alta';
    const rec = form.recurenta.value;
    const base = v === 'azi' ? todayIso() : v === 'alta' ? $('#dataPlata').value : '';
    let hint = '';
    if (v === 'nu') hint = 'La „Scadență / expiră la” pune termenul până la care trebuie plătită.';
    else if (v && rec === '0') hint = 'Plata intră în totalul „Plătit”. Alege la „Valabilitate” pe ce perioadă ai plătit, ca să calculez expirarea.';
    else if (v && !base) hint = 'Alege data plății.';
    else if (v) {
      const calc = addPeriod(base, rec);
      if (!manualExp) form.expira.value = calc;
      hint = form.expira.value === calc
        ? `Expiră automat la ${roDate(calc)} (data plății + ${PER_LABEL[rec]}). Poți corecta data mai sus.`
        : `Ai pus expirarea de mână (${roDate(form.expira.value)}). Calculat ar fi ${roDate(calc)}.`;
    }
    $('#paidHint').textContent = hint;
  }
  $('#paidSeg').addEventListener('change', updatePaidBlock);
  $('#dataPlata').addEventListener('change', updatePaidBlock);
  form.recurenta.addEventListener('change', updatePaidBlock);

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!form.expira.value) { form.expira.focus(); return toast('Alege data scadenței.'); }
    const id = form.id.value;
    const prev = id ? state.items.find((i) => i.id === id) : null;
    const platit = prev ? null : form.querySelector('input[name=platit]:checked')?.value;
    if (!prev && !platit) { $('#paidSeg').scrollIntoView({ block: 'center' }); return toast('Alege dacă ai plătit-o deja.'); }
    if (platit === 'alta' && !$('#dataPlata').value) { $('#dataPlata').focus(); return toast('Alege data plății.'); }
    const it = Object.assign(prev || { id: uid(), status: 'activ', istoric: [], eventId: null }, {
      categorie: form.categorie.value,
      titlu: form.titlu.value.trim(),
      assetId: form.assetId.value || null,
      expira: form.expira.value,
      suma: form.suma.value === '' ? null : Number(form.suma.value),
      recurenta: form.recurenta.value,
      note: form.note.value.trim(),
      dirty: true,
    });
    if (!prev) {
      if (platit === 'azi' || platit === 'alta') {
        const data = platit === 'azi' ? todayIso() : $('#dataPlata').value;
        it.istoric.push({ data, scadenta: null, suma: it.suma, perioada: it.recurenta });
        it.ultimaPlata = data;
      }
      state.items.push(it);
    }
    dlg.close();
    commit();
    toast(prev ? 'Salvat.' : 'Adăugat.');
  });

  $('#btnDelete').addEventListener('click', () => {
    const it = state.items.find((i) => i.id === form.id.value);
    if (!it || !confirm(`Ștergi „${titleOf(it)}”?`)) return;
    removeItem(it);
    dlg.close();
    commit();
    toast('Șters.', { label: 'Anulează', fn: () => { state.items.push(Object.assign(it, { dirty: true })); state.deleted = state.deleted.filter((x) => x !== it.id); state.pendingDeletes = state.pendingDeletes.filter((e) => e !== it.eventId); commit(); } });
  });

  function removeItem(it) {
    state.items = state.items.filter((i) => i.id !== it.id);
    state.deleted.push(it.id);
    if (it.eventId) state.pendingDeletes.push(it.eventId);
  }

  // ---------- Plată: pe ce perioadă? ----------
  const dlgPay = $('#dlgPay');
  const formPay = $('#formPay');
  let payItem = null;
  function openPay(it) {
    payItem = it;
    const cur = isRecurring(it) ? String(it.recurenta) : perFor(it.categorie).includes(String(catOf(it.categorie).rec)) ? String(catOf(it.categorie).rec) : '0';
    const opts = [...new Set([...perFor(it.categorie), ...(isRecurring(it) ? [String(it.recurenta)] : [])])];
    $('#payTitle').textContent = `Plătit: ${titleOf(it)}`;
    $('#payPeriods').innerHTML = [...opts.map((c) => [c, PER_LABEL[c]]), ['0', 'O singură dată']]
      .map(([c, l]) => `<label><input type="radio" name="per" value="${c}" ${c === cur ? 'checked' : ''}><span>${esc(l)}</span></label>`).join('');
    if (!formPay.querySelector('input[name=per]:checked')) formPay.querySelector('input[name=per][value="0"]').checked = true;
    formPay.start.value = daysLeft(it.expira) >= 0 ? it.expira : todayIso();
    formPay.suma.value = it.suma ?? '';
    updatePay();
    dlgPay.showModal();
  }
  function updatePay() {
    const per = formPay.querySelector('input[name=per]:checked').value;
    const once = per === '0';
    formPay.querySelectorAll('[data-rec]').forEach((el) => { el.hidden = once; });
    if (!once && formPay.start.value) formPay.next.value = addPeriod(formPay.start.value, per);
    $('#payHint').textContent = once
      ? 'Se marchează ca plătită și dispare din calendar.'
      : `Următoarea scadență: ${formPay.next.value ? roDate(formPay.next.value) : '—'}. Evenimentul din calendar se mută automat.`;
  }
  $('#payPeriods').addEventListener('change', updatePay);
  formPay.start.addEventListener('change', updatePay);
  formPay.next.addEventListener('change', () => {
    $('#payHint').textContent = `Următoarea scadență: ${formPay.next.value ? roDate(formPay.next.value) : '—'}.`;
  });
  formPay.addEventListener('submit', (e) => {
    e.preventDefault();
    const it = payItem;
    if (!it) return;
    const per = formPay.querySelector('input[name=per]:checked').value;
    if (per !== '0' && !formPay.next.value) { formPay.next.focus(); return toast('Alege data următoarei scadențe.'); }
    const snapshot = JSON.parse(JSON.stringify(it));
    const paid = formPay.suma.value === '' ? null : Number(formPay.suma.value);
    it.istoric = it.istoric || [];
    it.istoric.push({ data: todayIso(), scadenta: it.expira, suma: paid, perioada: per });
    it.ultimaPlata = todayIso();
    if (paid !== null) it.suma = paid;
    if (per === '0') {
      it.status = 'platit';
      toast('Marcat ca plătit.', { label: 'Anulează', fn: () => restore(snapshot) });
    } else {
      it.recurenta = per;
      it.expira = formPay.next.value;
      it.status = 'activ';
      toast(`Valabil până la ${roDate(it.expira)}`, { label: 'Anulează', fn: () => restore(snapshot) });
    }
    it.dirty = true;
    dlgPay.close();
    commit();
  });

  function restore(snap) {
    const i = state.items.findIndex((x) => x.id === snap.id);
    if (i >= 0) state.items[i] = Object.assign(snap, { dirty: true, eventId: state.items[i].eventId });
    commit();
  }

  // ---------- Formular bun ----------
  const dlgA = $('#dlgAsset');
  const formA = $('#formAsset');
  function syncAssetFields() {
    const tip = formA.querySelector('input[name=tip]:checked').value;
    formA.querySelectorAll('[data-for]').forEach((el) => { el.hidden = el.dataset.for !== tip; });
    formA.nume.placeholder = tip === 'masina' ? 'ex. Dacia Duster' : tip === 'locuinta' ? 'ex. Casa Pecica' : 'ex. Remorcă';
    if (!formA.id.value) $('#dlgAssetTitle').textContent = { masina: 'Mașină nouă', locuinta: 'Locuință nouă', alt: 'Bun nou' }[tip];
  }
  formA.querySelectorAll('input[name=tip]').forEach((r) => r.addEventListener('change', syncAssetFields));

  function openAssetForm(a, tip = 'masina') {
    formA.reset();
    formA.id.value = a?.id || '';
    formA.querySelector(`input[name=tip][value=${a?.tip || tip}]`).checked = true;
    formA.nume.value = a?.nume || '';
    formA.numar.value = a?.numar || '';
    formA.an.value = a?.an || '';
    formA.vin.value = a?.vin || '';
    formA.adresa.value = a?.adresa || '';
    formA.note.value = a?.note || '';
    $('#btnDeleteAsset').hidden = !a;
    if (a) $('#dlgAssetTitle').textContent = 'Editează';
    syncAssetFields();
    dlgA.showModal();
    if (!a) setTimeout(() => formA.nume.focus(), 50);
  }

  formA.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!formA.nume.value.trim()) { formA.nume.focus(); return toast('Completează numele.'); }
    const id = formA.id.value;
    const prev = id ? state.assets.find((a) => a.id === id) : null;
    const tip = formA.querySelector('input[name=tip]:checked').value;
    const a = Object.assign(prev || { id: uid() }, {
      tip,
      nume: formA.nume.value.trim(),
      numar: tip === 'masina' ? formA.numar.value.trim().toUpperCase().replace(/[-\s]+/g, ' ') : '',
      an: tip === 'masina' && formA.an.value ? Number(formA.an.value) : null,
      vin: tip === 'masina' ? formA.vin.value.trim().toUpperCase() : '',
      adresa: tip === 'locuinta' ? formA.adresa.value.trim() : '',
      note: formA.note.value.trim(),
      upd: Date.now(),
    });
    if (!prev) state.assets.push(a);
    // titlurile evenimentelor din calendar conțin numele bunului
    state.items.filter((i) => i.assetId === a.id).forEach((i) => { i.dirty = true; });
    dlgA.close();
    if (!prev) setView('bunuri');
    commit();
    toast(prev ? 'Salvat.' : `${a.nume} a fost adăugat. Completează documentele din fișă.`);
  });

  $('#btnDeleteAsset').addEventListener('click', () => {
    const a = state.assets.find((x) => x.id === formA.id.value);
    if (!a) return;
    const its = state.items.filter((i) => i.assetId === a.id);
    if (!confirm(`Ștergi „${a.nume}”${its.length ? ` și cele ${its.length} evidențe legate` : ''}?`)) return;
    its.forEach(removeItem);
    state.assets = state.assets.filter((x) => x.id !== a.id);
    state.deleted.push(a.id);
    dlgA.close();
    commit();
    toast('Șters.');
  });

  // ---------- Evenimente UI ----------
  const fab = $('#fab');
  const fabMenu = $('#fabMenu');
  function toggleFab(open) {
    fabMenu.hidden = !open;
    fab.setAttribute('aria-expanded', String(open));
  }
  fab.addEventListener('click', (e) => { e.stopPropagation(); toggleFab(fabMenu.hidden); });
  document.addEventListener('click', (e) => { if (!fabMenu.hidden && !fabMenu.contains(e.target)) toggleFab(false); });
  document.addEventListener('click', (e) => {
    const n = e.target.closest('[data-new]');
    if (!n) return;
    toggleFab(false);
    if (n.dataset.new === 'item') openForm(null);
    else openAssetForm(null, n.dataset.new);
  });

  document.querySelectorAll('dialog [data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
  document.querySelectorAll('dialog').forEach((d) => d.addEventListener('click', (e) => { if (e.target === d) d.close(); }));

  $('#view').addEventListener('click', (e) => {
    const act = e.target.closest('button[data-act]');
    if (act) {
      e.stopPropagation();
      const it = state.items.find((i) => i.id === act.dataset.id);
      if (!it) return;
      if (act.dataset.act === 'paid') openPay(it);
      if (act.dataset.act === 'reopen') { it.status = 'activ'; it.dirty = true; commit(); }
      return;
    }
    const add = e.target.closest('[data-add]');
    if (add) return openForm(null, { categorie: add.dataset.add || 'Revizie', assetId: add.dataset.asset });
    const open = e.target.closest('[data-open]');
    if (open) return openForm(state.items.find((i) => i.id === open.dataset.open));
    const ea = e.target.closest('[data-edit-asset]');
    if (ea) return openAssetForm(state.assets.find((a) => a.id === ea.dataset.editAsset));
    const row = e.target.closest('[data-id]');
    if (row) openForm(state.items.find((i) => i.id === row.dataset.id));
  });
  $('#chips').addEventListener('click', (e) => {
    const c = e.target.closest('.chip');
    if (c) { ui.cat = c.dataset.cat; render(); }
  });
  document.querySelectorAll('.stat[data-quick]').forEach((b) => b.addEventListener('click', () => {
    ui.quick = ui.quick === b.dataset.quick ? null : b.dataset.quick;
    if (ui.quick && prefs.view === 'bunuri') setView('prioritar');
    render();
  }));
  function setView(v) { prefs.view = v; savePrefs(); }
  document.querySelectorAll('.views button').forEach((b) => b.addEventListener('click', () => { setView(b.dataset.view); render(); }));
  $('#search').addEventListener('input', (e) => { ui.q = e.target.value; render(); });
  $('#showPaid').addEventListener('change', (e) => { ui.showPaid = e.target.checked; render(); });

  // Setări și aspect
  $('#swatches').innerHTML = ACCENTE.map((a) => `<button type="button" class="swatch" data-accent="${a.id}"><i style="background: linear-gradient(135deg, ${a.l}, ${a.d})"></i>${a.nume}</button>`).join('');
  $('#swatches').addEventListener('click', (e) => {
    const s = e.target.closest('[data-accent]');
    if (!s) return;
    prefs.accent = s.dataset.accent;
    savePrefs();
    applyTheme();
    markSettings();
  });
  document.querySelectorAll('#modeSeg input').forEach((r) => r.addEventListener('change', () => {
    prefs.mode = r.value;
    savePrefs();
    applyTheme();
  }));
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', applyTheme);
  function markSettings() {
    document.querySelectorAll('.swatch').forEach((s) => s.setAttribute('aria-pressed', String(s.dataset.accent === prefs.accent)));
    const m = document.querySelector(`#modeSeg input[value=${prefs.mode}]`);
    if (m) m.checked = true;
  }

  $('#btnSettings').addEventListener('click', () => {
    markSettings();
    $('#remInfo').textContent = (CFG.POPUP_REMINDER_DAYS || []).map((d) => `${d} ${d === 1 ? 'zi' : 'zile'}`).join(', ') || '—';
    $('#hourInfo').textContent = `${pad(CFG.EVENT_HOUR ?? 9)}:00`;
    $('#accountInfo').textContent = DEMO ? 'Mod demo: fără cont Google.' : token ? `Conectat la Google. Datele se salvează în Drive, iar scadențele în calendarul „${CFG.CALENDAR_NAME}”.` : 'Neconectat la Google.';
    $('#btnResync').disabled = DEMO;
    $('#btnSignOut').disabled = DEMO || !token;
    $('#dlgSettings').showModal();
  });
  $('#btnResync').addEventListener('click', async () => {
    state.items.forEach((i) => { i.dirty = true; });
    saveLocal();
    $('#dlgSettings').close();
    try { await ensureToken(true); syncNow(); } catch (e) { toast(`Conectare eșuată: ${e.message}`); }
  });
  $('#btnExport').addEventListener('click', () => download(`evidente-backup-${todayIso()}.json`, JSON.stringify(state, null, 2), 'application/json'));
  $('#fileImport').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const data = migrate(Object.assign(emptyState(), JSON.parse(await f.text())));
      if (!Array.isArray(data.items)) throw new Error('format');
      if (!confirm(`Import ${data.assets.length} bunuri și ${data.items.length} evidențe? Datele existente vor fi înlocuite.`)) return;
      state.items.forEach((i) => i.eventId && state.pendingDeletes.push(i.eventId));
      state.items = data.items.map((i) => Object.assign(i, { eventId: null, dirty: true }));
      state.assets = data.assets;
      $('#dlgSettings').close();
      commit();
      toast('Import reușit.');
    } catch (err) { toast('Fișier invalid.'); }
    e.target.value = '';
  });
  $('#btnIcs').addEventListener('click', () => download('evidente.ics', buildIcs(), 'text/calendar'));
  $('#btnSignOut').addEventListener('click', () => {
    if (token && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(token.access_token, () => {});
    token = null;
    sessionStorage.removeItem(SS_TOKEN);
    localStorage.removeItem(LS_CONNECTED);
    $('#dlgSettings').close();
    setSync('off');
  });

  function download(name, content, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([content], { type }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function buildIcs() {
    const h = pad(CFG.EVENT_HOUR ?? 9);
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
    const escI = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, (m) => '\\' + m);
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Evidente plati//RO', 'CALSCALE:GREGORIAN'];
    state.items.filter((i) => i.status !== 'platit').forEach((i) => {
      const d = i.expira.replace(/-/g, '');
      lines.push('BEGIN:VEVENT', `UID:${i.id}@evidente-plati`, `DTSTAMP:${stamp}`,
        `DTSTART;TZID=${CFG.TIME_ZONE}:${d}T${h}0000`, 'DURATION:PT30M',
        `SUMMARY:${escI(eventTitle(i))}`, `DESCRIPTION:${escI(eventDesc(i))}`);
      (CFG.POPUP_REMINDER_DAYS || []).forEach((n) => lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${escI(eventTitle(i))}`, `TRIGGER:-P${n}D`, 'END:VALARM'));
      lines.push('END:VEVENT');
    });
    lines.push('END:VCALENDAR');
    return lines.join('\r\n');
  }

  // ---------- Google: autentificare ----------
  function setSync(mode, label) {
    $('#syncDot').className = 'dot' + ({ on: ' on', busy: ' busy', err: ' err' }[mode] || '');
    $('#syncLabel').textContent = label || ({ on: 'Sincronizat', busy: 'Se sincronizează…', err: 'Eroare sincronizare', off: 'Conectează Google' }[mode]);
  }

  function loadGis() {
    return new Promise((resolve, reject) => {
      if (window.google?.accounts?.oauth2) return resolve();
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('Nu s-a putut încărca Google Sign-In.'));
      document.head.appendChild(s);
    });
  }

  function restoreToken() {
    const t = loadJson(sessionStorage, SS_TOKEN);
    if (t && t.exp > Date.now() + 60000) token = t;
  }

  async function ensureToken(interactive) {
    if (token && token.exp > Date.now() + 60000) return token;
    if (!interactive) return null;
    await loadGis();
    return new Promise((resolve, reject) => {
      if (!tokenClient) {
        tokenClient = google.accounts.oauth2.initTokenClient({ client_id: CFG.GOOGLE_CLIENT_ID, scope: SCOPES, callback: () => {} });
      }
      tokenClient.callback = (resp) => {
        if (resp.error) return reject(new Error(resp.error));
        if (!google.accounts.oauth2.hasGrantedAllScopes(resp, ...SCOPES.split(' '))) {
          return reject(new Error('Trebuie bifate ambele permisiuni (Drive și Calendar).'));
        }
        token = { access_token: resp.access_token, exp: Date.now() + (Number(resp.expires_in) || 3600) * 1000 };
        sessionStorage.setItem(SS_TOKEN, JSON.stringify(token));
        localStorage.setItem(LS_CONNECTED, '1');
        resolve(token);
      };
      tokenClient.error_callback = (err) => reject(new Error(err?.type || 'auth'));
      tokenClient.requestAccessToken({ prompt: localStorage.getItem(LS_CONNECTED) ? '' : 'consent' });
    });
  }

  async function api(url, opts = {}) {
    if (!token) throw new Error('neautentificat');
    const res = await fetch(url, Object.assign({}, opts, {
      headers: Object.assign({ Authorization: `Bearer ${token.access_token}` }, opts.headers || {}),
    }));
    if (res.status === 401) { token = null; sessionStorage.removeItem(SS_TOKEN); throw new Error('Sesiune expirată'); }
    if (res.status === 204) return null;
    const body = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
    if (!res.ok) { const err = new Error(body?.error?.message || `HTTP ${res.status}`); err.status = res.status; throw err; }
    return body;
  }

  // ---------- Google Drive (appDataFolder) ----------
  let driveFileId = null;
  async function driveFind() {
    const q = encodeURIComponent(`name='${DRIVE_FILE}'`);
    const r = await api(`https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${q}&fields=files(id,modifiedTime)`);
    driveFileId = r.files?.[0]?.id || null;
    return driveFileId;
  }
  async function driveRead() {
    if (!driveFileId && !(await driveFind())) return null;
    return api(`https://www.googleapis.com/drive/v3/files/${driveFileId}?alt=media`);
  }
  async function driveWrite(data) {
    const json = JSON.stringify(data);
    if (!driveFileId) await driveFind();
    if (driveFileId) {
      return api(`https://www.googleapis.com/upload/drive/v3/files/${driveFileId}?uploadType=media`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: json,
      });
    }
    const boundary = 'b' + Math.random().toString(36).slice(2);
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      JSON.stringify({ name: DRIVE_FILE, parents: ['appDataFolder'] }) +
      `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${json}\r\n--${boundary}--`;
    const r = await api('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
      method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body,
    });
    driveFileId = r.id;
    return r;
  }

  // ---------- Google Calendar ----------
  const CAL = 'https://www.googleapis.com/calendar/v3';
  function eventTitle(i) {
    const a = assetOf(i);
    const what = i.titlu ? `${i.categorie}: ${i.titlu}` : i.categorie;
    return `${catOf(i.categorie).ico} ${what}${a ? ' – ' + assetLabel(a) : ''}`;
  }
  function eventDesc(i) {
    return [
      i.suma ? `Ultima plată: ${lei(Number(i.suma))}` : '',
      REC_LABEL[i.recurenta] ? `Se repetă ${REC_LABEL[i.recurenta]}` : '',
      i.note || '',
      `Deschide aplicația: ${location.origin}${location.pathname}`,
    ].filter(Boolean).join('\n');
  }

  async function ensureCalendar() {
    if (state.settings.calendarId) return state.settings.calendarId;
    const cal = await api(`${CAL}/calendars`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ summary: CFG.CALENDAR_NAME, timeZone: CFG.TIME_ZONE, description: 'Creat de aplicația Evidențe plăți' }),
    });
    state.settings.calendarId = cal.id;
    state.items.forEach((i) => { i.eventId = null; i.dirty = true; });
    saveLocal(); // salvează imediat ID-ul, ca să nu se creeze un al doilea calendar
    return cal.id;
  }

  function eventBody(i) {
    const h = pad(CFG.EVENT_HOUR ?? 9);
    const overrides = [
      ...(CFG.POPUP_REMINDER_DAYS || []).map((d) => ({ method: 'popup', minutes: Math.min(d * 1440, 40320) })),
      ...(CFG.EMAIL_REMINDER_DAYS || []).map((d) => ({ method: 'email', minutes: Math.min(d * 1440, 40320) })),
    ].slice(0, 5);
    const d = daysLeft(i.expira);
    return {
      summary: eventTitle(i),
      description: eventDesc(i),
      start: { dateTime: `${i.expira}T${h}:00:00`, timeZone: CFG.TIME_ZONE },
      end: { dateTime: `${i.expira}T${h}:30:00`, timeZone: CFG.TIME_ZONE },
      reminders: { useDefault: false, overrides },
      colorId: d < 0 ? '11' : d <= 7 ? '6' : undefined,
      extendedProperties: { private: { evidenteId: i.id } },
    };
  }

  async function syncItemEvent(calId, i) {
    const base = `${CAL}/calendars/${encodeURIComponent(calId)}/events`;
    if (i.status === 'platit') {
      if (i.eventId) { try { await api(`${base}/${i.eventId}`, { method: 'DELETE' }); } catch (e) { if (![404, 410].includes(e.status)) throw e; } }
      i.eventId = null;
      return;
    }
    const body = JSON.stringify(eventBody(i));
    const headers = { 'Content-Type': 'application/json' };
    if (i.eventId) {
      try { await api(`${base}/${i.eventId}`, { method: 'PUT', headers, body }); return; } catch (e) { if (![404, 410].includes(e.status)) throw e; }
    }
    let ev;
    try { ev = await api(base, { method: 'POST', headers, body }); } catch (e) {
      if (e.status === 404) e.calendarGone = true; // calendarul a fost șters manual din Google Calendar
      throw e;
    }
    i.eventId = ev.id;
  }

  // ---------- Sincronizare ----------
  function scheduleSync() {
    if (DEMO || !token) return;
    clearTimeout(pendingSave);
    pendingSave = setTimeout(syncNow, 800);
  }

  // Îmbină datele locale cu cele din Drive (ex. telefon + PC): pe fiecare element câștigă modificarea mai nouă.
  function mergeStates(local, remote) {
    const deleted = [...new Set([...(local.deleted || []), ...(remote.deleted || [])])];
    const gone = new Set(deleted);
    const mergeArr = (a, b) => {
      const m = new Map();
      [...b, ...a].forEach((x) => { const cur = m.get(x.id); if (!cur || (x.upd || 0) >= (cur.upd || 0)) m.set(x.id, x); });
      return [...m.values()].filter((x) => !gone.has(x.id));
    };
    const out = Object.assign(emptyState(), {
      updatedAt: Math.max(local.updatedAt || 0, remote.updatedAt || 0),
      assets: mergeArr(local.assets, remote.assets),
      items: mergeArr(local.items, remote.items),
      deleted,
      pendingDeletes: [...new Set([...(local.pendingDeletes || []), ...(remote.pendingDeletes || [])])],
      settings: Object.assign({}, local.settings),
    });
    const rc = remote.settings?.calendarId;
    if (rc && rc !== out.settings.calendarId) {
      // un alt dispozitiv a creat deja calendarul: îl folosim pe acela
      if (out.settings.calendarId) out.items.forEach((i) => { i.eventId = null; i.dirty = true; });
      out.settings.calendarId = rc;
    }
    return out;
  }

  async function syncNow({ pull = false } = {}) {
    if (DEMO || syncing) return;
    if (!token) { setSync('off'); return; }
    syncing = true;
    setSync('busy');
    try {
      const remote = await driveRead();
      if (remote && Array.isArray(remote.items)) {
        state = mergeStates(state, migrate(Object.assign(emptyState(), remote)));
        saveLocal();
        render();
      }
      let calId = await ensureCalendar();
      for (const ev of [...state.pendingDeletes]) {
        try { await api(`${CAL}/calendars/${encodeURIComponent(calId)}/events/${ev}`, { method: 'DELETE' }); } catch (e) { if (![404, 410].includes(e.status)) throw e; }
        state.pendingDeletes = state.pendingDeletes.filter((x) => x !== ev);
      }
      for (const i of state.items.filter((x) => x.dirty)) {
        try {
          await syncItemEvent(calId, i);
        } catch (e) {
          if (!e.calendarGone) throw e;
          state.settings.calendarId = null;
          calId = await ensureCalendar();
          await syncItemEvent(calId, i);
        }
        i.dirty = false;
      }
      saveLocal();
      await driveWrite(state);
      render();
      setSync('on');
    } catch (e) {
      console.error(e);
      saveLocal();
      render();
      setSync(token ? 'err' : 'off', token ? 'Eroare – reîncearcă' : 'Reconectează Google');
      toast(`Sincronizare eșuată: ${e.message}`);
    } finally {
      syncing = false;
    }
  }

  $('#btnSync').addEventListener('click', async () => {
    if (DEMO) { toast('Mod demo: completează GOOGLE_CLIENT_ID în config.js.'); return; }
    try {
      await ensureToken(true);
      await syncNow();
    } catch (e) {
      setSync('err', 'Conectează Google');
      toast(`Conectare eșuată: ${e.message}`);
    }
  });

  // ---------- Pornire ----------
  state = migrate(loadLocal());
  applyTheme();
  if (DEMO) {
    $('#demoBanner').hidden = false;
    setSync('off', 'Mod demo');
  } else {
    restoreToken();
    if (token) syncNow();
    else setSync('off', localStorage.getItem(LS_CONNECTED) ? 'Sincronizează' : 'Conectează Google');
  }
  if (!state.assets.length && !state.items.length) prefs.view = 'bunuri';
  saveLocal();
  render();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
