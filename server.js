// TrimPoint — zero-dependency Node server.
// Serves the UI, proxies Finnhub (key stays server-side), stores one config on
// disk, notifies on threshold crossings, and optionally gates everything behind
// a single password. No frameworks, no database — Node built-ins only.
import http from 'node:http';
import crypto from 'node:crypto';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(ROOT, 'public');
let VERSION = '';
try { VERSION = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')).version || ''; } catch {}

const {
  FINNHUB_KEY = '',
  COINGECKO_KEY = '',                                  // optional free CoinGecko Demo key (higher rate limits)
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
const DEFAULTS = { ceiling: 25, floor: 20, bank: '', banks: [], cash: 0, minCash: 0, positions: [], crypto: [], cryptoCeiling: 40, cryptoFloor: 30, groups: [] };

// ---- effective per-position limits (overrides > scaled-from-global > global) ----
const limits = (p, g) => {
  const ratio = g.ceiling > 0 ? g.floor / g.ceiling : 0.8;
  const hasCeil = +p.ceiling > 0;
  const ceiling = hasCeil ? +p.ceiling : g.ceiling;
  const floor = +p.floor > 0 ? +p.floor : hasCeil ? +(ceiling * ratio).toFixed(2) : g.floor;
  return { ceiling, floor };
};

// ---- config store ----
// write-to-temp then rename, so a crash mid-write can't truncate the real file
const atomicWrite = async (file, data) => {
  await mkdir(DATA_DIR, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, file);
};

const readConfig = async () => {
  try {
    const raw = JSON.parse(await readFile(CONFIG_FILE, 'utf8'));
    if (raw.reset != null && raw.floor == null) raw.floor = raw.reset; // migrate old key
    return { ...DEFAULTS, ...raw };
  } catch { return { ...DEFAULTS }; }
};
const writeConfig = async (cfg) => {
  await atomicWrite(CONFIG_FILE, JSON.stringify(cfg, null, 2));
};

// keep only known fields when accepting a config from the client
const sanitizeConfig = (raw) => {
  const o = raw && typeof raw === 'object' ? raw : {};
  const pos = (p) => ({
    ticker: String(p?.ticker ?? '').toUpperCase().slice(0, 12),
    shares: +p?.shares || 0, price: +p?.price || 0, cost: +p?.cost || 0,
    ceiling: +p?.ceiling || 0, floor: +p?.floor || 0, underweightAlert: +p?.underweightAlert || 0,
    note: String(p?.note ?? '').slice(0, 200),
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
    groups: arr(o.groups).map((g) => ({
      name: String(g?.name ?? '').slice(0, 40),
      members: arr(g?.members).map((t) => String(t ?? '').toUpperCase().slice(0, 12)).filter(Boolean),
      ceiling: +g?.ceiling || 0,
    })).filter((g) => g.members.length),
  };
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

// ---- crypto prices via CoinGecko (keyless; set COINGECKO_KEY for a free Demo key) ----
const CG_IDS = {
  BTC: 'bitcoin', ETH: 'ethereum', USDT: 'tether', BNB: 'binancecoin', SOL: 'solana',
  USDC: 'usd-coin', XRP: 'ripple', ADA: 'cardano', DOGE: 'dogecoin', TRX: 'tron',
  TON: 'the-open-network', AVAX: 'avalanche-2', SHIB: 'shiba-inu', DOT: 'polkadot',
  LINK: 'chainlink', BCH: 'bitcoin-cash', NEAR: 'near', MATIC: 'matic-network',
  POL: 'polygon-ecosystem-token', LTC: 'litecoin', ICP: 'internet-computer',
  UNI: 'uniswap', DAI: 'dai', APT: 'aptos', ETC: 'ethereum-classic', XLM: 'stellar',
  ATOM: 'cosmos', FIL: 'filecoin', ARB: 'arbitrum', IMX: 'immutable-x',
  HBAR: 'hedera-hashgraph', VET: 'vechain', OP: 'optimism', INJ: 'injective-protocol',
  GRT: 'the-graph', AAVE: 'aave', RNDR: 'render-token', RENDER: 'render-token',
  MKR: 'maker', ALGO: 'algorand', QNT: 'quant-network', FTM: 'fantom', SAND: 'the-sandbox',
  MANA: 'decentraland', AXS: 'axie-infinity', FLOW: 'flow', XTZ: 'tezos',
  THETA: 'theta-token', CRO: 'crypto-com-chain', KAS: 'kaspa', SUI: 'sui',
  SEI: 'sei-network', PEPE: 'pepe', WIF: 'dogwifcoin', BONK: 'bonk', FET: 'fetch-ai',
  TIA: 'celestia', STX: 'blockstack', RUNE: 'thorchain', LDO: 'lido-dao',
  WBTC: 'wrapped-bitcoin', LEO: 'leo-token', OKB: 'okb', EGLD: 'elrond-erd-2',
  XMR: 'monero', GALA: 'gala', CHZ: 'chiliz', SNX: 'havven', ENS: 'ethereum-name-service',
  JUP: 'jupiter-exchange-solana', PYTH: 'pyth-network', WLD: 'worldcoin-wld',
  ENA: 'ethena', ONDO: 'ondo-finance', JTO: 'jito-governance-token', BTT: 'bittorrent',
};
const CG_HEADERS = COINGECKO_KEY ? { accept: 'application/json', 'x-cg-demo-api-key': COINGECKO_KEY } : { accept: 'application/json' };

// resolve a ticker to a CoinGecko id: built-in map first, then the search API
const idCache = new Map();                               // SYMBOL -> { id, at }
const ID_NULL_TTL = 10 * 60 * 1000;                      // retry unresolved tickers after 10 min
const resolveId = async (sym) => {
  sym = sym.toUpperCase();
  if (CG_IDS[sym]) return CG_IDS[sym];
  const hit = idCache.get(sym);
  if (hit && (hit.id || Date.now() - hit.at < ID_NULL_TTL)) return hit.id;
  let id = null;
  try {
    const r = await fetch(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(sym)}`, { headers: CG_HEADERS });
    if (r.ok) {
      const coins = (await r.json()).coins || [];
      const exact = coins.filter((c) => (c.symbol || '').toUpperCase() === sym);
      const pool = (exact.length ? exact : coins).slice().sort((a, b) => (a.market_cap_rank ?? 1e9) - (b.market_cap_rank ?? 1e9));
      id = pool.length ? pool[0].id : null;              // best market-cap match for that ticker
    }
  } catch {}
  idCache.set(sym, { id, at: Date.now() });
  return id;
};
const cryptoQuotes = async (symbols) => {
  const want = [...new Set(symbols.map((s) => s.toUpperCase()))];
  const out = {}; const need = [];
  for (const s of want) {
    const hit = cache.get('cg:' + s);
    if (hit && Date.now() - hit.at < QUOTE_TTL * 1000) out[s] = hit.q;
    else need.push(s);
  }
  if (need.length) {
    const symId = {};
    await Promise.all(need.map(async (s) => { symId[s] = await resolveId(s); }));
    const ids = [...new Set(Object.values(symId).filter(Boolean))];
    let d = {};
    if (ids.length) {
      try {
        const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(',')}&vs_currencies=usd&include_24hr_change=true`, { headers: CG_HEADERS });
        if (r.ok) d = await r.json();
      } catch {}
    }
    for (const s of need) {
      const row = symId[s] ? d[symId[s]] : null;
      const c = row && typeof row.usd === 'number' && row.usd > 0 ? row.usd : null;
      const q = c == null ? null : { c, pc: typeof row.usd_24h_change === 'number' ? +(c / (1 + row.usd_24h_change / 100)).toFixed(10) : null };
      if (q) cache.set('cg:' + s, { q, at: Date.now() });
      out[s] = q;
    }
  }
  return Object.fromEntries(symbols.map((s) => [s, out[s.toUpperCase()] ?? null]));
};

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
  const banks = Array.isArray(cfg.banks) && cfg.banks.length ? cfg.banks.map(b => String(b.ticker || '').toUpperCase()).filter(Boolean) : (cfg.bank ? [String(cfg.bank).toUpperCase()] : []);
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
  for (const p of valued) {
    if (banks.includes(p.sym)) continue;
    const pct = (p.value / total) * 100;
    if (pct > p.ceiling && !flagged.has(p.sym)) {
      flagged.add(p.sym);
      const sell = Math.max(1, Math.round((p.value - (p.floor / 100) * total) / (p.value / p.shares)));
      let body = `${p.sym} is ${pct.toFixed(1)}% of the account. Your plan: trim ~${sell} share(s) toward ${p.floor}%${dest ? ` into ${dest}` : ''}.`;
      if (p.note) body += `\nNote: ${p.note}`;
      await notify(`${p.sym} crossed your ${p.ceiling}% ceiling`, body);
    } else if (pct <= p.ceiling) flagged.delete(p.sym);
  }
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
  await atomicWrite(HISTORY_FILE, JSON.stringify(hist.slice(-HIST_DAYS)));
};

const tick = async () => {
  const cfg = await readConfig();
  const snap = await valuePortfolio(cfg);
  await checkThresholds(cfg, snap);
  await snapshot(cfg, snap);
};

// ---- auth: constant-time password check + signed, HttpOnly session cookie ----
const sha = (s) => crypto.createHash('sha256').update(String(s ?? '')).digest();
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

    if (path === '/api/health') return send(res, 200, { ok: true, auth: AUTH_ON, version: VERSION });

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
    if (path === '/api/crypto') {
      const symbols = (url.searchParams.get('symbols') || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
      return send(res, 200, symbols.length ? await cryptoQuotes(symbols) : {});
    }
    if (path === '/api/config' && req.method === 'GET') return send(res, 200, await readConfig());
    if (path === '/api/history' && req.method === 'GET') return send(res, 200, await readHistory());
    if (path === '/api/config' && req.method === 'POST') {
      await writeConfig({ ...DEFAULTS, ...sanitizeConfig(JSON.parse((await readBody(req)) || '{}')) });
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
