/* Evidențe plăți – PWA
 * Date: Google Drive (appDataFolder, fișier evidente.json) + copie locală în browser.
 * Notificări: evenimente într-un calendar Google dedicat, cu reminder-e pop-up / email.
 */
(() => {
  'use strict';

  const CFG = window.APP_CONFIG || {};
  const DEMO = !CFG.GOOGLE_CLIENT_ID;
  const LS_DATA = 'evidente.data.v1';
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
  const REC_LABEL = { 0: '', 1: 'lunar', 3: 'trimestrial', 6: 'la 6 luni', 12: 'anual', 24: 'la 2 ani' };

  // ---------- Stare ----------
  let state = loadLocal();
  const ui = { cat: 'Toate', quick: null, q: '', showPaid: false };
  let token = null;
  let tokenClient = null;
  let syncing = false;
  let pendingSave = null;

  function emptyState() {
    return { version: 1, updatedAt: 0, items: [], settings: { calendarId: null }, pendingDeletes: [] };
  }
  function loadLocal() {
    try {
      const s = JSON.parse(localStorage.getItem(LS_DATA));
      if (s && Array.isArray(s.items)) return Object.assign(emptyState(), s);
    } catch (e) { /* ignore */ }
    return emptyState();
  }
  function saveLocal() {
    try { localStorage.setItem(LS_DATA, JSON.stringify(state)); } catch (e) { /* ignore */ }
  }
  function commit() {
    state.updatedAt = Date.now();
    saveLocal();
    render();
    scheduleSync();
  }

  // ---------- Date ----------
  const pad = (n) => String(n).padStart(2, '0');
  const isoOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseIso = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const todayIso = () => isoOf(new Date());
  const roDate = (s) => { const [y, m, d] = s.split('-'); return `${d}.${m}.${y}`; };
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

  function statusOf(it) {
    if (it.status === 'platit') return { cls: 's-paid', text: 'Plătit' };
    const d = daysLeft(it.expira);
    if (d < 0) return { cls: 's-danger', text: `Expirat de ${-d} ${-d === 1 ? 'zi' : 'zile'}` };
    if (d === 0) return { cls: 's-danger', text: 'Azi' };
    if (d === 1) return { cls: 's-warn', text: 'Mâine' };
    if (d <= 7) return { cls: 's-warn', text: `În ${d} zile` };
    if (d <= 30) return { cls: 's-info', text: `În ${d} zile` };
    return { cls: 's-ok', text: `În ${d} zile` };
  }

  // ---------- Randare ----------
  const $ = (sel) => document.querySelector(sel);

  function render() {
    const active = state.items.filter((i) => i.status !== 'platit');
    const exp = active.filter((i) => daysLeft(i.expira) < 0).length;
    const in7 = active.filter((i) => { const d = daysLeft(i.expira); return d >= 0 && d <= 7; }).length;
    const in30 = active.filter((i) => { const d = daysLeft(i.expira); return d >= 0 && d <= 30; });
    const sum30 = active.filter((i) => daysLeft(i.expira) <= 30).reduce((a, i) => a + (Number(i.suma) || 0), 0);
    $('#stExpired').textContent = exp;
    $('#st7').textContent = in7;
    $('#st30').textContent = in30.length;
    $('#stSum').textContent = lei(sum30);
    document.querySelectorAll('.stat[data-quick]').forEach((b) => b.classList.toggle('active', b.dataset.quick === ui.quick));

    // chips
    const used = ['Toate', ...CATEGORII.map((c) => c.id).filter((c) => state.items.some((i) => i.categorie === c))];
    $('#chips').innerHTML = used.map((c) => `<button type="button" class="chip ${c === ui.cat ? 'on' : ''}" data-cat="${esc(c)}">${c === 'Toate' ? 'Toate' : catOf(c).ico + ' ' + esc(c)}</button>`).join('');

    // datalist obiecte
    const obs = [...new Set(state.items.map((i) => i.obiect).filter(Boolean))].sort();
    $('#obiecte').innerHTML = obs.map((o) => `<option value="${esc(o)}">`).join('');

    // listă
    const q = ui.q.trim().toLowerCase();
    let rows = state.items.filter((i) => {
      if (!ui.showPaid && i.status === 'platit') return false;
      if (ui.cat !== 'Toate' && i.categorie !== ui.cat) return false;
      if (ui.quick) {
        if (i.status === 'platit') return false;
        const d = daysLeft(i.expira);
        if (ui.quick === 'expired' && d >= 0) return false;
        if (ui.quick === '7' && (d < 0 || d > 7)) return false;
        if (ui.quick === '30' && (d < 0 || d > 30)) return false;
      }
      if (q && !`${i.titlu} ${i.obiect} ${i.categorie} ${i.note}`.toLowerCase().includes(q)) return false;
      return true;
    });
    rows.sort((a, b) => (a.status === 'platit') - (b.status === 'platit') || a.expira.localeCompare(b.expira));

    $('#empty').hidden = rows.length > 0;
    $('#list').innerHTML = rows.map(cardHtml).join('');
  }

  function cardHtml(it) {
    const st = statusOf(it);
    const c = catOf(it.categorie);
    const rec = REC_LABEL[it.recurenta] ? ` · ${REC_LABEL[it.recurenta]}` : '';
    const sub = [it.categorie, it.obiect].filter(Boolean).map(esc).join(' · ') + rec;
    const sync = !DEMO && it.dirty ? '<span class="sync-flag">nesincronizat</span>' : '';
    const btn = it.status === 'platit'
      ? `<button type="button" class="btn small ghost" data-act="reopen" data-id="${it.id}">Redeschide</button>`
      : `<button type="button" class="btn small ok" data-act="paid" data-id="${it.id}">✓ Plătit</button>`;
    return `<article class="card ${st.cls}" data-id="${it.id}">
      <div class="ico" aria-hidden="true">${c.ico}</div>
      <div class="main">
        <div class="t">${esc(it.titlu)}</div>
        <div class="sub">${sub}</div>
        <div class="meta"><span class="badge ${st.cls}">${st.text}</span><span class="date">${roDate(it.expira)}</span>${sync}</div>
      </div>
      <div class="side">
        ${it.suma ? `<span class="sum">${lei(Number(it.suma))}</span>` : ''}
        ${btn}
      </div>
    </article>`;
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

  // ---------- Formular ----------
  const dlg = $('#dlgItem');
  const form = $('#formItem');
  form.categorie.innerHTML = CATEGORII.map((c) => `<option value="${esc(c.id)}">${c.ico} ${esc(c.id)}</option>`).join('');

  function openForm(it) {
    form.reset();
    $('#dlgTitle').textContent = it ? 'Editează' : 'Adaugă evidență';
    $('#btnDelete').hidden = !it;
    const d = it || { categorie: 'RCA', recurenta: 12, expira: '' };
    form.id.value = d.id || '';
    form.categorie.value = d.categorie;
    form.titlu.value = d.titlu || '';
    form.obiect.value = d.obiect || '';
    form.expira.value = d.expira || '';
    form.suma.value = d.suma ?? '';
    form.recurenta.value = String(d.recurenta ?? 0);
    form.note.value = d.note || '';
    $('#amendaHelp').hidden = form.categorie.value !== 'Amendă';
    dlg.showModal();
    if (!it) setTimeout(() => form.titlu.focus(), 50);
  }

  form.categorie.addEventListener('change', () => {
    const c = catOf(form.categorie.value);
    if (!form.id.value) form.recurenta.value = String(c.rec);
    $('#amendaHelp').hidden = c.id !== 'Amendă';
  });
  $('#btnCalc15').addEventListener('click', () => {
    const v = $('#dataComunicare').value;
    if (v) form.expira.value = addDays(v, 15);
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!form.titlu.value.trim()) { form.titlu.focus(); return toast('Completează titlul.'); }
    if (!form.expira.value) { form.expira.focus(); return toast('Alege data scadenței.'); }
    const id = form.id.value;
    const prev = id ? state.items.find((i) => i.id === id) : null;
    const it = Object.assign(prev || { id: uid(), status: 'activ', istoric: [], eventId: null }, {
      categorie: form.categorie.value,
      titlu: form.titlu.value.trim(),
      obiect: form.obiect.value.trim(),
      expira: form.expira.value,
      suma: form.suma.value === '' ? null : Number(form.suma.value),
      recurenta: Number(form.recurenta.value),
      note: form.note.value.trim(),
      dirty: true,
    });
    if (!prev) state.items.push(it);
    dlg.close();
    commit();
    toast(prev ? 'Salvat.' : 'Adăugat.');
  });

  $('#btnDelete').addEventListener('click', () => {
    const id = form.id.value;
    const it = state.items.find((i) => i.id === id);
    if (!it || !confirm(`Ștergi „${it.titlu}”?`)) return;
    removeItem(it);
    dlg.close();
    commit();
    toast('Șters.', { label: 'Anulează', fn: () => { state.items.push(Object.assign(it, { dirty: true })); state.pendingDeletes = state.pendingDeletes.filter((e) => e !== it.eventId); commit(); } });
  });

  function removeItem(it) {
    state.items = state.items.filter((i) => i.id !== it.id);
    if (it.eventId) state.pendingDeletes.push(it.eventId);
  }

  function markPaid(it) {
    const snapshot = JSON.parse(JSON.stringify(it));
    it.istoric = it.istoric || [];
    it.istoric.push({ data: todayIso(), scadenta: it.expira, suma: it.suma });
    it.ultimaPlata = todayIso();
    if (it.recurenta > 0) {
      it.expira = addMonths(it.expira, it.recurenta);
      toast(`Următoarea scadență: ${roDate(it.expira)}`, { label: 'Anulează', fn: () => restore(snapshot) });
    } else {
      it.status = 'platit';
      toast('Marcat ca plătit.', { label: 'Anulează', fn: () => restore(snapshot) });
    }
    it.dirty = true;
    commit();
  }
  function restore(snap) {
    const i = state.items.findIndex((x) => x.id === snap.id);
    if (i >= 0) state.items[i] = Object.assign(snap, { dirty: true, eventId: state.items[i].eventId });
    commit();
  }

  // ---------- Evenimente UI ----------
  $('#fab').addEventListener('click', () => openForm(null));
  document.querySelectorAll('dialog [data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
  document.querySelectorAll('dialog').forEach((d) => d.addEventListener('click', (e) => { if (e.target === d) d.close(); }));

  $('#list').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]');
    if (b) {
      e.stopPropagation();
      const it = state.items.find((i) => i.id === b.dataset.id);
      if (!it) return;
      if (b.dataset.act === 'paid') markPaid(it);
      if (b.dataset.act === 'reopen') { it.status = 'activ'; it.dirty = true; commit(); }
      return;
    }
    const card = e.target.closest('.card');
    if (card) openForm(state.items.find((i) => i.id === card.dataset.id));
  });
  $('#chips').addEventListener('click', (e) => {
    const c = e.target.closest('.chip');
    if (c) { ui.cat = c.dataset.cat; render(); }
  });
  document.querySelectorAll('.stat[data-quick]').forEach((b) => b.addEventListener('click', () => {
    ui.quick = ui.quick === b.dataset.quick ? null : b.dataset.quick;
    render();
  }));
  $('#search').addEventListener('input', (e) => { ui.q = e.target.value; render(); });
  $('#showPaid').addEventListener('change', (e) => { ui.showPaid = e.target.checked; render(); });

  // Setări
  $('#btnSettings').addEventListener('click', () => {
    $('#remInfo').textContent = (CFG.POPUP_REMINDER_DAYS || []).map((d) => `${d} ${d === 1 ? 'zi' : 'zile'}`).join(', ') || '—';
    $('#hourInfo').textContent = `${pad(CFG.EVENT_HOUR ?? 9)}:00`;
    $('#accountInfo').textContent = DEMO ? 'Mod demo: fără cont Google.' : token ? 'Conectat la Google. Datele se salvează în Drive și calendarul „' + CFG.CALENDAR_NAME + '”.' : 'Neconectat la Google.';
    $('#btnResync').disabled = DEMO;
    $('#btnSignOut').disabled = DEMO || !token;
    $('#dlgSettings').showModal();
  });
  $('#btnResync').addEventListener('click', async () => {
    state.items.forEach((i) => { i.dirty = true; });
    saveLocal();
    $('#dlgSettings').close();
    await ensureToken(true);
    syncNow();
  });
  $('#btnExport').addEventListener('click', () => download(`evidente-backup-${todayIso()}.json`, JSON.stringify(state, null, 2), 'application/json'));
  $('#fileImport').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (!Array.isArray(data.items)) throw new Error('format');
      if (!confirm(`Import ${data.items.length} evidențe? Cele existente vor fi înlocuite.`)) return;
      state.items.forEach((i) => i.eventId && state.pendingDeletes.push(i.eventId));
      state.items = data.items.map((i) => Object.assign(i, { eventId: null, dirty: true }));
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
        `DTSTART;TZID=${CFG.TIME_ZONE}:${d}T${h}0000`, `DURATION:PT30M`,
        `SUMMARY:${escI(eventTitle(i))}`, `DESCRIPTION:${escI(eventDesc(i))}`);
      (CFG.POPUP_REMINDER_DAYS || []).forEach((n) => lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${escI(eventTitle(i))}`, `TRIGGER:-P${n}D`, 'END:VALARM'));
      lines.push('END:VEVENT');
    });
    lines.push('END:VCALENDAR');
    return lines.join('\r\n');
  }

  // ---------- Google: autentificare ----------
  function setSync(mode, label) {
    const dot = $('#syncDot');
    dot.className = 'dot' + ({ on: ' on', busy: ' busy', err: ' err' }[mode] || '');
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
    try {
      const t = JSON.parse(sessionStorage.getItem(SS_TOKEN));
      if (t && t.exp > Date.now() + 60000) token = t;
    } catch (e) { /* ignore */ }
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
  function eventTitle(i) { return `${catOf(i.categorie).ico} ${i.categorie}: ${i.titlu}${i.obiect ? ' – ' + i.obiect : ''}`; }
  function eventDesc(i) {
    return [
      i.suma ? `Sumă: ${lei(Number(i.suma))}` : '',
      REC_LABEL[i.recurenta] ? `Se repetă ${REC_LABEL[i.recurenta]}` : '',
      i.note || '',
      `Deschide aplicația: ${location.origin}${location.pathname}`,
    ].filter(Boolean).join('\n');
  }

  async function ensureCalendar() {
    const id = state.settings.calendarId;
    if (id) {
      try { await api(`${CAL}/calendars/${encodeURIComponent(id)}`); return id; } catch (e) { if (e.status !== 404 && e.status !== 403) throw e; }
      state.items.forEach((i) => { i.eventId = null; i.dirty = true; });
    }
    const cal = await api(`${CAL}/calendars`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ summary: CFG.CALENDAR_NAME, timeZone: CFG.TIME_ZONE, description: 'Creat de aplicația Evidențe plăți' }),
    });
    state.settings.calendarId = cal.id;
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
    const ev = await api(base, { method: 'POST', headers, body });
    i.eventId = ev.id;
  }

  // ---------- Sincronizare ----------
  function scheduleSync() {
    if (DEMO || !token) return;
    clearTimeout(pendingSave);
    pendingSave = setTimeout(syncNow, 800);
  }

  async function syncNow({ pull = false } = {}) {
    if (DEMO || syncing) return;
    if (!token) { setSync('off'); return; }
    syncing = true;
    setSync('busy');
    try {
      if (pull) {
        const remote = await driveRead();
        if (remote && Array.isArray(remote.items) && (remote.updatedAt || 0) > (state.updatedAt || 0)) {
          state = Object.assign(emptyState(), remote);
          saveLocal();
          render();
        }
      }
      const calId = await ensureCalendar();
      for (const ev of [...state.pendingDeletes]) {
        try { await api(`${CAL}/calendars/${encodeURIComponent(calId)}/events/${ev}`, { method: 'DELETE' }); } catch (e) { if (![404, 410].includes(e.status)) throw e; }
        state.pendingDeletes = state.pendingDeletes.filter((x) => x !== ev);
      }
      for (const i of state.items.filter((x) => x.dirty)) {
        await syncItemEvent(calId, i);
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
      await syncNow({ pull: true });
    } catch (e) {
      setSync('err', 'Conectează Google');
      toast(`Conectare eșuată: ${e.message}`);
    }
  });

  // ---------- Pornire ----------
  if (DEMO) {
    $('#demoBanner').hidden = false;
    setSync('off', 'Mod demo');
  } else {
    restoreToken();
    if (token) syncNow({ pull: true });
    else setSync('off', localStorage.getItem(LS_CONNECTED) ? 'Sincronizează' : 'Conectează Google');
  }
  render();
  // Recalculează zilele rămase când aplicația revine în prim-plan (de ex. a doua zi).
  document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
