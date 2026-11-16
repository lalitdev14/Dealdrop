#!/usr/bin/env node
/*
 * DealDrop "hot deals from every store" fetcher.
 *
 * Collects the best current deals from several sources, merges duplicates, ranks them and
 * writes data/deals.json (kept for 72 hours, so the list doesn't shrink between runs).
 *
 *   node scripts/fetch-deals.mjs
 *
 * Sources (each one is optional; a failing source is logged and skipped):
 *   Public deal feeds, no keys needed (toggle them in data/deal-sources.json):
 *     slickdeals   Slickdeals frontpage RSS (community-voted, has thumb scores)
 *     dealnews     DealNews RSS (editor-vetted, has price and retailer)
 *     reddit       r/buildapcsales top of the day (links straight to the store)
 *   Affiliate networks (links already carry DealDrop's affiliate id):
 *     FMTC_API_TOKEN                          https://www.fmtc.co  (deals from every network)
 *     IMPACT_ACCOUNT_SID, IMPACT_AUTH_TOKEN   https://impact.com   (deals from joined brands)
 *
 * No npm dependencies (Node 18+). For tests, DEALS_MOCK_DIR=<dir> reads <source>.xml / <source>.json
 * from that folder instead of the network.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_FILE = join(ROOT, "data", "deals.json");
const SOURCES_FILE = join(ROOT, "data", "deal-sources.json");
const KEEP_HOURS = 72;
const MAX_DEALS = 150;
const env = process.env;
const MOCK = env.DEALS_MOCK_DIR;
const NOW = env.DEALS_NOW ? new Date(env.DEALS_NOW) : new Date();
const UA = "Mozilla/5.0 (compatible; DealDropBot/1.0; +https://github.com/lalitdev14/Dealdrop)";
const log = (...a) => console.log("[deals]", ...a);

/* ---------------- small helpers ---------------- */
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', ndash: "-", mdash: "-", trade: "™", reg: "®", hellip: "…" };
export const decode = s => String(s || "")
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m);
const stripTags = s => decode(s).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const tag = (xml, name) => { const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`)); return m ? m[1] : ""; };
const attr = (xml, name, a) => { const m = xml.match(new RegExp(`<${name}\\b[^>]*\\b${a}="([^"]*)"`)); return m ? decode(m[1]) : ""; };
const blocks = (xml, name) => xml.split(new RegExp(`<${name}[\\s>]`)).slice(1).map(b => b.split(`</${name}>`)[0]);
const num = s => { const v = parseFloat(String(s).replace(/,/g, "")); return Number.isFinite(v) ? v : null; };
const round2 = v => Math.round(v * 100) / 100;
const hash = s => createHash("sha1").update(s).digest("hex").slice(0, 12);

async function getText(url, label) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*" } });
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`);
  return res.text();
}
async function getJson(url, label, headers = {}) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json", ...headers } });
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
  return res.json();
}
const mock = async (name, json) => { const t = await readFile(join(MOCK, name), "utf8"); return json ? JSON.parse(t) : t; };

/* ---------------- text parsing: price, list price, promo code, store, category ---------------- */
const MONEY = /\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{2}))?/;
export function priceFromText(t) {
  const m = String(t).match(MONEY);
  return m ? num(m[1] + (m[2] ? "." + m[2] : "")) : null;
}
export function wasFromText(t, price) {
  const s = String(t);
  const pats = [
    /(?:reg(?:ularly|\.)?|list(?:\s+price)?|was|orig(?:inally|\.)?|msrp|retail)\s*:?\s*\$\s?([\d,]+(?:\.\d{2})?)/i,
    /\$\s?([\d,]+(?:\.\d{2})?)\s*(?:→|->|=>)\s*\$/,
    /\(\s*\$?([\d,]+(?:\.\d{2})?)\s*-\s*\$?[\d,]+/,          // reddit style "(199.99-109.99-10 ...)"
  ];
  for (const re of pats) { const m = s.match(re); const v = m && num(m[1]); if (v && price && v > price * 1.01 && v < price * 20) return v; }
  const off = s.match(/\$\s?([\d,]+(?:\.\d{2})?)\s+(?:off|less|savings|below)/i) || s.match(/sav(?:e|ings of)\s+\$\s?([\d,]+(?:\.\d{2})?)/i);
  if (off && price) { const v = num(off[1]); if (v && v < price * 19) return round2(price + v); }
  return null;
}
export function pctFromText(t) {
  const m = String(t).match(/(\d{1,2})\s?%\s*off/i);
  return m ? +m[1] / 100 : null;
}
export const isUpTo = t => /\bup to\s+\d{1,2}\s?%/i.test(String(t));
export function codeFromText(t) {
  const m = String(t).match(/(?:promo|coupon|discount)?\s*code[:\s]+["“]?([A-Z0-9][A-Z0-9-]{3,19})\b/i);
  return m && /[A-Z0-9]/.test(m[1]) && m[1] === m[1].toUpperCase() ? m[1] : null;
}
const STORE_NAMES = {
  "amazon": "Amazon", "walmart": "Walmart", "best-buy": "Best Buy", "bestbuy": "Best Buy", "target": "Target", "ebay": "eBay",
  "newegg": "Newegg", "costco": "Costco", "homedepot": "Home Depot", "home-depot": "Home Depot", "lowes": "Lowe's", "staples": "Staples",
  "bhphotovideo": "B&H Photo", "adorama": "Adorama", "microcenter": "Micro Center", "dell": "Dell", "lenovo": "Lenovo", "hp": "HP",
  "apple": "Apple", "samsung": "Samsung", "kohls": "Kohl's", "macys": "Macy's", "nike": "Nike", "adidas": "adidas", "woot": "Woot",
  "wayfair": "Wayfair", "officedepot": "Office Depot", "gamestop": "GameStop", "sams-club": "Sam's Club", "samsclub": "Sam's Club",
  "the-home-depot": "Home Depot", "bose": "Bose", "aliexpress": "AliExpress", "gymshark": "Gymshark", "lululemon": "lululemon",
};
export function storeFromUrl(u) {
  try {
    const host = new URL(u).hostname.replace(/^www\.|^smile\.|^m\./, "");
    const base = host.split(".").slice(-2)[0];
    return STORE_NAMES[base] || base.charAt(0).toUpperCase() + base.slice(1);
  } catch { return ""; }
}
export const storeName = s => {
  let n = String(s || "").trim();
  try { n = decodeURIComponent(n); } catch {}
  n = n.replace(/\+/g, " ").replace(/^.*\bvia\s+/i, "").replace(/\s*(\.|\s)com$/i, "").trim();
  const known = STORE_NAMES[n.toLowerCase().replace(/[^a-z-]/g, "")] || STORE_NAMES[n.toLowerCase().replace(/\s+/g, "-")];
  if (known) return known;
  return /^[a-z]+(-[a-z]+)*$/.test(n) ? n.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ") : n;   // bare slugs like "micro-center"
};
const CATEGORIES = [
  ["tools", "Tools & Garden", /drill|\bsaw\b|\btools?\b|screwdriver|pliers|wrench|socket set|blower|dewalt|milwaukee|ryobi|makita|ridgid|kobalt|husky|craftsman|ladder|generator|mower|garden|pressure washer|leaf|chainsaw|trimmer kit|workbench/i],
  ["tech", "Tech & Computers", /laptop|macbook|chromebook|monitor|ssd|nvme|hard drive|\bhdd\b|\bram\b|ddr[45]|\bcpu\b|ryzen|intel core|\bgpu\b|rtx|radeon|router|wi-?fi|mesh|keyboard|mouse|printer|tablet|ipad|kindle|usb|charger|power bank|cable|webcam|computer|ethernet|gigabit|tp-link|media converter|motherboard|\bpsu\b|\[(?:ssd|hdd|monitor|gpu|cpu|ram|keyboard|mouse|case|psu|mobo|cooler|controller|headset|laptop|prebuilt|router|printer|other)\]/i],
  ["tv-audio", "TVs & Audio", /\btv\b|oled|qled|soundbar|headphone|earbud|airpods|speaker|projector|turntable|receiver|bose|sonos/i],
  ["phones", "Phones & Wearables", /iphone|galaxy|pixel|phone|smartwatch|apple watch|fitbit|garmin|wearable/i],
  ["gaming", "Gaming", /playstation|ps5|xbox|nintendo|switch|steam deck|video game|gaming|controller|\bgame\b/i],
  ["home", "Home & Kitchen", /vacuum|air fryer|instant pot|coffee|espresso|blender|mixer|kitchen|cookware|knife|mattress|bedding|sheets|towel|furniture|desk|chair|lamp|thermostat|doorbell|camera|smart plug|bulb|purifier|humidifier|appliance|grill/i],
  ["fashion", "Clothing & Shoes", /shoe|sneaker|boot|jacket|coat|hoodie|shirt|pants|jeans|dress|socks|apparel|clothing|backpack|bag|sunglasses|watch\b|adidas|nike|under armour/i],
  ["health", "Health & Beauty", /toothbrush|razor|shaver|trimmer|hair dryer|skincare|vitamin|supplement|protein|fragrance|perfume|beauty|massage/i],
  ["toys", "Toys & Kids", /lego|toy|kids|baby|stroller|car seat|puzzle|board game|doll/i],
  ["grocery", "Grocery & Household", /coffee beans|snack|grocery|soda|coca-cola|coke|pepsi|drink|water bottle pack|paper towel|toilet paper|detergent|cleaner|trash bag|pet food|dog|cat litter|batteries/i],
];
export function categorize(text) {
  for (const [id, , re] of CATEGORIES) if (re.test(text)) return id;
  return "other";
}

/* ---------------- sources ---------------- */
async function slickdeals(cfg) {
  const xml = MOCK ? await mock("slickdeals.xml") : await getText(cfg.url, "Slickdeals");
  const items = blocks(xml, "item");
  return items.map((it, i) => {
    const title = stripTags(tag(it, "title"));
    const html = decode(tag(it, "content:encoded"));
    const text = stripTags(html) + " " + stripTags(tag(it, "description"));
    const price = priceFromText(title);
    const thumbs = num((html.match(/Thumb Score:\s*([+-]?\d+)/) || [])[1]) || 0;
    const slug = (html.match(/data-store-slug="([^"]+)"/) || [])[1] || "";
    const trd = decode((html.match(/[?&](?:amp;)?trd=([^&"]+)/) || [])[1] || "").replace(/\+/g, " ");
    const asin = (html.match(/data-aps-asin="([A-Z0-9]{10})"/) || [])[1] || null;
    return {
      source: "slickdeals", sourceName: "Slickdeals", sourceUrl: decode(tag(it, "link")).replace(/\?utm_[^#]*$/, ""),
      title, price, was: wasFromText(title + " " + text, price), pct: pctFromText(title), code: codeFromText(title + " " + text),
      store: storeName(slug || trd), asin, url: null, image: (html.match(/<img[^>]+src="([^"]+)"/) || [])[1] || null,
      posted: new Date(stripTags(tag(it, "pubDate"))).toISOString(), expires: null,
      signals: { rank: i / Math.max(1, items.length), thumbs },
    };
  });
}

async function dealnews(cfg) {
  const xml = MOCK ? await mock("dealnews.xml") : await getText(cfg.url, "DealNews");
  const items = blocks(xml, "item");
  return items.map((it, i) => {
    const title = stripTags(tag(it, "title"));
    const desc = stripTags(tag(it, "description"));
    const price = num(stripTags(tag(it, "dealnews:price"))) || priceFromText(title);
    const exp = stripTags(tag(it, "dealnews:expires"));
    return {
      source: "dealnews", sourceName: "DealNews", sourceUrl: decode(tag(it, "link")).replace(/\?iref=rss$/, ""),
      title, price, was: wasFromText(title + " " + desc, price), pct: pctFromText(title), code: codeFromText(title + " " + desc),
      store: storeName(stripTags(tag(it, "dealnews:retailer"))), asin: null, url: null,
      image: attr(it, "media:content", "url") || null, category: stripTags(tag(it, "dealnews:category")),
      posted: new Date(stripTags(tag(it, "pubDate"))).toISOString(), expires: exp ? new Date(exp).toISOString() : null,
      signals: { rank: i / Math.max(1, items.length), staffPick: /true/i.test(tag(it, "dealnews:staffPick")), best: /best[- ]ever|all[- ]time low|lowest price/i.test(desc) },
    };
  });
}

async function reddit(cfg) {
  const xml = MOCK ? await mock("reddit.xml") : await getText(cfg.url, "Reddit");
  const entries = blocks(xml, "entry");
  return entries.map((e, i) => {
    const title = stripTags(tag(e, "title"));
    const content = decode(tag(e, "content"));
    const link = (content.match(/<a href="([^"]+)">\[link\]<\/a>/) || [])[1] || "";
    const direct = link && !/reddit\.com|redd\.it/.test(link) ? decode(link) : null;
    const price = priceFromText(title);
    return {
      source: "reddit", sourceName: "r/buildapcsales", sourceUrl: attr(e, "link", "href"),
      title: title.replace(/^\[[^\]]+\]\s*/, ""), rawTitle: title, price, was: wasFromText(title, price), pct: pctFromText(title), code: codeFromText(title),
      store: direct ? storeFromUrl(direct) : "", asin: null, url: direct, image: attr(e, "media:thumbnail", "url") || null,
      posted: new Date(stripTags(tag(e, "published")) || NOW).toISOString(), expires: null,
      signals: { rank: i / Math.max(1, entries.length) },
    };
  });
}

async function fmtc() {
  if (!env.FMTC_API_TOKEN && !MOCK) return null;
  const d = MOCK ? await mock("fmtc.json", true).catch(() => null) : await getJson(
    `https://s3.fmtc.co/api/3.0.0/deals?${new URLSearchParams({ api_token: env.FMTC_API_TOKEN, format: "JSON", country: "US", active: "1", sortby: "update", page_size: "500" })}`, "FMTC");
  if (!d) return null;
  return (d.data || []).filter(x => x.status === "active" || !x.status).map((x, i, all) => {
    const md = x.metadata || {};
    const price = num(x.sale_price) || num(md.new_price);
    const was = num(x.was_price) || num(md.old_price);
    return {
      source: "fmtc", sourceName: "FMTC", sourceUrl: null,
      title: stripTags(x.label), price, was: was && price && was > price ? was : null, pct: num(x.percent) ? num(x.percent) / 100 : null,
      code: x.code || null, store: x.merchant_name || "", asin: null, url: x.affiliate_url || null, affiliate: !!x.affiliate_url,
      direct: x.direct_link || null, image: x.image || null, posted: new Date(x.last_update || x.created || NOW).toISOString(),
      expires: x.end_date ? new Date(x.end_date).toISOString() : null, signals: { rank: i / Math.max(1, all.length), rating: num(x.rating) || 0 },
    };
  });
}

async function impact() {
  if (!(env.IMPACT_ACCOUNT_SID && env.IMPACT_AUTH_TOKEN) && !MOCK) return null;
  const sid = env.IMPACT_ACCOUNT_SID;
  const auth = { Authorization: "Basic " + Buffer.from(`${sid}:${env.IMPACT_AUTH_TOKEN}`).toString("base64") };
  const base = `https://api.impact.com/Mediapartners/${sid}`;
  const campaigns = MOCK ? ((await mock("impact-campaigns.json", true).catch(() => null)) || {}).Campaigns || []
    : ((await getJson(`${base}/Campaigns?PageSize=200`, "Impact campaigns", auth)).Campaigns || []);
  const active = campaigns.filter(c => !c.ContractStatus || /active/i.test(c.ContractStatus));
  const out = [];
  for (const c of active) {
    let deals;
    try {
      deals = MOCK ? ((await mock(`impact-deals-${c.CampaignId}.json`, true).catch(() => ({}))).Deals || [])
        : ((await getJson(`${base}/Campaigns/${c.CampaignId}/Deals?State=ACTIVE`, "Impact deals", auth)).Deals || []);
    } catch (e) { log(`Impact · ${c.CampaignName}: ${e.message}`); continue; }
    for (const x of deals) {
      const p = (x.Products || [])[0] || {};
      const price = num(p.ProductAfterPriceAmount), was = num(p.ProductBeforePriceAmount);
      out.push({
        source: "impact", sourceName: "Impact", sourceUrl: null,
        title: stripTags(x.Name || x.Description), price, was: was && price && was > price ? was : null,
        pct: x.DiscountType === "PERCENT" ? num(x.DiscountPercent) / 100 : x.DiscountType === "PERCENT_MAXIMUM" ? num(x.DiscountMaximumPercent) / 100 : null,
        code: x.DefaultPromoCode || null, store: c.CampaignName || c.AdvertiserName || "", asin: null,
        url: c.TrackingLink || null, affiliate: !!c.TrackingLink, image: p.ProductImageUrl || null,
        posted: new Date(x.DateLastUpdated || x.DateCreated || NOW).toISOString(), expires: x.EndDate ? new Date(x.EndDate).toISOString() : null,
        signals: { rank: 0.5 },
      });
    }
  }
  return out;
}

/* ---------------- ranking and merging ---------------- */
export function score(d) {
  const s = d.signals || {};
  const ageH = Math.max(0, (NOW - new Date(d.posted)) / 36e5);
  let v = 0.6 * (1 - (s.rank ?? 0.5));                       // position in the source's own "hot" ordering
  v += Math.min(Math.max(s.thumbs || 0, 0), 150) / 100;      // Slickdeals community votes
  if (s.staffPick) v += 0.4;
  if (s.best) v += 0.35;                                     // "best-ever price" per editors
  if (s.rating) v += Math.min(s.rating, 5) / 20;
  const pct = d.pct ?? (d.was && d.price ? 1 - d.price / d.was : null);
  if (pct) v += Math.min(pct, 0.9) * (d.upTo ? 0.5 : 1.2);   // deeper discount ranks higher ("up to X%" sales count less)
  if (d.code) v += 0.05;
  if ((d.sources || []).length > 1) v += 0.3 * ((d.sources.length) - 1);   // several sites agree it's a deal
  v *= Math.max(0.25, 1 - ageH / (KEEP_HOURS * 1.25));       // fresher first
  return Math.round(v * 1000) / 1000;
}
const titleKey = t => String(t).toLowerCase().replace(/\$[\d,.]+/g, "").replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(w => w.length > 2).slice(0, 7).join(" ");
const keyOf = d => d.asin ? "asin:" + d.asin : titleKey(d.title);

export function mergeDeals(lists, previous = []) {
  const byKey = new Map();
  const add = (d, fresh) => {
    if (!d.title || !d.posted || isNaN(new Date(d.posted))) return;
    if (d.expires && new Date(d.expires) < NOW) return;
    if ((NOW - new Date(d.posted)) / 36e5 > KEEP_HOURS) return;
    const k = keyOf(d);
    const cur = byKey.get(k);
    if (!cur) { byKey.set(k, { ...d, sources: d.sources || [{ id: d.source, name: d.sourceName, url: d.sourceUrl }] }); return; }
    // same deal seen on more than one site: keep the richest record, remember every source
    const srcs = [...cur.sources];
    for (const s of d.sources || [{ id: d.source, name: d.sourceName, url: d.sourceUrl }]) if (!srcs.some(x => x.id === s.id)) srcs.push(s);
    const keep = fresh && !cur.fresh ? d : cur;
    byKey.set(k, {
      ...keep, sources: srcs,
      price: keep.price ?? cur.price ?? d.price, was: keep.was ?? cur.was ?? d.was, pct: keep.pct ?? cur.pct ?? d.pct,
      code: keep.code || cur.code || d.code, image: keep.image || cur.image || d.image, url: keep.url || cur.url || d.url,
      affiliate: !!(keep.affiliate || cur.affiliate || d.affiliate), asin: keep.asin || cur.asin || d.asin,
      store: keep.store || cur.store || d.store, signals: { ...(cur.signals || {}), ...(keep.signals || {}) },
      posted: [cur.posted, d.posted].sort()[0], fresh: cur.fresh || fresh,
    });
  };
  lists.flat().forEach(d => add({ ...d, fresh: true }, true));
  previous.forEach(d => add({ ...d, fresh: false, signals: { ...(d.signals || {}), rank: Math.min(1, (d.signals?.rank ?? 0.5) + 0.1) } }, false));
  return [...byKey.values()].map(d => {
    const pct = d.pct ?? (d.was && d.price ? round2(1 - d.price / d.was) : null);
    const out = {
      id: d.id || hash(keyOf(d)), title: d.title, store: d.store || "", price: d.price ?? null, was: d.was ?? null,
      pct: pct && pct > 0 && pct < 0.99 ? pct : null, upTo: d.pct != null && isUpTo(d.title), code: d.code || null, image: d.image || null,
      url: d.url || null, affiliate: !!d.affiliate, asin: d.asin || null, cat: d.cat || categorize(`${d.rawTitle || d.title} ${d.category || ""}`),
      sources: d.sources, posted: d.posted, expires: d.expires || null, signals: d.signals,
    };
    out.score = score(out);
    return out;
  }).sort((a, b) => b.score - a.score).slice(0, MAX_DEALS);
}

/* ---------------- main ---------------- */
async function main() {
  const cfg = JSON.parse(await readFile(SOURCES_FILE, "utf8"));
  let previous = [];
  try { previous = JSON.parse(await readFile(OUT_FILE, "utf8")).deals || []; } catch {}

  const runners = { slickdeals, dealnews, reddit };
  const lists = [], used = [];
  for (const [id, sc] of Object.entries(cfg.feeds || {})) {
    if (!sc.enabled) { log(`${id}: off in data/deal-sources.json`); continue; }
    try { const r = await runners[id](sc); lists.push(r); used.push(id); log(`${id}: ${r.length} deals`); }
    catch (e) { log(`${id}: skipped (${e.message})`); }
  }
  for (const [id, fn] of Object.entries({ fmtc, impact })) {
    try { const r = await fn(); if (r == null) { log(`${id}: skipped (no keys)`); continue; } lists.push(r); used.push(id); log(`${id}: ${r.length} deals`); }
    catch (e) { log(`${id}: skipped (${e.message})`); }
  }
  if (!lists.flat().length && !previous.length) throw new Error("No deals from any source; leaving data unchanged.");

  const deals = mergeDeals(lists, previous);
  const out = {
    updatedAt: NOW.toISOString(),
    sources: used,
    categories: CATEGORIES.map(([id, name]) => ({ id, name })).concat([{ id: "other", name: "Everything else" }]),
    deals,
  };
  await mkdir(dirname(OUT_FILE), { recursive: true });
  await writeFile(OUT_FILE, JSON.stringify(out));
  log(`saved ${deals.length} deals from ${used.join(", ") || "previous run"} → data/deals.json`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch(e => { console.error(e.message); process.exit(1); });
