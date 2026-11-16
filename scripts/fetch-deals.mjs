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
const MAX_DEALS = 1500;
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
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*" }, signal: AbortSignal.timeout(20000) });
    if (res.ok) return res.text();
    // rate limited: wait as long as the site asks (Retry-After, else 15s), then try once more
    if (res.status === 429 && attempt === 1 && !MOCK) { await new Promise(r => setTimeout(r, Math.min(60, +res.headers.get("retry-after") || 15) * 1000)); continue; }
    throw new Error(`${label}: HTTP ${res.status}`);
  }
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
  "cvs": "CVS", "dicks-sporting-goods": "Dick's Sporting Goods", "dickssportinggoods": "Dick's Sporting Goods", "dicks sporting goods": "Dick's Sporting Goods",
  "jomashop": "Jomashop", "jenson-usa": "Jenson USA", "dollar-general": "Dollar General", "philips-hue": "Philips Hue", "harman-kardon": "Harman Kardon",
  "steampowered": "Steam", "gog": "GOG", "playstation": "PlayStation", "walmar": "Walmart", "humblebundle": "Humble Bundle", "fanatical": "Fanatical",
  "the-home-depot": "Home Depot", "costco-wholesale": "Costco", "target-com": "Target", "lowes-com": "Lowe's", "bose": "Bose", "aliexpress": "AliExpress", "gymshark": "Gymshark", "lululemon": "lululemon",
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
  if (/^https?\s/i.test(n)) {                                                  // "https shop simon com products" → "Simon"
    const w = n.split(/\s+/), i = w.findIndex(x => /^(com|net|org|co)$/i.test(x));
    return i > 1 ? storeName(w[i - 1]) : "";
  }
  if (/^https?:|\//i.test(n)) return storeFromUrl(/^https?:/.test(n) ? n : "https://" + n) || "";
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
  const xml = MOCK ? await mock(cfg.mockName || "slickdeals.xml") : await getText(cfg.url, "Slickdeals");
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
    const exitSite = (html.match(/data-product-exitWebsite="([a-z0-9.-]+\.[a-z]{2,})"/i) || [])[1];
    return {
      source: "slickdeals", sourceName: "Slickdeals", sourceUrl: decode(tag(it, "link")).replace(/\?utm_[^#]*$/, ""),
      title, price, was: wasFromText(title + " " + text, price), pct: pctFromText(title), code: codeFromText(title + " " + text),
      store: storeName(slug || trd), asin, url: null, storeHome: exitSite ? `https://www.${exitSite.replace(/^www\./, "")}/` : null, image: (html.match(/<img[^>]+src="([^"]+)"/) || [])[1] || null,
      posted: new Date(stripTags(tag(it, "pubDate"))).toISOString(), expires: null,
      signals: { rank: i / Math.max(1, items.length), thumbs },
    };
  });
}

async function dealnews(cfg) {
  const xml = MOCK ? await mock(cfg.mockName || "dealnews.xml") : await getText(cfg.url, "DealNews");
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
  const xml = MOCK ? await mock(cfg.mockName || "reddit.xml") : await getText(cfg.url, "Reddit");
  const entries = blocks(xml, "entry");
  return entries.map((e, i) => {
    const title = stripTags(tag(e, "title"));
    const content = decode(tag(e, "content"));
    const link = (content.match(/<a href="([^"]+)">\[link\]<\/a>/) || [])[1] || "";
    let direct = link && !/reddit\.com|redd\.it/.test(link) ? decode(link) : null;
    let host = ""; try { host = new URL(direct).hostname; } catch {}
    const amazonShort = /(^|\.)(amzn\.to|a\.co|amzn\.com)$/.test(host);
    // someone else's affiliate short-link: don't use it (we never route through other people's codes)
    if (amazonShort || /(^|\.)(7tiv\.net|vzew\.net|sjv\.io|pxf\.io|skimresources\.com|linksynergy\.com|anrdoezrs\.net|dpbolvw\.net|jdoqocy\.com|kqzyfj\.com|tkqlhce\.com|bit\.ly|tinyurl\.com|howl\.link|shop-links\.co|prf\.hn|awin1\.com|ojrq\.net|ebay\.us|go\.magik\.ly|geni\.us|joinhoney\.com)$/.test(host)) direct = null;
    const price = priceFromText(title);
    return {
      source: "reddit", sourceName: "r/buildapcsales", sourceUrl: attr(e, "link", "href"),
      title: title.replace(/^\[[^\]]+\]\s*/, ""), rawTitle: title, price, was: wasFromText(title, price), pct: pctFromText(title), code: codeFromText(title),
      store: direct ? storeFromUrl(direct) : amazonShort ? "Amazon" : detectStore(title), asin: direct ? ((direct.match(/amazon\.com\/(?:[^?#]*\/)?(?:dp|gp\/product)\/([A-Z0-9]{10})/) || [])[1] || null) : null,
      url: direct && !/amazon\./.test(host) ? direct : null, image: attr(e, "media:thumbnail", "url") || null,
      posted: new Date(stripTags(tag(e, "published")) || NOW).toISOString(), expires: null,
      signals: { rank: i / Math.max(1, entries.length) },
    };
  });
}

/* Any deal blog / deal site RSS feed. Store comes from the text ("$5 at Amazon", "Amazon - …", "Walmart has …"). */
const KNOWN_STORES = [...new Set([...Object.values(STORE_NAMES), "CVS", "Walgreens", "Ulta", "Sephora", "Old Navy", "Gap", "JCPenney", "Dick's Sporting Goods",
  "REI", "Nordstrom", "Nordstrom Rack", "Zappos", "Chewy", "Etsy", "Steam", "Epic Games", "GOG", "Fanatical", "Humble Bundle", "Nintendo", "PlayStation", "Xbox",
  "Kroger", "Sam's Club", "BJ's", "QVC", "HSN", "Vitacost", "iHerb", "Bath & Body Works", "Under Armour", "Reebok", "Puma", "New Balance", "Levi's", "J.Crew",
  "Banana Republic", "Ashley", "IKEA", "Overstock", "Best Buy", "Verizon", "AT&T", "T-Mobile", "Mint Mobile", "Visible", "Google Store", "Meta", "Anker"])]
  .sort((a, b) => b.length - a.length);
const storeRe = KNOWN_STORES.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/'/g, "['’]?")).join("|");
export function detectStore(text) {
  const t = String(text);
  const m = t.match(new RegExp(`\\b(?:at|from|via|@)\\s+(${storeRe})\\b`, "i")) || t.match(new RegExp(`^\\s*(${storeRe})\\s*[-–:|]`, "i"))
    || t.match(new RegExp(`\\b(${storeRe})\\s+(?:with [^.]{1,40}\\s+)?(?:has|offers|is offering|now offers|discounts|knocks)\\b`, "i"));
  if (!m) return "";
  const hit = m[1].toLowerCase().replace(/['’]/g, "");
  return KNOWN_STORES.find(s => s.toLowerCase().replace(/['’]/g, "") === hit) || m[1];
}
async function rss(cfg) {
  const xml = MOCK ? await mock(cfg.mockName || `${cfg.id}.xml`) : await getText(cfg.url, cfg.id);
  const items = blocks(xml, "item");
  return items.filter(it => !cfg.match || new RegExp(cfg.match, "i").test(it)).map((it, i) => {
    const title = stripTags(tag(it, "title"));
    const html = decode(tag(it, "content:encoded") || tag(it, "description"));
    const text = stripTags(html);
    const price = priceFromText(title) ?? (cfg.priceInBody ? priceFromText(text) : null);
    const amazon = html.match(/https?:\/\/(?:www\.)?amazon\.com\/(?:[^"'\s]*\/)?(?:dp|gp\/product)\/([A-Z0-9]{10})/);
    const img = attr(it, "media:content", "url") || attr(it, "enclosure", "url") || stripTags(tag(it, "thumbnail-image")) || (html.match(/<img[^>]+src="([^"]+)"/) || [])[1] || null;
    return {
      source: cfg.id, title, price, was: wasFromText(title + " " + text, price), pct: pctFromText(title), code: codeFromText(title + " " + text),
      store: cfg.store || detectStore(title) || detectStore(text.slice(0, 300)), asin: amazon ? amazon[1] : null, url: null,
      image: img && img.startsWith("//") ? "https:" + img : img,
      posted: new Date(stripTags(tag(it, "pubDate")) || NOW).toISOString(), expires: null,
      signals: { rank: cfg.ranked ? i / Math.max(1, items.length) : 0.5 },
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

/* ---------------- direct store links (never via the deal site) ---------------- */
const STORE_SEARCH = {
  "Amazon": "https://www.amazon.com/s?k=", "Walmart": "https://www.walmart.com/search?q=", "Best Buy": "https://www.bestbuy.com/site/searchpage.jsp?st=",
  "Home Depot": "https://www.homedepot.com/s/", "Lowe's": "https://www.lowes.com/search?searchTerm=", "Target": "https://www.target.com/s?searchTerm=",
  "Costco": "https://www.costco.com/CatalogSearch?keyword=", "eBay": "https://www.ebay.com/sch/i.html?_nkw=", "Newegg": "https://www.newegg.com/p/pl?d=",
  "Staples": "https://www.staples.com/", "Kohl's": "https://www.kohls.com/search.jsp?search=", "Macy's": "https://www.macys.com/shop/featured/",
  "Dell": "https://www.dell.com/en-us/search/", "Lenovo": "https://www.lenovo.com/us/en/search?text=", "Samsung": "https://www.samsung.com/us/search/searchMain/?searchTerm=",
  "Micro Center": "https://www.microcenter.com/search/search_results.aspx?Ntt=", "B&H Photo": "https://www.bhphotovideo.com/c/search?q=",
  "Woot": "https://www.woot.com/search?q=", "Wayfair": "https://www.wayfair.com/keyword.php?keyword=", "AliExpress": "https://www.aliexpress.us/w/wholesale-",
  "adidas": "https://www.adidas.com/us/search?q=", "Nike": "https://www.nike.com/w?q=", "lululemon": "https://shop.lululemon.com/search?Ntt=",
  "Apple": "https://www.apple.com/us/search/", "GameStop": "https://www.gamestop.com/search/?q=", "Office Depot": "https://www.officedepot.com/catalog/search.do?Ntt=",
  "CVS": "https://www.cvs.com/search?searchTerm=", "Walgreens": "https://www.walgreens.com/search/results.jsp?Ntt=", "Ulta": "https://www.ulta.com/search?search=",
  "Sephora": "https://www.sephora.com/search?keyword=", "Old Navy": "https://oldnavy.gap.com/browse/search.do?searchText=", "Gap": "https://www.gap.com/browse/search.do?searchText=",
  "Nordstrom": "https://www.nordstrom.com/sr?keyword=", "Nordstrom Rack": "https://www.nordstromrack.com/sr?keyword=", "Zappos": "https://www.zappos.com/search?term=",
  "Chewy": "https://www.chewy.com/s?query=", "Etsy": "https://www.etsy.com/search?q=", "Steam": "https://store.steampowered.com/search/?term=",
  "Sam's Club": "https://www.samsclub.com/s/", "JCPenney": "https://www.jcpenney.com/s?searchTerm=", "REI": "https://www.rei.com/search?q=",
  "Dick's Sporting Goods": "https://www.dickssportinggoods.com/search/SearchDisplay?searchTerm=", "Wayfair": "https://www.wayfair.com/keyword.php?keyword=",
  "Ashley": "https://www.ashleyfurniture.com/search/?q=", "IKEA": "https://www.ikea.com/us/en/search/?q=", "QVC": "https://www.qvc.com/catalog/search.html?keyword=",
  "Under Armour": "https://www.underarmour.com/en-us/search/?q=", "New Balance": "https://www.newbalance.com/search?q=", "Puma": "https://us.puma.com/us/en/search?q=",
  "GOG": "https://www.gog.com/en/games?query=", "PlayStation": "https://store.playstation.com/en-us/search/", "Humble Bundle": "https://www.humblebundle.com/store/search?search=",
  "Fanatical": "https://www.fanatical.com/en/search?search=", "Woot": "https://www.woot.com/search?q=",
  "Bath & Body Works": "https://www.bathandbodyworks.com/search?q=", "Kroger": "https://www.kroger.com/search?query=", "Anker": "https://www.anker.com/search?q=",
};
/** Clean deal title → product name, e.g. "Select Accts: 12-Pk Coke 3 for $12 + Free S&H" → "12-Pk Coke". */
export function productName(title) {
  return String(title)
    .replace(/^\s*(?:\[[^\]]*\]\s*|(?:select accts?|prime members?|ymmv|today only|lightning deal|in[- ]store|members?|new users?)\s*:\s*)+/gi, "")
    .replace(/\s+(?:for|at|from|only|now|just)?\s*\$\s?[\d,]+(?:\.\d{2})?.*$/i, "")
    .replace(/\s+(?:\+|w\/|with)\s+(?:free|f\/?s|fs).*$/i, "")
    .replace(/\s+-\s*$/, "").replace(/\s{2,}/g, " ").trim();
}
export function storeLink(d) {
  if (d.url) return d.url;                                                   // direct link from the feed (Reddit, FMTC, Impact)
  if (d.asin && d.store === "Amazon") return `https://www.amazon.com/dp/${d.asin}`;
  const base = STORE_SEARCH[d.store];
  if (base) {
    const q = productName(d.title).split(/\s+/).slice(0, 9).join(" ");
    return base.endsWith("=") || base.endsWith("-") ? base + encodeURIComponent(q) + (base.endsWith("-") ? ".html" : "")
      : /\/s\/$|\/search\/$|featured\/$/.test(base) ? base + encodeURIComponent(q) : base;
  }
  return d.storeHome || null;                                                // store homepage when that's all we know
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
      feeds: [...new Set([...(cur.feeds || []), ...(d.feeds || [])])], linkType: keep.linkType || cur.linkType || d.linkType, store: keep.store || cur.store || d.store, storeHome: keep.storeHome || cur.storeHome || d.storeHome,
      signals: { ...(cur.signals || {}), ...(keep.signals || {}) },
      posted: [cur.posted, d.posted].sort()[0], fresh: cur.fresh || fresh,
    });
  };
  lists.flat().forEach(d => add({ ...d, fresh: true }, true));
  previous.forEach(d => add({ ...d, fresh: false, signals: { ...(d.signals || {}), rank: Math.min(1, (d.signals?.rank ?? 0.5) + 0.1) } }, false));
  return [...byKey.values()].map(d => {
    const pct = d.pct ?? (d.was && d.price ? round2(1 - d.price / d.was) : null);
    const url = storeLink(d);
    if (!url) return null;                                                   // only deals we can send straight to the store
    const out = {
      id: d.id || hash(keyOf(d)), title: d.title, name: d.name || productName(d.title) || d.title, store: d.store || "",
      price: d.price ?? null, was: d.was ?? null,
      pct: pct && pct > 0 && pct < 0.99 ? pct : null, upTo: d.pct != null && isUpTo(d.title), code: d.code || null, image: d.image || null,
      freeShip: /free (?:s&h|shipping|ship)|\bfs\b/i.test(d.title),
      url, linkType: d.linkType || (d.url ? "product" : d.asin && d.store === "Amazon" ? "product" : STORE_SEARCH[d.store] ? "search" : "store"),
      affiliate: !!d.affiliate, asin: d.asin || null, cat: d.cat || categorize(`${d.rawTitle || d.title} ${d.category || ""}`),
      sources: (d.sources || []).map(s => ({ id: s.id })), feeds: (d.feeds || []).slice(0, 6), posted: d.posted, expires: d.expires || null, signals: d.signals,
    };
    out.score = score(out);
    return out;
  }).filter(Boolean).sort((a, b) => b.score - a.score).slice(0, MAX_DEALS);
}

/* ---------------- main ---------------- */
// Rotation: each run fetches only the feeds that are due, most overdue first, within a time budget.
// A feed's interval adapts to how many of its deals reach the top of the list ("yield"):
//   3+ top deals → every 15 min, 1–2 → hourly, none → every 3 hours (never faster than its own "every").
const STATE_FILE = join(ROOT, "data", "feed-state.json");
const RUN_BUDGET_MS = +(env.DEALS_RUN_BUDGET_MS || 5 * 60 * 1000);
const TOP_N = 200;
const intervalFor = (sc, st) => {
  const hits = st?.hits ?? 3;                                               // new feeds start "hot" so they get tried quickly
  const adaptive = hits >= 3 ? 15 : hits >= 1 ? 60 : 180;
  return Math.max(sc.every || 15, adaptive);
};

async function main() {
  const cfg = JSON.parse(await readFile(SOURCES_FILE, "utf8"));
  let previous = [];
  try { previous = JSON.parse(await readFile(OUT_FILE, "utf8")).deals || []; } catch {}
  let state = {};
  try { state = JSON.parse(await readFile(STATE_FILE, "utf8")); } catch {}

  const runners = { slickdeals, dealnews, reddit, rss };
  const lists = [], used = [], fetched = [];
  const all = (Array.isArray(cfg.feeds) ? cfg.feeds : Object.entries(cfg.feeds || {}).map(([id, sc]) => ({ id, type: id, ranked: true, ...sc })))
    .filter(sc => sc.enabled !== false && runners[sc.type]);
  const due = all.map(sc => {
    const st = state[sc.id];
    const overdue = st?.last ? (NOW - new Date(st.last)) / 6e4 - intervalFor(sc, st) : 1e9;
    return { sc, overdue };
  }).filter(x => x.overdue >= 0 || env.DEALS_ALL === "1").sort((a, b) => b.overdue - a.overdue);
  log(`${due.length} of ${all.length} feeds due this run`);

  const t0 = Date.now(), lastHit = {};
  for (const { sc } of due) {
    if (Date.now() - t0 > RUN_BUDGET_MS && !MOCK) { log(`time budget reached; ${due.length - fetched.length} feeds wait for the next run`); break; }
    const host = (() => { try { return new URL(sc.url).hostname; } catch { return sc.type; } })();
    const gap = sc.type === "reddit" ? 6000 : 900;                          // per-site politeness gap
    if (!MOCK && lastHit[host]) { const w = gap - (Date.now() - lastHit[host]); if (w > 0) await new Promise(r => setTimeout(r, w)); }
    try {
      let r = await runners[sc.type]({ ...sc, mockName: MOCK ? `${sc.id}.xml` : null });
      if (sc.store) r = r.filter(d => d.store === sc.store);                    // store searches also match other stores
      if (sc.titleMatch) r = r.filter(d => new RegExp(sc.titleMatch, "i").test(d.title));
      if (!sc.ranked) r = r.map(d => ({ ...d, signals: { ...d.signals, rank: 0.5 } }));   // date-ordered feed: position means nothing
      lists.push(r.map(d => ({ ...d, feeds: [sc.id] })));
      if (!used.includes(sc.type)) used.push(sc.type);
      state[sc.id] = { ...(state[sc.id] || {}), last: NOW.toISOString(), items: r.length, error: null };
      log(`${sc.id}: ${r.length} deals`);
    } catch (e) {
      state[sc.id] = { ...(state[sc.id] || {}), last: NOW.toISOString(), error: e.message.slice(0, 120) };
      log(`${sc.id}: skipped (${e.message})`);
    }
    fetched.push(sc.id);
    lastHit[host] = Date.now();
  }
  for (const [id, fn] of Object.entries({ fmtc, impact })) {
    try { const r = await fn(); if (r == null) { log(`${id}: skipped (no keys)`); continue; } lists.push(r.map(d => ({ ...d, feeds: [id] }))); used.push(id); log(`${id}: ${r.length} deals`); }
    catch (e) { log(`${id}: skipped (${e.message})`); }
  }
  if (!lists.flat().length && !previous.length) throw new Error("No deals from any source; leaving data unchanged.");

  const deals = mergeDeals(lists, previous);
  // yield: how many of each fetched feed's deals made the top of the list
  const hits = {};
  deals.slice(0, TOP_N).forEach(d => (d.feeds || []).forEach(f => { hits[f] = (hits[f] || 0) + 1; }));
  for (const id of fetched) state[id] = { ...state[id], hits: hits[id] || 0 };
  const known = new Set(all.map(sc => sc.id));
  for (const id of Object.keys(state)) if (!known.has(id)) delete state[id];

  const out = {
    updatedAt: NOW.toISOString(),
    sources: used,
    feedCount: all.length,
    categories: CATEGORIES.map(([id, name]) => ({ id, name })).concat([{ id: "other", name: "Everything else" }]),
    deals,
  };
  await mkdir(dirname(OUT_FILE), { recursive: true });
  await writeFile(OUT_FILE, JSON.stringify(out));
  await writeFile(STATE_FILE, JSON.stringify(state, null, 0).replace(/\},"/g, '},\n"'));
  log(`fetched ${fetched.length} feeds; saved ${deals.length} deals → data/deals.json`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch(e => { console.error(e.message); process.exit(1); });
