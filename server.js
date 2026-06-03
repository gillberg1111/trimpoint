// TrimPoint — zero-dependency Node server.
// Serves the UI, proxies Finnhub (key stays server-side), stores one config on
// disk, notifies on threshold crossings, and optionally gates everything behind
// a single password. No frameworks, no database — Node built-ins only.
import http from 'node:http';
import crypto from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(ROOT, 'public');

const {
  FINNHUB_KEY = '',
  PORT = 8080,
  DATA_DIR = '/data',
  QUOTE_TTL = 45,
  CHECK_INTERVAL = 60,
  NOTIFY_KIND = 'off',
  NOTIFY_URL = '',
  HISTORY = 'on',                                       // daily concentration snapshots; 'off' to disable
  AUTH_PASSWORD = '',                                   // set to require login; blank = open
  SESSION_SECRET = crypto.randomBytes(32).toString('hex'),
  COOKIE_SECURE = 'false',                              // 'true' when served over HTTPS
} = process.env;

const AUTH_ON = AUTH_PASSWORD.length > 0;
const SESSION_DAYS = 30;
const CONFIG_FILE = join(DATA_DIR, 'config.json');
const HISTORY_FILE = join(DATA_DIR, 'history.json');
const HISTORY_ON = HISTORY !== 'off';
const HIST_DAYS = 730;
const DEFAULTS = { ceiling: 25, floor: 20, bank: '', cash: 0, minCash: 0, positions: [] };

// ---- effective per-position limits (overrides > scaled-from-global > global) ----
const limits = (p, g) => {
  const ratio = g.ceiling > 0 ? g.floor / g.ceiling : 0.8;
  const hasCeil = +p.ceiling > 0;
  const ceiling = hasCeil ? +p.ceiling : g.ceiling;
  const floor = +p.floor > 0 ? +p.floor : hasCeil ? +(ceiling * ratio).toFixed(2) : g.floor;
  return { ceiling, floor };
};

// ---- config store ----
const readConfig = async () => {
  try {
    const raw = JSON.parse(await readFile(CONFIG_FILE, 'utf8'));
    if (raw.reset != null && raw.floor == null) raw.floor = raw.reset; // migrate old key
    return { ...DEFAULTS, ...raw };
  } catch { return { ...DEFAULTS }; }
};
const writeConfig = async (cfg) => {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2));
};

// ---- quote proxy with short-lived cache; key never leaves the server ----
const cache = new Map();
const quote = async (symbol) => {
  const hit = cache.get(symbol);
  if (hit && Date.now() - hit.at < QUOTE_TTL * 1000) return hit.q;
  const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${FINNHUB_KEY}`);
  if (!r.ok) throw new Error(`finnhub ${r.status}`);
  const d = await r.json();
  const c = typeof d.c === 'number' && d.c > 0 ? d.c : null;
  if (c == null) return null;
  const q = { c, pc: typeof d.pc === 'number' && d.pc > 0 ? d.pc : null };
  cache.set(symbol, { q, at: Date.now() });
  return q;
};
const quotes = async (symbols) =>
  Object.fromEntries(await Promise.all(symbols.map(async (s) => {
    try { return [s, await quote(s)]; } catch { return [s, null]; }
  })));

// ---- notify only on a fresh threshold crossing ----
const flagged = new Set();
const notify = async (title, body) => {
  if (NOTIFY_KIND === 'off' || !NOTIFY_URL) return;
  try {
    if (NOTIFY_KIND === 'ntfy')
      await fetch(NOTIFY_URL, { method: 'POST', headers: { Title: title }, body });
    else if (NOTIFY_KIND === 'discord')
      await fetch(NOTIFY_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: `**${title}**\n${body}` }) });
    else
      await fetch(NOTIFY_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, body }) });
  } catch (e) { console.error('notify failed:', e.message); }
};

// value every active position once (shared by notifications + history)
const valuePortfolio = async (cfg) => {
  const active = cfg.positions.filter((p) => p.ticker && +p.shares > 0);
  if (!active.length) return null;
  const prices = await quotes(active.map((p) => p.ticker.toUpperCase()));
  const valued = active.map((p) => {
    const px = prices[p.ticker.toUpperCase()]?.c ?? +p.price;
    const { ceiling, floor } = limits(p, cfg);
    return { sym: p.ticker.toUpperCase(), shares: +p.shares, value: +p.shares * px, ceiling, floor, note: (p.note || '').trim() };
  });
  const total = valued.reduce((s, p) => s + p.value, 0) + (+cfg.cash || 0);
  return total > 0 ? { valued, total } : null;
};

const checkThresholds = async (cfg, snap) => {
  if (NOTIFY_KIND === 'off' || !NOTIFY_URL || !snap) return;
  const { valued, total } = snap;
  const bank = (cfg.bank || '').toUpperCase();
  for (const p of valued) {
    if (p.sym === bank) continue;
    const pct = (p.value / total) * 100;
    if (pct > p.ceiling && !flagged.has(p.sym)) {
      flagged.add(p.sym);
      const sell = Math.max(1, Math.round((p.value - (p.floor / 100) * total) / (p.value / p.shares)));
      let body = `${p.sym} is ${pct.toFixed(1)}% of the account. Your plan: trim ~${sell} share(s) toward ${p.floor}%${bank ? ` into ${bank}` : ''}.`;
      if (p.note) body += `\nNote: ${p.note}`;
      await notify(`${p.sym} crossed your ${p.ceiling}% ceiling`, body);
    } else if (pct <= p.ceiling) flagged.delete(p.sym);
  }
  if (+cfg.minCash > 0) {
    const cashPct = ((+cfg.cash || 0) / total) * 100;
    if (cashPct < +cfg.minCash && !flagged.has('__cash__')) {
      flagged.add('__cash__');
      await notify(`Cash below your ${cfg.minCash}% floor`, `Cash is ${cashPct.toFixed(1)}% of the account, under your ${cfg.minCash}% minimum.`);
    } else if (cashPct >= +cfg.minCash) flagged.delete('__cash__');
  }
};

// ---- history: one weight snapshot per day, bounded to HIST_DAYS ----
const readHistory = async () => {
  try { return JSON.parse(await readFile(HISTORY_FILE, 'utf8')); } catch { return []; }
};
const snapshot = async (cfg, snap) => {
  if (!HISTORY_ON || !snap) return;
  const { valued, total } = snap;
  const hist = await readHistory();
  const today = new Date().toISOString().slice(0, 10);
  if (hist.length && hist[hist.length - 1].d === today) return; // one per day
  const w = {};
  for (const p of valued) w[p.sym] = +((p.value / total) * 100).toFixed(2);
  w.Cash = +(((+cfg.cash || 0) / total) * 100).toFixed(2);
  hist.push({ d: today, total: Math.round(total), w });
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(HISTORY_FILE, JSON.stringify(hist.slice(-HIST_DAYS)));
};

const tick = async () => {
  const cfg = await readConfig();
  const snap = await valuePortfolio(cfg);
  await checkThresholds(cfg, snap);
  await snapshot(cfg, snap);
};

// ---- auth: constant-time password check + signed, HttpOnly session cookie ----
const sha = (s) => crypto.createHash('sha256').update(s || '').digest();
const checkPassword = (pw) => crypto.timingSafeEqual(sha(pw), sha(AUTH_PASSWORD));
const makeSession = () => {
  const data = Buffer.from(JSON.stringify({ exp: Date.now() + SESSION_DAYS * 864e5 })).toString('base64url');
  return `${data}.${crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url')}`;
};
const validSession = (token) => {
  if (!token || !token.includes('.')) return false;
  const [data, mac] = token.split('.');
  const want = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');
  if (mac.length !== want.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(want))) return false;
  try { return JSON.parse(Buffer.from(data, 'base64url').toString()).exp > Date.now(); } catch { return false; }
};
const cookie = (req, name) => {
  const jar = Object.fromEntries((req.headers.cookie || '').split(';').map((c) => {
    const i = c.indexOf('='); return i < 0 ? ['', ''] : [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1))];
  }));
  return jar[name];
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isPublic = (path, method) =>
  path === '/api/health' || path === '/login' || (path === '/api/login' && method === 'POST') ||
  path === '/favicon.svg' || path === '/apple-touch-icon.png';

// ---- http ----
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const send = (res, status, body, type = 'application/json') => {
  res.writeHead(status, { 'Content-Type': type });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
const readBody = async (req) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
};
const serveStatic = async (res, path) => {
  const rel = normalize(path === '/' ? '/index.html' : path).replace(/^(\.\.[/\\])+/, '');
  const file = join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) return send(res, 403, 'forbidden', 'text/plain');
  try { send(res, 200, await readFile(file), MIME[extname(file)] || 'application/octet-stream'); }
  catch { send(res, 404, 'not found', 'text/plain'); }
};

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;

    if (AUTH_ON && !isPublic(path, req.method) && !validSession(cookie(req, 'tp_session'))) {
      if (path.startsWith('/api/')) return send(res, 401, { error: 'unauthorized' });
      res.writeHead(302, { Location: '/login' }); return res.end();
    }

    if (path === '/api/health') return send(res, 200, { ok: true, auth: AUTH_ON });

    if (path === '/api/login' && req.method === 'POST') {
      const { password } = JSON.parse((await readBody(req)) || '{}');
      if (!AUTH_ON || checkPassword(password)) {
        const secure = COOKIE_SECURE === 'true' ? '; Secure' : '';
        res.setHeader('Set-Cookie', `tp_session=${makeSession()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure}`);
        return send(res, 200, { ok: true });
      }
      await sleep(400); // gentle brute-force speed bump
      return send(res, 401, { error: 'wrong password' });
    }
    if (path === '/api/logout' && req.method === 'POST') {
      res.setHeader('Set-Cookie', 'tp_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
      return send(res, 200, { ok: true });
    }

    if (path === '/api/quote') {
      if (!FINNHUB_KEY) return send(res, 500, { error: 'FINNHUB_KEY not set' });
      const symbols = (url.searchParams.get('symbols') || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
      return send(res, 200, symbols.length ? await quotes(symbols) : {});
    }
    if (path === '/api/config' && req.method === 'GET') return send(res, 200, await readConfig());
    if (path === '/api/history' && req.method === 'GET') return send(res, 200, await readHistory());
    if (path === '/api/config' && req.method === 'POST') {
      await writeConfig({ ...DEFAULTS, ...JSON.parse((await readBody(req)) || '{}') });
      return send(res, 200, { ok: true });
    }
    if (path.startsWith('/api/')) return send(res, 404, { error: 'not found' });

    if (path === '/login') return serveStatic(res, '/login.html');
    return serveStatic(res, path);
  } catch (e) { send(res, 500, { error: e.message }); }
}).listen(PORT, () => {
  console.log(`TrimPoint listening on :${PORT}  ·  auth ${AUTH_ON ? 'ON' : 'OFF'}`);
  if (AUTH_ON && !process.env.SESSION_SECRET) console.log('note: set SESSION_SECRET to keep logins valid across restarts');
});

const mins = +CHECK_INTERVAL;
if (mins > 0 && (NOTIFY_KIND !== 'off' || HISTORY_ON)) {
  const run = () => tick().catch((e) => console.error('tick failed:', e.message));
  setInterval(run, mins * 60_000);
  setTimeout(run, 5_000); // first run shortly after boot so history starts populating
  console.log(`background tick every ${mins}m  ·  notify ${NOTIFY_KIND}  ·  history ${HISTORY_ON ? 'on' : 'off'}`);
}
const limits = (p, g) => {
  const ratio = g.ceiling > 0 ? g.floor / g.ceiling : 0.8;
  const hasCeil = +p.ceiling > 0;
  const ceiling = hasCeil ? +p.ceiling : g.ceiling;
  const floor = +p.floor > 0 ? +p.floor : hasCeil ? +(ceiling * ratio).toFixed(2) : g.floor;
  return { ceiling, floor };
};

// ---- config store ----
const readConfig = async () => {
  try {
    const raw = JSON.parse(await readFile(CONFIG_FILE, 'utf8'));
    if (raw.reset != null && raw.floor == null) raw.floor = raw.reset; // migrate old key
    return { ...DEFAULTS, ...raw };
  } catch { return { ...DEFAULTS }; }
};
const writeConfig = async (cfg) => {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2));
};

// ---- quote proxy with short-lived cache; key never leaves the server ----
const cache = new Map();
const quote = async (symbol) => {
  const hit = cache.get(symbol);
  if (hit && Date.now() - hit.at < QUOTE_TTL * 1000) return hit.price;
  const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${FINNHUB_KEY}`);
  if (!r.ok) throw new Error(`finnhub ${r.status}`);
  const d = await r.json();
  const price = typeof d.c === 'number' && d.c > 0 ? d.c : null;
  if (price != null) cache.set(symbol, { price, at: Date.now() });
  return price;
};
const quotes = async (symbols) =>
  Object.fromEntries(await Promise.all(symbols.map(async (s) => {
    try { return [s, await quote(s)]; } catch { return [s, null]; }
  })));

// ---- notify only on a fresh threshold crossing ----
const flagged = new Set();
const notify = async (title, body) => {
  if (NOTIFY_KIND === 'off' || !NOTIFY_URL) return;
  try {
    if (NOTIFY_KIND === 'ntfy')
      await fetch(NOTIFY_URL, { method: 'POST', headers: { Title: title }, body });
    else if (NOTIFY_KIND === 'discord')
      await fetch(NOTIFY_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: `**${title}**\n${body}` }) });
    else
      await fetch(NOTIFY_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, body }) });
  } catch (e) { console.error('notify failed:', e.message); }
};

// value every active position once (shared by notifications + history)
const valuePortfolio = async (cfg) => {
  const active = cfg.positions.filter((p) => p.ticker && +p.shares > 0);
  if (!active.length) return null;
  const prices = await quotes(active.map((p) => p.ticker.toUpperCase()));
  const valued = active.map((p) => {
    const px = prices[p.ticker.toUpperCase()] ?? +p.price;
    const { ceiling, floor } = limits(p, cfg);
    return { sym: p.ticker.toUpperCase(), shares: +p.shares, value: +p.shares * px, ceiling, floor, note: (p.note || '').trim() };
  });
  const total = valued.reduce((s, p) => s + p.value, 0) + (+cfg.cash || 0);
  return total > 0 ? { valued, total } : null;
};

const checkThresholds = async (cfg, snap) => {
  if (NOTIFY_KIND === 'off' || !NOTIFY_URL || !snap) return;
  const { valued, total } = snap;
  const bank = (cfg.bank || '').toUpperCase();
  for (const p of valued) {
    if (p.sym === bank) continue;
    const pct = (p.value / total) * 100;
    if (pct > p.ceiling && !flagged.has(p.sym)) {
      flagged.add(p.sym);
      const sell = Math.max(1, Math.round((p.value - (p.floor / 100) * total) / (p.value / p.shares)));
      let body = `${p.sym} is ${pct.toFixed(1)}% of the account. Your plan: trim ~${sell} share(s) toward ${p.floor}%${bank ? ` into ${bank}` : ''}.`;
      if (p.note) body += `\nNote: ${p.note}`;
      await notify(`${p.sym} crossed your ${p.ceiling}% ceiling`, body);
    } else if (pct <= p.ceiling) flagged.delete(p.sym);
  }
  if (+cfg.minCash > 0) {
    const cashPct = ((+cfg.cash || 0) / total) * 100;
    if (cashPct < +cfg.minCash && !flagged.has('__cash__')) {
      flagged.add('__cash__');
      await notify(`Cash below your ${cfg.minCash}% floor`, `Cash is ${cashPct.toFixed(1)}% of the account, under your ${cfg.minCash}% minimum.`);
    } else if (cashPct >= +cfg.minCash) flagged.delete('__cash__');
  }
};

// ---- history: one weight snapshot per day, bounded to HIST_DAYS ----
const readHistory = async () => {
  try { return JSON.parse(await readFile(HISTORY_FILE, 'utf8')); } catch { return []; }
};
const snapshot = async (cfg, snap) => {
  if (!HISTORY_ON || !snap) return;
  const { valued, total } = snap;
  const hist = await readHistory();
  const today = new Date().toISOString().slice(0, 10);
  if (hist.length && hist[hist.length - 1].d === today) return; // one per day
  const w = {};
  for (const p of valued) w[p.sym] = +((p.value / total) * 100).toFixed(2);
  w.Cash = +(((+cfg.cash || 0) / total) * 100).toFixed(2);
  hist.push({ d: today, total: Math.round(total), w });
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(HISTORY_FILE, JSON.stringify(hist.slice(-HIST_DAYS)));
};

const tick = async () => {
  const cfg = await readConfig();
  const snap = await valuePortfolio(cfg);
  await checkThresholds(cfg, snap);
  await snapshot(cfg, snap);
};

// ---- auth: constant-time password check + signed, HttpOnly session cookie ----
const sha = (s) => crypto.createHash('sha256').update(s || '').digest();
const checkPassword = (pw) => crypto.timingSafeEqual(sha(pw), sha(AUTH_PASSWORD));
const makeSession = () => {
  const data = Buffer.from(JSON.stringify({ exp: Date.now() + SESSION_DAYS * 864e5 })).toString('base64url');
  return `${data}.${crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url')}`;
};
const validSession = (token) => {
  if (!token || !token.includes('.')) return false;
  const [data, mac] = token.split('.');
  const want = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');
  if (mac.length !== want.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(want))) return false;
  try { return JSON.parse(Buffer.from(data, 'base64url').toString()).exp > Date.now(); } catch { return false; }
};
const cookie = (req, name) => {
  const jar = Object.fromEntries((req.headers.cookie || '').split(';').map((c) => {
    const i = c.indexOf('='); return i < 0 ? ['', ''] : [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1))];
  }));
  return jar[name];
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isPublic = (path, method) =>
  path === '/api/health' || path === '/login' || (path === '/api/login' && method === 'POST') ||
  path === '/favicon.svg' || path === '/apple-touch-icon.png';

// ---- http ----
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const send = (res, status, body, type = 'application/json') => {
  res.writeHead(status, { 'Content-Type': type });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
const readBody = async (req) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
};
const serveStatic = async (res, path) => {
  const rel = normalize(path === '/' ? '/index.html' : path).replace(/^(\.\.[/\\])+/, '');
  const file = join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) return send(res, 403, 'forbidden', 'text/plain');
  try { send(res, 200, await readFile(file), MIME[extname(file)] || 'application/octet-stream'); }
  catch { send(res, 404, 'not found', 'text/plain'); }
};

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;

    if (AUTH_ON && !isPublic(path, req.method) && !validSession(cookie(req, 'tp_session'))) {
      if (path.startsWith('/api/')) return send(res, 401, { error: 'unauthorized' });
      res.writeHead(302, { Location: '/login' }); return res.end();
    }

    if (path === '/api/health') return send(res, 200, { ok: true, auth: AUTH_ON });

    if (path === '/api/login' && req.method === 'POST') {
      const { password } = JSON.parse((await readBody(req)) || '{}');
      if (!AUTH_ON || checkPassword(password)) {
        const secure = COOKIE_SECURE === 'true' ? '; Secure' : '';
        res.setHeader('Set-Cookie', `tp_session=${makeSession()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure}`);
        return send(res, 200, { ok: true });
      }
      await sleep(400); // gentle brute-force speed bump
      return send(res, 401, { error: 'wrong password' });
    }
    if (path === '/api/logout' && req.method === 'POST') {
      res.setHeader('Set-Cookie', 'tp_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
      return send(res, 200, { ok: true });
    }

    if (path === '/api/quote') {
      if (!FINNHUB_KEY) return send(res, 500, { error: 'FINNHUB_KEY not set' });
      const symbols = (url.searchParams.get('symbols') || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
      return send(res, 200, symbols.length ? await quotes(symbols) : {});
    }
    if (path === '/api/config' && req.method === 'GET') return send(res, 200, await readConfig());
    if (path === '/api/history' && req.method === 'GET') return send(res, 200, await readHistory());
    if (path === '/api/config' && req.method === 'POST') {
      await writeConfig({ ...DEFAULTS, ...JSON.parse((await readBody(req)) || '{}') });
      return send(res, 200, { ok: true });
    }
    if (path.startsWith('/api/')) return send(res, 404, { error: 'not found' });

    if (path === '/login') return serveStatic(res, '/login.html');
    return serveStatic(res, path);
  } catch (e) { send(res, 500, { error: e.message }); }
}).listen(PORT, () => {
  console.log(`TrimPoint listening on :${PORT}  ·  auth ${AUTH_ON ? 'ON' : 'OFF'}`);
  if (AUTH_ON && !process.env.SESSION_SECRET) console.log('note: set SESSION_SECRET to keep logins valid across restarts');
});

const mins = +CHECK_INTERVAL;
if (mins > 0 && (NOTIFY_KIND !== 'off' || HISTORY_ON)) {
  const run = () => tick().catch((e) => console.error('tick failed:', e.message));
  setInterval(run, mins * 60_000);
  setTimeout(run, 5_000); // first run shortly after boot so history starts populating
  console.log(`background tick every ${mins}m  ·  notify ${NOTIFY_KIND}  ·  history ${HISTORY_ON ? 'on' : 'off'}`);
}
