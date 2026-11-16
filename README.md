# DealDrop – Black Friday tracker

A static site that ranks Black Friday deals by discount, with categories, per-store price history and a "highest discount store" pick for each product.

- **Home**: countdown to Black Friday, category grid, top 12 highest discounts (sort by % off or $ saved).
- **Category**: every tracked product, sortable by % off / $ saved / price, filterable by best store and "90-day lows only".
- **Product**: highest-discount store with a Buy link, price-history chart, store comparison table, and a verdict on whether the price is really the lowest seen.

## Real prices (US, Best Buy)

`scripts/update-prices.mjs` fetches the most-discounted products in each category from the
[Best Buy Products API](https://developer.bestbuy.com), re-checks products it is already tracking,
and appends today's prices to `data/prices.json` (90 days kept). The page loads that file; if it
is missing, the page shows built-in sample data and says so.

### One-time setup

1. Get a free API key at https://developer.bestbuy.com.
2. In GitHub: **Settings → Secrets and variables → Actions → New repository secret**, name `BESTBUY_API_KEY`.
3. Merge this branch into the default branch. GitHub only runs scheduled workflows from the default branch.
4. Open **Actions → Update Black Friday prices → Run workflow** for the first update. After that it runs daily at 11:17 UTC and commits the new `data/prices.json`.

Run it locally:

```bash
BESTBUY_API_KEY=your-key node scripts/update-prices.mjs
```

Categories live in `data/categories.json`. To find a Best Buy category id:

```bash
BESTBUY_API_KEY=your-key node scripts/update-prices.mjs --find-category "Laptops"
```

### Hosting

Serve the `black-friday-tracker/` folder from any static host (GitHub Pages, Netlify, Vercel) so
that `data/prices.json` sits next to `index.html`. Opening `index.html` straight from disk can't
load the JSON (browsers block `fetch` on `file://`), so it falls back to sample data.

### Notes

- Discount = Best Buy's sale price vs. its regular price.
- History starts the day the job first runs; the "real deal" verdict appears after about a week of data.
- Only Best Buy is wired up. More stores (for example Walmart or Target) can be added as extra `offers`
  on each product, matched by UPC, which the script already stores.
