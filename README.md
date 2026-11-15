# DealDrop – Black Friday tracker

A standalone, single-file site (no build step) that ranks Black Friday deals by discount.

- **Home**: countdown to Black Friday, category grid, top 12 highest discounts (sort by % off or $ saved).
- **Category**: every product in the category, sortable by % off / $ saved / price, filterable by best store and "90-day lows only".
- **Product**: highest-discount store, 90-day price-history chart per store (30/60/90-day ranges, hover for prices), store comparison table, and a verdict on whether the deal is really the lowest price (flags stores that inflated prices before discounting).

Open `index.html` in a browser, or deploy the folder to any static host.

> Products, stores and prices are generated sample data, and product pictures are drawn as inline SVG (`DRAW` / `productArt` in the script). To use real data, replace the `CATS`/`PRODUCTS` generation with a feed of `{ product, msrp, image, offers: [{ store, history[] }] }` and swap `productArt(p)` for an `<img src>` of the product photo.
