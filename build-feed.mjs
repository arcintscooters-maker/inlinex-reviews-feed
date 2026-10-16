#!/usr/bin/env node
/* Google Product Ratings feed for Merchant Center 10799544, built from Loox.   2026-10-16
 *
 * Why: Google enabled the account for Product Ratings feeds (ticket 8-0412000041371) and waits for OUR feed; Loox offers no feed
 * URL (it only pushes as an aggregator, the other onboarding route). So this script builds Google's product-review XML (schema 2.3,
 * https://developers.google.com/product-review-feeds) from Loox's public widget pages and the Shopify catalogue, and the GitHub
 * Action in .github/workflows commits it to docs/product-reviews.xml, which GitHub Pages serves for Merchant Center's daily fetch.
 *
 * Sources
 *   Shopify Admin API (client_credentials, same app as inlinex-admin-app): active products with reviews.rating_count > 0, their
 *   handle, title, vendor and variant SKUs/barcodes.
 *   Loox widget page https://loox.io/widget/UEf-LnQ_ui/reviews/<product id> (public, no login): one review per
 *   <div data-id=".." data-media-type=".." class="grid-item-wrap..."> with reviewer name, data-time (ms), star rating, text, photo,
 *   "Item type" (variant). No product has more than ~20 reviews, so the first page holds them all (the Show-more button is hidden).
 *   Loox "product groups" repeat one review across colourways: reviews are deduplicated by data-id and the <products> list carries
 *   every product the review appeared on.
 *
 * Google rules applied: reviewer name required; content required (reviews with no text are skipped); overall rating 1-5;
 * product_ids = gtin only when the barcode passes the GS1 check digit (brand + mpn=SKU otherwise, 700+ of our barcodes fail),
 * product_url + review_url on inlinexskate.com; collection_method post_fulfillment (Loox asks after fulfilment).
 *
 *   node build-feed.mjs            -> docs/product-reviews.xml + docs/summary.json
 *   env SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET (or ../inlinex-admin-app/.env when run on Adam's machine)
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOP = "inline-skate.myshopify.com";
const STORE = "https://inlinexskate.com";
const LOOX_KEY = "UEf-LnQ_ui";
const OUT_DIR = join(HERE, "docs");

if (!process.env.SHOPIFY_CLIENT_ID) {                       // local run: borrow the admin app's .env
  const p = join(HERE, "..", "inlinex-admin-app", ".env");
  if (existsSync(p)) for (const l of readFileSync(p, "utf8").split(/\r?\n/)) { const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); }
}
const { SHOPIFY_CLIENT_ID: CID, SHOPIFY_CLIENT_SECRET: CSEC } = process.env;
if (!CID || !CSEC) { console.error("SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET missing"); process.exit(1); }

const tk = await (await fetch(`https://${SHOP}/admin/oauth/access_token`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_id: CID, client_secret: CSEC, grant_type: "client_credentials" }) })).json();
const gql = async (q, v) => { for (let a = 0; a < 8; a++) { const r = await (await fetch(`https://${SHOP}/admin/api/2026-04/graphql.json`, { method: "POST", headers: { "X-Shopify-Access-Token": tk.access_token, "Content-Type": "application/json" }, body: JSON.stringify({ query: q, variables: v }) })).json(); if (r.errors && JSON.stringify(r.errors).includes("THROTTLED")) { await new Promise(r => setTimeout(r, 2000)); continue; } if (r.errors) throw new Error(JSON.stringify(r.errors).slice(0, 300)); return r.data; } };

// 1. products with reviews
const products = []; let cursor = null;
for (;;) {
  const d = await gql(`query($c:String){ products(first:100, after:$c, query:"status:active"){ pageInfo{hasNextPage endCursor} nodes{ id title handle vendor onlineStoreUrl rc: metafield(namespace:"reviews", key:"rating_count"){value} variants(first:60){nodes{ sku barcode title }} } } }`, { c: cursor });
  for (const p of d.products.nodes) if (+(p.rc?.value || 0) > 0 && p.onlineStoreUrl) products.push({ id: p.id.split("/").pop(), title: p.title.replace(/[\u{1F300}-\u{1FAFF}☀-➿]/gu, "").trim(), handle: p.handle, vendor: p.vendor, variants: p.variants.nodes });
  if (!d.products.pageInfo.hasNextPage) break; cursor = d.products.pageInfo.endCursor;
}
console.log(`products with reviews: ${products.length}`);

// 2. Loox widget pages
const gs1ok = b => { if (!/^\d{8}$|^\d{12,14}$/.test(b)) return false; const d = b.split("").map(Number); const chk = d.pop(); let s = 0; d.reverse().forEach((x, i) => s += x * (i % 2 === 0 ? 3 : 1)); return (10 - s % 10) % 10 === chk; };
const unesc = s => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").trim();
const reviews = new Map(); let fetched = 0, failed = 0; const statuses = {};
async function scrape(p) {
  let html = "";
  for (let a = 0; a < 5; a++) { try { const r = await fetch(`https://loox.io/widget/${LOOX_KEY}/reviews/${p.id}`, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36", "Accept": "text/html" } }); if (r.ok) { html = await r.text(); break; } statuses[r.status] = (statuses[r.status] || 0) + 1; } catch (e) { statuses.err = (statuses.err || 0) + 1; } await new Promise(r => setTimeout(r, 2500 * (a + 1))); }
  if (!html) { failed++; return; }
  fetched++;
  const parts = html.split(/<div data-id="([A-Za-z0-9_-]+)" data-media-type="([a-z]*)" class="grid-item-wrap/);
  for (let k = 1; k < parts.length - 1; k += 3) {
    const id = parts[k], block = parts[k + 2];
    const name = (block.match(/class="title">([^<]*)/) || [])[1]; const ts = +(block.match(/data-time='(\d+)'/) || [])[1];
    const stars = +(block.match(/Rating icons:\s+(\d) \/ 5/) || [])[1]; const text = unesc((block.match(/class="main-text">([\s\S]*?)<\/div>/) || [, ""])[1]);
    const img = (block.match(/<img src="([^"]+)"/) || [])[1]; const verified = /verified-badge-and-text/.test(block);
    const variant = (block.match(/item-type-value">([^<]*)/) || [])[1];
    if (!id || !name || !ts || !(stars >= 1 && stars <= 5)) continue;
    const r = reviews.get(id) || { id, name: unesc(name), ts, stars, text, img: img ? "https:" + img.replace(/^https?:/, "") : null, verified, variant, products: [] };
    if (!r.products.find(x => x.id === p.id)) r.products.push(p);
    reviews.set(id, r);
  }
}
for (let i = 0; i < products.length; i += 2) { await Promise.all(products.slice(i, i + 2).map(scrape)); await new Promise(r => setTimeout(r, 400)); }
console.log(`loox pages fetched ${fetched}, failed ${failed}, unique reviews ${reviews.size}, non-ok statuses ${JSON.stringify(statuses)}`);

// 3. XML
const x = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const idsFor = p => {
  const gtins = [...new Set(p.variants.map(v => (v.barcode || "").trim()).filter(gs1ok))];
  const mpns = [...new Set(p.variants.map(v => (v.sku || "").trim()).filter(m => m && !gtins.includes(m)))].slice(0, 20);
  let out = "<product_ids>";
  if (gtins.length) out += `<gtins>${gtins.slice(0, 20).map(g => `<gtin>${g}</gtin>`).join("")}</gtins>`;
  if (mpns.length) out += `<mpns>${mpns.map(m => `<mpn>${x(m)}</mpn>`).join("")}</mpns>`;
  if (p.vendor) out += `<brands><brand>${x(p.vendor)}</brand></brands>`;
  return out + "</product_ids>";
};
let n = 0, skippedNoText = 0; const items = [];
for (const r of [...reviews.values()].sort((a, b) => b.ts - a.ts)) {
  if (!r.text || r.text.length < 2) { skippedNoText++; continue; }
  const main = r.products[0];
  items.push(`<review>
<review_id>${x(r.id)}</review_id>
<reviewer><name>${x(r.name)}</name></reviewer>
<review_timestamp>${new Date(r.ts).toISOString().replace(/\.\d{3}Z$/, "Z")}</review_timestamp>
<content>${x(r.text)}</content>
<review_url type="singleton">${x(`${STORE}/products/${main.handle}#looxReviews`)}</review_url>
${r.img ? `<reviewer_images><reviewer_image><url>${x(r.img)}</url></reviewer_image></reviewer_images>\n` : ""}<ratings><overall min="1" max="5">${r.stars}</overall></ratings>
<products>${r.products.map(p => `<product>${idsFor(p)}<product_name>${x(p.title)}</product_name><product_url>${x(`${STORE}/products/${p.handle}`)}</product_url></product>`).join("")}</products>
<is_spam>false</is_spam>
<collection_method>post_fulfillment</collection_method>
</review>`);
  n++;
}
const xml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:vc="http://www.w3.org/2007/XMLSchema-versioning" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://www.google.com/shopping/reviews/schema/product/2.3/product_reviews.xsd">
<version>2.3</version>
<publisher><name>Inlinex</name><favicon>${STORE}/favicon.ico</favicon></publisher>
<reviews>
${items.join("\n")}
</reviews>
</feed>
`;
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, "product-reviews.xml"), xml);
const summary = { built: new Date().toISOString(), products: products.length, looxPagesFetched: fetched, looxPagesFailed: failed, uniqueReviews: reviews.size, reviewsInFeed: n, skippedNoText, bytes: Buffer.byteLength(xml) };
writeFileSync(join(OUT_DIR, "summary.json"), JSON.stringify(summary, null, 1));
if (!existsSync(join(OUT_DIR, "index.html"))) writeFileSync(join(OUT_DIR, "index.html"), `<!doctype html><title>Inlinex product reviews feed</title><p>Google Product Ratings feed: <a href="product-reviews.xml">product-reviews.xml</a></p>`);
console.log(JSON.stringify(summary));
if (failed > products.length * 0.2 || n < 100) { console.error("feed looks incomplete - not trusting this build"); process.exit(2); }
