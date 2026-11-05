// Test end-to-end cu Google Drive + Calendar simulate, două dispozitive (PC + telefon).
// Rulare: python3 -m http.server 8765 (în folderul aplicației), apoi: node tests/sim.js <folder-capturi>
const { chromium, devices } = require('playwright');
const OUT = process.argv[2];
const BASE = 'http://localhost:8765/';

// ---------- Google simulat ----------
const G = { files: {}, cals: {}, nextId: 1, fail: false, failAfter: null, calls: [] };
const nid = (p) => `${p}${G.nextId++}`;
function json(route, status, body) {
  return route.fulfill({ status, contentType: 'application/json', body: body === undefined ? '' : JSON.stringify(body) });
}
async function googleApi(route) {
  const req = route.request();
  const u = new URL(req.url());
  const m = req.method();
  G.calls.push(`${m} ${u.pathname}`);
  if (G.failAfter !== null) { if (G.failAfter <= 0) G.fail = true; else G.failAfter--; }
  if (G.fail) return json(route, 503, { error: { message: 'Service unavailable (simulat)' } });
  const path = u.pathname;
  // Drive
  if (path === '/drive/v3/files' && m === 'GET') {
    return json(route, 200, { files: Object.keys(G.files).map((id) => ({ id })) });
  }
  let mm;
  if ((mm = path.match(/^\/drive\/v3\/files\/([^/]+)$/)) && m === 'GET') {
    const f = G.files[mm[1]];
    return f ? route.fulfill({ status: 200, contentType: 'application/json', body: f }) : json(route, 404, { error: { message: 'nf' } });
  }
  if ((mm = path.match(/^\/upload\/drive\/v3\/files\/([^/]+)$/)) && m === 'PATCH') {
    G.files[mm[1]] = req.postData();
    return json(route, 200, { id: mm[1] });
  }
  if (path === '/upload/drive/v3/files' && m === 'POST') {
    const body = req.postData();
    const parts = body.split(/--b[a-z0-9]+/).filter((x) => x.includes('{'));
    const content = parts[1].slice(parts[1].indexOf('\r\n\r\n') + 4).trim();
    const id = nid('file');
    G.files[id] = content;
    return json(route, 200, { id });
  }
  // Calendar
  if (path === '/calendar/v3/calendars' && m === 'POST') {
    const id = nid('cal') + '@group.calendar.google.com';
    G.cals[id] = { summary: JSON.parse(req.postData()).summary, events: {} };
    return json(route, 200, { id });
  }
  if ((mm = path.match(/^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/))) {
    const cal = G.cals[decodeURIComponent(mm[1])];
    if (!cal) return json(route, 404, { error: { message: 'Calendar not found' } });
    const eid = mm[2];
    if (m === 'POST') { const id = nid('ev'); cal.events[id] = JSON.parse(req.postData()); return json(route, 200, { id }); }
    if (!cal.events[eid]) return json(route, 404, { error: { message: 'Event not found' } });
    if (m === 'PUT') { cal.events[eid] = JSON.parse(req.postData()); return json(route, 200, { id: eid }); }
    if (m === 'DELETE') { delete cal.events[eid]; return route.fulfill({ status: 204, body: '' }); }
  }
  return json(route, 400, { error: { message: 'neimplementat ' + m + ' ' + path } });
}
const FAKE_GIS = `window.google = { accounts: { oauth2: {
  initTokenClient(cfg) { return { callback: cfg.callback, requestAccessToken() { setTimeout(() => this.callback({ access_token: 'tok', expires_in: 3600 }), 20); } }; },
  hasGrantedAllScopes() { return true; }, revoke(t, cb) { cb && cb(); } } } };`;

// ---------- utilitare ----------
const results = [];
function check(name, ok, detail = '') { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); }
const iso = (o) => { const x = new Date(); x.setDate(x.getDate() + o); return x.toISOString().slice(0, 10); };
const dmy = (o) => iso(o).split('-').reverse().join('');
const allEvents = () => Object.values(G.cals).flatMap((c) => Object.values(c.events));
const driveState = () => { const f = Object.values(G.files)[0]; return f ? JSON.parse(f) : null; };

async function device(browser, name, opts) {
  const ctx = await browser.newContext(opts);
  await ctx.route('https://accounts.google.com/gsi/client', (r) => r.fulfill({ contentType: 'application/javascript', body: FAKE_GIS }));
  await ctx.route('https://www.googleapis.com/**', googleApi);
  const p = await ctx.newPage();
  p.errs = [];
  p.on('pageerror', (e) => p.errs.push(e.message));
  p.dev = name;
  await p.goto(BASE);
  return p;
}
const local = (p) => p.evaluate(() => JSON.parse(localStorage.getItem('evidente.data.v1')));
async function settle(p) {
  // așteaptă să se termine sincronizarea (punctul nu mai e „busy” și nimic nu e „dirty”)
  await p.waitForTimeout(1000);
  for (let k = 0; k < 40; k++) {
    const busy = await p.evaluate(() => document.querySelector('#syncDot').classList.contains('busy'));
    if (!busy) break;
    await p.waitForTimeout(150);
  }
  await p.waitForTimeout(200);
}
async function connect(p) { await p.click('#btnSync'); await settle(p); }
async function view(p, v) { await p.click(`.views [data-view=${v}]`); }
async function addItem(p, { cat, asset, titlu, exp, suma, rec, paid = 'nu', paidDate }) {
  await p.click('#fab'); await p.click('[data-new=item]');
  await p.selectOption('#formItem select[name=categorie]', cat);
  if (asset) await p.selectOption('#formItem select[name=assetId]', { label: asset });
  if (titlu) await p.fill('#formItem input[name=titlu]', titlu);
  if (rec) await p.selectOption('#formItem select[name=recurenta]', rec);
  if (suma) await p.fill('#formItem input[name=suma]', String(suma));
  await p.click(`#paidSeg input[value=${paid}] + span`);
  if (paidDate) await p.locator('#paidDateWrap input[type=text]').pressSequentially(paidDate);
  if (exp) { const t = p.locator('#formItem .dfield input[type=text]').first(); await t.fill(''); await t.pressSequentially(exp); }
  await p.click('#formItem button[type=submit]');
  await p.waitForTimeout(250);
  if (await p.evaluate(() => document.querySelector('#dlgItem').open)) {
    console.log('DEBUG still open', p.dev, cat, JSON.stringify(await p.evaluate(() => ({
      toast: document.querySelector('#toast').textContent,
      exp: document.querySelector('#formItem input[name=expira]').value,
      expText: document.querySelector('#formItem .dfield input[type=text]').value,
      paid: document.querySelector('#formItem input[name=platit]:checked')?.value,
      cat: document.querySelector('#formItem select[name=categorie]').value,
    }))));
  }
}
async function addCar(p, nume, numar) {
  await p.click('#fab'); await p.click('[data-new=masina]');
  await p.fill('#formAsset input[name=nume]', nume);
  await p.fill('#formAsset input[name=numar]', numar);
  await p.click('#formAsset button[type=submit]');
}
const findItem = (st, pred) => st.items.find(pred);

(async () => {
  const browser = await chromium.launch();
  const pc = await device(browser, 'PC', { viewport: { width: 1280, height: 900 }, locale: 'ro-RO' });
  const tel = await device(browser, 'Telefon', { ...devices['Pixel 7'], locale: 'en-US' });

  // ===== 1. Conectare și calendar unic =====
  check('1.0 Înainte de conectare: banda „Nu ești conectat” e vizibilă', await pc.isVisible('#syncBanner'));
  await connect(pc);
  check('1.05 După conectare: banda dispare', await pc.isHidden('#syncBanner'));
  check('1.1 PC: prima conectare creează un singur calendar', Object.keys(G.cals).length === 1, `${Object.keys(G.cals).length} calendare`);
  check('1.2 PC: fișierul de date apare în Drive', Object.keys(G.files).length === 1);
  await connect(tel);
  check('1.3 Telefon: conectarea folosește același calendar (nu creează altul)', Object.keys(G.cals).length === 1, `${Object.keys(G.cals).length} calendare`);
  await connect(pc); await connect(tel);
  check('1.4 Sincronizări repetate nu creează calendare noi', Object.keys(G.cals).length === 1);

  // ===== 2. Adăugare / editare / ștergere pe PC =====
  await addCar(pc, 'Dacia Duster', 'ar-12-abc');
  await addItem(pc, { cat: 'RCA', asset: 'Dacia Duster · AR 12 ABC', titlu: 'Allianz', rec: '12', suma: 1450, paid: 'azi' });
  await addItem(pc, { cat: 'ITP', asset: 'Dacia Duster · AR 12 ABC', exp: dmy(20), paid: 'nu' });
  await addItem(pc, { cat: 'Amendă', titlu: 'Viteză', exp: dmy(9), suma: 290, paid: 'nu' });
  await settle(pc);
  let st = await local(pc);
  check('2.1 Adăugare: 3 evidențe + 1 mașină salvate local', st.items.length === 3 && st.assets.length === 1);
  check('2.2 Adăugare: 3 evenimente în calendar', allEvents().length === 3, `${allEvents().length} evenimente`);
  check('2.3 Nimic rămas nesincronizat', st.items.every((i) => !i.dirty));
  const rca = findItem(st, (i) => i.categorie === 'RCA');
  check('2.4 RCA plătit azi pe 1 an → expiră peste 1 an', rca.expira.slice(0, 4) === String(new Date().getFullYear() + 1) && rca.expira.slice(5) === iso(0).slice(5), rca.expira);
  check('2.5 Titlul evenimentului conține mașina', allEvents().some((e) => e.summary.includes('Allianz') && e.summary.includes('AR 12 ABC')));
  const ev = allEvents().find((e) => e.summary.includes('Allianz'));
  check('2.6 Evenimentul are notificări 14/7/1 zile + email', JSON.stringify(ev.reminders.overrides.map((o) => o.minutes)) === JSON.stringify([20160, 10080, 1440, 10080]));

  // editare
  await view(pc, 'prioritar');
  await pc.locator('.card', { hasText: 'Viteză' }).click();
  await pc.fill('#formItem input[name=titlu]', 'Viteză DN7');
  await pc.click('#formItem button[type=submit]');
  await settle(pc);
  check('2.7 Editare: titlul se actualizează în calendar', allEvents().some((e) => e.summary.includes('Viteză DN7')) && !allEvents().some((e) => e.summary.endsWith('Viteză')));
  check('2.8 Editare: nu se dublează evenimentul', allEvents().length === 3, `${allEvents().length}`);

  // editare mașină → titlurile se schimbă
  await view(pc, 'bunuri');
  await pc.click('[data-edit-asset]');
  await pc.fill('#formAsset input[name=nume]', 'Duster 4x4');
  await pc.click('#formAsset button[type=submit]');
  await settle(pc);
  check('2.9 Redenumire mașină → evenimentele ei se redenumesc', allEvents().filter((e) => e.summary.includes('Duster 4x4')).length === 2);

  // ștergere + anulare
  await view(pc, 'prioritar');
  pc.once('dialog', (d) => d.accept());
  await pc.locator('.card', { hasText: 'Viteză DN7' }).click();
  await pc.click('#btnDelete');
  await settle(pc);
  check('2.10 Ștergere: evenimentul dispare din calendar', allEvents().length === 2, `${allEvents().length}`);
  check('2.11 Ștergere: dispare și din Drive', !driveState().items.some((i) => i.titlu === 'Viteză DN7'));

  // ===== 3. Plată =====
  await pc.locator('.card', { hasText: 'ITP' }).locator('[data-act=paid]').click();
  await pc.click('#payPeriods input[value="12"] + span');
  await pc.fill('#formPay input[name=suma]', '180');
  await pc.click('#formPay button[type=submit]');
  await settle(pc);
  st = await local(pc);
  const itp = findItem(st, (i) => i.categorie === 'ITP');
  check('3.1 ITP plătit 1 an → noua expirare = vechea scadență + 1 an', itp.expira === `${Number(iso(20).slice(0, 4)) + 1}${iso(20).slice(4)}`, itp.expira);
  const itpEv = allEvents().find((e) => e.summary.includes('ITP'));
  check('3.2 Evenimentul ITP s-a mutat la noua dată', itpEv && itpEv.start.dateTime.startsWith(itp.expira));
  check('3.3 Totalul „Plătit” include 1450 + 180', (await pc.textContent('#stSum')).replace(/\D/g, '') === '1630', await pc.textContent('#stSum'));
  // anulare plată
  await pc.locator('.card', { hasText: 'Allianz' }).locator('[data-act=paid]').click();
  await pc.click('#payPeriods input[value="0"] + span');
  await pc.click('#formPay button[type=submit]');
  await pc.click('#toast button'); // Anulează
  await settle(pc);
  st = await local(pc);
  check('3.4 „Anulează” după plată readuce starea', findItem(st, (i) => i.titlu === 'Allianz').status === 'activ' && allEvents().some((e) => e.summary.includes('Allianz')));

  // ===== 4. Formulare abandonate / invalide =====
  const before = JSON.stringify((await local(pc)).items);
  await pc.click('#fab'); await pc.click('[data-new=item]');
  await pc.fill('#formItem input[name=titlu]', 'Neterminat');
  await pc.click('#formItem [data-close]');
  check('4.1 Formular închis cu „Renunță” → nimic salvat', JSON.stringify((await local(pc)).items) === before);
  await pc.click('#fab'); await pc.click('[data-new=item]');
  await pc.fill('#formItem input[name=titlu]', 'Fără dată');
  await pc.click('#paidSeg input[value=nu] + span');
  await pc.click('#formItem button[type=submit]');
  check('4.2 Fără dată → nu se salvează, formularul rămâne deschis', await pc.evaluate(() => document.querySelector('#dlgItem').open));
  await pc.locator('#formItem .dfield input[type=text]').first().pressSequentially('31022027');
  await pc.click('#formItem button[type=submit]');
  check('4.3 Dată imposibilă (31/02) → nu se salvează', await pc.evaluate(() => document.querySelector('#dlgItem').open));
  await pc.keyboard.press('Escape');
  await pc.click('#fab'); await pc.click('[data-new=item]');
  await pc.locator('#formItem .dfield input[type=text]').first().pressSequentially(dmy(5));
  await pc.click('#formItem button[type=submit]');
  check('4.4 Fără răspuns la „Ai plătit-o deja?” → nu se salvează', await pc.evaluate(() => document.querySelector('#dlgItem').open));
  await pc.keyboard.press('Escape');
  await pc.reload(); await settle(pc);
  check('4.5 După reîncărcarea paginii datele sunt intacte', JSON.stringify((await local(pc)).items.map((i) => i.id).sort()) === JSON.stringify(JSON.parse(before).map((i) => i.id).sort()));

  // ===== 5. Fără internet / eroare Google =====
  G.fail = true;
  await addItem(pc, { cat: 'Factură', titlu: 'Enel', exp: dmy(12), suma: 320, rec: '1', paid: 'nu' });
  await settle(pc);
  st = await local(pc);
  check('5.1 Eroare Google: evidența rămâne salvată local', !!findItem(st, (i) => i.titlu === 'Enel'));
  check('5.2 Eroare Google: e marcată „nesincronizat”', findItem(st, (i) => i.titlu === 'Enel').dirty && (await pc.isVisible('.card:has-text("Enel") .sync-flag')));
  check('5.3 Eroare Google: butonul arată eroarea', (await pc.textContent('#syncLabel')).includes('Eroare'));
  await pc.reload(); await settle(pc);
  check('5.4 Reîncărcare cu Google căzut: datele nesincronizate nu se pierd', !!findItem(await local(pc), (i) => i.titlu === 'Enel'));
  G.fail = false;
  await connect(pc);
  st = await local(pc);
  check('5.5 Revenire: se trimite automat la apăsarea „Sincronizează”', !findItem(st, (i) => i.titlu === 'Enel').dirty && allEvents().some((e) => e.summary.includes('Enel')));

  // salvare parțială: Google cade la mijlocul sincronizării
  G.fail = true;
  await addItem(pc, { cat: 'Abonament', titlu: 'Netflix', exp: dmy(15), suma: 50, rec: '1', paid: 'nu' });
  await addItem(pc, { cat: 'Abonament', titlu: 'Digi', exp: dmy(16), suma: 60, rec: '1', paid: 'nu' });
  await addItem(pc, { cat: 'Abonament', titlu: 'Spotify', exp: dmy(17), suma: 30, rec: '1', paid: 'nu' });
  await settle(pc);
  G.fail = false; G.failAfter = 2; // citire Drive + 1 eveniment, apoi cade
  await connect(pc);
  const partial = allEvents().filter((e) => /Netflix|Digi|Spotify/.test(e.summary)).length;
  G.fail = false; G.failAfter = null;
  await connect(pc);
  const subs = allEvents().filter((e) => /Netflix|Digi|Spotify/.test(e.summary));
  check('5.6 Sincronizare întreruptă la jumătate, apoi reluată → fără evenimente dublate', subs.length === 3, `după cădere: ${partial}, după reluare: ${subs.length}`);
  check('5.7 …și nimic nu rămâne nesincronizat', (await local(pc)).items.every((i) => !i.dirty));

  // ===== 6. Telefon ↔ PC =====
  await connect(tel);
  st = await local(tel);
  check('6.1 Telefonul primește tot ce s-a adăugat pe PC', st.items.length === (await local(pc)).items.length && st.assets.length === 1, `${st.items.length} evidențe`);
  // modificări pe dispozitive diferite, pe elemente diferite
  await view(tel, 'prioritar');
  await addItem(tel, { cat: 'Rovinietă', asset: 'Duster 4x4 · AR 12 ABC', rec: '30d', suma: 35, paid: 'azi' });
  await tel.locator('.card', { hasText: 'Enel' }).click();
  await tel.fill('#formItem input[name=suma]', '345');
  await tel.click('#formItem button[type=submit]');
  await settle(tel);
  await pc.locator('.card', { hasText: 'ITP' }).click();
  await pc.fill('#formItem textarea[name=note]', 'Stația RAR Arad');
  await pc.click('#formItem button[type=submit]');
  await settle(pc);
  st = await local(pc);
  check('6.2 PC vede rovinieta adăugată pe telefon', !!findItem(st, (i) => i.categorie === 'Rovinietă'));
  check('6.3 PC vede suma Enel schimbată pe telefon', findItem(st, (i) => i.titlu === 'Enel').suma === 345);
  check('6.4 Nota de pe PC s-a păstrat (nu a fost suprascrisă)', findItem(st, (i) => i.categorie === 'ITP').note === 'Stația RAR Arad');
  await connect(tel);
  check('6.5 Telefonul primește nota de pe PC', findItem(await local(tel), (i) => i.categorie === 'ITP').note === 'Stația RAR Arad');
  check('6.6 Rovinieta pe 30 de zile plătită azi expiră peste 30 de zile', findItem(await local(tel), (i) => i.categorie === 'Rovinietă').expira === iso(30));

  // conflict pe același element: câștigă modificarea mai nouă
  G.fail = true; // ambele „offline”
  await pc.locator('.card', { hasText: 'Enel' }).click();
  await pc.fill('#formItem input[name=titlu]', 'Enel PC');
  await pc.click('#formItem button[type=submit]');
  await pc.waitForTimeout(1200);
  await tel.locator('.card', { hasText: 'Enel' }).click();
  await tel.fill('#formItem input[name=titlu]', 'Enel Telefon');
  await tel.click('#formItem button[type=submit]');
  await tel.waitForTimeout(1200);
  G.fail = false;
  await connect(pc); await connect(tel); await connect(pc);
  const tPc = findItem(await local(pc), (i) => i.titlu && i.titlu.startsWith('Enel')).titlu;
  const tTel = findItem(await local(tel), (i) => i.titlu && i.titlu.startsWith('Enel')).titlu;
  check('6.7 Conflict: ambele dispozitive ajung la aceeași variantă', tPc === tTel, `PC=${tPc}, Tel=${tTel}`);
  check('6.8 Conflict: câștigă ultima modificare (de pe telefon)', tPc === 'Enel Telefon');
  check('6.9 Conflict: un singur eveniment Enel în calendar', allEvents().filter((e) => e.summary.includes('Enel')).length === 1, `${allEvents().filter((e) => e.summary.includes('Enel')).length}`);

  // ștergere pe un dispozitiv
  tel.once('dialog', (d) => d.accept());
  await tel.locator('.card', { hasText: 'Enel Telefon' }).click();
  await tel.click('#btnDelete');
  await settle(tel);
  await connect(pc);
  check('6.10 Ștergere pe telefon → dispare și de pe PC', !findItem(await local(pc), (i) => (i.titlu || '').startsWith('Enel')));
  check('6.11 Ștergere pe telefon → dispare din calendar', !allEvents().some((e) => e.summary.includes('Enel')));

  // ștergere mașină cu tot cu documente
  await view(pc, 'bunuri');
  pc.once('dialog', (d) => d.accept());
  await pc.click('[data-edit-asset]');
  await pc.click('#btnDeleteAsset');
  await settle(pc);
  check('6.12 Ștergere mașină → și documentele ei dispar din calendar', !allEvents().some((e) => e.summary.includes('Duster')), `${allEvents().length} evenimente rămase`);
  await connect(tel);
  check('6.13 Ștergerea mașinii ajunge și pe telefon', (await local(tel)).assets.length === 0);

  // ===== 7. Calendar șters manual din Google Calendar =====
  await addItem(pc, { cat: 'Impozit', titlu: 'Casă', exp: dmy(40), suma: 600, paid: 'nu' });
  await settle(pc);
  for (const k of Object.keys(G.cals)) delete G.cals[k];
  await pc.locator('.views [data-view=prioritar]').click();
  await pc.locator('.card', { hasText: 'Casă' }).click();
  await pc.fill('#formItem input[name=suma]', '650');
  await pc.click('#formItem button[type=submit]');
  await settle(pc);
  check('7.1 Calendar șters manual → aplicația îl recreează', Object.keys(G.cals).length === 1);
  check('7.2 …și pune evenimentele înapoi', allEvents().some((e) => e.summary.includes('Casă')));
  await settle(pc);
  const nActive = (await local(pc)).items.filter((i) => i.status !== 'platit').length;
  check('7.3 …toate evenimentele, nu doar cel editat', allEvents().length === nActive, `${allEvents().length} evenimente / ${nActive} evidențe active`);

  // ===== 8. Sesiune Google expirată =====
  await pc.evaluate(() => sessionStorage.clear());
  await pc.reload(); await pc.waitForTimeout(500);
  check('8.1 Fără sesiune: aplicația pornește cu datele locale', (await pc.locator('.card').count()) > 0);
  check('8.3 Fără sesiune: banda de reconectare apare', await pc.isVisible('#syncBanner'));
  check('8.2 Fără sesiune: butonul cere reconectare', /Sincronizează|Conectează/.test(await pc.textContent('#syncLabel')));

  const errs = [...pc.errs.map((e) => 'PC: ' + e), ...tel.errs.map((e) => 'Tel: ' + e)];
  check('9.1 Nicio eroare JavaScript în pagină', errs.length === 0, errs.join(' | '));

  await pc.screenshot({ path: `${OUT}/sim-pc.png` });
  await view(tel, 'prioritar');
  await tel.screenshot({ path: `${OUT}/sim-tel.png` });
  require('fs').writeFileSync(`${OUT}/sim-results.json`, JSON.stringify(results, null, 1));
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} OK`);
  await browser.close();
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
