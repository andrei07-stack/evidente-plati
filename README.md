# Evidențe plăți

Aplicație web instalabilă pe telefon (PWA) pentru evidența rovinietelor, asigurărilor (RCA, CASCO, locuință), ITP-urilor, facturilor, impozitelor și amenzilor.

- Carduri colorate după termen: **roșu** = expirat / azi, **portocaliu** = ≤ 7 zile, **albastru** = ≤ 30 zile, **verde** = mai târziu.
- **✓ Plătit**: la elementele recurente (RCA anual, factură lunară etc.) mută automat scadența la următoarea perioadă. La cele unice (amenzi) le marchează plătite. Ai „Anulează” 7 secunde.
- **Google Calendar**: fiecare scadență devine un eveniment la ora 09:00 într-un calendar separat, **„Evidențe plăți”**. Notificările pop-up vin cu 14, 7 și 1 zi înainte, iar emailul cu 7 zile înainte. Se modifică în `config.js`.
- **Date**: se salvează în Google Drive-ul tău, într-un folder ascuns al aplicației (`appDataFolder`), și local în browser, ca să poți deschide aplicația și offline. În repo nu ajung date.
- Pentru amenzi, aplicația calculează termenul de 15 zile de la comunicare (plata a jumătate din minim, OG 2/2001 art. 28).
- Are backup/import JSON și export `.ics`.

Aplicația cere doar două permisiuni restrânse:
- `drive.appdata`: vede **doar** fișierul propriu al aplicației, nu restul Drive-ului.
- `calendar.app.created`: gestionează **doar** calendarul creat de aplicație, nu celelalte calendare.

---

## Instalare (o singură dată, ~15 minute)

### 1. Publicare pe GitHub Pages
1. În repo-ul `evidente-plati` deschide **Settings → Pages**.
2. La *Source* alege **Deploy from a branch**, branch `main`, folder `/ (root)`, apoi apasă **Save**.
3. După 1–2 minute aplicația apare la `https://andrei07-stack.github.io/evidente-plati/`.

Până la pasul 3 aplicația merge în **mod demo**: datele rămân doar în browser și nu se creează nimic în calendar.

### 2. Client OAuth în Google Cloud
1. Intră pe <https://console.cloud.google.com/> cu contul Google al calendarului și creează un proiect nou, de exemplu `evidente-plati`.
2. Activează API-urile din **APIs & Services → Library**: **Google Calendar API** și **Google Drive API**.
3. Configurează ecranul de consimțământ din **Google Auth Platform** (în unele versiuni ale consolei se numește *OAuth consent screen*):
   - *Branding*: numele aplicației „Evidențe plăți” și emailul tău.
   - *Audience*: tip **External**, status **Testing**. La **Test users** adaugă adresa ta Gmail și, dacă vrei, pe a soției.
   - *Data access → Add or remove scopes*: adaugă `.../auth/drive.appdata` și `.../auth/calendar.app.created`.
4. Creează clientul din **Clients → Create client**:
   - Tip: **Web application**.
   - *Authorized JavaScript origins*: `https://andrei07-stack.github.io`. Opțional, pentru teste locale, adaugă și `http://localhost:8765`.
   - Nu e nevoie de *redirect URI*.
5. Copiază **Client ID**-ul, care arată ca `123…apps.googleusercontent.com`.

### 3. Completare config
În `config.js` pune Client ID-ul:
```js
GOOGLE_CLIENT_ID: '123…apps.googleusercontent.com',
```
Fă commit. În 1–2 minute GitHub Pages publică versiunea nouă.

### 4. Pe telefon
1. Deschide linkul în **Chrome** pe Android sau **Safari** pe iPhone.
2. Instalează aplicația: pe Android din meniul ⋮ → **Instalează aplicația** / *Adaugă pe ecranul de pornire*, iar pe iPhone din Share → **Adaugă pe ecranul principal**.
3. Apasă **Conectează Google** și acceptă ambele permisiuni. Pentru că aplicația e în modul *Testing*, Google afișează avertismentul „Google nu a verificat această aplicație”. Apasă **Continuă**: aplicația e a ta.
4. În aplicația Google Calendar de pe telefon verifică dacă e bifat calendarul **„Evidențe plăți”**.

---

## De știut
- **Sesiunea Google durează ~1 oră**, așa funcționează autentificarea fără server. Când redeschizi aplicația după mai mult timp, apeși o dată pe „Sincronizează”. Notificările vin oricum din Google Calendar, chiar dacă aplicația e închisă.
- Dacă lucrezi pe două dispozitive, datele se sincronizează prin Drive. Câștigă ultima modificare salvată.
- **Resincronizează tot calendarul** (din Setări) reface toate evenimentele, de exemplu după ce schimbi notificările în `config.js`.
- Dacă Google respinge scope-ul `calendar.app.created`, înlocuiește-l în `app.js` cu `https://www.googleapis.com/auth/calendar`, care e mai larg, și adaugă-l și la *Data access*.

## Rulare locală
```bash
python3 -m http.server 8765
# deschide http://localhost:8765
```

## Structură
| Fișier | Rol |
|---|---|
| `index.html`, `styles.css` | interfața |
| `app.js` | logică, sincronizare Drive + Calendar |
| `config.js` | Client ID, ora și notificările |
| `sw.js`, `manifest.webmanifest`, `icons/` | instalare ca aplicație, funcționare offline |
