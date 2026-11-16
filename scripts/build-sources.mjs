#!/usr/bin/env node
/*
 * Rebuilds data/deal-sources.json from the lists below.
 *   node scripts/build-sources.mjs
 * Edit the lists here (not the JSON) to add or remove feeds.
 */
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "deal-sources.json");
const SD = "https://slickdeals.net/newsearch.php?searcharea=deals&searchin=first&rss=1";
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// Slickdeals searches limited to one store (only that store's deals are kept)
const SD_STORES = [
  ["amazon", "Amazon"], ["walmart", "Walmart"], ["lowes", "Lowe's"], ["target", "Target"], ["home depot", "Home Depot"], ["best buy", "Best Buy"],
  ["costco", "Costco"], ["ebay", "eBay"], ["newegg", "Newegg"], ["kohls", "Kohl's"], ["macys", "Macy's"], ["dell", "Dell"], ["lenovo", "Lenovo"],
  ["hp.com", "HP"], ["samsung", "Samsung"], ["apple", "Apple"], ["nike", "Nike"], ["adidas", "adidas"], ["staples", "Staples"], ["office depot", "Office Depot"],
  ["gamestop", "GameStop"], ["wayfair", "Wayfair"], ["sams club", "Sam's Club"], ["woot", "Woot"], ["micro center", "Micro Center"],
  ["b&h", "B&H Photo"], ["adorama", "Adorama"], ["rei", "REI"], ["dicks sporting goods", "Dick's Sporting Goods"], ["old navy", "Old Navy"],
  ["gap", "Gap"], ["nordstrom rack", "Nordstrom Rack"], ["ulta", "Ulta"], ["sephora", "Sephora"], ["cvs", "CVS"], ["walgreens", "Walgreens"],
  ["chewy", "Chewy"], ["steam", "Steam"], ["playstation store", "PlayStation"], ["aliexpress", "AliExpress"], ["anker", "Anker"],
];
// Slickdeals product searches: any store
const SD_TOPICS = [
  "laptop", "macbook", "chromebook", "gaming laptop", "monitor", "4k tv", "oled tv", "soundbar", "headphones", "airpods", "earbuds", "speaker",
  "ssd", "nvme", "hard drive", "microsd", "graphics card", "rtx", "cpu", "ram", "router", "mesh wifi", "printer", "webcam", "keyboard", "mouse",
  "ipad", "tablet", "kindle", "iphone", "pixel", "galaxy", "smartwatch", "apple watch", "fitbit", "garmin", "camera", "gopro", "drone",
  "nintendo switch", "ps5", "xbox", "video game", "steam deck", "vr headset",
  "air fryer", "instant pot", "coffee maker", "espresso", "blender", "kitchenaid", "cookware", "knife set", "vacuum", "robot vacuum", "dyson",
  "air purifier", "mattress", "bedding", "furniture", "office chair", "standing desk", "smart home", "ring doorbell", "security camera", "thermostat",
  "dewalt", "milwaukee", "ryobi", "makita", "drill", "tool set", "generator", "lawn mower", "pressure washer", "grill", "patio",
  "running shoes", "sneakers", "jacket", "jeans", "backpack", "luggage", "watch", "sunglasses",
  "lego", "toys", "board game", "baby", "diapers", "vitamins", "protein", "skincare", "razor", "electric toothbrush",
  "pet food", "gift card", "costco membership", "tires", "car battery", "bike", "e-bike", "camping", "fitness", "treadmill",
];
// DealNews category and store feeds
const DN_CATS = ["c1009/Home-Garden", "c108/Computers", "c113/Computers", "c1139/Home-Garden", "c114/Computers", "c124/Computers", "c142/Electronics",
  "c143/Electronics", "c147/Electronics", "c148/Electronics", "c155/Electronics", "c159/Electronics", "c168/Electronics", "c171/Electronics",
  "c174/Electronics", "c178/Movies-Music-Books", "c182/Office-School-Supplies", "c186/Gaming-Toys", "c189/Gaming-Toys", "c191/Gaming-Toys",
  "c196/Home-Garden", "c197/Home-Garden", "c198/Home-Garden", "c199/Home-Garden", "c200/Home-Garden", "c201/Home-Garden", "c202/Clothing-Accessories",
  "c205/Clothing-Accessories", "c211/Sports-Fitness", "c213/Home-Garden", "c214/Home-Garden", "c227/Clothing-Accessories", "c238/Automotive",
  "c280/Clothing-Accessories", "c287/Clothing-Accessories", "c297/Computers", "c299/Electronics", "c304/Home-Garden", "c306/Electronics",
  "c360/Home-Garden", "c377/Home-Garden", "c39/Computers", "c40/Store-Events", "c41/Computers", "c436/Clothing-Accessories", "c452/Electronics",
  "c454/Clothing-Accessories", "c48/Computers", "c481/Clothing-Accessories", "c487/Clothing-Accessories", "c488/Clothing-Accessories",
  "c489/Clothing-Accessories", "c49/Computers", "c490/Clothing-Accessories", "c491/Electronics", "c492/Home-Garden", "c515/Clothing-Accessories",
  "c529/Home-Garden", "c559/Clothing-Accessories", "c56/Computers", "c568/Computers", "c572/Computers", "c577/Computers", "c594/Computers",
  "c607/Home-Garden", "c623/Computers", "c636/Special-Occasion", "c642/Home-Garden", "c645/Home-Garden", "c646/Home-Garden", "c647/Home-Garden",
  "c648/Home-Garden", "c649/Office-School-Supplies", "c661/Home-Garden", "c671/Electronics", "c672/Electronics", "c674/Electronics",
  "c678/Sports-Fitness", "c70/Computers", "c716/Clothing-Accessories", "c717/Clothing-Accessories", "c719/Clothing-Accessories",
  "c721/Clothing-Accessories", "c732/Computers", "c744/Home-Garden", "c747/Home-Garden", "c756/Health-Beauty", "c798/Health-Beauty",
  "c810/Home-Garden", "c831/Home-Garden", "c837/Electronics", "c851/Clothing-Accessories", "c862/Home-Garden", "c866/Clothing-Accessories",
  "c882/Home-Garden", "c914/Electronics", "c917/Electronics", "c93/Computers", "c961/Home-Garden"];
const DN_STORES = ["s313/Amazon", "s321/Walmart", "s1308/Lowes", "s560/Best-Buy", "s50/eBay", "s504/Newegg", "s1009/Kohls", "s288/Macys",
  "s38875/Wayfair", "s604/Dell-Technologies", "s1662/Lenovo", "s6058/Samsung", "s1186/Nike", "s415/Apple", "s1692/Woot-An-Amazon-Company",
  "s1065/Boscovs", "s1491/Levis", "s279/J-Crew", "s289/Walgreens", "s320/JCPenney", "s363/Overstock-com", "s40109/All-Modern", "s40155/Joss-Main",
  "s42512/lululemon", "s43780/Anker", "s44411/Ali-Express", "s474/Petco", "s52801/Leatherman", "s5796/Crocs", "s60696/Gymshark"];
// Deal blogs and editorial deal feeds (titleMatch keeps posts that are about a priced deal)
const PRICED = "\\$\\d|\\d+% off|free\\b|bogo|deal";
const BLOGS = [
  { id: "9to5toys", url: "https://9to5toys.com/feed/", ranked: true },
  { id: "9to5mac-deals", url: "https://9to5mac.com/guides/deals/feed/" },
  { id: "9to5google-deals", url: "https://9to5google.com/guides/deals/feed/" },
  { id: "androidauthority-deals", url: "https://www.androidauthority.com/deals/feed/" },
  { id: "androidpolice-deals", url: "https://www.androidpolice.com/feed/deals/" },
  { id: "cnet-deals", url: "https://www.cnet.com/rss/deals/", titleMatch: PRICED },
  { id: "bgr-deals", url: "https://www.bgr.com/category/deals/feed/", titleMatch: PRICED },
  { id: "gamespot-deals", url: "https://www.gamespot.com/feeds/deals/", titleMatch: PRICED },
  { id: "digitaltrends-deals", url: "https://www.digitaltrends.com/deals/feed/", titleMatch: PRICED },
  { id: "bensbargains", url: "https://www.bensbargains.com/rss/", priceInBody: true },
  { id: "dealcatcher", url: "https://www.dealcatcher.com/rss" },
  { id: "hip2save", url: "https://www.hip2save.com/feed/", match: "post_type=deals" },
  { id: "bargainbabe", url: "https://bargainbabe.com/feed/" },
  { id: "thefreebieguy", url: "https://www.thefreebieguy.com/feed/", titleMatch: PRICED },
  { id: "livingrichwithcoupons", url: "https://www.livingrichwithcoupons.com/feed", titleMatch: PRICED },
];
const REDDIT_SUBS = "deals+GameDeals+frugalmalefashion+frugalfemalefashion+techdeals+NintendoSwitchDeals+PS5Deals+XboxSeriesXDeals+AppleDeals+LaptopDeals+MonitorDeals+headphonedeals+kindledeals+BoardGameDeals+lego_deals+SneakerDeals+AmazonDeals+buildapcsales+Costco+ebaydeals";

const feeds = [
  { id: "slickdeals", type: "slickdeals", ranked: true, url: `${SD}&mode=frontpage` },
  { id: "slickdeals-p2", type: "slickdeals", ranked: true, every: 30, url: `${SD}&mode=frontpage&page=2` },
  { id: "slickdeals-popular", type: "slickdeals", ranked: true, url: `${SD}&mode=popdeals` },
  ...SD_STORES.map(([q, store]) => ({ id: "sd-store-" + slug(store), type: "slickdeals", store, every: 60, url: `${SD}&q=${encodeURIComponent(q)}` })),
  ...SD_TOPICS.map(q => ({ id: "sd-" + slug(q), type: "slickdeals", every: 60, url: `${SD}&q=${encodeURIComponent(q)}` })),
  { id: "dealnews", type: "dealnews", ranked: true, url: "https://www.dealnews.com/?rss=1" },
  ...DN_STORES.map(p => ({ id: "dn-" + slug(p.split("/")[1]), type: "dealnews", every: 30, url: `https://www.dealnews.com/${p}/?rss=1` })),
  ...DN_CATS.map(p => ({ id: "dn-" + p.split("/")[0], type: "dealnews", every: 60, url: `https://www.dealnews.com/${p}/?rss=1` })),
  ...BLOGS.map(b => ({ type: "rss", every: 30, ...b })),
  { id: "reddit", type: "reddit", ranked: true, url: `https://www.reddit.com/r/${REDDIT_SUBS}/top/.rss?t=day` },
];
const ids = new Set(); for (const f of feeds) { if (ids.has(f.id)) throw new Error("duplicate id " + f.id); ids.add(f.id); }

const body = {
  _comment: "Generated by scripts/build-sources.mjs; edit that file. type: slickdeals | dealnews | reddit | rss. store: keep only that store's deals. ranked: feed order means hotness. every: minimum minutes between fetches (rotation adapts on top of this).",
  feeds,
};
await writeFile(OUT, JSON.stringify(body, null, 1).replace(/\{\n\s+("id"[^}]*?)\n\s+\}/g, (m, inner) => "{ " + inner.replace(/,\n\s+/g, ", ") + " }") + "\n");
console.log(`${feeds.length} feeds → data/deal-sources.json`);
