# Changelog

All notable changes to TrimPoint are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] — 2026-06-03

### Added
- **Crypto sleeve.** A separate section for cryptocurrency with its own doughnut, its own ceiling/floor, and an **+ Add crypto** button. Coin weights are measured *within the crypto sleeve only* — never blended with stocks — and the section stays hidden until you add a coin.
- **Tap-to-expand chip grid.** Holdings render as a compact, frosted-glass chip grid that's collapsed by default; tap a chip to open its full card. Anything over its ceiling glows. Each chip shows the ticker, its last-checked price, and a larger bold weight percentage.
- **Responsive desktop layout.** On wider screens the app opens into a two-column dashboard — allocation doughnut and value-trend chart side by side, expanded cards two-up — and collapses back to a single column on the phone.
- **Previous close on each holding.** Cards show the prior close and the day's percent change beside the current price.

### Changed
- Refactored the allocation/trim engine so stocks and crypto run through one shared computation-and-render path — separate sleeves, identical behavior.
- Server config defaults now include the crypto holdings and crypto ceiling/floor, so they persist and sync across devices like the rest of your settings.

### Notes
- Coin prices are entered manually for now. The price refresh, the daily history snapshot, and threshold notifications currently cover stocks; live crypto prices and crypto alerts are planned.

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

[1.1.0]: https://github.com/gillberg1111/trimpoint/releases/tag/v1.1.0
[1.0.0]: https://github.com/gillberg1111/trimpoint/releases/tag/v1.0.0
