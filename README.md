# DealDrop – Black Friday tracker

A static site that ranks Black Friday deals by discount, with categories, per-store price history and a "highest discount store" pick for each product.

- **Home**: countdown to Black Friday, category grid, top 12 highest discounts (sort by % off or $ saved).
- **Category**: every tracked product, sortable by % off / $ saved / price, filterable by best store and "90-day lows only".
- **Product**: highest-discount store with a Buy link, price-history chart, store comparison table, and a verdict on whether the price is really the lowest seen.

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

Then merge this branch into the default branch (GitHub only runs scheduled workflows from there) and
open **Actions → Update Black Friday prices → Run workflow** for the first update. After that it runs
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

### Hosting

Serve the `black-friday-tracker/` folder from any static host (GitHub Pages, Netlify, Vercel) so
that `data/prices.json` sits next to `index.html`. Opening `index.html` straight from disk can't
load the JSON (browsers block `fetch` on `file://`), so it falls back to sample data.

### Notes

- Discount = Best Buy's sale price vs. its regular price.
- History starts the day the job first runs; the "real deal" verdict appears after about a week of data.
- More stores (for example Target) can be added the same way: another lookup by UPC that adds an
  entry to each product's `offers`.
