#!/usr/bin/env node
/*
 * DealDrop alert emails.
 *
 *   node scripts/send-alerts.mjs                      confirmations + price alerts
 *   node scripts/send-alerts.mjs --confirmations-only confirmations only (runs every 15 minutes)
 *   node scripts/send-alerts.mjs --price-alerts-only  price alerts only (runs after the daily price update)
 *
 * Environment:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   the dealdrop Supabase project (service role key, never the anon key)
 *   RESEND_API_KEY                            https://resend.com
 *   ALERT_FROM                                e.g. "DealDrop <alerts@yourdomain.com>" (domain verified in Resend)
 *   SITE_URL                                  public address of the site, e.g. https://you.github.io/dealdrop/
 *
 * Testing without services: ALERTS_MOCK_FILE=<alerts.json> uses a local JSON array instead of
 * Supabase, and EMAIL_DRY_RUN=1 prints emails instead of sending them.
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const env = process.env;
const CONFIRM_ONLY = process.argv.includes("--confirmations-only");
const ALERTS_ONLY = process.argv.includes("--price-alerts-only");
const SITE = (env.SITE_URL || "").replace(/#.*$/, "").replace(/\/?$/, "/");
const log = (...a) => console.log("[alerts]", ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const money = v => "$" + Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/* ---------- storage: Supabase REST (service role) or a local mock file ---------- */
const store = env.ALERTS_MOCK_FILE ? {
  async list(filter) { return JSON.parse(await readFile(env.ALERTS_MOCK_FILE, "utf8")).filter(filter); },
  async update(id, patch) {
    const rows = JSON.parse(await readFile(env.ALERTS_MOCK_FILE, "utf8"));
    Object.assign(rows.find(r => r.id === id), patch);
    await writeFile(env.ALERTS_MOCK_FILE, JSON.stringify(rows, null, 1));
  },
} : {
  async req(path, opts = {}) {
    const res = await fetch(`${env.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/${path}`, {
      ...opts,
      headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json", ...(opts.headers || {}) },
    });
    if (!res.ok) throw new Error(`Supabase ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.status === 204 ? null : res.json();
  },
  async list(_, query) { return this.req(`dealdrop_alerts?${query}&order=id&limit=1000`); },
  async update(id, patch) { await this.req(`dealdrop_alerts?id=eq.${id}`, { method: "PATCH", body: JSON.stringify(patch), headers: { Prefer: "return=minimal" } }); },
};

/* ---------- email ---------- */
async function sendEmail({ to, subject, html, text, unsubUrl }) {
  if (env.EMAIL_DRY_RUN) { log(`DRY RUN → ${to}: ${subject}\n${text}\n`); return; }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: env.ALERT_FROM, to: [to], subject, html, text,
      headers: unsubUrl ? { "List-Unsubscribe": `<${unsubUrl}>` } : undefined,
    }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
  await sleep(600);                                       // Resend's default limit is 2 requests/second
}

const layout = (title, bodyHtml, unsubUrl) => `<!doctype html><html><body style="margin:0;background:#f6f7f9;font-family:Arial,Helvetica,sans-serif;color:#12151c">
<div style="max-width:520px;margin:0 auto;padding:24px 16px">
<div style="font-weight:800;font-size:18px;margin-bottom:16px"><span style="background:#d1203a;color:#fff;padding:4px 8px;font-size:12px;letter-spacing:.06em">BLACK FRIDAY</span> DealDrop</div>
<div style="background:#fff;border:1px solid #dde1e8;border-radius:10px;padding:20px">
<h1 style="font-size:20px;margin:0 0 12px">${esc(title)}</h1>${bodyHtml}</div>
<p style="font-size:12px;color:#747b8a;line-height:1.5">Prices change often; confirm on the store's site before buying.${unsubUrl ? ` <a href="${esc(unsubUrl)}" style="color:#747b8a">Stop this alert</a>.` : ""}</p>
</div></body></html>`;
const button = (href, label) => `<a href="${esc(href)}" style="display:inline-block;background:#d1203a;color:#fff;text-decoration:none;font-weight:bold;padding:12px 18px;border-radius:8px">${esc(label)}</a>`;

/* ---------- prices ---------- */
async function loadPrices() {
  const d = JSON.parse(await readFile(join(ROOT, "data", "prices.json"), "utf8"));
  const names = Object.fromEntries((d.stores || []).map(s => [s.id, s.name]));
  const best = new Map();
  for (const p of d.products) {
    let top = null;
    for (const o of p.offers) {
      const now = o.hist[o.hist.length - 1];
      if (now != null && (!top || now < top.price)) top = { price: now, store: names[o.store] || o.store, url: o.url };
    }
    if (top) best.set(p.id, { ...top, msrp: p.msrp, name: p.name, brand: p.brand });
  }
  return best;
}

async function main() {
  if (!env.ALERTS_MOCK_FILE && !(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY)) { log("skipped: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set"); return; }
  if (!env.EMAIL_DRY_RUN && !(env.RESEND_API_KEY && env.ALERT_FROM)) { log("skipped: RESEND_API_KEY / ALERT_FROM not set"); return; }
  if (!env.SITE_URL) { log("skipped: SITE_URL not set (needed for links in emails)"); return; }
  let failures = 0;

  // 1) confirmation emails for new alerts
  const pending = ALERTS_ONLY ? [] : await store.list(r => !r.confirm_sent_at && !r.confirmed_at && !r.unsubscribed_at,
    "confirm_sent_at=is.null&confirmed_at=is.null&unsubscribed_at=is.null&select=id,email,product_id,product_name,target_price,confirm_token,unsub_token");
  for (const a of pending) {
    const confirmUrl = `${SITE}#confirm-${a.confirm_token}`, unsubUrl = `${SITE}#unsub-${a.unsub_token}`;
    try {
      await sendEmail({
        to: a.email, unsubUrl,
        subject: `Confirm your price alert: ${a.product_name}`,
        text: `Confirm your DealDrop alert for ${a.product_name} at ${money(a.target_price)} or less:\n${confirmUrl}\n\nDidn't ask for this? Ignore this email and you won't hear from us.`,
        html: layout("Confirm your price alert",
          `<p style="line-height:1.5">We'll email you once when <b>${esc(a.product_name)}</b> drops to <b>${money(a.target_price)}</b> or less at Best Buy, Walmart or Amazon.</p>
           <p>${button(confirmUrl, "Confirm alert")}</p>
           <p style="font-size:13px;color:#4a5160">Didn't ask for this? Ignore this email and you won't hear from us.</p>`),
      });
      await store.update(a.id, { confirm_sent_at: new Date().toISOString() });
    } catch (e) { failures++; log(`confirmation to alert ${a.id} failed: ${e.message}`); }
  }
  if (!ALERTS_ONLY) log(`confirmations sent: ${pending.length - failures}`);
  if (CONFIRM_ONLY) return;

  // 2) price alerts: confirmed, still active, best price now at or below the target
  const best = await loadPrices();
  const active = await store.list(r => r.confirmed_at && !r.triggered_at && !r.unsubscribed_at,
    "confirmed_at=not.is.null&triggered_at=is.null&unsubscribed_at=is.null&select=id,email,product_id,product_name,target_price,unsub_token");
  let sent = 0;
  for (const a of active) {
    const b = best.get(a.product_id);
    if (!b || b.price > Number(a.target_price)) continue;
    const productUrl = `${SITE}#p-${a.product_id}`, unsubUrl = `${SITE}#unsub-${a.unsub_token}`;
    const off = b.msrp > 0 ? Math.round((1 - b.price / b.msrp) * 100) : 0;
    try {
      await sendEmail({
        to: a.email, unsubUrl,
        subject: `Price drop: ${b.name} is ${money(b.price)} at ${b.store}`,
        text: `${b.brand} ${b.name} is now ${money(b.price)} at ${b.store} (your target: ${money(a.target_price)}${off > 0 ? `, ${off}% off` : ""}).\nBuy: ${b.url || productUrl}\nPrice history: ${productUrl}\n\nThis was a one-time alert. Set a new target on the site any time.`,
        html: layout("Your target price was reached",
          `<p style="line-height:1.5"><b>${esc(b.brand)} ${esc(b.name)}</b> is now</p>
           <p style="font-size:30px;font-weight:bold;margin:4px 0">${money(b.price)} <span style="font-size:14px;color:#747b8a;text-decoration:line-through">${b.msrp ? money(b.msrp) : ""}</span></p>
           <p style="line-height:1.5;margin-top:0">at <b>${esc(b.store)}</b>${off > 0 ? ` · ${off}% off` : ""} · your target was ${money(a.target_price)}</p>
           <p>${button(b.url || productUrl, `Buy at ${b.store}`)}</p>
           <p style="font-size:13px"><a href="${esc(productUrl)}" style="color:#d1203a">See price history and other stores</a></p>
           <p style="font-size:13px;color:#4a5160">This was a one-time alert. You can set a new target on the site any time.</p>`, unsubUrl),
      });
      await store.update(a.id, { triggered_at: new Date().toISOString(), triggered_price: b.price });
      sent++;
    } catch (e) { failures++; log(`alert ${a.id} failed: ${e.message}`); }
  }
  log(`price alerts sent: ${sent} (of ${active.length} active)`);
  if (failures) process.exitCode = 1;
}

main().catch(e => { console.error(e.message); process.exit(1); });
