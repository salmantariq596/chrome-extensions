# Chrome Extensions

Two Manifest V3 Chrome extensions written in plain JavaScript (content scripts, service workers and a popup UI).

| Extension | What it does | Key techniques |
|---|---|---|
| [`mexc-quick-trade`](mexc-quick-trade/) | Trading assistant panel injected into the MEXC futures page: grid and one-direction bots, activation prices, per-grid take-profit/stop-loss, loop re-entry, order reconciliation and an alert centre with sounds and desktop notifications. | DOM automation on a live single-page app, state machine per bot, order-book "frozen page" watchdog, `chrome.notifications` |
| [`buildzoom-scraper`](buildzoom-scraper/) | Scrapes contractor cards from BuildZoom search results (name, score, price range, address, phone, rating, licence, years in business) and exports CSV or JSON. | Card detection by walking up from `/contractor/` links, de-duplication, highlight-to-verify, client-side CSV export |

## Install (either extension)

1. Open `chrome://extensions/` and enable **Developer mode**.
2. Click **Load unpacked** and pick the extension's folder.

See each folder's README for usage. The MEXC README is a full changelog (v9.7 → v9.9.1).

> The trading extension automates clicks on the user's own logged-in session and stores no API keys. Use at your own risk.

## Author

**Salman Tariq** · [GitHub](https://github.com/salmantariq596)
