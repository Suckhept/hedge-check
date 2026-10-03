# Hedge Check: handoff for a browser agent

You are taking over **Hedge Check**, a finished static website. Your job is to publish it from the owner's own browser and confirm it works on live data. The code is written and its tests pass (14 of 14). It has **never been run against the live Lighter APIs**: the build environment could not reach them. That live check is the main thing left.

## What the product is

Hedge Check is a read-only dashboard for **Lighter**, a perp DEX that runs on two separate venues:

- **Lighter RH** (Robinhood Chain): API `https://api.rh.lighter.xyz`, explorer API `https://explorerapi.rh.lighter.xyz/api`, UI `https://robinhoodchain.lighter.xyz`
- **Lighter Core**: API `https://mainnet.zklighter.elliot.ai`, explorer API `https://explorer.elliot.ai/api`, UI `https://app.lighter.xyz`

Users farm points with a delta-neutral hedge: long on one venue and short on the other, from the same L1 address. A user pastes a wallet address and the site shows both venues side by side:

- whether each pair is hedged (delta in coins)
- distance to liquidation for each leg
- pair funding per day
- 7-day volume
- optionally, points (with a read-only token the user creates)

It also has a markets table, a pair calculator, weekly team notes from `weekly.json`, and live announcements.

The site is in English. The UI carries the owner's referral code **FREEDOM**: RH links get `?referral=FREEDOM`. The footer states that the site is independent and not affiliated with Lighter or Robinhood. Keep that statement.

## Files (all in the repo root)

| File | Role |
|---|---|
| `index.html` | page markup |
| `styles.css` | styles, light and dark |
| `app.js` | UI and network layer (ES module). `CONFIG` is at the top: referralCode, repoUrl, venues |
| `lib.js` | pure logic: market matching, hedge analysis, funding, liquidation estimate, volume, calculator |
| `weekly.json` | team updates, edited by hand each week |
| `api/proxy.js` | Vercel serverless GET proxy, fallback only. Whitelist of the 4 hosts above; refuses any `auth*` param |
| `vercel.json` | headers, including a CSP whose `connect-src` lists the 4 hosts |
| `favicon.svg`, `og.png` | icon and social preview |
| `tests/*.mjs`, `package.json` | `npm test` (Node 20+) |
| `README.md`, `LICENSE` (MIT) | docs |

There is no build step. Vercel framework preset: **Other**. Leave the build command empty.

## Verified API facts (do not "fix" these)

- `funding-rates` → `funding_rates[]` with `exchange`, `symbol`, `rate`. `rate` is **per 8 hours**.
- `orderBookDetails` → `order_book_details[]`. Note the units:
  - `maintenance_margin_fraction` and `min_initial_margin_fraction` are in 1/10000.
  - Max leverage is `10000 / min_initial_margin_fraction`.
  - `strategy_index` on Core gives the category: 2 crypto, 3 commodity, 4 FX, 5/6 stocks, 7 pre-IPO. RH reports 0, so categories come from Core.
- Market IDs differ between venues, so markets are matched by **symbol**.
- `account?by=l1_address&value=0x…` → `accounts[]` with `positions[]`:
  - `sign` is 1 or −1.
  - `position` is the absolute size.
  - `initial_margin_fraction` is a percent string ("33.33" = 3x).
  - `total_asset_value` is equity.
- Explorer logs (`/accounts/{addr}/logs?limit=100&offset=N`) come newest first. Trades are in `pubdata.trade_pubdata` or `trade_pubdata_with_funding`.
- All four hosts send CORS headers to any origin, so the browser calls them directly.
- **Unverified:** how a read-only token is passed for `livePoints/total` and `leaderboard`. The code first tries the token as an `authorization` header, then as an `auth=` query parameter.

## Your tasks, in order

The owner is logged in to GitHub (user **Suckhept**) and Vercel in this browser.

1. **Repository.** Check that `https://github.com/Suckhept/hedge-check` exists and contains the files above at the root. The root must not be a nested `hedge-check-v2/` folder. If it is empty, ask the owner to drag the unzipped files into GitHub's "uploading an existing file" page and commit. Don't try to reach their file system yourself.
2. **Deploy.**
   - On vercel.com: Add New → Project → Import `Suckhept/hedge-check`. Framework **Other**, no build command. Deploy.
   - If Vercel asks to install or authorize its GitHub app, stop and let the owner click approve.
3. **Live check on the deployed URL.** Open DevTools console, or read console messages, and go through this list:
   - [ ] No errors in the console on load. The markets table fills in (about 40+ markets active on both venues).
   - [ ] Funding columns show small percentages, around ±0.00x% per 8h, not huge numbers. Max leverage looks sane (e.g. 3x–50x).
   - [ ] "This week" filter and category filters work. Search works. Column sorting works.
   - [ ] Clicking a row fills the calculator. Size, margin and liquidation estimate look plausible. The "Open on Lighter RH" link has `?referral=FREEDOM`.
   - [ ] The team-update card and the "Team updates" section render from `weekly.json`. Announcements from both venues appear (or nothing, if none are active).
   - [ ] Paste the owner's address. The owner will give it to you; never hardcode it as a demo. Then confirm:
     - Venue cards show equity, free margin and positions.
     - Pair cards appear.
     - Compare with what the owner sees in the Lighter UIs: positions, sizes, liquidation prices.
     - The 7-day volume finishes counting on both venues.
   - [ ] The URL becomes `…/#0x…` and reloading it opens the same wallet. "Copy link" works.
   - [ ] Dark mode toggle works. The layout is OK at phone width (resize to ~390px).
   - [ ] Optional points: the owner creates read-only tokens at `robinhoodchain.lighter.xyz/read-only-tokens` and `app.lighter.xyz/read-only-tokens`. **They paste the token into the site themselves; you never type tokens, keys or passwords.** Check that points or rank appear. If both auth modes fail, open the Lighter UI's network tab on the points page, see how the UI sends the token, and adjust `loadPoints()` in `app.js`.
   - [ ] `https://<deploy>/api/proxy?url=https://evil.com/api/x` returns 400 "host not allowed".
4. **Fix what's broken.**
   - Edit files in GitHub's web editor: pencil icon → commit to `main`. Vercel redeploys automatically.
   - Keep fixes minimal. Don't change the verified API facts above. Don't add trackers, analytics or third-party scripts. The CSP blocks them anyway; if you add a host, update `vercel.json`.
   - If you change `lib.js`, mirror the change in `tests/lib.test.mjs` if you can.
5. **Report to the owner, in Russian:**
   - the live URL
   - what passed and what you fixed (with commit links)
   - anything still open

## Hard rules

- Read-only product. Never add trading, signing, wallet connection or private-key fields.
- Never enter passwords, tokens, API keys or seed phrases. Never approve OAuth or app installs yourself. The owner does those.
- Don't publish the owner's wallet address anywhere in the code or README.
- Keep "independent, not affiliated with Lighter or Robinhood" and "Not financial advice" visible.
- Don't invent API endpoints. If something is unclear, inspect what the official Lighter UI calls in the network tab.
