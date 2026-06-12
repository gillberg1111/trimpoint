# ENG-004 — Polish pass: day change on chips, unified refresh, hover parity & small fixes (v1.3.2)

**Architect:** Claude · **Engineer:** Deepseek · **Reviewer:** Claude
**Status:** Ready for implementation
**Target:** `server.js`, `public/index.html`

---

## Scope & ground rules

Code changes **only**. Same rules as ENG-001/002/003:

- Edit **`server.js`** and **`public/index.html`** exactly as specified.
- Do **not** touch `CHANGELOG.md`, `README.md`, `.env.example`, `.gitignore`, `package.json`, `docs/`, or branding/copy beyond the exact strings below. The architect owns those.
- No refactors, no reformatting untouched lines, no new dependencies (Node built-ins only — this project is zero-dependency).
- Match existing style. If a context string doesn't match, **stop and flag it** rather than improvising.

Six tasks. All required. Tasks 2 and 6e depend on Task 1's `prevClose` persistence, so apply in order.

---

## Task 1 — Persist `prevClose` and the last-refresh time

### Problem
`prevClose` is set when prices refresh but is never saved — the client's `saveConfig` omits it and the server's sanitizer would strip it anyway. So "prev close · +x.x% today" vanishes on every reload. Likewise, the "Updated 7 · 2:41 PM" status evaporates on reload, leaving no answer to "how fresh are these prices?". Persist both: `prevClose` per position, and a top-level `pricesAsOf` timestamp (epoch ms).

### 1a — `server.js`: DEFAULTS

Current:
```js
const DEFAULTS = { ceiling: 25, floor: 20, bank: '', banks: [], cash: 0, minCash: 0, positions: [], crypto: [], cryptoCeiling: 40, cryptoFloor: 30, groups: [] };
```
New:
```js
const DEFAULTS = { ceiling: 25, floor: 20, bank: '', banks: [], cash: 0, minCash: 0, positions: [], crypto: [], cryptoCeiling: 40, cryptoFloor: 30, groups: [], pricesAsOf: 0 };
```

### 1b — `server.js`: sanitizer keeps the new fields

In `sanitizeConfig`, current `pos` helper line:
```js
    shares: +p?.shares || 0, price: +p?.price || 0, cost: +p?.cost || 0,
```
New:
```js
    shares: +p?.shares || 0, price: +p?.price || 0, cost: +p?.cost || 0, prevClose: +p?.prevClose || 0,
```

And in the same function's `return` object, current:
```js
    cash: +o.cash || 0, minCash: +o.minCash || 0,
```
New:
```js
    cash: +o.cash || 0, minCash: +o.minCash || 0, pricesAsOf: +o.pricesAsOf || 0,
```

### 1c — `public/index.html`: client state carries both fields

Current state init:
```js
let state = { ceiling:25, floor:20, bank:"", banks:[], cash:0, minCash:0, positions:[], crypto:[], cryptoCeiling:40, cryptoFloor:30, groups:[] };
```
New:
```js
let state = { ceiling:25, floor:20, bank:"", banks:[], cash:0, minCash:0, positions:[], crypto:[], cryptoCeiling:40, cryptoFloor:30, groups:[], pricesAsOf:0 };
```

In `loadConfig`, current:
```js
  try{ const r = await fetch('/api/config'); if(r.status===401){ location.href='/login'; return; } if(r.ok) state = { ceiling:25, floor:20, bank:"", banks:[], cash:0, minCash:0, positions:[], crypto:[], cryptoCeiling:40, cryptoFloor:30, groups:[], ...(await r.json()) }; }catch(e){}
```
New:
```js
  try{ const r = await fetch('/api/config'); if(r.status===401){ location.href='/login'; return; } if(r.ok) state = { ceiling:25, floor:20, bank:"", banks:[], cash:0, minCash:0, positions:[], crypto:[], cryptoCeiling:40, cryptoFloor:30, groups:[], pricesAsOf:0, ...(await r.json()) }; }catch(e){}
```

Still in `loadConfig`, current `mapPos`:
```js
  const mapPos = p => ({ id:nextId++, ticker:p.ticker||"", shares:p.shares||0, price:p.price||0, cost:p.cost||0, ceiling:p.ceiling||"", floor:p.floor||"", underweightAlert:p.underweightAlert||"", note:p.note||"" });
```
New:
```js
  const mapPos = p => ({ id:nextId++, ticker:p.ticker||"", shares:p.shares||0, price:p.price||0, cost:p.cost||0, prevClose:p.prevClose||0, ceiling:p.ceiling||"", floor:p.floor||"", underweightAlert:p.underweightAlert||"", note:p.note||"" });
```

In `saveConfig`, current `mapPos`:
```js
    const mapPos = p => ({ ticker:(p.ticker||"").toUpperCase(), shares:num(p.shares), price:num(p.price), cost:num(p.cost), ceiling:num(p.ceiling)||0, floor:num(p.floor)||0, underweightAlert:num(p.underweightAlert)||0, note:(p.note||"").trim() });
```
New:
```js
    const mapPos = p => ({ ticker:(p.ticker||"").toUpperCase(), shares:num(p.shares), price:num(p.price), cost:num(p.cost), prevClose:num(p.prevClose)||0, ceiling:num(p.ceiling)||0, floor:num(p.floor)||0, underweightAlert:num(p.underweightAlert)||0, note:(p.note||"").trim() });
```

And the payload, current:
```js
    const payload = { ceiling:num(state.ceiling), floor:num(state.floor), bank:banks[0]?banks[0].ticker:"", banks, cash:num(state.cash), minCash:num(state.minCash), cryptoCeiling:num(state.cryptoCeiling), cryptoFloor:num(state.cryptoFloor),
```
New:
```js
    const payload = { ceiling:num(state.ceiling), floor:num(state.floor), bank:banks[0]?banks[0].ticker:"", banks, cash:num(state.cash), minCash:num(state.minCash), pricesAsOf:num(state.pricesAsOf)||0, cryptoCeiling:num(state.cryptoCeiling), cryptoFloor:num(state.cryptoFloor),
```

### 1d — `public/index.html`: stamp the time on a successful refresh

In `refreshPrices`, current:
```js
    buildRows(); saveConfig(); animateValue($("dcVal"), compute().total);
```
New:
```js
    if(updated) state.pricesAsOf=Date.now();
    buildRows(); saveConfig(); animateValue($("dcVal"), compute().total);
```

In `refreshCrypto`, the corresponding line is `buildRows(); saveConfig();` (the one directly after the `state.crypto.forEach(…)` price-assignment line). New:
```js
    if(updated) state.pricesAsOf=Date.now();
    buildRows(); saveConfig();
```

### 1e — `public/index.html`: show "prices as of …" on load

Add this helper directly **above** the line `async function refreshPrices(){`:
```js
function asOfLabel(ts){ const d=new Date(ts), t=d.toLocaleTimeString([], {hour:"numeric",minute:"2-digit"});
  return d.toDateString()===new Date().toDateString() ? `prices as of ${t}` : `prices as of ${d.toLocaleDateString([], {month:"short",day:"numeric"})}, ${t}`; }
```

In the boot IIFE at the bottom of the script, current:
```js
(async ()=>{ await loadConfig(); await loadHistory(); $("ceil").value=state.ceiling; $("floor").value=state.floor; $("cCeil").value=state.cryptoCeiling; $("cFloor").value=state.cryptoFloor; $("cash").value=state.cash; $("minCash").value=state.minCash; buildRows(); animateValue($("dcVal"), compute().total); booted=true; })();
```
New:
```js
(async ()=>{ await loadConfig(); await loadHistory(); $("ceil").value=state.ceiling; $("floor").value=state.floor; $("cCeil").value=state.cryptoCeiling; $("cFloor").value=state.cryptoFloor; $("cash").value=state.cash; $("minCash").value=state.minCash; buildRows(); animateValue($("dcVal"), compute().total); if(num(state.pricesAsOf)>0){ $("refreshStatus").textContent=asOfLabel(num(state.pricesAsOf)); } booted=true; })();
```

### Acceptance criteria
- Refresh prices, reload the page → cards still show "prev close … · ±x.x% today", and the text next to the refresh button reads `prices as of 2:41 PM` (or `prices as of Jun 10, 2:41 PM` if it was a different day).
- A config that has never seen these fields loads unchanged (`prevClose` 0, no as-of line).
- POSTed configs persist `prevClose` per position (stocks and crypto) and top-level `pricesAsOf`; unknown keys are still stripped.

---

## Task 2 — Day change on the chips

### Problem
The chip grid is the screen looked at daily, but it shows only a static price. Add the day's move beside it, colored like the card version.

### Change — `public/index.html`
In `paintRow`, current:
```js
    const cp=$("cp-"+r.id); if(cp) cp.textContent = num(r.price)>0 ? priceFmt(r.price) : "—";
```
New:
```js
    const cp=$("cp-"+r.id); if(cp){ const pc=num(r.prevClose), ch=(pc>0&&num(r.price)>0)?(num(r.price)-pc)/pc*100:null;
      cp.innerHTML = num(r.price)>0 ? priceFmt(r.price)+(ch!=null&&isFinite(ch)?` <span style="color:${ch>=0?"var(--green)":"var(--danger)"}">${ch>=0?"+":"−"}${Math.abs(ch).toFixed(1)}%</span>`:"") : "—"; }
```
(Note the down sign is the minus glyph `−` (U+2212), matching the existing card code. `priceFmt` output contains no HTML-significant characters, so `innerHTML` is safe here.)

### Acceptance criteria
- After a price refresh, each chip's small line reads e.g. `$212.40 +1.2%` with the change in green (up) or coral (down).
- Positions with no `prevClose` (never refreshed) show just the price, exactly as before.
- With Task 1 in place, the change survives a reload.

---

## Task 3 — One refresh for everything

### Problem
The top "↻ Refresh prices" button updates stocks only; keeping crypto current is a second stop. Make the top button refresh both. The crypto section keeps its local button unchanged.

### Change — `public/index.html`
Current:
```js
$("refreshBtn").addEventListener("click", refreshPrices);
```
New:
```js
$("refreshBtn").addEventListener("click", ()=>{ if(state.positions.length) refreshPrices(); if(state.crypto.length) refreshCrypto(); if(!state.positions.length && !state.crypto.length){ $("refreshStatus").textContent="Add a position first."; $("refreshStatus").style.color="var(--muted2)"; } });
```

### Acceptance criteria
- With both stocks and crypto present, one tap of the top button updates both; each section's status line reports its own result.
- Crypto-only portfolio: the top button updates crypto without printing "Add a position first."
- Empty portfolio: the top button shows "Add a position first." as before.
- The crypto section's own "↻ Update crypto prices" button behaves exactly as before.

---

## Task 4 — Suppress native number-input spinners

### Problem
The styled numeric fields (gold dial inputs, per-position inputs, targets, caps) grow native up/down spinner arrows on hover/focus in Chrome, clashing with the design.

### Change — `public/index.html`
Directly **after** this line in the `<style>` block:
```css
  *{box-sizing:border-box;margin:0;padding:0;}
```
add:
```css
  input[type=number]{appearance:textfield;-moz-appearance:textfield;}
  input[type=number]::-webkit-outer-spin-button,input[type=number]::-webkit-inner-spin-button{-webkit-appearance:none;margin:0;}
```

### Acceptance criteria
- No spinner arrows on any numeric input on hover or focus (Chrome/Edge/Safari/Firefox).
- Typing, `inputmode=decimal` keyboards on mobile, and all input handlers are unaffected.

---

## Task 5 — Legend hover parity for the crypto donut

### Problem
Hovering a legend row dims the other donut slices — but only for the stock donut; the crypto legend has identical markup and no wiring.

### Change — `public/index.html`
Replace this entire block:
```js
const legendEl=$("legend");
legendEl.addEventListener("mouseover", e=>{ const leg=e.target.closest(".leg"); if(!leg) return; const s=leg.dataset.seg;
  document.querySelectorAll("#donut .seg").forEach(g=>g.style.opacity = g.dataset.seg===s?"1":"0.18");
  document.querySelectorAll("#legend .leg").forEach(l=>l.style.opacity = l.dataset.seg===s?"1":"0.4"); });
legendEl.addEventListener("mouseout", e=>{ if(e.target.closest(".leg")){ document.querySelectorAll("#donut .seg").forEach(g=>g.style.opacity=""); document.querySelectorAll("#legend .leg").forEach(l=>l.style.opacity=""); } });
```
with:
```js
function wireLegendHover(legendId, donutId){
  const el=$(legendId); if(!el) return;
  el.addEventListener("mouseover", e=>{ const leg=e.target.closest(".leg"); if(!leg) return; const s=leg.dataset.seg;
    document.querySelectorAll("#"+donutId+" .seg").forEach(g=>g.style.opacity = g.dataset.seg===s?"1":"0.18");
    document.querySelectorAll("#"+legendId+" .leg").forEach(l=>l.style.opacity = l.dataset.seg===s?"1":"0.4"); });
  el.addEventListener("mouseout", e=>{ if(e.target.closest(".leg")){ document.querySelectorAll("#"+donutId+" .seg").forEach(g=>g.style.opacity=""); document.querySelectorAll("#"+legendId+" .leg").forEach(l=>l.style.opacity=""); } });
}
wireLegendHover("legend","donut");
wireLegendHover("cryptoLegend","cryptoDonut");
```

### Acceptance criteria
- Stock legend hover behaves exactly as before.
- Crypto legend hover now highlights/dims the crypto donut the same way.

---

## Task 6 — Two small fixes

### 6a — Footer copy: notifications also cover group caps

Current (in the `<footer>`):
```html
    <span class="em">Notifications</span> ping you only when a holding crosses its ceiling or cash dips below your floor — and your note rides along.<br>
```
New:
```html
    <span class="em">Notifications</span> ping you only when a holding crosses its ceiling, a group crosses its cap, or cash dips below your floor — and your note rides along.<br>
```

### 6b — Exclude the "NEW" placeholder from the bank dropdown

The group-member dropdown already excludes the freshly-added `NEW` placeholder ticker; the bank dropdown doesn't. In `buildBankAdd`, current:
```js
  const opts = state.positions.filter(p=>p.ticker.trim() && !set.has(p.ticker.trim().toUpperCase()));
```
New:
```js
  const opts = state.positions.filter(p=>{ const tk=p.ticker.trim().toUpperCase(); return tk && tk!=="NEW" && !set.has(tk); });
```

### Acceptance criteria
- Footer reads the new sentence verbatim.
- Tap "+ Add position" → "NEW" does not appear in the bank dropdown; rename the ticker → it appears.

---

## Handback checklist

- [ ] Task 1: `prevClose` (per position) and `pricesAsOf` (top-level) persist server-side and client-side; "prices as of …" shows on load after a refresh.
- [ ] Task 2: chips show the colored day change next to the price.
- [ ] Task 3: top refresh button updates stocks and crypto.
- [ ] Task 4: no native spinners on numeric inputs.
- [ ] Task 5: legend hover works on both donuts via `wireLegendHover`.
- [ ] Task 6: footer copy updated verbatim; "NEW" excluded from the bank dropdown.
- [ ] No edits to CHANGELOG / README / .env.example / .gitignore / package.json / docs / assets.
- [ ] No new dependencies.
- [ ] `node --check server.js` clean; client JS eyeballed for balanced braces/quotes.
- [ ] App boots; refresh → reload → day change and as-of line survive.
- [ ] Notes on anything you couldn't apply verbatim.
