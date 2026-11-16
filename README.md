# DealDrop – Black Friday tracker

A static site that ranks Black Friday deals by discount, with categories, per-store price history and a "highest discount store" pick for each product.

- **Home**: countdown to Black Friday, category grid, top 12 highest discounts (sort by % off or $ saved).
- **Category**: every tracked product, sortable by % off / $ saved / price, filterable by best store and "90-day lows only".
- **Product**: highest-discount store with a Buy link, price-history chart, store comparison table, a verdict on whether the price is really the lowest seen, and a **price alert** form.
- **My alerts**: every target set on this device, with the current best price and "Target reached" status.

- **Hot deals**: the best current deals from every store on the internet, refreshed every 15 minutes, with promo codes and direct store links that carry DealDrop's affiliate code.

## Hot deals from every store (no keys needed)

`scripts/fetch-deals.mjs` runs every 15 minutes (`.github/workflows/update-deals.yml`) and writes `data/deals.json`:

1. **Collects** deals from public deal feeds (Slickdeals frontpage, popular and per-store searches; DealNews main and
   per-store feeds for Amazon, Walmart, Lowe's, Best Buy, eBay and Newegg; r/buildapcsales) and, when keys are set,
   from affiliate networks (FMTC covers deals from every major network; Impact covers brands you have joined).
   Each feed can be switched off in `data/deal-sources.json`.
2. **Merges** the same deal posted on several sites (by Amazon ASIN or title) and keeps every source credited.
3. **Ranks** by community votes, editor picks, "best-ever price" notes, discount depth, agreement between sites and freshness.
   Deals older than 72 hours or past their end date drop off.

The page shows them on the home page and under **Hot deals · every store** (sort, filter by store or category, "with promo code"
only, one-click code copy). Every deal links straight to the store, never to the deal site: the product page when known
(Amazon ASIN, direct links), otherwise a search for that product on the store's own site. Deals with no store link are dropped.
The deal sites' own click links are never followed, so no fake clicks are sent to their affiliate accounts.
While there is no Best Buy key, the home page shows only these real deals instead of the demo catalog.

Run it locally: `node scripts/fetch-deals.mjs`

## DealDrop's affiliate code on every store link

Outbound store links are rewritten in the browser from the public IDs in `data/site-config.json`:

| Field | What it does | Where to get it |
|---|---|---|
| `amazonTag` | Adds `?tag=…` to every Amazon link, and turns Amazon deals found by ASIN into direct Amazon links | Amazon Associates (free): https://affiliate-program.amazon.com |
| `sovrnKey` | Wraps every other store link (Best Buy, Walmart, Target, Home Depot, eBay, …, ~50,000 stores) in a Sovrn Commerce redirect that pays a commission | Sovrn Commerce (free): https://www.sovrn.com/publishers/commerce/ → Commerce settings → Sites → API key |

Both values are public by design (they appear in every link), so they live in the repository, not in secrets.
Links that already carry an affiliate code (FMTC, Impact, Walmart/Amazon API links) are left alone. The site shows a
commission disclosure next to the deals as soon as either field is set.

Optional affiliate-network deal feeds (repository **secrets**): `FMTC_API_TOKEN` (https://www.fmtc.co), or
`IMPACT_ACCOUNT_SID` + `IMPACT_AUTH_TOKEN` (https://impact.com → Settings → API). Their deals arrive with your
affiliate links already built in.

## Real prices (US: Best Buy, Walmart, Amazon)

`scripts/update-prices.mjs` runs once a day:

1. **Best Buy** decides what is tracked: the most-discounted products in each category from the
   [Best Buy Products API](https://developer.bestbuy.com), plus products tracked in the last 14 days.
2. **Walmart** ([Affiliate Product API](https://walmart.io)) and **Amazon**
   ([Product Advertising API 5.0](https://webservices.amazon.com/paapi5/documentation/)) are looked up
   for the same products by UPC barcode. Only exact barcode matches are used, so a product a store
   doesn't carry simply shows fewer stores. Failed matches are retried weekly.
3. Prices go into `data/prices.json` (90 days kept). The page loads that file; if it is missing,
   the page shows built-in sample data and says so.

Discount is measured against Best Buy's regular price for every store, so stores compare fairly.
Each store is optional except Best Buy: missing keys mean that store is skipped.

### One-time setup

Add these as GitHub repository secrets (**Settings → Secrets and variables → Actions**):

| Store | Secrets | Where to get them |
|---|---|---|
| Best Buy (required) | `BESTBUY_API_KEY` | Free at https://developer.bestbuy.com |
| Walmart | `WALMART_CONSUMER_ID`, `WALMART_PRIVATE_KEY` (the PEM private key you generated), `WALMART_KEY_VERSION` (usually `1`), optional `WALMART_PUBLISHER_ID` (Impact affiliate id for commission links) | Register an app at https://walmart.io and upload your public key |
| Amazon | `AMAZON_ACCESS_KEY`, `AMAZON_SECRET_KEY`, `AMAZON_PARTNER_TAG` (e.g. `yourtag-20`) | Amazon Associates account → Tools → Product Advertising API. Amazon only grants API access after the Associates account has made qualifying sales. |

Then make sure this code is on the default branch (GitHub only runs scheduled workflows from there) and
open **Actions → Update Black Friday prices → Run workflow** for the first update. Until `BESTBUY_API_KEY` is set,
the job skips itself without failing. After that it runs
daily at 11:17 UTC and commits the new `data/prices.json`.

Run it locally:

```bash
BESTBUY_API_KEY=... WALMART_CONSUMER_ID=... WALMART_PRIVATE_KEY="$(cat walmart_private_key.pem)" AMAZON_ACCESS_KEY=... AMAZON_SECRET_KEY=... AMAZON_PARTNER_TAG=... node scripts/update-prices.mjs
```

Categories live in `data/categories.json`. To find a Best Buy category id:

```bash
BESTBUY_API_KEY=your-key node scripts/update-prices.mjs --find-category "Laptops"
```

### Amazon rules to know

- Amazon's API license limits how long its data may be stored (24 hours for most content), so by
  default only today's Amazon price is kept and Amazon has no history line. Set
  `AMAZON_KEEP_HISTORY=true` only if you've confirmed your use is allowed.
- Amazon links use your partner tag, and the page shows the required Associates disclosure and an
  "accurate as of" note whenever Amazon prices are present.
- Daily updates are the minimum; Amazon expects displayed prices to be refreshed at least every 24 hours.

## Price alerts (target price + email)

On any product page, a visitor enters a target price and their email. The best price across all
stores is checked after every daily price update; when it is at or below the target, one email
goes out with the price, the store and a Buy link. Alerts are one-time; setting a new target
re-arms it.

How it fits together:

- **Supabase** stores alerts. `supabase/setup.sql` creates one table and three functions
  (create, confirm, unsubscribe). The site only calls those functions with the public anon key;
  the table itself can't be read with that key.
- **Double opt-in**: each new alert gets a confirmation email first (sent within ~15 minutes by
  `.github/workflows/alert-confirmations.yml`), so nobody can sign up someone else's address.
  Each address can watch up to 25 products, and confirmation emails aren't re-sent more than once a day.
- **Resend** sends the emails (`scripts/send-alerts.mjs`). Every email has an unsubscribe link and a
  `List-Unsubscribe` header; the unsubscribe page also offers "Stop all my alerts".
- Without Supabase configured, the form still saves targets on the visitor's device and shows them
  under **My alerts**, but no emails are sent.

**Current status: device-only.** `data/site-config.json` is empty, so the form saves targets in
the visitor's browser (shown under My alerts, with "Target reached" marks) and hides the email field.
The email pieces below are in place but dormant: the 15-minute confirmation workflow is unscheduled,
and the daily alert step skips itself while its secrets are missing.

### Setup (to switch email on later)

1. Create a Supabase project (free) at https://supabase.com/dashboard, open **SQL Editor**, paste
   `supabase/setup.sql` and run it.
2. In **Project Settings → API**, copy the **Project URL** and the **anon public** key into
   `data/site-config.json`. Both are meant to be public.
3. Create a Resend account at https://resend.com, verify a domain you own (needed to email anyone
   other than yourself) and create an API key.
4. Add GitHub repository **secrets**: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (Project Settings →
   API → service_role; keep it secret), `RESEND_API_KEY`, `ALERT_FROM` (e.g.
   `DealDrop <alerts@yourdomain.com>`). Add a repository **variable** `SITE_URL` with the public
   address of the site, used for links in emails.
5. Uncomment the `schedule` block in `.github/workflows/alert-confirmations.yml`.

Test the email script without sending anything:

```bash
ALERTS_MOCK_FILE=alerts.json EMAIL_DRY_RUN=1 SITE_URL=https://example.com/ node scripts/send-alerts.mjs
```

### Hosting

Serve this repository from any static host (GitHub Pages, Netlify, Vercel) so
that `data/prices.json` sits next to `index.html`. Opening `index.html` straight from disk can't
load the JSON (browsers block `fetch` on `file://`), so it falls back to sample data.

### Notes

- Discount = Best Buy's sale price vs. its regular price.
- History starts the day the job first runs; the "real deal" verdict appears after about a week of data.
- More stores (for example Target) can be added the same way: another lookup by UPC that adds an
  entry to each product's `offers`.

### GitHub Pages (simplest hosting)

In the repository: **Settings → Pages → Build and deployment → Deploy from a branch**, pick `main`
and `/ (root)`. The site appears at `https://<your-username>.github.io/<repo-name>/` and picks up
each day's `data/prices.json` automatically. Use that address as the `SITE_URL` variable.
