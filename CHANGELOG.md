# Changelog

All notable changes to TrimPoint are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.1] — 2026-06-11

### Added
- **Version in the footer.** The bottom of the page now shows the running version (e.g. `TrimPoint v1.3.1`). It's read from `package.json` on the server and surfaced via `/api/health`, so it always matches the deployed build — no second place to keep in sync.

### Fixed
- **Bank funds can't linger in a group.** Nominating a position as a bank fund now also removes it from any group it belonged to. Group math already excluded bank funds; this clears the leftover chip so the two never visually overlap — matching the cleanup that already happens when a position is deleted.

## [1.3.0] — 2026-06-11

This release makes TrimPoint model "core + capped tilts" correctly — a multi-fund core held as the bank, with smaller positions kept under a shared cap — without nagging you to buy into deliberately-small holdings.

### Added
- **Position groups.** Cap a basket of holdings under one combined ceiling — e.g. a "Tech tilt" of AAPL / MSFT / NVDA limited to 15% together. Each position still keeps its own ceiling; the group adds a limit on their total. When the group is over, its panel turns gold and names the move — which member to trim, roughly how much, and where it lands — and the status banner counts it alongside position breaches. Notifications fire on a group crossing its cap, too. Bank funds can't be grouped (they're ceiling-exempt by design).
- **Underweight alerts.** A new optional, per-position threshold that flags a holding as underweight when it dips below a level you choose. It's **off by default**, and it's the *only* thing that raises the underweight flag now (see below).

### Changed
- **Multi-fund bank trim routing.** With more than one fund in the bank, trims now name the specific fund furthest *below* its target weight — so following the suggestion nudges your core back toward its split (e.g. a 75 / 25 VTI / VXUS core routes trims to whichever side is light). Both the on-card suggestion and the notification name the same fund. A single-fund bank, and a multi-fund bank with no targets set, behave exactly as before.
- **Trim-to and underweight are now separate.** A per-position floor used to do double duty — it was both the trim landing *and* a silent underweight trigger, which meant a deliberately-small capped position read as "underweight" forever. The floor (relabeled **"Trim-to % override"**) now controls only where a trim lands; underweight flagging moved entirely to the new optional alert above.

### Notes
- Existing configurations load unchanged. Per-position floors keep their trim-to meaning, and underweight alerts start **off** — so nothing that was quiet before suddenly starts flagging. Set an underweight alert on any holding you do want watched.
- Removing a position now also clears it from the bank and from any group it belonged to, so no stale references linger.

## [1.2.1] — 2026-06-09

### Fixed
- **Crash-safe config writes.** `config.json` and `history.json` are now written to a temporary file and atomically renamed into place. A process kill or crash mid-write can no longer truncate them — previously a half-written file would read back as an empty portfolio and then be overwritten, losing your settings.
- **Crypto day change.** The previous close and the day's percent change now appear on crypto cards. The values were already fetched but never displayed; they use the small-value price format, so sub-dollar coins read correctly.

### Changed
- **Cash slice color.** The cash segment in the allocation doughnuts is now a deep emerald instead of grey, making it easy to pick out at a glance.

### Security
- **Login input hardening.** A non-string `password` in the login request now returns a clean 401 instead of a 500.
- **Config field whitelist.** `POST /api/config` now keeps only known fields, so unexpected keys can no longer be persisted into the on-disk config.

## [1.2.0] — 2026-06-05

### Added
- **Multi-fund bank.** The bank — where trims land, exempt from the ceiling — can now hold more than one fund. Add several (say a three-fund 80 / 10 / 10) and give each a target weight; the bank panel shows every fund's live share of the bank and tracks how far it has drifted from its target.
- **Rebalancing guidance.** When a fund drifts past its tolerance band (the 5/25 rule), its row colors by *direction* — warm if it's **over** target (gold → red, ▲), cool if it's **under** (teal → blue, ▼) — and spells out the exact move: e.g. "Trim ~$1,240 (≈ 38 sh) to reach 80%" or "Add ~$320 to reach 10%."
- **Targets readout.** A live indicator in the bank panel flags whether your fund targets add up to 100%.

### Changed
- **Varied allocation palette.** The doughnut's near-identical gold shades are replaced with a distinct, theme-coherent set — gold, teal, pink, green, orange, purple, yellow, blue, coral, indigo — ordered so neighboring slices contrast. Bank funds stay blue (they're one group); cash stays grey.
- A single nominated bank still behaves exactly as before, and existing configurations migrate automatically to the new multi-fund model — no action needed.

### Notes
- Rebalance amounts size each fund to its target share of the *current* bank total, so they're exact when your targets sum to 100%.

## [1.1.0] — 2026-06-03

### Added
- **Crypto section.** A separate section for cryptocurrency with its own doughnut, its own ceiling/floor, and an **+ Add crypto** button. Coin weights are measured *against your crypto only* — never blended with stocks — and the section stays hidden until you add a coin.
- **Live crypto prices.** An **Update crypto prices** button (shown once you add a coin) looks up quotes by ticker via CoinGecko — no key required — resolving most listed coins automatically; anything it can't find keeps its manually entered price. An optional `COINGECKO_KEY` env var enables a free Demo key for higher rate limits.
- **Adaptive price formatting.** Per-unit prices under $1 now show with enough significant figures that fractional-cent coins display their real price instead of rounding to $0.00.
- **Tap-to-expand chip grid.** Holdings render as a compact, frosted-glass chip grid that's collapsed by default; tap a chip to open its full card. Anything over its ceiling glows. Each chip shows the ticker, its last-checked price, and a larger bold weight percentage.
- **Responsive desktop layout.** On wider screens the app opens into a two-column dashboard — allocation doughnut and value-trend chart side by side, expanded cards two-up — and collapses back to a single column on the phone.
- **Previous close on each holding.** Cards show the prior close and the day's percent change beside the current price.
- **Support link.** A Buy Me a Coffee button at the foot of the app for anyone who wants to chip in.

### Changed
- Data sources are now credited in the app footer (Finnhub for stocks, CoinGecko for crypto).
- Refactored the allocation/trim engine so stocks and crypto run through one shared computation-and-render path — separate sections, identical behavior.
- Server config defaults now include the crypto holdings and crypto ceiling/floor, so they persist and sync across devices like the rest of your settings.

### Notes
- The daily history snapshot and threshold notifications currently cover stocks; crypto history and crypto alerts are planned.

## [1.0.0] — 2026-06-02

Initial public release.

### Added
- **Position-ceiling tracking.** Set a maximum weight per holding; the dashboard shows each position's weight, distance to its ceiling, and — when over — the trim your own plan calls for. Holdings below a set floor read "underweight."
- **Per-position overrides.** A default ceiling/floor for everything, overridable on any single position.
- **Bank.** Nominate a holding (e.g. a broad-market ETF) where trims land; it's exempt from the ceiling.
- **Notes.** One line per position on *why* you set that ceiling — shown on the card and carried into alerts.
- **House-money flag.** Positions past 2× cost are tagged, as a plain cost-basis fact.
- **Cash floor.** Set a minimum cash %; the dashboard and alerts flag cash below it.
- **Drift & history.** A daily weight snapshot per holding powers a sparkline and a 30-day drift readout, stored in one bounded file — no database.
- **Live prices.** Quotes proxied through the server from [Finnhub](https://finnhub.io), with the API key kept server-side and never exposed to the browser; brief server-side caching avoids redundant calls.
- **Notifications.** Scheduled checks ping you via ntfy, Discord, or any webhook — only when a holding crosses its ceiling or cash dips below your floor — restating your plan and your note.
- **Optional single-password login.** Gate the whole app behind one password (constant-time compare, signed HttpOnly session cookie), or run open on a trusted LAN.
- **Cross-device sync.** Configuration lives in one file on the server.
- **Self-hosting.** Zero-dependency Node (built-ins only), a Dockerfile and docker-compose, and a GitHub Actions workflow that builds and publishes the image to GHCR. Unraid Community Applications template included.

[1.3.1]: https://github.com/gillberg1111/trimpoint/releases/tag/v1.3.1
[1.3.0]: https://github.com/gillberg1111/trimpoint/releases/tag/v1.3.0
[1.2.1]: https://github.com/gillberg1111/trimpoint/releases/tag/v1.2.1
[1.2.0]: https://github.com/gillberg1111/trimpoint/releases/tag/v1.2.0
[1.1.0]: https://github.com/gillberg1111/trimpoint/releases/tag/v1.1.0
[1.0.0]: https://github.com/gillberg1111/trimpoint/releases/tag/v1.0.0
