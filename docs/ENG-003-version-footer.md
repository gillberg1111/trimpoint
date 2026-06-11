# ENG-003 — Version footer & bank/group hygiene (v1.3.1)

**Architect:** Claude · **Engineer:** Deepseek · **Reviewer:** Claude
**Status:** Ready for implementation
**Target:** `server.js`, `public/index.html`

---

## Scope & ground rules

Code changes **only**. Same rules as ENG-001/002:

- Edit **`server.js`** and **`public/index.html`** exactly as specified.
- Do **not** touch `CHANGELOG.md`, `README.md`, `.env.example`, `.gitignore`, `package.json`, `docs/`, or branding/copy beyond the exact strings below. The architect owns those.
- No refactors, no reformatting untouched lines, no new dependencies (Node built-ins only — this project is zero-dependency).
- Match existing style. If a context string doesn't match, **stop and flag it** rather than improvising.

Three small edits across two files. All required.

---

## Task 1 — Expose the app version from the server

The version's single source of truth is `package.json`. The server reads it once at boot and returns it from the health endpoint. **Do not hardcode a version number anywhere.**

### 1a — `server.js`: read the version at boot

Just **after** this existing line near the top:
```js
const PUBLIC = join(ROOT, 'public');
```
add:
```js
let VERSION = '';
try { VERSION = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')).version || ''; } catch {}
```
(`readFile` and `join` are already imported. Top-level `await` is fine — this is an ES module. If the read fails for any reason, `VERSION` stays `''` and the footer simply shows nothing.)

### 1b — `server.js`: return it from `/api/health`

Current:
```js
    if (path === '/api/health') return send(res, 200, { ok: true, auth: AUTH_ON });
```
New:
```js
    if (path === '/api/health') return send(res, 200, { ok: true, auth: AUTH_ON, version: VERSION });
```

### Acceptance criteria
- `GET /api/health` returns `{ ok, auth, version }`, where `version` matches `package.json`'s `version` (e.g. `"1.3.1"`).
- If `package.json` can't be read, `version` is `""` and nothing else breaks.

---

## Task 2 — Show the version in the footer

### 2a — `public/index.html`: add the footer element

Current (end of the `<footer>` block):
```html
    <span id="logoutWrap" style="display:none;"><br><a href="#" id="logoutLink" style="color:var(--gold-dim);text-decoration:none;">Log out</a></span>
  </footer>
```
New (add a discreet version line just before `</footer>`):
```html
    <span id="logoutWrap" style="display:none;"><br><a href="#" id="logoutLink" style="color:var(--gold-dim);text-decoration:none;">Log out</a></span>
    <span id="verNum" style="display:block;margin-top:8px;color:var(--muted2);font-size:11.5px;letter-spacing:.04em;"></span>
  </footer>
```

### 2b — `public/index.html`: fill it from `/api/health`

The page already calls `/api/health` on load. Current:
```js
fetch('/api/health').then(r=>r.json()).then(d=>{ if(d&&d.auth) $("logoutWrap").style.display="inline"; }).catch(()=>{});
```
New (also set the version line when present):
```js
fetch('/api/health').then(r=>r.json()).then(d=>{ if(d&&d.auth) $("logoutWrap").style.display="inline"; if(d&&d.version) $("verNum").textContent="TrimPoint v"+d.version; }).catch(()=>{});
```

### Acceptance criteria
- The bottom of the page shows a small, muted `TrimPoint v1.3.1` (matching `package.json`).
- When the server returns no version, the line stays empty (no stray "TrimPoint v").
- Layout is otherwise unchanged.

---

## Task 3 — Pruning a position from groups when it becomes a bank fund

### Problem
Today, removing a position prunes it from `banks` and group `members` (v1.3.0). But *nominating* an existing position as a bank fund does not remove it from any group it's already in — so it can linger as a group chip even though group math correctly excludes bank funds. Make "a bank fund is never a group member" true by construction, on the nominate path too.

### Change — `public/index.html`
In the `document.addEventListener("change", …)` handler, current `bankAdd` branch:
```js
  if(e.target.id==="bankAdd" && e.target.value){ const tk=e.target.value.toUpperCase(); if(!bankSet().has(tk)){ state.banks.push({ ticker:tk, target:"" }); render(); } e.target.value=""; }
```
New (also drop the ticker from every group's members when it's nominated):
```js
  if(e.target.id==="bankAdd" && e.target.value){ const tk=e.target.value.toUpperCase(); if(!bankSet().has(tk)){ state.banks.push({ ticker:tk, target:"" }); state.groups.forEach(g=>{ g.members=(g.members||[]).filter(m=>(m||"").trim().toUpperCase()!==tk); }); render(); } e.target.value=""; }
```

### Acceptance criteria
- Add a position to a group, then nominate that same position as a bank fund → it disappears from the group's member chips immediately, and the change persists (the handler's existing `saveConfig()` still fires).
- Bank funds and group members never overlap, on either the add-to-bank path or the delete-position path.
- Nominating a position that isn't in any group is unaffected.

---

## Handback checklist

- [ ] Task 1: `VERSION` read at boot from `package.json`; `/api/health` returns `version`.
- [ ] Task 2: `#verNum` footer element added; health fetch fills it with `TrimPoint v<version>`.
- [ ] Task 3: `bankAdd` change branch prunes the nominated ticker from all group members.
- [ ] No edits to CHANGELOG / README / .env.example / .gitignore / package.json / docs / assets.
- [ ] No new dependencies.
- [ ] `node --check server.js` clean; client JS eyeballed for balanced braces/quotes.
- [ ] App boots; `/api/health` shows the version; footer renders it.
- [ ] Notes on anything you couldn't apply verbatim.
