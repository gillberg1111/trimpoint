# ENG-002 — Core-and-Tilt Support (v1.3)

**Architect:** Claude · **Engineer:** Deepseek · **Reviewer:** Claude
**Status:** Ready for implementation
**Target:** `server.js`, `public/index.html`

---

## Scope & ground rules

You (Deepseek) are implementing the **code changes only**. Do the following and nothing more:

- Edit **`server.js`** and **`public/index.html`** exactly as specified below.
- Do **not** touch `CHANGELOG.md`, `README.md`, `.env.example`, `.gitignore`, `package.json` version, `docs/`, or any branding/copy outside the exact strings given here. The architect owns all of those.
- Do **not** refactor unrelated code, rename things, reformat untouched lines, or "improve" style. Keep diffs minimal and surgical.
- Match the existing code style: 2-space indent in `server.js`, the terse inline style already used in `public/index.html`, single quotes in JS, no new dependencies (Node built-ins only — this project is intentionally **zero-dependency**).
- If a change can't be made exactly as written because the surrounding code has shifted, **stop and flag it** in your handback notes rather than improvising.

There are **four tasks**, all required. They are ordered low-risk → high-surface. Task 3 (groups) is the bulk of the work.

### Things explicitly NOT in scope (do not implement)

- **Do NOT rename the `floor` field.** It stays `floor` everywhere on disk and in the payload. Task 1 changes its *meaning* (trim-to only), not its name.
- **Do NOT add a guard that blocks a ticker from being both a bank fund and a position.** In this app a bank fund *is* a position that's been nominated — the bank reads its shares/price by looking the ticker up in `positions`. Forbidding the overlap would zero out the bank. (The real referential hygiene we do want is Task 4.)
- **Do NOT touch the crypto pricing path, the auth path, or the history format.** Task 1 will naturally also apply to crypto holdings because they share `computeList` and the position shape — that's intended and fine. Do not branch the shared code to special-case crypto.
- No annual "rebalance day" feature — that's deferred to a later release.

---

## Background (how the data model actually works — read before starting)

- `state.positions` is the one list of stock holdings; each is `{ ticker, shares, price, cost, ceiling, floor, note }`. Crypto holdings (`state.crypto`) use the same shape.
- **The bank is not a separate holding.** `state.banks` is a list of `{ ticker, target }` that *references positions by ticker*. `computeBank()` finds each bank fund's value with `state.positions.find(p => p.ticker === bankTicker)`. A bank fund must therefore exist as a position. Bank funds are ceiling-exempt.
- `computeList(list, cashVal, gC, gF, bankSet)` is shared by both stocks and crypto. It returns per-row `{ weight, isBank, effCeil, effFloor, kind, sellShares, sellVal, ... }`.
- Today `floor` does double duty: it's the trim-to landing **and** it flags "underweight." Task 1 splits those.

---

## Task 1 — Smart bank trim routing (multi-fund banks)

### Problem
When the bank holds more than one fund, a trim suggestion just says "→ your bank funds" — it doesn't say *which* fund. The useful answer is: route the trim to the bank fund that is currently **furthest below its target weight**, so trims keep the core split on target.

Single-fund banks (and multi-fund banks with no targets set) must keep their current behavior exactly.

### 1a — `public/index.html`: add a routing helper

Add this function immediately **after** the existing `bankFix` function (it currently ends at the line `function bankFix(it){ ... }`). Place the new function right below it:

```js
function bankRouteLabel(){
  const { items } = computeBank();
  if(!items.length) return "";
  if(items.length===1) return (items[0].ticker||"").toUpperCase();
  const withTargets = items.filter(i=>i.target>0);
  if(!withTargets.length) return "your bank funds";
  const pick = withTargets.reduce((a,b)=> (b.target-b.within) > (a.target-a.within) ? b : a);
  return (pick.ticker||"").toUpperCase();
}
```

### 1b — `public/index.html`: use it in `render()`

Current (in `render()`):
```js
  const bankLabel = state.banks.length===1 ? (state.banks[0].ticker||"").toUpperCase() : state.banks.length>1 ? "your bank funds" : "";
```
New:
```js
  const bankLabel = bankRouteLabel();
```

### 1c — `server.js`: mirror the routing in notifications

In `checkThresholds`, the bank destination string is currently computed on these two lines:
```js
  const banks = Array.isArray(cfg.banks) && cfg.banks.length ? cfg.banks.map(b => String(b.ticker || '').toUpperCase()).filter(Boolean) : (cfg.bank ? [String(cfg.bank).toUpperCase()] : []);
  const dest = banks.length === 1 ? banks[0] : banks.length > 1 ? 'your bank funds' : '';
```
**Keep the first line unchanged** (`banks` is reused later in the loop). **Replace only the `const dest = …` line** with:
```js
  const bankList = (Array.isArray(cfg.banks) ? cfg.banks : []).map((b) => ({ sym: String(b.ticker || '').toUpperCase(), target: +b.target || 0 })).filter((b) => b.sym);
  let dest = '';
  if (bankList.length === 1) dest = bankList[0].sym;
  else if (bankList.length > 1) {
    const withT = bankList.filter((b) => b.target > 0);
    const bankTotal = bankList.reduce((s, b) => { const v = valued.find((p) => p.sym === b.sym); return s + (v ? v.value : 0); }, 0);
    if (withT.length && bankTotal > 0) {
      const pick = withT.reduce((a, b) => {
        const av = valued.find((p) => p.sym === a.sym), bv = valued.find((p) => p.sym === b.sym);
        return (b.target - (bv ? bv.value / bankTotal * 100 : 0)) > (a.target - (av ? av.value / bankTotal * 100 : 0)) ? b : a;
      });
      dest = pick.sym;
    } else dest = 'your bank funds';
  } else if (cfg.bank) dest = String(cfg.bank).toUpperCase();
```

### Acceptance criteria
- A single-fund bank shows trims routing to that fund's ticker (unchanged).
- A two-fund bank `VTI 75 / VXUS 25` where VXUS is below its target routes trims "→ VXUS"; if VTI is the one below target, "→ VTI".
- A multi-fund bank with **no** targets set still shows "→ your bank funds".
- No bank → no `→ …` suffix (unchanged).
- The notification email/webhook names the same fund the UI does.

---

## Task 2 — Decouple "underweight" from the trim-to floor

### Problem
`floor` is overloaded. A per-position floor is the trim landing **and** silently arms an "underweight" warning. That makes capped tilt positions (e.g. a 6%-ceiling holding with a 5% trim-to) read as "underweight" whenever they sit small — nudging buys the plan forbids. We split the two responsibilities:

- **`floor`** → trim-to landing **only**. No more underweight side effect.
- **`underweightAlert`** → a new **optional**, per-position threshold that is the *sole* trigger for the underweight flag. **Default off** (absent/`0`).

This is backward-compatible: existing configs have no `underweightAlert`, so every holding simply loads with the underweight flag **off**, keeping its `floor` as the trim-to landing. We do **not** auto-copy `floor → underweightAlert` (that would resurrect the exact nag we're removing).

### 2a — `public/index.html`: gate the underweight flag on the new field

In `computeList`, current:
```js
    else if(num(p.floor)>0 && weight>0 && weight<num(p.floor)){ kind="under"; }
```
New:
```js
    else if(num(p.underweightAlert)>0 && weight>0 && weight<num(p.underweightAlert)){ kind="under"; }
```

### 2b — `public/index.html`: carry the alert value on the row

In `computeList`, the row is returned with:
```js
    return { ...p, weight, isBank, mult, effCeil, effFloor, kind, sellShares, sellVal, landWeight, house };
```
New (add `uwAlert`):
```js
    return { ...p, weight, isBank, mult, effCeil, effFloor, uwAlert:num(p.underweightAlert), kind, sellShares, sellVal, landWeight, house };
```

### 2c — `public/index.html`: fix the underweight message

In `paintRow`, current:
```js
  else if(r.kind==="under") html=`<div class="status under"><span class="dot"></span>Underweight <span class="near">· ${(r.effFloor-r.weight).toFixed(1)} pts below your ${r.effFloor}% floor</span></div>`;
```
New (reference the alert threshold, not the floor):
```js
  else if(r.kind==="under") html=`<div class="status under"><span class="dot"></span>Underweight <span class="near">· ${(r.uwAlert-r.weight).toFixed(1)} pts under your ${r.uwAlert}% alert</span></div>`;
```

### 2d — `public/index.html`: add the input field + relabel the override

In `buildCardsInto`, the advanced block currently reads:
```js
        <div class="inputs" style="grid-template-columns:1fr 1fr;"><div class="g"><label>Ceiling % override</label><input data-id="${p.id}" data-f="ceiling" type="number" inputmode="decimal" value="${p.ceiling||''}" placeholder="${gC}"></div>
        <div class="g"><label>Floor % override</label><input data-id="${p.id}" data-f="floor" type="number" inputmode="decimal" value="${p.floor||''}" placeholder="${gF}"></div></div>
        <div class="g" style="margin-top:8px;"><label>Note — why this ceiling</label><input data-id="${p.id}" data-f="note" type="text" value="${esc(p.note)}" placeholder="e.g. lock gains for house fund"></div>
```
New (rename the second label to "Trim-to % override", and add a full-width underweight-alert field above the note):
```js
        <div class="inputs" style="grid-template-columns:1fr 1fr;"><div class="g"><label>Ceiling % override</label><input data-id="${p.id}" data-f="ceiling" type="number" inputmode="decimal" value="${p.ceiling||''}" placeholder="${gC}"></div>
        <div class="g"><label>Trim-to % override</label><input data-id="${p.id}" data-f="floor" type="number" inputmode="decimal" value="${p.floor||''}" placeholder="${gF}"></div></div>
        <div class="g" style="margin-top:8px;"><label>Underweight alert % — optional</label><input data-id="${p.id}" data-f="underweightAlert" type="number" inputmode="decimal" value="${p.underweightAlert||''}" placeholder="off"></div>
        <div class="g" style="margin-top:8px;"><label>Note — why this ceiling</label><input data-id="${p.id}" data-f="note" type="text" value="${esc(p.note)}" placeholder="e.g. lock gains for house fund"></div>
```
(The existing `input` handler keys off `data-f`, so `data-f="underweightAlert"` is picked up automatically — no listener change needed for this field.)

### 2e — `public/index.html`: round-trip the new field

In `loadConfig`, current `mapPos`:
```js
  const mapPos = p => ({ id:nextId++, ticker:p.ticker||"", shares:p.shares||0, price:p.price||0, cost:p.cost||0, ceiling:p.ceiling||"", floor:p.floor||"", note:p.note||"" });
```
New:
```js
  const mapPos = p => ({ id:nextId++, ticker:p.ticker||"", shares:p.shares||0, price:p.price||0, cost:p.cost||0, ceiling:p.ceiling||"", floor:p.floor||"", underweightAlert:p.underweightAlert||"", note:p.note||"" });
```

In `saveConfig`, current `mapPos`:
```js
    const mapPos = p => ({ ticker:(p.ticker||"").toUpperCase(), shares:num(p.shares), price:num(p.price), cost:num(p.cost), ceiling:num(p.ceiling)||0, floor:num(p.floor)||0, note:(p.note||"").trim() });
```
New:
```js
    const mapPos = p => ({ ticker:(p.ticker||"").toUpperCase(), shares:num(p.shares), price:num(p.price), cost:num(p.cost), ceiling:num(p.ceiling)||0, floor:num(p.floor)||0, underweightAlert:num(p.underweightAlert)||0, note:(p.note||"").trim() });
```

In the **two** "add" buttons at the bottom, current:
```js
$("addBtn").addEventListener("click", ()=>{ const id=nextId++; state.positions.push({id, ticker:"NEW", shares:0, price:0, cost:0, ceiling:"", floor:"", note:""}); openIds.add(id); justOpened=id; buildRows(); saveConfig(); });
$("addCryptoBtn").addEventListener("click", ()=>{ const id=nextId++; state.crypto.push({id, ticker:"NEW", shares:0, price:0, cost:0, ceiling:"", floor:"", note:""}); openIds.add(id); justOpened=id; buildRows(); saveConfig(); });
```
New (add `underweightAlert:""` to both pushed objects):
```js
$("addBtn").addEventListener("click", ()=>{ const id=nextId++; state.positions.push({id, ticker:"NEW", shares:0, price:0, cost:0, ceiling:"", floor:"", underweightAlert:"", note:""}); openIds.add(id); justOpened=id; buildRows(); saveConfig(); });
$("addCryptoBtn").addEventListener("click", ()=>{ const id=nextId++; state.crypto.push({id, ticker:"NEW", shares:0, price:0, cost:0, ceiling:"", floor:"", underweightAlert:"", note:""}); openIds.add(id); justOpened=id; buildRows(); saveConfig(); });
```

### 2f — `public/index.html`: fix the now-stale hint copy

Current (the default-limits hint):
```html
  <div class="hint">Ceiling = the weight that triggers a trim; floor = where the trim lands. Each position can override either — and a per-position floor also flags the holding "underweight" if it dips below. Changes sync across your devices.</div>
```
New (exact string — copy owned by architect, apply verbatim):
```html
  <div class="hint">Ceiling = the weight that triggers a trim; floor = where the trim lands. Each position can override either, and optionally set an underweight alert to flag when it dips below a level you choose. Changes sync across your devices.</div>
```

### 2g — `server.js`: accept the field in the sanitizer

In `sanitizeConfig`, the per-position mapper `pos` is currently:
```js
  const pos = (p) => ({
    ticker: String(p?.ticker ?? '').toUpperCase().slice(0, 12),
    shares: +p?.shares || 0, price: +p?.price || 0, cost: +p?.cost || 0,
    ceiling: +p?.ceiling || 0, floor: +p?.floor || 0, note: String(p?.note ?? '').slice(0, 200),
  });
```
New (add `underweightAlert`):
```js
  const pos = (p) => ({
    ticker: String(p?.ticker ?? '').toUpperCase().slice(0, 12),
    shares: +p?.shares || 0, price: +p?.price || 0, cost: +p?.cost || 0,
    ceiling: +p?.ceiling || 0, floor: +p?.floor || 0, underweightAlert: +p?.underweightAlert || 0,
    note: String(p?.note ?? '').slice(0, 200),
  });
```

### Acceptance criteria
- A position with a `floor` (trim-to) set but **no** `underweightAlert` never shows the "underweight" status — even when its weight is well below the floor.
- A position with `underweightAlert` set shows "underweight" only when its weight drops below that value, and the message reads `… pts under your X% alert`.
- The trim landing (`floor`/trim-to) behavior is unchanged: an over-ceiling position still trims down toward its floor.
- Existing saved configs load without error; their positions keep their `floor` as trim-to and have the underweight flag off.
- Saving round-trips `underweightAlert` to `config.json` and back. The sanitizer drops it for unknown shapes safely (coerces to `0`).
- This applies identically to crypto holdings (shared code) — expected, not a bug.

---

## Task 3 — Position groups with a combined ceiling

### Goal
A **group** is `{ name, members:[tickers], ceiling }`. When the members' combined weight (against the stock account total) exceeds the group's ceiling, flag the group and suggest trimming its most-overweight member — down to that member's trim-to, or by the breach amount if smaller — routed to the bank. Individual position ceilings still apply independently. The status banner treats a group breach like a position breach.

New config field: `groups: []` (array). Members reference **stock positions** by ticker. Bank funds are excluded from group math (they're ceiling-exempt and are where trims land — trimming one to satisfy a group cap is contradictory).

### 3a — `server.js`: default + sanitizer

In `DEFAULTS`, current:
```js
const DEFAULTS = { ceiling: 25, floor: 20, bank: '', banks: [], cash: 0, minCash: 0, positions: [], crypto: [], cryptoCeiling: 40, cryptoFloor: 30 };
```
New (add `groups: []`):
```js
const DEFAULTS = { ceiling: 25, floor: 20, bank: '', banks: [], cash: 0, minCash: 0, positions: [], crypto: [], cryptoCeiling: 40, cryptoFloor: 30, groups: [] };
```

In `sanitizeConfig`'s returned object, add a `groups` entry (put it right after the `crypto:` line, before the closing `}`):
```js
    crypto: arr(o.crypto).map(pos),
    groups: arr(o.groups).map((g) => ({
      name: String(g?.name ?? '').slice(0, 40),
      members: arr(g?.members).map((t) => String(t ?? '').toUpperCase().slice(0, 12)).filter(Boolean),
      ceiling: +g?.ceiling || 0,
    })).filter((g) => g.members.length),
```

### 3b — `server.js`: notify on a group breach

In `checkThresholds`, after the per-position `for (const p of valued) { … }` loop and **before** the `if (+cfg.minCash > 0) { … }` cash block, insert:
```js
  for (const g of (Array.isArray(cfg.groups) ? cfg.groups : [])) {
    const members = (Array.isArray(g.members) ? g.members : []).map((t) => String(t || '').toUpperCase()).filter(Boolean);
    if (!members.length || !(+g.ceiling > 0)) continue;
    const rows = valued.filter((p) => members.includes(p.sym) && !banks.includes(p.sym));
    if (!rows.length) continue;
    const gpct = rows.reduce((s, p) => s + p.value, 0) / total * 100;
    const key = 'grp:' + (g.name || members.join('+'));
    if (gpct > +g.ceiling && !flagged.has(key)) {
      flagged.add(key);
      const top = rows.reduce((a, b) => (b.value > a.value ? b : a));
      let body = `${g.name || 'Group'} is ${gpct.toFixed(1)}% of the account, over your ${g.ceiling}% cap. Your plan: trim ${top.sym}${dest ? ` into ${dest}` : ''}.`;
      await notify(`${g.name || 'Group'} crossed its ${g.ceiling}% cap`, body);
    } else if (gpct <= +g.ceiling) flagged.delete(key);
  }
```
(`banks`, `dest`, and `total` are already in scope here.)

### 3c — `public/index.html`: state + load + save

In **both** the top-level `state` initializer and the `loadConfig` default object, add `groups:[]`.

Current `state`:
```js
let state = { ceiling:25, floor:20, bank:"", banks:[], cash:0, minCash:0, positions:[], crypto:[], cryptoCeiling:40, cryptoFloor:30 };
```
New:
```js
let state = { ceiling:25, floor:20, bank:"", banks:[], cash:0, minCash:0, positions:[], crypto:[], cryptoCeiling:40, cryptoFloor:30, groups:[] };
```

Current `loadConfig` default object:
```js
  try{ const r = await fetch('/api/config'); if(r.status===401){ location.href='/login'; return; } if(r.ok) state = { ceiling:25, floor:20, bank:"", banks:[], cash:0, minCash:0, positions:[], crypto:[], cryptoCeiling:40, cryptoFloor:30, ...(await r.json()) }; }catch(e){}
```
New:
```js
  try{ const r = await fetch('/api/config'); if(r.status===401){ location.href='/login'; return; } if(r.ok) state = { ceiling:25, floor:20, bank:"", banks:[], cash:0, minCash:0, positions:[], crypto:[], cryptoCeiling:40, cryptoFloor:30, groups:[], ...(await r.json()) }; }catch(e){}
```

In `loadConfig`, after the existing `state.banks = …` normalization block (the two lines ending in `: (state.bank ? [{ ticker:String(state.bank).toUpperCase(), target:"" }] : []);`), add:
```js
  state.groups = (Array.isArray(state.groups)?state.groups:[]).map(g=>({ name:g.name||"", members:(Array.isArray(g.members)?g.members:[]).map(t=>(t||"").toUpperCase()), ceiling:g.ceiling||"" }));
```

In `saveConfig`, current `banks`/`payload` block:
```js
    const banks = state.banks.map(b=>({ ticker:(b.ticker||"").toUpperCase(), target:num(b.target)||0 })).filter(b=>b.ticker);
    const payload = { ceiling:num(state.ceiling), floor:num(state.floor), bank:banks[0]?banks[0].ticker:"", banks, cash:num(state.cash), minCash:num(state.minCash), cryptoCeiling:num(state.cryptoCeiling), cryptoFloor:num(state.cryptoFloor),
      positions: state.positions.map(mapPos), crypto: state.crypto.map(mapPos) };
```
New (build `groups` and add it to the payload):
```js
    const banks = state.banks.map(b=>({ ticker:(b.ticker||"").toUpperCase(), target:num(b.target)||0 })).filter(b=>b.ticker);
    const groups = state.groups.map(g=>({ name:(g.name||"").trim().slice(0,40), members:(g.members||[]).map(t=>(t||"").toUpperCase()).filter(Boolean), ceiling:num(g.ceiling)||0 })).filter(g=>g.members.length);
    const payload = { ceiling:num(state.ceiling), floor:num(state.floor), bank:banks[0]?banks[0].ticker:"", banks, cash:num(state.cash), minCash:num(state.minCash), cryptoCeiling:num(state.cryptoCeiling), cryptoFloor:num(state.cryptoFloor),
      positions: state.positions.map(mapPos), crypto: state.crypto.map(mapPos), groups };
```

### 3d — `public/index.html`: compute group state

Add these two functions immediately **after** the existing `function computeCrypto(){ … }` block:
```js
function computeGroups(stock){
  const bset = bankSet();
  return state.groups.map(g=>{
    const members = (g.members||[]).map(t=>(t||"").trim().toUpperCase()).filter(Boolean);
    const rows = stock.rows.filter(r=>members.includes(r.ticker.trim().toUpperCase()) && !bset.has(r.ticker.trim().toUpperCase()));
    const weight = rows.reduce((s,r)=>s+r.weight,0);
    const ceiling = num(g.ceiling);
    const over = ceiling>0 && weight>ceiling+1e-4;
    let pick=null, trimVal=0, trimShares=0;
    if(over && rows.length){
      pick = rows.reduce((a,b)=> b.weight>a.weight ? b : a);
      const breachVal = (weight-ceiling)/100*stock.total;
      const toTrimToVal = pick.mv - (pick.effFloor/100)*stock.total;
      trimVal = toTrimToVal>0 ? Math.min(breachVal, toTrimToVal) : breachVal;
      trimShares = num(pick.price)>0 ? Math.max(1, Math.round(trimVal/num(pick.price))) : 0;
    }
    return { name:(g.name||"").trim()||"Group", members, weight, ceiling, over, pick, trimVal, trimShares };
  });
}
function groupStatusText(gc, dest){
  if(!(gc.ceiling>0)) return `${gc.weight.toFixed(1)}% combined — set a cap %`;
  if(!gc.over) return `${gc.weight.toFixed(1)}% of your ${gc.ceiling}% cap`;
  const trim = gc.pick ? ` · trim ~${money0(gc.trimVal)}${gc.trimShares?` (≈ ${gc.trimShares} sh)`:''} from ${gc.pick.ticker.trim().toUpperCase()}${dest?` → ${dest}`:''}` : '';
  return `▲ ${gc.weight.toFixed(1)}% — over your ${gc.ceiling}% cap${trim}`;
}
```

### 3e — `public/index.html`: extract the banner, then teach it about groups

The banner is currently built inline in `render()`. Replace that inline block with a call to a new `renderBanner()` function so both `render()` and the live group-edit handler can refresh it.

Current block in `render()`:
```js
  const over = stock.overCount + crypto.overCount;
  const b = $("banner");
  if(!state.positions.length && !state.crypto.length){ b.className="banner"; b.innerHTML=`<span class="mark" style="color:var(--muted2)">·</span><div class="btxt">Add your positions below to start tracking.</div>`; }
  else {
    const parts=[];
    if(over) parts.push(`${over} position${over>1?"s":""} over your ceiling`);
    if(stock.cashLow) parts.push(`cash below your ${stock.minCash}% floor`);
    if(parts.length){ b.className="banner act"; b.innerHTML=`<span class="mark">▲</span><div class="btxt">${parts.join(" · ")} — check your plan.</div>`; }
    else { b.className="banner clear"; b.innerHTML=`<span class="mark">✓</span><div class="btxt">Everything's within your limits. Nothing to do.</div>`; }
  }
```
New (replace the whole block above with this single call):
```js
  renderBanner();
```
Then add the `renderBanner` function. Put it directly **above** `function render(){`:
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

### 3f — `public/index.html`: render the groups panel

In `render()`, the bank panel is rendered by the line `renderBank();`. Add a groups render right after it:

Current:
```js
  renderBank();
```
New:
```js
  renderBank();
  renderGroups();
```

Then add the two render functions. Place them directly **after** the existing `updateBankColors` function:
```js
function renderGroups(){
  const host=$("groupRows"); if(!host) return;
  const stock=compute(), gs=computeGroups(stock), dest=bankRouteLabel(), bset=bankSet();
  host.innerHTML = state.groups.map((g,idx)=>{
    const gc=gs[idx];
    const memChips=(g.members||[]).map((t,mi)=>`<span class="grp-mem">${esc((t||"").toUpperCase())}<button data-grpmemrm="${idx}:${mi}" title="remove">×</button></span>`).join('');
    const opts=state.positions.filter(p=>{ const tk=p.ticker.trim().toUpperCase(); return tk && tk!=="NEW" && !(g.members||[]).map(x=>(x||"").toUpperCase()).includes(tk) && !bset.has(tk); });
    const addSel=opts.length?`<select class="grp-memadd" data-grpmemadd="${idx}"><option value="">+ add holding</option>${opts.map(p=>{const t=esc(p.ticker.trim().toUpperCase());return `<option value="${t}">${t}</option>`;}).join('')}</select>`:'';
    return `<div class="group-item ${gc.over?'over':''}">
      <div class="grp-top"><input class="grp-name" data-grpname="${idx}" value="${esc(g.name||'')}" placeholder="Group name" maxlength="40"><label class="grp-cap">cap <input data-grpcap="${idx}" type="number" inputmode="decimal" value="${g.ceiling||''}">%</label><button class="grp-rm" data-grprm="${idx}" title="remove group">×</button></div>
      <div class="grp-members">${memChips||'<span style="font-size:12px;color:var(--muted2)">no holdings yet</span>'} ${addSel}</div>
      <div class="grp-status">${groupStatusText(gc, dest)}</div>
    </div>`;
  }).join('');
}
function updateGroups(){
  const stock=compute(), gs=computeGroups(stock), dest=bankRouteLabel();
  document.querySelectorAll('#groupRows .group-item').forEach((el,idx)=>{
    const gc=gs[idx]; if(!gc) return;
    el.classList.toggle('over', gc.over);
    const st=el.querySelector('.grp-status'); if(st) st.innerHTML=groupStatusText(gc, dest);
  });
  renderBanner();
}
```

### 3g — `public/index.html`: the panel markup

Insert this block immediately **after** the bank panel's hint line and **before** the `<hr class="rule">` that precedes the Positions panel.

Current:
```html
  <div class="hint" id="bankHint">Pick the holding your trims flow into. Add a second fund to track a target split — e.g. a three-fund 80 / 10 / 10.</div>

  <hr class="rule">
  <div class="panel-label">Positions <span class="ph-hint">tap a holding to expand</span></div>
```
New (insert the Groups panel between them):
```html
  <div class="hint" id="bankHint">Pick the holding your trims flow into. Add a second fund to track a target split — e.g. a three-fund 80 / 10 / 10.</div>

  <div class="panel-label">Groups — a shared ceiling across several positions</div>
  <div id="groupRows"></div>
  <button class="bank-add" id="groupAdd" type="button">+ Add a group</button>
  <div class="hint">Cap a basket of holdings together — e.g. a "Tech tilt" of AAPL / MSFT / NVDA at a combined 15%. Each position still keeps its own ceiling; the group adds a limit on their total. Bank funds can't be grouped.</div>

  <hr class="rule">
  <div class="panel-label">Positions <span class="ph-hint">tap a holding to expand</span></div>
```

### 3h — `public/index.html`: CSS for the groups panel

Add this block immediately **after** the line `.bank-item.under-off{ … }` (line just before the `.hint{…}` rule in the `<style>` block):
```css
  #groupRows{display:flex;flex-direction:column;gap:8px;margin-bottom:10px;}
  .group-item{display:flex;flex-direction:column;gap:8px;background:var(--card);border:1px solid var(--line);border-left:3px solid var(--gold-dim);border-radius:11px;padding:11px 13px;}
  .group-item.over{border-left-color:var(--gold);}
  .grp-top{display:flex;align-items:center;gap:8px;}
  .grp-top input.grp-name{flex:1;min-width:0;background:transparent;border:0;border-bottom:1px solid var(--line);color:var(--ink);font-family:'Hanken Grotesk',sans-serif;font-weight:600;font-size:14px;padding:3px 2px;outline:none;}
  .grp-top input.grp-name:focus{border-bottom-color:var(--gold-dim);}
  .grp-cap{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--muted);flex:0 0 auto;}
  .grp-cap input{width:52px;background:var(--bg);border:1px solid var(--line);color:var(--ink);font-family:'IBM Plex Mono',monospace;font-size:13px;border-radius:7px;padding:5px 7px;text-align:right;outline:none;}
  .grp-rm{background:transparent;border:0;color:var(--muted2);font-size:16px;cursor:pointer;padding:0 2px;line-height:1;flex:0 0 auto;} .grp-rm:hover{color:var(--danger);}
  .grp-members{display:flex;flex-wrap:wrap;gap:6px;align-items:center;}
  .grp-mem{display:inline-flex;align-items:center;gap:5px;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:4px 8px;font-family:'IBM Plex Mono',monospace;font-size:12.5px;color:var(--ink);}
  .grp-mem button{background:transparent;border:0;color:var(--muted2);cursor:pointer;font-size:14px;line-height:1;padding:0;} .grp-mem button:hover{color:var(--danger);}
  .grp-memadd{background:transparent;border:1px dashed var(--line);color:var(--muted);font-family:'Hanken Grotesk',sans-serif;font-size:12px;border-radius:8px;padding:5px 8px;outline:none;cursor:pointer;}
  .grp-memadd:hover{border-color:var(--gold-dim);color:var(--gold);}
  .grp-status{font-size:12px;line-height:1.4;color:var(--muted);} .group-item.over .grp-status{color:var(--gold);}
```

### 3i — `public/index.html`: wire up the events

**Add to the `input` listener.** Current tail of the `document.addEventListener("input", …)` handler:
```js
  else if(t.id==="cash"){ state.cash=t.value; render(); }
  else if(t.id==="minCash"){ state.minCash=t.value; render(); }
});
```
New (insert the two group branches before the cash branch — group name/cap must NOT call `render()`, which would rebuild the panel and drop input focus; use the in-place `updateGroups` instead, mirroring how bank targets use `updateBankColors`):
```js
  else if(t.dataset && t.dataset.grpname!==undefined){ const i=+t.dataset.grpname; if(state.groups[i]) state.groups[i].name=t.value; }
  else if(t.dataset && t.dataset.grpcap!==undefined){ const i=+t.dataset.grpcap; if(state.groups[i]) state.groups[i].ceiling=t.value; updateGroups(); }
  else if(t.id==="cash"){ state.cash=t.value; render(); }
  else if(t.id==="minCash"){ state.minCash=t.value; render(); }
});
```

**Add to the `change` listener.** Current:
```js
document.addEventListener("change", e=>{
  if(e.target.id==="bankAdd" && e.target.value){ const tk=e.target.value.toUpperCase(); if(!bankSet().has(tk)){ state.banks.push({ ticker:tk, target:"" }); render(); } e.target.value=""; }
  if(e.target.dataset && e.target.dataset.f==="ticker") buildBankAdd();
  saveConfig();
});
```
New (add a member-add branch; the existing `saveConfig()` at the end still fires):
```js
document.addEventListener("change", e=>{
  if(e.target.id==="bankAdd" && e.target.value){ const tk=e.target.value.toUpperCase(); if(!bankSet().has(tk)){ state.banks.push({ ticker:tk, target:"" }); render(); } e.target.value=""; }
  if(e.target.dataset && e.target.dataset.grpmemadd!==undefined && e.target.value){ const i=+e.target.dataset.grpmemadd, tk=e.target.value.toUpperCase(); if(state.groups[i] && !(state.groups[i].members||[]).includes(tk)){ (state.groups[i].members=state.groups[i].members||[]).push(tk); render(); } e.target.value=""; }
  if(e.target.dataset && e.target.dataset.f==="ticker") buildBankAdd();
  saveConfig();
});
```

**Add to the `click` listener.** Current:
```js
  else if(bankrm){ state.banks.splice(+bankrm.dataset.bankrm,1); render(); saveConfig(); }
  else if(rm){ const id=rm.dataset.rm; state.positions=state.positions.filter(p=>p.id!=id); state.crypto=state.crypto.filter(p=>p.id!=id); openIds.delete(+id); buildRows(); saveConfig(); }
```
New (add group-remove and member-remove branches; declare the two new closest-matches alongside the existing ones at the top of the handler):

First, in the variable declarations at the top of the `click` handler, current:
```js
  const bankrm=t.closest&&t.closest("[data-bankrm]");
```
New:
```js
  const bankrm=t.closest&&t.closest("[data-bankrm]");
  const grprm=t.closest&&t.closest("[data-grprm]");
  const grpmemrm=t.closest&&t.closest("[data-grpmemrm]");
```
Then add these two branches right after the `else if(bankrm){ … }` branch:
```js
  else if(grprm){ state.groups.splice(+grprm.dataset.grprm,1); render(); saveConfig(); }
  else if(grpmemrm){ const [gi,mi]=grpmemrm.dataset.grpmemrm.split(":").map(Number); if(state.groups[gi]) state.groups[gi].members.splice(mi,1); render(); saveConfig(); }
```

**Add the "+ Add a group" button handler.** Next to the existing `$("addBtn")` / `$("addCryptoBtn")` handlers, add:
```js
$("groupAdd").addEventListener("click", ()=>{ state.groups.push({ name:"", members:[], ceiling:"" }); render(); saveConfig(); });
```

### Acceptance criteria
- "+ Add a group" creates an editable group card with a name, a cap %, an empty member list, and an "+ add holding" dropdown listing only non-bank positions not already in the group.
- Adding members and a cap updates the group's status line live: under cap shows `X% of your N% cap`; over cap turns gold and shows `▲ X% — over your N% cap · trim ~$… (≈ … sh) from TICKER → BANK`.
- A group breach adds `N groups over cap` to the top banner; clearing it returns the banner to green when nothing else is wrong.
- Typing in the group **name** or **cap** does not steal focus (no full re-render on keystroke).
- Removing a member, removing a group, and adding a group all persist.
- Group math excludes any member that is also a bank fund.
- `groups` round-trips through `config.json`; the server sanitizer drops groups with no members and caps name/ticker lengths.
- With notifications on, a group crossing its cap sends one notification naming the member to trim and the bank destination, and re-arms only after it drops back under the cap.

---

## Task 4 — Keep bank & groups referentially clean when a position is removed

### Problem
Bank funds and group members reference positions **by ticker**. Today, deleting a position leaves a dangling bank entry (shows 0%) or a phantom group member. Clean those references up on delete. (This is also the practical form of the "a bank fund must be a real position" invariant — the add path already only offers existing positions via the dropdown, so the gap is on delete.)

### Change — `public/index.html`
In the `click` handler's position-remove branch, current:
```js
  else if(rm){ const id=rm.dataset.rm; state.positions=state.positions.filter(p=>p.id!=id); state.crypto=state.crypto.filter(p=>p.id!=id); openIds.delete(+id); buildRows(); saveConfig(); }
```
New (capture the removed ticker, then prune it from `banks` and every group's `members`):
```js
  else if(rm){ const id=rm.dataset.rm; const gone=(state.positions.find(p=>p.id==id)||{}).ticker; const tk=(gone||"").trim().toUpperCase();
    state.positions=state.positions.filter(p=>p.id!=id); state.crypto=state.crypto.filter(p=>p.id!=id); openIds.delete(+id);
    if(tk){ state.banks=state.banks.filter(b=>(b.ticker||"").trim().toUpperCase()!==tk); state.groups.forEach(g=>{ g.members=(g.members||[]).filter(m=>(m||"").trim().toUpperCase()!==tk); }); }
    buildRows(); saveConfig(); }
```

### Acceptance criteria
- Deleting a position that is also a bank fund removes it from the bank panel (no 0% ghost row).
- Deleting a position that is a group member removes it from that group.
- Deleting an ordinary position is unaffected.

---

## Handback checklist (fill this in when you return the work)

- [ ] **Task 1 — bank routing:** `bankRouteLabel()` added; `render()` uses it; `server.js` `dest` computes the furthest-below-target fund; single-fund and no-target cases unchanged.
- [ ] **Task 2 — floor decoupling:** underweight gated on `underweightAlert`; `uwAlert` on the row; message reads "under your X% alert"; card has the new field; "Floor % override" relabeled "Trim-to % override"; `loadConfig`/`saveConfig`/both add-buttons/`sanitizeConfig` carry `underweightAlert`; hint copy updated verbatim.
- [ ] **Task 3 — groups:** `DEFAULTS` + `sanitizeConfig` + `checkThresholds` (server); `state`/`loadConfig`/`saveConfig`, `computeGroups`/`groupStatusText`, `renderBanner` extraction, `renderGroups`/`updateGroups`, panel markup, CSS, and all input/change/click wiring + `groupAdd` handler (client).
- [ ] **Task 4 — referential cleanup:** position delete prunes `banks` and group `members`.
- [ ] Did **not** rename `floor`; did **not** add a bank/position overlap guard; did **not** touch crypto pricing, auth, or history format.
- [ ] No edits to CHANGELOG / README / .env.example / .gitignore / package.json / docs / assets.
- [ ] No new dependencies; `package.json` unchanged.
- [ ] `node --check server.js` is clean. (`public/index.html` has no separate check — eyeball the JS for balanced braces/quotes.)
- [ ] App boots (`DATA_DIR=./data FINNHUB_KEY=test npm start`), config saves/loads, an existing pre-1.3 `config.json` loads without error.
- [ ] Notes on anything you couldn't apply verbatim.
