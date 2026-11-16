#!/usr/bin/env node
/*
 * DealDrop daily price updater.
 *
 * Fetches the most-discounted products in each category from the Best Buy
 * Products API, re-checks every product already being tracked, and appends
 * today's prices to data/prices.json (90 days of history is kept).
 *
 *   BESTBUY_API_KEY=xxxx node scripts/update-prices.mjs
 *   BESTBUY_API_KEY=xxxx node scripts/update-prices.mjs --find-category "laptops"
 *
 * Get a free key at https://developer.bestbuy.com. No npm dependencies (Node 18+).
 * For tests, BESTBUY_MOCK_DIR=<dir> reads responses from <dir>/<category-id>.json
 * and <dir>/skus.json instead of calling the API.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_FILE = join(ROOT, "data", "prices.json");
const CONFIG_FILE = join(ROOT, "data", "categories.json");
const HISTORY_DAYS = 90;
const KEEP_AFTER_DROP_DAYS = 14;   // keep tracking a product this long after it leaves the top list
const API = "https://api.bestbuy.com/v1";
const KEY = process.env.BESTBUY_API_KEY;
const MOCK = process.env.BESTBUY_MOCK_DIR;
const TODAY = process.env.PRICES_DATE || new Date().toISOString().slice(0, 10);
const FIELDS = "sku,name,manufacturer,regularPrice,salePrice,onSale,image,url,upc,orderable";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log("[prices]", ...a);

async function api(path, params = {}) {
  const qs = new URLSearchParams({ format: "json", apiKey: KEY, ...params });
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(`${API}/${path}?${qs}`);
    if (res.ok) { await sleep(250); return res.json(); }          // free tier allows ~5 calls/second
    if (res.status === 403 || res.status === 429 || res.status >= 500) { await sleep(1000 * 2 ** attempt); continue; }
    throw new Error(`Best Buy API ${res.status} for ${path}: ${(await res.text()).slice(0, 200)}`);
  }
  throw new Error(`Best Buy API kept failing for ${path}`);
}

async function topDeals(cat) {
  if (MOCK) return JSON.parse(await readFile(join(MOCK, `${cat.id}.json`), "utf8")).products;
  const q = `products((categoryPath.id=${cat.bestbuyCategory})&onSale=true&active=true)`;
  const data = await api(q, { show: FIELDS, sort: "dollarSavings.dsc", pageSize: "100" });
  return data.products;
}

async function bySkus(skus) {
  if (!skus.length) return [];
  if (MOCK) { try { return JSON.parse(await readFile(join(MOCK, "skus.json"), "utf8")).products.filter(p => skus.includes(p.sku)); } catch { return []; } }
  const out = [];
  for (let i = 0; i < skus.length; i += 100) {
    const data = await api(`products(sku in(${skus.slice(i, i + 100).join(",")}))`, { show: FIELDS, pageSize: "100" });
    out.push(...data.products);
  }
  return out;
}

const cleanName = (name, brand) => {
  const n = String(name || "").trim();
  return brand && n.toLowerCase().startsWith(brand.toLowerCase() + " - ") ? n.slice(brand.length + 3) : n;
};
const pctOff = p => p.regularPrice > 0 ? (p.regularPrice - p.salePrice) / p.regularPrice : 0;

async function findCategory(term) {
  const data = await api(`categories(name=${term}*)`, { show: "id,name,path.name", pageSize: "50" });
  for (const c of data.categories) console.log(c.id.padEnd(24), c.path.map(x => x.name).join(" > "));
}

async function main() {
  if (!KEY && !MOCK) { console.error("Set BESTBUY_API_KEY (free at https://developer.bestbuy.com)."); process.exit(1); }
  const fi = process.argv.indexOf("--find-category");
  if (fi > 0) return findCategory(process.argv[fi + 1] || "");

  const config = JSON.parse(await readFile(CONFIG_FILE, "utf8"));
  let db;
  try { db = JSON.parse(await readFile(DATA_FILE, "utf8")); } catch { db = null; }
  if (!db || !Array.isArray(db.dates)) db = { dates: [], products: [] };

  // 1) today's column
  let col = db.dates.indexOf(TODAY);
  if (col === -1) {
    db.dates.push(TODAY);
    db.products.forEach(p => p.offers.forEach(o => o.hist.push(null)));
    col = db.dates.length - 1;
  }
  const len = db.dates.length;
  const byId = new Map(db.products.map(p => [p.id, p]));

  const upsert = (bb, catId, isTop) => {
    if (!bb || !(bb.salePrice > 0)) return;
    const id = "bb-" + bb.sku;
    let p = byId.get(id);
    if (!p) {
      p = { id, sku: bb.sku, cat: catId, offers: [{ store: "bestbuy", hist: Array(len).fill(null) }] };
      byId.set(id, p); db.products.push(p);
    }
    p.brand = bb.manufacturer || p.brand || "";
    p.name = cleanName(bb.name, p.brand);
    p.msrp = bb.regularPrice || p.msrp;
    p.image = bb.image || p.image;
    p.upc = bb.upc || p.upc;
    const offer = p.offers.find(o => o.store === "bestbuy");
    offer.url = bb.url || offer.url;
    offer.hist[col] = bb.orderable === "SoldOut" ? null : Math.round(bb.salePrice * 100) / 100;
    if (isTop) p.lastTop = TODAY;
  };

  // 2) top deals per category
  let fetched = 0;
  for (const cat of config.categories) {
    try {
      const list = (await topDeals(cat)).filter(p => p.regularPrice > 0 && p.salePrice > 0)
        .sort((a, b) => pctOff(b) - pctOff(a)).slice(0, config.perCategory || 12);
      list.forEach(bb => upsert(bb, cat.id, true));
      fetched += list.length;
      log(`${cat.name}: ${list.length} deals`);
    } catch (e) { log(`${cat.name}: skipped (${e.message})`); }
  }
  if (!fetched) throw new Error("No prices fetched for any category; leaving data unchanged.");

  // 3) re-check products tracked earlier that are no longer in a top list
  const cutoff = new Date(TODAY); cutoff.setDate(cutoff.getDate() - KEEP_AFTER_DROP_DAYS);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  db.products = db.products.filter(p => (p.lastTop || "") >= cutoffStr);
  const stale = db.products.filter(p => p.offers[0].hist[col] == null && p.lastTop !== TODAY).map(p => p.sku);
  try { (await bySkus(stale)).forEach(bb => upsert(bb, byId.get("bb-" + bb.sku).cat, false)); }
  catch (e) { log(`re-check skipped (${e.message})`); }

  // 4) trim to the history window and drop columns no product uses
  const drop = Math.max(0, db.dates.length - HISTORY_DAYS);
  if (drop) { db.dates = db.dates.slice(drop); db.products.forEach(p => p.offers.forEach(o => (o.hist = o.hist.slice(drop)))); }

  const out = {
    updatedAt: new Date().toISOString(),
    source: "Best Buy Products API",
    dates: db.dates,
    stores: [{ id: "bestbuy", name: "Best Buy" }],
    categories: config.categories.map(({ id, name, ico }) => ({ id, name, ico })),
    products: db.products,
  };
  await mkdir(dirname(DATA_FILE), { recursive: true });
  await writeFile(DATA_FILE, JSON.stringify(out));
  log(`saved ${out.products.length} products, ${out.dates.length} day(s) of history → data/prices.json`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
