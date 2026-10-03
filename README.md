# Hedge Check

**Both Lighter venues. One wallet.**

Paste an Ethereum address and see its positions on **Lighter on Robinhood Chain (RH)** and **Lighter Core** side by side:

- whether each RH ↔ Core pair is actually hedged (delta measured in coins, not dollars)
- how far each leg is from liquidation
- what the pair earns or pays in funding per day
- 7-day trade volume on each venue (maker / taker split)
- your points and rank, if you add a read-only token (optional)
- every market listed on both venues, with funding, volume, open interest and max leverage
- a pair calculator that sizes both legs to a precision both venues accept
- the Lighter team's weekly updates and live announcements from both venues

Hedge Check is an independent, open-source tool. It is **not affiliated with Lighter or Robinhood**. Nothing here is financial advice.

## Is it safe?

- **Read-only.** There is no wallet connection, no signing and no private keys. The page only reads public data.
- **Runs in your browser.** Data comes straight from the public Lighter APIs to your browser. There is no database and no analytics.
- **Read-only tokens stay with you.** If you add a token to see your points, it is stored only in your browser (localStorage) and sent only to the Lighter API of that venue. It never passes through the proxy. A read-only token cannot trade or withdraw. You can remove it at any time with "Forget".
- **The proxy is a fallback only.** `api/proxy.js` relays GET requests to four whitelisted Lighter hosts, and only if a direct browser call fails. It refuses any request carrying an auth parameter.

## How to use it

1. Open the site and paste your wallet address (the same L1 address you use on both venues).
2. Read the pair cards. Green means hedged; yellow means "needs a tweak"; red means act now (one leg only, legs pointing the same way, a large size mismatch, or a leg close to liquidation).
3. Optional: add a read-only token to see points.
   - RH: robinhoodchain.lighter.xyz/read-only-tokens
   - Core: app.lighter.xyz/read-only-tokens
4. Share a result: the page URL ends with `#0x…`, so a link opens straight to that wallet.

## Updating the weekly notes

The team announces changes on Discord and X. Once a week, edit `weekly.json` and add a new entry at the top of `weeks`:

```json
{
  "week_of": "2026-09-28",
  "drop_points": 90000,
  "headline": "One sentence on what the team announced.",
  "boosts": [
    { "scope": "hedge", "x": 2, "categories": ["stock"], "note": "Only what was actually announced." }
  ],
  "warning": "Optional caution from the team.",
  "source": "Lighter Discord #announcements, Oct 2 2026"
}
```

- `week_of` is the Monday of that week (YYYY-MM-DD).
- `scope` is one of `hedge`, `market`, `wallet` or `other`.
- `x` is the multiplier. Leave it out if the team did not publish a number.
- `categories` can include `crypto`, `stock`, `etf`, `preipo`, `commodity` and `fx`.
- `symbols` can be used instead, for example `["NVDA", "TSLA"]`.

Commit the change and Vercel redeploys within a minute. If the newest entry is more than a week old, the site says so instead of pretending it is current.

## Deploy your own copy

1. Fork this repo (or upload the files to a new GitHub repo).
2. On vercel.com: **Add New → Project → Import** this repo. Framework preset: **Other**. No build command. Deploy.
3. Set your own referral code in `app.js` (`CONFIG.referralCode`) and your repo link (`CONFIG.repoUrl`).

There is no build step. It is plain HTML, CSS and JavaScript modules.

## Run the tests

You need Node.js 20 or newer:

```bash
npm test
```

The tests cover hedge analysis, funding signs, the liquidation estimate, volume counting (including self-matches), pair sizing and the proxy whitelist.

## Data sources

| What | Endpoint |
|---|---|
| Markets, margin, max leverage | `GET /api/v1/orderBookDetails` |
| Funding (rate per 8 hours) | `GET /api/v1/funding-rates` |
| Accounts and positions | `GET /api/v1/account?by=l1_address&value=0x…` |
| Announcements | `GET /api/v1/announcement` |
| Points and rank (token) | `GET /api/v1/livePoints/total`, `GET /api/v1/leaderboard` |
| Trade history for volume | `explorer.elliot.ai/api/accounts/{addr}/logs`, `explorerapi.rh.lighter.xyz/api/accounts/{addr}/logs` |

The API hosts are `api.rh.lighter.xyz` (RH) and `mainnet.zklighter.elliot.ai` (Core). Markets are matched across venues by symbol, because market IDs differ between them. Categories come from Core's `strategy_index`.

## What it does not do

- It does not trade, place orders or move funds.
- Liquidation prices for open positions come from Lighter. The calculator's liquidation figure is an isolated-margin estimate.
- Volume counts the last 7 days, up to 3,000 log entries per venue. Very active accounts show a "capped" note.
- It cannot tell you how points are calculated. Lighter does not publish that.

## License

MIT
