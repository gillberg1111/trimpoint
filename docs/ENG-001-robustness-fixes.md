# ENG-001 — Robustness & Correctness Fixes

**Architect:** Claude · **Engineer:** Deepseek · **Reviewer:** Claude
**Status:** Ready for implementation
**Target:** `server.js`, `public/index.html`

---

## Scope & ground rules

You (Deepseek) are implementing the **code changes only**. Do the following and nothing more:

- Edit **`server.js`** and **`public/index.html`** exactly as specified below.
- Do **not** touch `CHANGELOG.md`, `README.md`, `.env.example`, `.gitignore`, `package.json` version, or any docs/branding. The architect owns all of those.
- Do **not** refactor unrelated code, rename things, reformat untouched lines, or "improve" style. Keep diffs minimal and surgical.
- Match the existing code style: 2-space indent, single quotes, terse one-line helpers, no new dependencies (Node built-ins only — this project is intentionally zero-dependency).
- If a change can't be made exactly as written because the surrounding code has shifted, stop and flag it in your handback notes rather than improvising.

There are **six tasks**. Tasks 1 and 2 are required (correctness/data-safety). Tasks 3–6 are smaller. Do all six.

---

## Task 1 — Atomic writes for `config.json` and `history.json` (REQUIRED)

### Problem
`writeConfig` and `snapshot` call `writeFile(path, …)` directly. If the process is killed mid-write, or two writes overlap, the file is left truncated/corrupt. `readConfig` then catches the JSON parse error and **silently returns `DEFAULTS`**, which presents as an empty portfolio — and the next save overwrites the corrupt file permanently. This is a real data-loss path. Same exposure for `history.json`.

### Fix
Write to a sibling temp file, then atomically `rename` it over the target. `rename` is atomic on a POSIX filesystem when source and destination are in the same directory (they are — both live in `DATA_DIR`).

### Changes in `server.js`

**1a.** Add `rename` to the `node:fs/promises` import.

Current:
```js
import { readFile, writeFile, mkdir } from 'node:fs/promises';
```
New:
```js
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
```

**1b.** Add a small shared helper for atomic writes. Place it directly **above** `readConfig` (i.e. just under the `// ---- config store ----` comment, before `const readConfig`):

```js
// write-to-temp then rename, so a crash mid-write can't truncate the real file
const atomicWrite = async (file, data) => {
  await mkdir(DATA_DIR, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, file);
};
```

**1c.** Rewrite `writeConfig` to use it:

Current:
```js
const writeConfig = async (cfg) => {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2));
};
```
New:
```js
const writeConfig = async (cfg) => {
  await atomicWrite(CONFIG_FILE, JSON.stringify(cfg, null, 2));
};
```

**1d.** Update the history write in `snapshot`. The last two lines of `snapshot` are currently:
```js
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(HISTORY_FILE, JSON.stringify(hist.slice(-HIST_DAYS)));
```
Replace **both** of those lines with the single call:
```js
  await atomicWrite(HISTORY_FILE, JSON.stringify(hist.slice(-HIST_DAYS)));
```

### Acceptance criteria
- `config.json` and `history.json` are only ever replaced via temp-file + `rename`.
- No direct `writeFile` to either of those two files remains.
- `mkdir` is still guaranteed before each write (it now lives inside `atomicWrite`).
- App still starts and saves config normally.

---

## Task 2 — Don't 500 on a non-string login password (REQUIRED)

### Problem
`sha(s)` does `crypto.createHash('sha256').update(s || '')`. If a client POSTs `{"password": 123}` (a number, or any non-string), `.update()` throws a `TypeError`, which bubbles to the outer request handler and returns HTTP **500** instead of a clean 401. Minor, but it's an unhandled type error on an unauthenticated endpoint.

### Fix
Coerce to string inside `sha`.

### Change in `server.js`

Current:
```js
const sha = (s) => crypto.createHash('sha256').update(s || '').digest();
```
New:
```js
const sha = (s) => crypto.createHash('sha256').update(String(s ?? '')).digest();
```

### Acceptance criteria
- `POST /api/login` with body `{"password": 123}`, `{"password": null}`, `{"password": {}}`, or `{}` returns a normal `401 {error:'wrong password'}` (assuming the wrong/empty password), never a 500.
- Correct-password login still succeeds and sets the cookie.
- Constant-time comparison behaviour is unchanged (both sides still go through `sha`).

---

## Task 3 — Render the crypto "% today" line (MINOR)

### Problem
The server already computes a previous-close (`pc`) for each coin in `cryptoQuotes`, and the crypto cards include an empty `pc-<id>` slot (they reuse `buildCardsInto`). But:
1. `refreshCrypto` never stores the returned `pc` onto the coin, and
2. `render()` only fills the `pc-<id>` element for `state.positions`, never `state.crypto`.

So the day-change line is permanently blank for coins.

### Fix — two edits in `public/index.html`

**3a.** In `refreshCrypto`, store `prevClose` alongside `price`, mirroring how `refreshPrices` does it for stocks.

Current (inside the `state.crypto.forEach(...)` line in `refreshCrypto`):
```js
state.crypto.forEach(p=>{ const t=(p.ticker||"").trim().toUpperCase(); if(t in prices){ const q=prices[t]; if(q&&q.c!=null){ p.price=Number(q.c); updated++; } else missed++; } });
```
New:
```js
state.crypto.forEach(p=>{ const t=(p.ticker||"").trim().toUpperCase(); if(t in prices){ const q=prices[t]; if(q&&q.c!=null){ p.price=Number(q.c); p.prevClose=(q.pc!=null)?Number(q.pc):null; updated++; } else missed++; } });
```
(Note: stocks round to 2 dp; crypto prices are not rounded here, matching the existing crypto behaviour where `p.price=Number(q.c)` is left unrounded. Keep `prevClose` unrounded for the same reason.)

**3b.** In `render()`, the block that fills the prev-close line currently iterates only stock positions:
```js
  state.positions.forEach(p=>{ const el=$("pc-"+p.id); if(!el) return; const pc=num(p.prevClose), cur=num(p.price);
    if(pc>0){ const ch=cur>0?(cur-pc)/pc*100:null;
      el.innerHTML=`prev close ${money(pc)}`+(ch!=null&&isFinite(ch)?` · <span style="color:${ch>=0?"var(--green)":"var(--danger)"}">${ch>=0?"+":"−"}${Math.abs(ch).toFixed(1)}% today</span>`:""); }
    else el.textContent=""; });
```
Change the array it iterates from `state.positions` to `[...state.positions, ...state.crypto]` so coins get the same treatment. The body is unchanged:
```js
  [...state.positions, ...state.crypto].forEach(p=>{ const el=$("pc-"+p.id); if(!el) return; const pc=num(p.prevClose), cur=num(p.price);
    if(pc>0){ const ch=cur>0?(cur-pc)/pc*100:null;
      el.innerHTML=`prev close ${priceFmt(pc)}`+(ch!=null&&isFinite(ch)?` · <span style="color:${ch>=0?"var(--green)":"var(--danger)"}">${ch>=0?"+":"−"}${Math.abs(ch).toFixed(1)}% today</span>`:""); }
    else el.textContent=""; });
```
**Important detail:** I changed `money(pc)` → `priceFmt(pc)` in this line. `money()` forces 2 decimals, which is wrong for sub-dollar coins (e.g. a $0.000012 token). `priceFmt` already handles small-value precision and is the formatter used elsewhere for coin prices. This is correct for stocks too (they're ≥ $1 in practice and `priceFmt` renders them identically).

### Acceptance criteria
- After "Update crypto prices", each coin card shows `prev close $X · ±Y% today` when the server returned a `pc`, and nothing when it didn't.
- Stock cards still show their prev-close line exactly as before (formatting unchanged for ≥$1 prices).
- Sub-dollar coins show sensible precision, not `$0.00`.

---

## Task 4 — (Intentionally left as-is) `prevClose` not persisted across reload

After review, **no code change**. `prevClose` is deliberately ephemeral — it's stale by the next trading day and is repopulated on every Refresh. Persisting it would risk showing a stale "% today" against a fresh price. Listed here only so it's on record as a conscious decision, not an oversight. **Skip — do not implement anything for Task 4.**

---

## Task 5 — Whitelist keys accepted by `POST /api/config` (MINOR)

### Problem
`POST /api/config` does `writeConfig({ ...DEFAULTS, ...JSON.parse(body) })`. Any extra/unknown keys a client sends are persisted verbatim into `config.json`. For a single-user LAN app this is low-impact, but it lets the on-disk config accumulate arbitrary attacker-or-bug-supplied keys. Constrain the persisted shape to the known fields.

### Fix — in `server.js`

Add a sanitizer near the config store helpers (just under `writeConfig` is fine):

```js
// keep only known fields when accepting a config from the client
const sanitizeConfig = (raw) => {
  const o = raw && typeof raw === 'object' ? raw : {};
  const pos = (p) => ({
    ticker: String(p?.ticker ?? '').toUpperCase().slice(0, 12),
    shares: +p?.shares || 0, price: +p?.price || 0, cost: +p?.cost || 0,
    ceiling: +p?.ceiling || 0, floor: +p?.floor || 0, note: String(p?.note ?? '').slice(0, 200),
  });
  const arr = (v) => Array.isArray(v) ? v : [];
  return {
    ceiling: +o.ceiling || 0, floor: +o.floor || 0,
    bank: String(o.bank ?? ''),
    banks: arr(o.banks).map((b) => ({ ticker: String(b?.ticker ?? '').toUpperCase().slice(0, 12), target: +b?.target || 0 })).filter((b) => b.ticker),
    cash: +o.cash || 0, minCash: +o.minCash || 0,
    cryptoCeiling: +o.cryptoCeiling || 0, cryptoFloor: +o.cryptoFloor || 0,
    positions: arr(o.positions).map(pos),
    crypto: arr(o.crypto).map(pos),
  };
};
```

Then change the POST handler.

Current:
```js
if (path === '/api/config' && req.method === 'POST') {
  await writeConfig({ ...DEFAULTS, ...JSON.parse((await readBody(req)) || '{}') });
  return send(res, 200, { ok: true });
}
```
New:
```js
if (path === '/api/config' && req.method === 'POST') {
  await writeConfig({ ...DEFAULTS, ...sanitizeConfig(JSON.parse((await readBody(req)) || '{}')) });
  return send(res, 200, { ok: true });
}
```

### Notes / constraints
- The field list above must stay **in sync with `DEFAULTS`** (`server.js`) and the client's `saveConfig` payload (`public/index.html`). Cross-check both before finishing: every key the client sends must survive the sanitizer, and no extra keys should pass through.
- `slice(0, 12)` on ticker / `slice(0, 200)` on note are sanity caps, not security boundaries — fine to keep.
- Do **not** change what the client sends; the sanitizer must accept the current client payload losslessly.

### Acceptance criteria
- Saving from the UI round-trips with **no visible change** in behaviour (all current fields preserved: ceiling, floor, bank, banks+targets, cash, minCash, crypto limits, positions, crypto, per-position ceiling/floor/note).
- A POST containing an unknown top-level key (e.g. `{"evil":"x", ...validconfig}`) results in a `config.json` that does **not** contain `evil`.
- A POST with `positions` as a non-array, or a position missing fields, does not throw — it coerces to safe defaults.

---

## Task 6 — Constant-time guard already correct (NO CHANGE)

For the record: `validSession` correctly length-checks `mac` before `timingSafeEqual`, and `checkPassword` compares equal-length SHA-256 digests. No change needed. **Skip — listed only so the review checklist is complete.**

---

## Task 7 — Make the "Cash" donut segment an easy-to-identify green (REQUIRED)

### Problem
The cash slice in both doughnut charts is currently a muted grey (`#626975`) that blends into the background and is hard to pick out at a glance.

### Fix — one edit in `public/index.html`
There is a single source of truth for this color, used by both the donut segment and its legend swatch.

Current:
```js
const BANK_COLOR='#84A9DA', CASH_COLOR='#626975';
```
New:
```js
const BANK_COLOR='#84A9DA', CASH_COLOR='#1F9E5A';
```

### Color rationale (so you don't substitute a different value)
- `#1F9E5A` is a deep, saturated forest-emerald. It's deliberately **darker and more saturated** than the two existing light greens — `--green` (`#79C6A0`, the "within bounds" status) and the palette's soft `#7FC795` (holdings) — so the cash slice never reads as "just another green holding," even when one sits right beside it.
- It still has enough luminance to stand out clearly against the dark `#13151b` background and the gold accent.
- Use this exact hex. Do not change `--green`, the `PALETTE` array, or `BANK_COLOR`.

### Acceptance criteria
- The cash segment in the main donut and its legend swatch both render as `#1F9E5A`.
- No other segment colors change.
- The crypto donut is unaffected (it has no cash segment — confirm you didn't touch anything else).

---

## Handback checklist (fill this in when you return the work)

- [ ] Task 1: atomic writes — `rename` imported, `atomicWrite` added, `writeConfig` + `snapshot` use it, no direct `writeFile` to config/history remains.
- [ ] Task 2: `sha` coerces with `String(s ?? '')`.
- [ ] Task 3: `refreshCrypto` stores `prevClose`; `render()` iterates stocks+crypto; line uses `priceFmt`.
- [ ] Task 4: skipped (intentional).
- [ ] Task 5: `sanitizeConfig` added and wired into the POST handler; client payload verified lossless.
- [ ] Task 6: skipped (intentional).
- [ ] Task 7: `CASH_COLOR` set to `#1F9E5A`; no other segment colors changed.
- [ ] No edits to CHANGELOG / README / .env.example / .gitignore / package.json / assets.
- [ ] No new dependencies; `package.json` unchanged.
- [ ] App boots (`DATA_DIR=./data FINNHUB_KEY=test npm start`), config saves/loads, login works.
- [ ] Notes on anything you couldn't apply verbatim.
