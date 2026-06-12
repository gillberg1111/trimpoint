# ENG-005 — The living interface: view transitions, animated donut, status pill, PWA & finish details (v1.4.0)

**Architect:** Claude · **Engineer:** Deepseek · **Reviewer:** Claude
**Status:** Ready for implementation
**Target:** `server.js`, `public/index.html`, **plus two NEW files**: `public/manifest.webmanifest`, `public/sw.js`

---

## Scope & ground rules

Code changes **only**. Same rules as ENG-001 through 004, with one addition:

- Edit **`server.js`** and **`public/index.html`** exactly as specified.
- **Create** `public/manifest.webmanifest` and `public/sw.js` with the exact contents in Task 4. These are the only new files.
- Do **not** touch `CHANGELOG.md`, `README.md`, `.env.example`, `.gitignore`, `package.json`, `docs/`, or branding/copy beyond the exact strings below. The architect owns those.
- No refactors, no reformatting untouched lines, no new dependencies (Node built-ins / browser built-ins only — this project is zero-dependency).
- Match existing style. If a context string doesn't match, **stop and flag it** rather than improvising.

Theme of this release: **the interface moves like a living thing instead of repainting.** The visual identity (palette, type, layout) does not change. Every feature below is a progressive enhancement — on a browser without the API, behavior is exactly today's.

Five tasks. All required. Apply in order (Task 5 reuses a constant defined in Task 1).

⚠️ **Two paths must stay untouched:** the in-place updaters `updateBankColors()` / `updateGroups()` and everything in the `input` event handler. They exist to preserve keyboard focus while typing. Nothing in this spec wraps them, and you must not "helpfully" extend the new transition wrapper to them.

---

## Task 1 — Motion continuity (View Transitions)

### Problem
Every structural interaction goes through `buildRows()` — a full teardown-and-rebuild — so chips and cards pop in and out and everything below them jumps. With the View Transitions API, the browser snapshots before/after and animates the difference: opening a card pushes content down smoothly, a deleted chip's neighbors slide into its place. Browsers without the API (or users with reduced motion) just run `buildRows()` directly.

### 1a — `public/index.html`: the `morph()` helper

Directly **after** this existing line:
```js
const BANK_COLOR='#84A9DA', CASH_COLOR='#1F9E5A';
```
add:
```js
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)");
function morph(fn){ if(document.startViewTransition && !REDUCED.matches) document.startViewTransition(fn); else fn(); }
```

### 1b — `public/index.html`: name the moving parts

In `buildChipsInto`, current:
```js
  host.innerHTML = list.map(p=>`<button class="chip" id="chip-${p.id}" data-open="${p.id}"><span class="cd"></span><span class="cmain"><span class="ct" id="ct-${p.id}">${esc((p.ticker||"").toUpperCase()||"—")}</span><span class="cp" id="cp-${p.id}">—</span></span><span class="cw" id="cw-${p.id}">—</span></button>`).join('');
```
New (adds a per-chip `view-transition-name`):
```js
  host.innerHTML = list.map(p=>`<button class="chip" id="chip-${p.id}" data-open="${p.id}" style="view-transition-name:tpc-${p.id}"><span class="cd"></span><span class="cmain"><span class="ct" id="ct-${p.id}">${esc((p.ticker||"").toUpperCase()||"—")}</span><span class="cp" id="cp-${p.id}">—</span></span><span class="cw" id="cw-${p.id}">—</span></button>`).join('');
```

In `buildCardsInto`, current:
```js
    const el=document.createElement("div"); el.className="pos"; el.id="card-"+p.id;
```
New:
```js
    const el=document.createElement("div"); el.className="pos"; el.id="card-"+p.id; el.style.viewTransitionName="tpd-"+p.id;
```

### 1c — `public/index.html`: transition styling

In the `<style>` block, directly **after** this existing line:
```css
  @media (prefers-reduced-motion:reduce){ *{animation:none!important;} }
```
add:
```css
  ::view-transition-group(*){animation-duration:.32s;animation-timing-function:cubic-bezier(.2,.75,.2,1);}
  ::view-transition-old(root),::view-transition-new(root){animation-duration:.22s;}
```

### 1d — `public/index.html`: wrap the four structural paths

These are the only call sites that get wrapped. **Refresh, boot, and all `input`-handler paths stay as they are.**

In the `click` handler, current (the remove-position branch):
```js
    buildRows(); saveConfig(); }
  else if(op){ const id=+op.dataset.open; if(openIds.has(id)) openIds.delete(id); else { openIds.add(id); justOpened=id; } buildRows(); }
```
New:
```js
    morph(buildRows); saveConfig(); }
  else if(op){ const id=+op.dataset.open; if(openIds.has(id)) openIds.delete(id); else { openIds.add(id); justOpened=id; } morph(buildRows); }
```

The add-position button, current:
```js
$("addBtn").addEventListener("click", ()=>{ const id=nextId++; state.positions.push({id, ticker:"NEW", shares:0, price:0, cost:0, ceiling:"", floor:"", underweightAlert:"", note:""}); openIds.add(id); justOpened=id; buildRows(); saveConfig(); });
```
New:
```js
$("addBtn").addEventListener("click", ()=>{ const id=nextId++; state.positions.push({id, ticker:"NEW", shares:0, price:0, cost:0, ceiling:"", floor:"", underweightAlert:"", note:""}); openIds.add(id); justOpened=id; morph(buildRows); saveConfig(); });
```

The add-crypto button, current:
```js
$("addCryptoBtn").addEventListener("click", ()=>{ const id=nextId++; state.crypto.push({id, ticker:"NEW", shares:0, price:0, cost:0, ceiling:"", floor:"", underweightAlert:"", note:""}); openIds.add(id); justOpened=id; buildRows(); saveConfig(); });
```
New:
```js
$("addCryptoBtn").addEventListener("click", ()=>{ const id=nextId++; state.crypto.push({id, ticker:"NEW", shares:0, price:0, cost:0, ceiling:"", floor:"", underweightAlert:"", note:""}); openIds.add(id); justOpened=id; morph(buildRows); saveConfig(); });
```

### Acceptance criteria
- Tapping a chip: the card area animates open and everything below slides down smoothly (Chrome/Edge/Safari 18+). Collapsing animates back.
- Removing a position: its chip fades out and neighbors glide into place.
- Firefox / older browsers: identical behavior to today (instant rebuild), no errors.
- With "reduce motion" enabled in the OS: instant rebuild.
- Typing in a group name/cap, bank target, or any position field never loses focus (those paths are untouched).

---

## Task 2 — The living donut

### Problem
`renderDonut` rebuilds its SVG via `innerHTML` on every render, so when weights change the arcs snap. When the segment *structure* is unchanged (same labels, same count — the overwhelmingly common case: a price refresh or an edited share count), update the existing circles in place and let a CSS transition sweep the arcs to their new sizes.

### 2a — `public/index.html`: replace `renderDonut`

Replace this entire function:
```js
function renderDonut(svgId, segs, total){
  const svg=$(svgId); const cx=90,cy=90,r=64,sw=20,C=2*Math.PI*r;
  let off=0, inner=`<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--track)" stroke-width="${sw}"/>`;
  if(total>0) segs.forEach(s=>{ const full=C*Math.max(0,Math.min(100,s.pct))/100, len=Math.max(0,full-2);
    inner+=`<circle class="seg" data-seg="${esc(s.label)}" cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${s.color}" stroke-width="${sw}" stroke-dasharray="${len.toFixed(2)} ${(C-len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"/>`; off+=full; });
  svg.innerHTML=inner;
}
```
with:
```js
function renderDonut(svgId, segs, total){
  const svg=$(svgId); const cx=90,cy=90,r=64,sw=20,C=2*Math.PI*r;
  const arc=s=>{ const full=C*Math.max(0,Math.min(100,s.pct))/100; return { full, len:Math.max(0,full-2) }; };
  const old=[...svg.querySelectorAll('.seg')];
  if(total>0 && old.length===segs.length && segs.every((s,i)=>old[i].dataset.seg===s.label)){
    let off=0;
    segs.forEach((s,i)=>{ const a=arc(s), el=old[i]; el.setAttribute('stroke',s.color);
      el.style.strokeDasharray=`${a.len.toFixed(2)} ${(C-a.len).toFixed(2)}`; el.style.strokeDashoffset=(-off).toFixed(2); off+=a.full; });
    return;
  }
  let off=0, inner=`<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--track)" stroke-width="${sw}"/>`;
  if(total>0) segs.forEach(s=>{ const a=arc(s);
    inner+=`<circle class="seg" data-seg="${esc(s.label)}" cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${s.color}" stroke-width="${sw}" stroke-dasharray="${a.len.toFixed(2)} ${(C-a.len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"/>`; off+=a.full; });
  svg.innerHTML=inner;
}
```
(In-place updates write `el.style.*` so they override the initial presentation attributes; a structural change — segment added/removed/reordered — still rebuilds instantly, which is correct because there's nothing meaningful to tween between different segment sets.)

### 2b — `public/index.html`: let the arcs transition

Current:
```css
  #donut .seg,#cryptoDonut .seg{transition:opacity .18s;}
```
New:
```css
  #donut .seg,#cryptoDonut .seg{transition:opacity .18s,stroke-dasharray .6s cubic-bezier(.2,.75,.2,1),stroke-dashoffset .6s cubic-bezier(.2,.75,.2,1),stroke .4s linear;}
```

### Acceptance criteria
- Refresh prices → the donut arcs *sweep* to their new proportions over ~0.6s instead of snapping. Same for editing a share count.
- Legend hover dim/undim still works (the opacity transition is preserved).
- Adding or removing a position rebuilds the donut instantly with the new segment set (no broken tween), exactly as today.
- Both donuts (stocks and crypto) behave identically.

---

## Task 3 — Sticky status pill

### Problem
The status banner is the most important element on the page and it scrolls away after one flick. When the banner leaves the viewport, float a small frosted capsule at the top — `▲ 2 to review` (gold) or `✓ all clear` (green) — that scrolls you back to the top when tapped. It must never appear on an empty portfolio or while the real banner is visible.

### 3a — `public/index.html`: the element

Current:
```html
  <hr class="rule">
  <div id="banner" class="banner ease"></div>
```
New:
```html
  <hr class="rule">
  <div id="banner" class="banner ease"></div>
  <button id="pill" class="pill" type="button" aria-label="Portfolio status — back to top"></button>
```

### 3b — `public/index.html`: the styles

In the `<style>` block, directly **after** this existing line:
```css
  .banner .btxt{font-size:14.5px;line-height:1.5;} .banner .btxt b{font-family:'IBM Plex Mono',monospace;font-weight:600;}
```
add:
```css
  .pill{position:fixed;top:calc(env(safe-area-inset-top,0px) + 10px);left:50%;transform:translateX(-50%) translateY(-14px);z-index:60;opacity:0;pointer-events:none;
    font-family:'IBM Plex Mono',monospace;font-size:12.5px;font-weight:600;letter-spacing:.03em;color:var(--ink);padding:9px 16px;border-radius:999px;cursor:pointer;
    background:rgba(27,31,40,.72);backdrop-filter:blur(14px) saturate(130%);-webkit-backdrop-filter:blur(14px) saturate(130%);
    border:1px solid var(--line);box-shadow:0 8px 24px rgba(0,0,0,.45);transition:opacity .25s,transform .25s cubic-bezier(.2,.75,.2,1);}
  .pill.show{opacity:1;pointer-events:auto;transform:translateX(-50%) translateY(0);}
  .pill.act{border-color:rgba(227,169,74,.5);color:var(--gold);}
  .pill.clear{border-color:rgba(121,198,160,.4);color:var(--green);}
```

### 3c — `public/index.html`: feed it from `renderBanner`

Replace this entire function:
```js
function renderBanner(){
  const stock=compute(), crypto=computeCrypto(), groups=computeGroups(stock);
  const over=stock.overCount+crypto.overCount, groupsOver=groups.filter(g=>g.over).length;
  const b=$("banner");
  if(!state.positions.length && !state.crypto.length){ b.className="banner"; b.innerHTML=`<span class="mark" style="color:var(--muted2)">·</span><div class="btxt">Add your positions below to start tracking.</div>`; return; }
  const parts=[];
  if(over) parts.push(`${over} position${over>1?"s":""} over your ceiling`);
  if(groupsOver) parts.push(`${groupsOver} group${groupsOver>1?"s":""} over cap`);
  if(stock.cashLow) parts.push(`cash below your ${stock.minCash}% floor`);
  if(parts.length){ b.className="banner act"; b.innerHTML=`<span class="mark">▲</span><div class="btxt">${parts.join(" · ")} — check your plan.</div>`; }
  else { b.className="banner clear"; b.innerHTML=`<span class="mark">✓</span><div class="btxt">Everything's within your limits. Nothing to do.</div>`; }
}
```
with:
```js
function renderBanner(){
  const stock=compute(), crypto=computeCrypto(), groups=computeGroups(stock);
  const over=stock.overCount+crypto.overCount, groupsOver=groups.filter(g=>g.over).length;
  const b=$("banner"), pill=$("pill");
  if(!state.positions.length && !state.crypto.length){ b.className="banner"; b.innerHTML=`<span class="mark" style="color:var(--muted2)">·</span><div class="btxt">Add your positions below to start tracking.</div>`; pill.dataset.on="0"; syncPill(); return; }
  const parts=[];
  if(over) parts.push(`${over} position${over>1?"s":""} over your ceiling`);
  if(groupsOver) parts.push(`${groupsOver} group${groupsOver>1?"s":""} over cap`);
  if(stock.cashLow) parts.push(`cash below your ${stock.minCash}% floor`);
  const n=over+groupsOver+(stock.cashLow?1:0);
  if(parts.length){ b.className="banner act"; b.innerHTML=`<span class="mark">▲</span><div class="btxt">${parts.join(" · ")} — check your plan.</div>`; pill.className="pill act"; pill.textContent=`▲ ${n} to review`; }
  else { b.className="banner clear"; b.innerHTML=`<span class="mark">✓</span><div class="btxt">Everything's within your limits. Nothing to do.</div>`; pill.className="pill clear"; pill.textContent=`✓ all clear`; }
  pill.dataset.on="1"; syncPill();
}
```

### 3d — `public/index.html`: visibility wiring

Directly **after** these existing lines:
```js
wireLegendHover("legend","donut");
wireLegendHover("cryptoLegend","cryptoDonut");
```
add:
```js
let bannerOff=false;
function syncPill(){ const p=$("pill"); p.classList.toggle("show", bannerOff && p.dataset.on==="1"); }
new IntersectionObserver(es=>{ bannerOff=!es[0].isIntersecting; syncPill(); },{rootMargin:"-1px 0px 0px 0px"}).observe($("banner"));
$("pill").addEventListener("click", ()=>scrollTo({top:0,behavior:REDUCED.matches?"auto":"smooth"}));
```
(`syncPill` is a function declaration, so it's hoisted and safely callable from `renderBanner` regardless of execution order. Note `pill.className="pill act"` in 3c wipes the `show` class on every render — that's intentional; `syncPill()` immediately restores it when applicable.)

### Acceptance criteria
- Scroll past the banner with positions present → the pill slides in at top-center: gold `▲ N to review` when anything is over (N = positions over + groups over + low cash), green `✓ all clear` otherwise.
- Scroll back up → the pill slides away. It never overlaps the visible banner.
- Empty portfolio → no pill, ever.
- Tapping it smooth-scrolls to the top (instant when reduced motion is set).
- The count updates live: trigger a breach by editing a share count while scrolled down → the pill flips to gold with the right count.

---

## Task 4 — PWA: manifest + service worker

### Problem
The app has apple-touch meta tags but no web app manifest and no service worker — so no install prompt, no standalone window, no splash, and a blank page offline. Add a minimal, safe shell: install metadata, network-first caching with offline fallback for the static shell, and offline read-only fallback for `GET /api/config` + `/api/history` only. **Never cache redirects** (that's what keeps the login flow safe) and never touch POSTs or quote endpoints.

### 4a — NEW FILE `public/manifest.webmanifest`

Create with exactly:
```json
{
  "name": "TrimPoint",
  "short_name": "TrimPoint",
  "description": "Self-hosted position-ceiling tracker — your limits, your plan.",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "background_color": "#13151b",
  "theme_color": "#13151b",
  "icons": [
    { "src": "/favicon.svg", "sizes": "any", "type": "image/svg+xml", "purpose": "any" },
    { "src": "/apple-touch-icon.png", "sizes": "180x180", "type": "image/png", "purpose": "any" }
  ]
}
```

### 4b — NEW FILE `public/sw.js`

Create with exactly:
```js
// TrimPoint service worker — minimal offline shell.
// network-first everywhere; cache fallback when offline. Never caches redirects
// (login flow) or non-OK responses. API fallback is read-only and limited to
// config + history so the dashboard can render with last-known data offline.
const CACHE = 'trimpoint-v1';
const STATIC = ['/favicon.svg', '/apple-touch-icon.png', '/manifest.webmanifest'];
const API_FALLBACK = ['/api/config', '/api/history'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(STATIC)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') && !API_FALLBACK.includes(url.pathname)) return;
  e.respondWith(
    fetch(e.request).then((r) => {
      if (r.ok && r.type === 'basic' && !r.redirected) {
        const copy = r.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
      }
      return r;
    }).catch(() =>
      caches.match(e.request, { ignoreSearch: e.request.mode === 'navigate' })
        .then((m) => m || (e.request.mode === 'navigate' ? caches.match('/') : undefined))
        .then((m) => m || Response.error())
    )
  );
});
```

### 4c — `server.js`: serve the new types publicly

The MIME map, current:
```js
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
```
New:
```js
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
```

`isPublic`, current:
```js
const isPublic = (path, method) =>
  path === '/api/health' || path === '/login' || (path === '/api/login' && method === 'POST') ||
  path === '/favicon.svg' || path === '/apple-touch-icon.png';
```
New (manifest requests are sent without credentials, and the SW script must be fetchable to register — both must bypass the auth gate; neither exposes any data):
```js
const isPublic = (path, method) =>
  path === '/api/health' || path === '/login' || (path === '/api/login' && method === 'POST') ||
  path === '/favicon.svg' || path === '/apple-touch-icon.png' ||
  path === '/manifest.webmanifest' || path === '/sw.js';
```

### 4d — `public/index.html`: link + register

In the `<head>`, current:
```html
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
```
New:
```html
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/manifest.webmanifest">
```

In the script, current:
```js
fetch('/api/health').then(r=>r.json()).then(d=>{ if(d&&d.auth) $("logoutWrap").style.display="inline"; if(d&&d.version) $("verNum").textContent="TrimPoint v"+d.version; }).catch(()=>{});
```
New:
```js
fetch('/api/health').then(r=>r.json()).then(d=>{ if(d&&d.auth) $("logoutWrap").style.display="inline"; if(d&&d.version) $("verNum").textContent="TrimPoint v"+d.version; }).catch(()=>{});
if("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(()=>{});
```

### Acceptance criteria
- Chrome/Edge desktop & Android show the install affordance; installed app opens standalone with the dark splash.
- `GET /manifest.webmanifest` returns 200 with `application/manifest+json` **with auth enabled and no session** (same for `/sw.js`).
- With auth on: log out → `/` still redirects to `/login`; the login redirect is **not** served from cache afterward (redirects are never cached).
- Offline after one online visit: the page loads from cache and renders the last-known portfolio (config/history fallback); price refresh fails gracefully with the existing "couldn't reach" message; `POST` saves fail silently as today (debounced fetch already has a `.catch`).
- `/api/quote` and `/api/crypto` are never served from cache.

> **Maintenance note (for the architect, recorded here for completeness):** the `CACHE` constant (`trimpoint-v1`) is bumped in future specs only if the cache strategy itself changes — content updates flow through network-first automatically.

---

## Task 5 — Finish details

Five small refinements. All in `public/index.html`.

### 5a — Native dark UI + wide-gamut accents

The `:root` block, current:
```css
  :root{
    --bg:#13151b;--bg2:#181b22;--card:#1b1f28;--card2:#1f2530;--line:#2b313c;--line-soft:#23272f;--track:#22262f;
    --ink:#ECE7DD;--muted:#878d99;--muted2:#5f6571;--gold:#E3A94A;--gold-dim:#a7813c;--green:#79C6A0;--blue:#84A9DA;--danger:#d98a7a;
  }
```
New (adds `color-scheme` so native widgets/scrollbars render dark, then re-expresses the five accents in OKLCH for wide-gamut screens — values chosen to match the hex originals with a touch more chroma where the display can show it; sRGB screens are visually unchanged):
```css
  :root{
    --bg:#13151b;--bg2:#181b22;--card:#1b1f28;--card2:#1f2530;--line:#2b313c;--line-soft:#23272f;--track:#22262f;
    --ink:#ECE7DD;--muted:#878d99;--muted2:#5f6571;--gold:#E3A94A;--gold-dim:#a7813c;--green:#79C6A0;--blue:#84A9DA;--danger:#d98a7a;
    color-scheme:dark;
  }
  @supports (color: oklch(70% 0.1 80)){
    :root{--gold:oklch(76% 0.14 78);--gold-dim:oklch(62% 0.1 80);--green:oklch(77% 0.11 163);--blue:oklch(73% 0.09 258);--danger:oklch(71% 0.1 33);}
  }
```

### 5b — Typography wrapping

Current:
```css
  h1{font-family:'Fraunces',serif;font-weight:500;font-size:34px;line-height:1.04;letter-spacing:-.012em;margin-bottom:8px;}
```
New:
```css
  h1{font-family:'Fraunces',serif;font-weight:500;font-size:34px;line-height:1.04;letter-spacing:-.012em;margin-bottom:8px;text-wrap:balance;}
```

Current:
```css
  .sub{color:var(--muted);font-size:14.5px;line-height:1.5;max-width:48ch;}
```
New:
```css
  .sub{color:var(--muted);font-size:14.5px;line-height:1.5;max-width:48ch;text-wrap:pretty;}
```

### 5c — Themed scrollbar

Current:
```css
  html,body{background:var(--bg);}
```
New:
```css
  html,body{background:var(--bg);}
  html{scrollbar-color:var(--line) var(--bg);}
```

### 5d — Press feedback

Directly **after** this existing line:
```css
  .chip:focus-visible{outline:2px solid var(--gold-dim);outline-offset:2px;}
```
add:
```css
  .chip:active{transform:scale(.97);transition-duration:.08s;}
  .btn:active{transform:translateY(0) scale(.98);transition-duration:.08s;}
```

### 5e — Shimmer while prices load

Directly **after** this existing line:
```css
  @keyframes chipGlow{0%,100%{box-shadow:0 0 0 1px rgba(227,169,74,.2),0 0 16px rgba(227,169,74,.18);}50%{box-shadow:0 0 0 1px rgba(227,169,74,.42),0 0 30px rgba(227,169,74,.44);}}
```
add:
```css
  @keyframes shimmer{0%{background-position:-160% 0;}100%{background-position:160% 0;}}
  .chips.loading .chip .cp{color:transparent;border-radius:6px;background:linear-gradient(90deg,rgba(255,255,255,.05) 25%,rgba(255,255,255,.14) 50%,rgba(255,255,255,.05) 75%);background-size:200% 100%;animation:shimmer 1.1s linear infinite;}
```

Then wire the class. In `refreshPrices`, current:
```js
  const label=btn.textContent; btn.disabled=true; btn.textContent="Refreshing…"; status.textContent="Fetching latest prices…"; status.style.color="var(--muted)";
```
New:
```js
  const label=btn.textContent; btn.disabled=true; btn.textContent="Refreshing…"; status.textContent="Fetching latest prices…"; status.style.color="var(--muted)"; $("chips").classList.add("loading");
```
**In the same function** (`refreshPrices`), its `finally`, current:
```js
  finally{ btn.disabled=false; btn.textContent=label; }
```
New:
```js
  finally{ btn.disabled=false; btn.textContent=label; $("chips").classList.remove("loading"); }
```

In `refreshCrypto`, current:
```js
  const label=btn.textContent; btn.disabled=true; btn.textContent="Updating…"; status.textContent="Fetching latest prices…"; status.style.color="var(--muted)";
```
New:
```js
  const label=btn.textContent; btn.disabled=true; btn.textContent="Updating…"; status.textContent="Fetching latest prices…"; status.style.color="var(--muted)"; $("cryptoChips").classList.add("loading");
```
**In the same function** (`refreshCrypto`), its `finally` — note this line is textually identical to the one in `refreshPrices`, so locate it by function — current:
```js
  finally{ btn.disabled=false; btn.textContent=label; }
```
New:
```js
  finally{ btn.disabled=false; btn.textContent=label; $("cryptoChips").classList.remove("loading"); }
```

### Acceptance criteria
- The page renders pixel-identical on an sRGB screen; on a P3 display the gold/green/blue accents are subtly richer.
- The headline never wraps to a lonely last word; the desktop scrollbar matches the theme.
- Chips and buttons compress slightly on press.
- During a refresh, every chip's price line becomes a soft sweeping shimmer bar, returning to the price when done — both sections, including on failure (the `finally` clears it).

---

## Handback checklist

- [ ] Task 1: `morph()` + `REDUCED` defined; chips/cards named; transition CSS added; exactly four call sites wrapped (expand/collapse, remove, add position, add crypto). `updateBankColors`/`updateGroups`/`input` paths untouched.
- [ ] Task 2: `renderDonut` updates in place when structure is unchanged; arcs transition; rebuild on structural change.
- [ ] Task 3: pill element + CSS + `renderBanner` replacement + observer wiring; pill shows only when the banner is offscreen and the portfolio is non-empty.
- [ ] Task 4: `manifest.webmanifest` + `sw.js` created exactly as specified; head link + registration added; server MIME + `isPublic` updated. **No other server changes.**
- [ ] Task 5: color-scheme + OKLCH overrides, text-wrap, scrollbar-color, press states, shimmer (CSS + both refresh functions).
- [ ] No edits to CHANGELOG / README / .env.example / .gitignore / package.json / docs / assets. No files created beyond the two in Task 4.
- [ ] No new dependencies.
- [ ] `node --check server.js` clean; `node --check public/sw.js` clean; client JS eyeballed for balanced braces/quotes.
- [ ] App boots; expand/collapse animates in Chrome; donut sweeps on refresh; pill appears on scroll; install prompt available; typing in group/bank inputs keeps focus.
- [ ] Notes on anything you couldn't apply verbatim.
