#!/usr/bin/env node
/*
 * DealDrop daily price updater.
 *
 * 1. Best Buy: fetches the most-discounted products in each category (this decides
 *    which products are tracked) and re-checks products tracked earlier.
 * 2. Walmart and Amazon: looks up each tracked product by its UPC barcode and
 *    records their price for the same item.
 * Today's prices are appended to data/prices.json (90 days of history).
 *
 *   node scripts/update-prices.mjs
 *   node scripts/update-prices.mjs --find-category "laptops"     (Best Buy category ids)
 *
 * Environment (each store is skipped if its keys are missing; Best Buy is required):
 *   BESTBUY_API_KEY                         https://developer.bestbuy.com
 *   WALMART_CONSUMER_ID, WALMART_PRIVATE_KEY (PEM), WALMART_KEY_VERSION (default 1)
 *                                           https://walmart.io (Affiliate Product API)
 *   AMAZON_ACCESS_KEY, AMAZON_SECRET_KEY, AMAZON_PARTNER_TAG
 *                                           Amazon Associates, Product Advertising API 5.0
 *   AMAZON_KEEP_HISTORY=true                keep past Amazon prices (off by default, see README)
 *
 * No npm dependencies (Node 18+). For tests, BESTBUY_MOCK_DIR=<dir> reads canned
 * responses: <dir>/<category-id>.json, skus.json, walmart.json, amazon.json.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createSign, createHmac, createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_FILE = join(ROOT, "data", "prices.json");
const CONFIG_FILE = join(ROOT, "data", "categories.json");
const HISTORY_DAYS = 90;
const KEEP_AFTER_DROP_DAYS = 14;   // keep tracking a product this long after it leaves the top list
const RETRY_MISS_DAYS = 7;         // retry a failed Walmart/Amazon match after this many days
const env = process.env;
const MOCK = env.BESTBUY_MOCK_DIR;
const TODAY = env.PRICES_DATE || new Date().toISOString().slice(0, 10);

export const STORES = [
  { id: "bestbuy", name: "Best Buy", color: 1 },
  { id: "walmart", name: "Walmart", color: 2 },
  { id: "amazon", name: "Amazon", color: 3 },
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log("[prices]", ...a);
const round2 = v => Math.round(v * 100) / 100;
const normUpc = u => String(u || "").replace(/\D/g, "").replace(/^0+/, "");
const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 864e5);
const mockFile = async name => JSON.parse(await readFile(join(MOCK, name), "utf8"));

async function fetchRetry(url, opts = {}, label = url) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(url, opts);
    if (res.ok) return res.json();
    if (res.status === 404) return null;
    if (res.status === 429 || res.status >= 500 || res.status === 403 && /best ?buy/i.test(label)) { await sleep(1000 * 2 ** attempt); continue; }
    throw new Error(`${label}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  throw new Error(`${label}: kept failing`);
}

/* ---------------- Best Buy ---------------- */
const BB_FIELDS = "sku,name,manufacturer,regularPrice,salePrice,onSale,image,url,upc,orderable";
async function bestbuy(path, params = {}) {
  const qs = new URLSearchParams({ format: "json", apiKey: env.BESTBUY_API_KEY, ...params });
  const data = await fetchRetry(`https://api.bestbuy.com/v1/${path}?${qs}`, {}, "Best Buy");
  await sleep(250);                                  // free tier allows ~5 calls/second
  return data || {};
}
async function bbTopDeals(cat) {
  if (MOCK) return (await mockFile(`${cat.id}.json`)).products;
  const q = `products((categoryPath.id=${cat.bestbuyCategory})&onSale=true&active=true)`;
  return (await bestbuy(q, { show: BB_FIELDS, sort: "dollarSavings.dsc", pageSize: "100" })).products || [];
}
async function bbBySkus(skus) {
  if (!skus.length) return [];
  if (MOCK) { try { return (await mockFile("skus.json")).products.filter(p => skus.includes(p.sku)); } catch { return []; } }
  const out = [];
  for (let i = 0; i < skus.length; i += 100) {
    const d = await bestbuy(`products(sku in(${skus.slice(i, i + 100).join(",")}))`, { show: BB_FIELDS, pageSize: "100" });
    out.push(...(d.products || []));
  }
  return out;
}

/* ---------------- Walmart (Affiliate Product API) ---------------- */
const walmartEnabled = () => MOCK ? true : !!(env.WALMART_CONSUMER_ID && env.WALMART_PRIVATE_KEY);
export function walmartHeaders(consumerId, privateKeyPem, keyVersion, ts = Date.now().toString()) {
  // Walmart signs "<consumer id>\n<timestamp>\n<key version>\n" with RSA-SHA256.
  const sig = createSign("RSA-SHA256").update(`${consumerId}\n${ts}\n${keyVersion}\n`).sign(privateKeyPem, "base64");
  return { "WM_CONSUMER.ID": consumerId, "WM_CONSUMER.INTIMESTAMP": ts, "WM_SEC.KEY_VERSION": keyVersion, "WM_SEC.AUTH_SIGNATURE": sig, Accept: "application/json" };
}
async function walmartByUpc(upc) {
  let items;
  if (MOCK) { try { items = [(await mockFile("walmart.json"))[upc]].filter(Boolean); } catch { items = []; } }
  else {
    const key = env.WALMART_PRIVATE_KEY.includes("BEGIN") ? env.WALMART_PRIVATE_KEY.replace(/\\n/g, "\n") : `-----BEGIN PRIVATE KEY-----\n${env.WALMART_PRIVATE_KEY}\n-----END PRIVATE KEY-----`;
    const headers = walmartHeaders(env.WALMART_CONSUMER_ID, key, env.WALMART_KEY_VERSION || "1");
    const qs = new URLSearchParams({ upc });
    if (env.WALMART_PUBLISHER_ID) qs.set("publisherId", env.WALMART_PUBLISHER_ID);
    const d = await fetchRetry(`https://developer.api.walmart.com/api-proxy/service/affil/product/v2/items?${qs}`, { headers }, "Walmart");
    items = (d && d.items) || [];
    await sleep(200);
  }
  const it = items.find(i => normUpc(i.upc) === normUpc(upc));   // only accept an exact barcode match
  if (!it) return null;
  const inStock = !it.stock || !/not available|out of stock/i.test(it.stock);
  return { price: inStock && it.salePrice > 0 ? round2(it.salePrice) : null, url: it.productTrackingUrl || it.productUrl, ref: String(it.itemId || "") };
}

/* ---------------- Amazon (Product Advertising API 5.0) ---------------- */
const amazonEnabled = () => MOCK ? true : !!(env.AMAZON_ACCESS_KEY && env.AMAZON_SECRET_KEY && env.AMAZON_PARTNER_TAG);
const hmac = (k, s) => createHmac("sha256", k).update(s).digest();
const sha256 = s => createHash("sha256").update(s).digest("hex");
/** AWS Signature Version 4. Returns the Authorization header value. */
export function sigV4({ method, host, path, query = "", headers, body, accessKey, secretKey, region, service, amzDate }) {
  const date = amzDate.slice(0, 8);
  const names = Object.keys(headers).map(h => h.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()]));
  const signed = names.join(";");
  const canonical = [method, path, query, names.map(n => `${n}:${lower[n]}\n`).join(""), signed, sha256(body)].join("\n");
  const scope = `${date}/${region}/${service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac("AWS4" + secretKey, date), region), service), "aws4_request");
  const signature = createHmac("sha256", key).update(toSign).digest("hex");
  return `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signed}, Signature=${signature}`;
}
const PAAPI_RESOURCES = ["ItemInfo.Title", "ItemInfo.ExternalIds", "OffersV2.Listings.Price", "OffersV2.Listings.Availability", "Offers.Listings.Price"];
async function paapi(op, payload) {
  const host = "webservices.amazon.com", path = `/paapi5/${op.toLowerCase()}`;
  const body = JSON.stringify({ ...payload, PartnerTag: env.AMAZON_PARTNER_TAG, PartnerType: "Associates", Marketplace: "www.amazon.com", Resources: PAAPI_RESOURCES });
  const amzDate = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const headers = {
    "content-encoding": "amz-1.0", "content-type": "application/json; charset=utf-8", host,
    "x-amz-date": amzDate, "x-amz-target": `com.amazon.paapi5.v1.ProductAdvertisingAPIv1.${op}`,
  };
  const auth = sigV4({ method: "POST", host, path, headers, body, accessKey: env.AMAZON_ACCESS_KEY, secretKey: env.AMAZON_SECRET_KEY, region: "us-east-1", service: "ProductAdvertisingAPI", amzDate });
  const d = await fetchRetry(`https://${host}${path}`, { method: "POST", headers: { ...headers, Authorization: auth }, body }, "Amazon");
  await sleep(1100);                                 // new accounts get 1 request/second
  return d || {};
}
const amazonPrice = item => {
  const l = ((item.OffersV2 && item.OffersV2.Listings) || (item.Offers && item.Offers.Listings) || [])[0];
  if (!l || !l.Price) return null;
  const amt = l.Price.Money ? l.Price.Money.Amount : l.Price.Amount;
  return amt > 0 ? round2(amt) : null;
};
const amazonUpcs = item => ((item.ItemInfo && item.ItemInfo.ExternalIds && item.ItemInfo.ExternalIds.UPCs && item.ItemInfo.ExternalIds.UPCs.DisplayValues) || []).map(normUpc);
async function amazonByUpc(upc) {
  let items;
  if (MOCK) { try { items = [(await mockFile("amazon.json"))[upc]].filter(Boolean); } catch { items = []; } }
  else items = ((await paapi("SearchItems", { Keywords: upc, SearchIndex: "All", ItemCount: 5 })).SearchResult || {}).Items || [];
  const it = items.find(i => amazonUpcs(i).includes(normUpc(upc)));   // only accept an exact barcode match
  return it ? { price: amazonPrice(it), url: it.DetailPageURL, ref: it.ASIN } : null;
}
async function amazonByAsins(asins) {
  const out = new Map();
  if (MOCK) { try { Object.values(await mockFile("amazon.json")).filter(i => asins.includes(i.ASIN)).forEach(i => out.set(i.ASIN, i)); } catch {} return out; }
  for (let i = 0; i < asins.length; i += 10) {
    const d = await paapi("GetItems", { ItemIds: asins.slice(i, i + 10), ItemIdType: "ASIN" });
    ((d.ItemsResult || {}).Items || []).forEach(it => out.set(it.ASIN, it));
  }
  return out;
}

/* ---------------- main ---------------- */
const cleanName = (name, brand) => {
  const n = String(name || "").trim();
  return brand && n.toLowerCase().startsWith(brand.toLowerCase() + " - ") ? n.slice(brand.length + 3) : n;
};
const pctOff = p => p.regularPrice > 0 ? (p.regularPrice - p.salePrice) / p.regularPrice : 0;

async function findCategory(term) {
  const d = await bestbuy(`categories(name=${term}*)`, { show: "id,name,path.name", pageSize: "50" });
  for (const c of d.categories || []) console.log(c.id.padEnd(24), c.path.map(x => x.name).join(" > "));
}

async function main() {
  if (!env.BESTBUY_API_KEY && !MOCK) {
    if (process.argv.includes("--skip-if-unconfigured")) { log("skipped: BESTBUY_API_KEY not set (hot deals still update on their own)"); return; }
    console.error("Set BESTBUY_API_KEY (free at https://developer.bestbuy.com)."); process.exit(1);
  }
  const fi = process.argv.indexOf("--find-category");
  if (fi > 0) return findCategory(process.argv[fi + 1] || "");

  const config = JSON.parse(await readFile(CONFIG_FILE, "utf8"));
  let db;
  try { db = JSON.parse(await readFile(DATA_FILE, "utf8")); } catch { db = null; }
  if (!db || !Array.isArray(db.dates)) db = { dates: [], products: [] };

  let col = db.dates.indexOf(TODAY);
  if (col === -1) {
    db.dates.push(TODAY);
    db.products.forEach(p => p.offers.forEach(o => o.hist.push(null)));
    col = db.dates.length - 1;
  }
  const len = db.dates.length;
  const byId = new Map(db.products.map(p => [p.id, p]));
  const offerFor = (p, store) => {
    let o = p.offers.find(x => x.store === store);
    if (!o) { o = { store, hist: Array(len).fill(null) }; p.offers.push(o); }
    return o;
  };

  const upsertBestBuy = (bb, catId, isTop) => {
    if (!bb || !(bb.salePrice > 0)) return;
    const id = "bb-" + bb.sku;
    let p = byId.get(id);
    if (!p) { p = { id, sku: bb.sku, cat: catId, offers: [] }; byId.set(id, p); db.products.push(p); }
    p.brand = bb.manufacturer || p.brand || "";
    p.name = cleanName(bb.name, p.brand);
    p.msrp = bb.regularPrice || p.msrp;
    p.image = bb.image || p.image;
    p.upc = bb.upc || p.upc;
    const o = offerFor(p, "bestbuy");
    o.url = bb.url || o.url;
    o.hist[col] = bb.orderable === "SoldOut" ? null : round2(bb.salePrice);
    if (isTop) p.lastTop = TODAY;
  };

  // 1) Best Buy top deals per category
  let fetched = 0;
  for (const cat of config.categories) {
    try {
      const list = (await bbTopDeals(cat)).filter(p => p.regularPrice > 0 && p.salePrice > 0)
        .sort((a, b) => pctOff(b) - pctOff(a)).slice(0, config.perCategory || 12);
      list.forEach(bb => upsertBestBuy(bb, cat.id, true));
      fetched += list.length;
      log(`Best Buy · ${cat.name}: ${list.length} deals`);
    } catch (e) { log(`Best Buy · ${cat.name}: skipped (${e.message})`); }
  }
  if (!fetched) throw new Error("No Best Buy prices fetched for any category; leaving data unchanged.");

  // 2) drop products that left the top lists long ago; re-check the rest at Best Buy
  const cutoff = new Date(TODAY); cutoff.setDate(cutoff.getDate() - KEEP_AFTER_DROP_DAYS);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  db.products = db.products.filter(p => (p.lastTop || "") >= cutoffStr);
  const stale = db.products.filter(p => p.lastTop !== TODAY).map(p => p.sku);
  try { (await bbBySkus(stale)).forEach(bb => upsertBestBuy(bb, byId.get("bb-" + bb.sku).cat, false)); }
  catch (e) { log(`Best Buy re-check skipped (${e.message})`); }

  // 3) Walmart and Amazon prices for the same items, matched by UPC
  const withUpc = db.products.filter(p => p.upc);
  const shouldTry = (p, store) => { const m = p.miss && p.miss[store]; return !m || daysBetween(m, TODAY) >= RETRY_MISS_DAYS; };
  const markMiss = (p, store) => { p.miss = { ...(p.miss || {}), [store]: TODAY }; };
  const stats = { walmart: 0, amazon: 0 };

  if (walmartEnabled()) {
    let errors = 0;
    for (const p of withUpc) {
      if (!shouldTry(p, "walmart") && !p.offers.some(o => o.store === "walmart")) continue;
      try {
        const r = await walmartByUpc(p.upc);
        if (!r) { markMiss(p, "walmart"); continue; }
        const o = offerFor(p, "walmart"); o.url = r.url || o.url; o.hist[col] = r.price; stats.walmart++;
      } catch (e) { if (++errors <= 3) log(`Walmart: ${e.message}`); if (errors >= 10) { log("Walmart: too many errors, stopping"); break; } }
    }
    log(`Walmart: matched ${stats.walmart} of ${withUpc.length} products`);
  } else log("Walmart: skipped (no WALMART_CONSUMER_ID / WALMART_PRIVATE_KEY)");

  if (amazonEnabled()) {
    let errors = 0;
    try {   // known items: refresh by ASIN, 10 per request
      const known = withUpc.map(p => p.offers.find(o => o.store === "amazon")).filter(o => o && o.ref);
      const items = await amazonByAsins(known.map(o => o.ref));
      known.forEach(o => { const it = items.get(o.ref); if (it) { o.hist[col] = amazonPrice(it); o.url = it.DetailPageURL || o.url; stats.amazon++; } });
    } catch (e) { errors++; log(`Amazon: ${e.message}`); }
    for (const p of withUpc) {   // new items: search by UPC
      if (p.offers.some(o => o.store === "amazon" && o.ref) || !shouldTry(p, "amazon") || errors >= 10) continue;
      try {
        const r = await amazonByUpc(p.upc);
        if (!r) { markMiss(p, "amazon"); continue; }
        const o = offerFor(p, "amazon"); o.url = r.url; o.ref = r.ref; o.hist[col] = r.price; stats.amazon++;
      } catch (e) { if (++errors <= 3) log(`Amazon: ${e.message}`); if (errors >= 10) log("Amazon: too many errors, stopping"); }
    }
    log(`Amazon: matched ${stats.amazon} of ${withUpc.length} products`);
    if (env.AMAZON_KEEP_HISTORY !== "true")   // Amazon's API terms limit how long its data may be stored
      db.products.forEach(p => p.offers.filter(o => o.store === "amazon").forEach(o => { o.hist = o.hist.map((v, i) => i === col ? v : null); }));
  } else log("Amazon: skipped (no AMAZON_ACCESS_KEY / AMAZON_SECRET_KEY / AMAZON_PARTNER_TAG)");

  // 4) trim to the history window; drop store offers with no prices left
  const drop = Math.max(0, db.dates.length - HISTORY_DAYS);
  if (drop) { db.dates = db.dates.slice(drop); db.products.forEach(p => p.offers.forEach(o => (o.hist = o.hist.slice(drop)))); }
  db.products.forEach(p => { p.offers = p.offers.filter(o => o.hist.some(v => v != null) || o.ref); });

  const present = new Set(db.products.flatMap(p => p.offers.map(o => o.store)));
  const out = {
    updatedAt: new Date().toISOString(),
    source: "Best Buy Products API, Walmart Affiliate API, Amazon Product Advertising API",
    amazonAssociate: present.has("amazon"),
    dates: db.dates,
    stores: STORES.filter(s => present.has(s.id)),
    categories: config.categories.map(({ id, name, ico }) => ({ id, name, ico })),
    products: db.products,
  };
  await mkdir(dirname(DATA_FILE), { recursive: true });
  await writeFile(DATA_FILE, JSON.stringify(out));
  log(`saved ${out.products.length} products from ${out.stores.map(s => s.name).join(", ")}, ${out.dates.length} day(s) of history → data/prices.json`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch(e => { console.error(e.message); process.exit(1); });
