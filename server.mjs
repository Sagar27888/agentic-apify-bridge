import express from "express";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { paymentMiddleware } from "@x402/express";
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme as ExactEvmServerScheme } from "@x402/evm/exact/server";
import { ExactEvmScheme as ExactEvmClientScheme } from "@x402/evm/exact/client";
import { declareDiscoveryExtension } from "@x402/extensions";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { createCdpFacilitatorClient } from "@coinbase/cdp-sdk/x402";
import { privateKeyToAccount } from "viem/accounts";
dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");

const {
  PORT = 8080,
  PAY_TO,                                   // your Base wallet (USDC lands here)
  PRICE = "$0.05",                          // price per call (what the paying agent is charged)
  NETWORK = "base-sepolia",                 // testnet: base-sepolia | mainnet: base
  FACILITATOR_URL = "https://x402.org/facilitator",
  APIFY_TOKEN,                              // OUR Apify token (Scenario A: platform pays compute)
  MOCK_DATA,                                // "1" => bundled sample data (no Apify needed)
} = process.env;

// ---------------------------------------------------------------------------
// Actor registry — one bridge, many Actors. Add/remove entries freely.
// input(p): builds the Actor's real input from simple UI params {q, location, max}.
// row(r):   normalizes one result object into {title, sub, meta, url} for the UI table.
// ---------------------------------------------------------------------------
// Result-count policy.
// Floor: every call scrapes at least MIN_RESULTS (buyer always gets value).
// Ceiling: our token (Scenario A, we pay compute) capped at CAP_OUR to protect margin.
//          customer token (Scenario B, they pay compute) is uncapped.
const MIN_RESULTS = 1;
const CAP_OUR = 1000;
function amountFor(v, token) {
  const n = Math.max(Number(v || MIN_RESULTS), MIN_RESULTS);
  return token ? n : Math.min(n, CAP_OUR);
}

const ACTORS = {
  "flipkart-scraper": {
    apify: "techforce.global~flipkart-scraper",
    label: "Flipkart Product Search",
    kind: "e-commerce",
    needs: ["q", "max"],
    input: (p) => ({ searchQuery: p.q || "wireless earbuds", maxProducts: Number(p.max), sortBy: "relevance" }),
    row: (r) => ({ title: r.title, sub: r.currentPrice != null ? "₹" + r.currentPrice : "", meta: [r.originalPrice ? "MRP ₹" + r.originalPrice : "", r.discountPercent ? r.discountPercent + "% off" : "", r.rating ? "★" + r.rating : ""].filter(Boolean).join(" · "), url: r.url }),
  },
  "amazon-scraper": {
    apify: "techforce.global~amazon-scraper",
    label: "Amazon Product Search",
    kind: "e-commerce",
    needs: ["q", "max"],
    input: (p) => {
      const allowed = ["www.amazon.com", "www.amazon.in", "www.amazon.co.uk", "www.amazon.de", "www.amazon.ca", "www.amazon.com.au", "www.amazon.ae"];
      const amazonDomain = allowed.includes(p.domain) ? p.domain : "www.amazon.com";
      return { searchKeywords: [p.q || "wireless earbuds"], maxItemsPerSearch: Number(p.max), maxPagesPerSearch: 20, amazonDomain, proxyConfiguration: { useApifyProxy: true, apifyProxyGroups: ["RESIDENTIAL"] } };
    },
    row: (r) => ({ title: r.title, sub: r.priceRaw || (r.price != null ? r.price : ""), meta: [r.brand, r.rating ? "★" + r.rating : "", r.reviewsCount ? r.reviewsCount + " reviews" : ""].filter(Boolean).join(" · "), url: r.url }),
  },
  "google-maps-leads-sales-intelligence-tool": {
    apify: "techforce.global~google-maps-leads-sales-intelligence-tool",
    label: "Google Maps Business Leads",
    kind: "lead-gen",
    needs: ["q", "location", "max"],
    input: (p) => ({ searchQuery: p.q || "Coffee shop", location: p.location || "London", maxResults: Number(p.max), includeSalesStrategy: false, includeWebsiteHealthScorecard: false, includeServiceRecommendations: false, includeTechnicalIntel: false, proxyConfiguration: { useApifyProxy: false } }),
    row: (r) => ({ title: r.businessName, sub: r.category || "", meta: [r.phone && r.phone !== "NA" ? r.phone : "", r.companyEmail && r.companyEmail !== "NA" ? r.companyEmail : "", r.address].filter(Boolean).join(" · "), url: r.website || r.url }),
  },
  "eventbrite-scraper": {
    apify: "techforce.global~eventbrite-scraper",
    label: "Eventbrite Events",
    kind: "events",
    needs: ["location", "max"],
    input: (p) => ({ location: p.location || "india--ahmedabad", category: "All Events", maxEvents: Number(p.max) }),
    row: (r) => ({ title: r.name, sub: r.start || "", meta: [r.venue && r.venue.city ? r.venue.city : "", r.venue && r.venue.name ? String(r.venue.name).slice(0, 60) : ""].filter(Boolean).join(" · "), url: r.url }),
  },
  "all-events-scraper": {
    apify: "techforce.global~all-events-scraper",
    label: "All Events",
    kind: "events",
    needs: ["location", "max"],
    input: (p) => ({ location: p.location || "London", limit: Math.min(Number(p.max), 100), proxyConfiguration: { useApifyProxy: true, apifyProxyGroups: ["RESIDENTIAL"], apifyProxyCountry: "IN" } }),
    row: (r) => ({ title: r.Title, sub: r.DateTime || "", meta: [r.Location, r.Interested].filter(Boolean).join(" · "), url: r.URL }),
  },
};

const app = express();
app.set("trust proxy", true); // behind Render proxy → detect real https for x402 resource URL
app.use(express.static(PUBLIC_DIR));
app.get("/", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));

// ---- helpers ----
function actorFromReq(req) {
  const key = (req.query.actor || "google-maps-leads-sales-intelligence-tool").toString();
  return { key, def: ACTORS[key] };
}
function paramsFromReq(req) {
  return {
    q: (req.query.q || "").toString(),
    location: (req.query.location || "").toString(),
    domain: (req.query.domain || "").toString(),
    max: req.query.max,
  };
}
// Customer-supplied Apify token (Scenario B). Header preferred; query fallback for browser tests.
function customerToken(req) {
  return (req.get("x-apify-token") || req.query.apify_token || "").toString().trim();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const whoCache = new Map();
async function whoami(token) {
  if (!token) return "(none)";
  if (whoCache.has(token)) return whoCache.get(token);
  try {
    const r = await fetch(`https://api.apify.com/v2/users/me?token=${token}`);
    const name = ((await r.json()).data || {}).username || "(unknown)";
    whoCache.set(token, name);
    return name;
  } catch {
    return "(unknown)";
  }
}

function sampleItems(max) {
  const base = [
    { title: "Sample Item A", sub: "₹1,599", meta: "demo · ★4.3", url: "https://example.com/a", currentPrice: 1599 },
    { title: "Sample Item B", sub: "₹2,499", meta: "demo · ★4.5", url: "https://example.com/b", currentPrice: 2499 },
    { title: "Sample Item C", sub: "₹999", meta: "demo · ★4.1", url: "https://example.com/c", currentPrice: 999 },
  ];
  return base.slice(0, Math.min(Math.max(Number(max || MIN_RESULTS), 1), 3));
}

// ---- core: run an Actor and RETURN THE PLATFORM FEE + which account paid it ----
// token supplied  => runs on CUSTOMER Apify account (Scenario B) → platform fee billed to them.
// no token        => runs on OUR APIFY_TOKEN (Scenario A)        → platform fee billed to us.
async function runActor(actorKey, params, token) {
  const def = ACTORS[actorKey];
  if (!def) throw new Error(`Unknown actor '${actorKey}'. Known: ${Object.keys(ACTORS).join(", ")}`);
  const useToken = token || APIFY_TOKEN;
  const billedTo = token ? "customer" : "platform";

  if (MOCK_DATA === "1" || !useToken) {
    return { actor: actorKey, label: def.label, billedTo, account: "(sample)", platformFeeUsd: 0, durationSec: 0, runId: null, sample: true, items: sampleItems(params.max), rows: sampleItems(params.max) };
  }

  // resolve how many to scrape: floor MIN_RESULTS; ceiling CAP_OUR on our token, uncapped on customer token
  const amount = amountFor(params.max, token);
  const input = def.input({ ...params, max: amount });
  // 1) start the run (async) so we can read its usage/cost afterward
  const start = await fetch(`https://api.apify.com/v2/acts/${def.apify}/runs?token=${useToken}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!start.ok) throw new Error(`Apify start ${start.status}: ${(await start.text()).slice(0, 300)}`);
  let run = (await start.json()).data;

  // 2) poll until the run finishes (cap ~240s for the demo)
  const deadline = Date.now() + 240000;
  while (!["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"].includes(run.status)) {
    if (Date.now() > deadline) throw new Error(`Run ${run.id} still ${run.status} after 240s (Apify free plan runs one job at a time — wait, then retry, or use a smaller max).`);
    await sleep(2500);
    run = (await (await fetch(`https://api.apify.com/v2/actor-runs/${run.id}?token=${useToken}`)).json()).data;
  }
  if (run.status !== "SUCCEEDED") throw new Error(`Run ${run.id} ended ${run.status}.`);

  // 3) fetch the results (limit to the resolved amount)
  const items = await (await fetch(`https://api.apify.com/v2/datasets/${run.defaultDatasetId}/items?clean=true&limit=${amount}&token=${useToken}`)).json();
  const rows = items.map((r) => { try { return def.row(r); } catch { return { title: JSON.stringify(r).slice(0, 80) }; } });

  return {
    actor: actorKey,
    label: def.label,
    billedTo,                                   // platform | customer
    account: await whoami(useToken),            // which Apify account was charged
    platformFeeUsd: run.usageTotalUsd ?? null,  // <-- THE PLATFORM FEE for this run
    durationSec: run.stats ? Math.round((run.stats.runTimeSecs || 0)) : null,
    runId: run.id,
    sample: false,
    requested: amount,                          // how many we asked for (after floor/ceiling)
    shortfall: items.length < MIN_RESULTS,      // source had fewer than the MIN_RESULTS floor
    count: items.length,
    items,
    rows,
  };
}

// price string "$0.05" -> number
function priceNum() { const n = parseFloat(String(PRICE).replace(/[^0-9.]/g, "")); return isNaN(n) ? 0 : n; }

// ---- per-record pricing ----
// What the paying agent is charged PER RECORD, by Actor. Price for a call = records × rate.
const RATES = {
  "google-maps-leads-sales-intelligence-tool": 0.05, // premium leads
  "amazon-scraper": 0.03,
  "flipkart-scraper": 0.008,
  "eventbrite-scraper": 0.006,
  "all-events-scraper": 0.005,
};
// Per-actor hard ceiling on records (some Apify actors cap what they return).
// Protects buyers from being charged for records the actor cannot deliver.
const ACTOR_MAX = { "all-events-scraper": 100 };
function recordsFor(actorKey, maxParam, token) {
  const n = amountFor(maxParam, token);
  const cap = ACTOR_MAX[actorKey];
  return cap ? Math.min(n, cap) : n;
}
const DEFAULT_RATE = Number(process.env.RATE_PER_RECORD || 0.01);
const rateFor = (key) => (RATES[key] != null ? RATES[key] : DEFAULT_RATE);

// resolve {records, rate, priceUsd} for a request (floor 10; cap 1000 on our token)
function pricingForReq(req) {
  const { key } = actorFromReq(req);
  const records = amountFor(req.query.max, customerToken(req));
  const rate = rateFor(key);
  const priceUsd = +(records * rate).toFixed(4);
  return { key, records, rate, priceUsd, priceStr: "$" + priceUsd.toFixed(4) };
}

// CAIP-2 chain id for the configured network (x402 v2 uses these)
const CAIP = NETWORK === "base" ? "eip155:8453" : "eip155:84532";
// Public HTTPS resource URL. MUST be https for the CDP Bazaar to accept discovery registration.
// (Render provides RENDER_EXTERNAL_URL; falls back to an explicit PUBLIC_URL env, else undefined for local dev.)
const PUBLIC_BASE = process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL || "";
const PUBLIC_RESOURCE = PUBLIC_BASE ? `${PUBLIC_BASE.replace(/\/$/, "")}/api/business-leads` : undefined;
// Per-endpoint public https resource URL (each Actor = its own path = its own Bazaar entry).
const resourceFor = (p) => (PUBLIC_BASE ? `${PUBLIC_BASE.replace(/\/$/, "")}${p}` : undefined);
// x402 v2 DynamicPrice: compute "$X" from the request's records × actor rate (reads x402 request context).
// actorKey pins the price to the endpoint's Actor (each paid path passes its own).
function priceFromCtx(ctx, actorKey) {
  const a = ctx.adapter;
  const q = (n) => { const v = a.getQueryParam ? a.getQueryParam(n) : undefined; return Array.isArray(v) ? v[0] : v; };
  const actor = actorKey || q("actor") || "google-maps-leads-sales-intelligence-tool";
  const token = (a.getHeader && (a.getHeader("x-apify-token") || "")) || q("apify_token") || "";
  const records = recordsFor(actor, q("max"), token);
  return "$" + (records * rateFor(actor)).toFixed(4);
}

// annotate a run result with the money picture (agent pays records × rate; platform fee as measured)
function withMoney(result, paid) {
  const price = typeof result.priceUsd === "number" ? result.priceUsd : priceNum();
  const fee = typeof result.platformFeeUsd === "number" ? result.platformFeeUsd : 0;
  const money =
    result.billedTo === "customer"
      ? { agentPaysUsd: price, ratePerRecord: result.ratePerRecord, platformFeeUsd: fee, platformFeePaidBy: "customer (their Apify account)", netToYouUsd: +price.toFixed(6), note: "You keep the full price. Customer's Apify account pays the platform fee separately." }
      : { agentPaysUsd: price, ratePerRecord: result.ratePerRecord, platformFeeUsd: fee, platformFeePaidBy: "you (our Apify account)", netToYouUsd: +(price - fee).toFixed(6), note: "Platform fee is deducted from your Apify balance. Net = price - platform fee." };
  return { paid: !!paid, price: "$" + price.toFixed(4), network: NETWORK, ...result, money };
}

// ---- FREE preview (no payment) — shows the Actor + platform fee for both scenarios ----
app.get("/demo/run", async (req, res) => {
  const { key } = actorFromReq(req);
  const cust = customerToken(req);
  const pr = pricingForReq(req);
  try {
    const result = await runActor(key, paramsFromReq(req), cust);
    result.priceUsd = pr.priceUsd;
    result.ratePerRecord = pr.rate;
    res.json(withMoney(result, false));
  } catch (e) {
    res.status(500).json({ error: String(e.message), billedTo: cust ? "customer" : "platform" });
  }
});

// ---- "Paying agent" showcase: server pays its own x402 endpoint with a test wallet ----
// No customer token => "PAID from OUR side" (we pay compute). With token => "PAID from CUSTOMER side".
app.get("/agent-pay/run", async (req, res) => {
  const pk = process.env.PRIVATE_KEY;
  if (!PAY_TO || !pk) {
    return res.status(400).json({ paid: false, error: "Set PAY_TO + PRIVATE_KEY (a funded base-sepolia wallet) in env to run the paying-agent showcase." });
  }
  const { key } = actorFromReq(req);
  const cust = customerToken(req);
  try {
    const account = privateKeyToAccount(pk.startsWith("0x") ? pk : "0x" + pk);
    // x402 v2 client: register the EVM 'exact' scheme for our network, signed by the payer wallet.
    const client = new x402Client().register(CAIP, new ExactEvmClientScheme(account));
    const payFetch = wrapFetchWithPayment(globalThis.fetch.bind(globalThis), client);
    const PATHS = { "amazon-scraper": "/api/amazon-products", "all-events-scraper": "/api/all-events" };
    const targetPath = PATHS[key] || "/api/business-leads";
    let params;
    if (key === "amazon-scraper") params = { q: req.query.q || "", max: String(req.query.max || 10), domain: req.query.domain || "" };
    else if (key === "all-events-scraper") params = { location: req.query.location || "", max: String(req.query.max || 10) };
    else params = { actor: key, q: req.query.q || "", location: req.query.location || "", max: String(req.query.max || 10) };
    const qs = new URLSearchParams(params).toString();
    const r = await payFetch(`http://localhost:${PORT}${targetPath}?${qs}`, {
      method: "GET",
      headers: cust ? { "x-apify-token": cust } : {},
    });
    const data = await r.json();
    res.json({ paidBy: account.address, payTo: PAY_TO, ...data });
  } catch (e) {
    res.status(502).json({ paid: false, error: String(e.message), hint: "Ensure the payer wallet holds USDC on Base." });
  }
});

// ---- x402 v2 PAID route: the real monetized endpoint agents / agentic.market call ----
let x402Enabled = false;
try {
  if (PAY_TO) {
    // Mainnet (base): Coinbase CDP facilitator (reads CDP_API_KEY_ID / CDP_API_KEY_SECRET) — required for Bazaar listing.
    // Testnet (base-sepolia): public x402.org facilitator.
    const useCdp = NETWORK === "base" && process.env.CDP_API_KEY_ID && process.env.CDP_API_KEY_SECRET;
    const facilitator = useCdp ? createCdpFacilitatorClient() : new HTTPFacilitatorClient({ url: FACILITATOR_URL });
    console.log(`[x402] v2 facilitator: ${useCdp ? "Coinbase CDP mainnet" : FACILITATOR_URL} on ${CAIP}`);
    const resourceServer = new x402ResourceServer(facilitator).register("eip155:*", new ExactEvmServerScheme());

    const routes = {
      "GET /api/business-leads": {
        accepts: {
          scheme: "exact",
          network: CAIP,
          payTo: PAY_TO,
          price: (ctx) => priceFromCtx(ctx, "google-maps-leads-sales-intelligence-tool"), // dynamic per-record price
        },
        resource: PUBLIC_RESOURCE, // pin to public https URL so the CDP Bazaar accepts discovery registration
        serviceName: "Techforce Agents Business Leads", // shared prefix "Techforce Agents" => page header; card shows "Business Leads"
        tags: ["data", "web-scraping", "data-extraction", "leads", "google-maps", "sales-intelligence", "b2b", "scraper"],
        // Real sample returned in the 402 body for unpaid requests, so marketplace cards
        // (and any client) can preview the true output shape without paying.
        unpaidResponseBody: () => ({
          contentType: "application/json",
          body: {
            note: "Sample preview. Pay $0.05/lead via x402 to receive live results.",
            items: [
              { businessName: "Monmouth Coffee", category: "Coffee shop", phone: "+44 20 7232 3010", website: "https://www.monmouthcoffee.co.uk", companyEmail: "hello@monmouthcoffee.co.uk", address: "27 Monmouth St, London WC2H 9EU, UK", workingHours: { "Mon-Sat": "8 AM - 6 PM" } },
              { businessName: "Kaffeine", category: "Coffee shop", phone: "+44 20 7580 6755", website: "https://www.kaffeine.co.uk", companyEmail: "", address: "66 Great Titchfield St, London W1W 7QJ, UK", workingHours: { "Mon-Fri": "7:30 AM - 5 PM" } },
              { businessName: "Prufrock Coffee", category: "Coffee shop", phone: "+44 20 7242 0467", website: "https://www.prufrockcoffee.com", companyEmail: "info@prufrockcoffee.com", address: "23-25 Leather Ln, London EC1N 7TE, UK", workingHours: { "Mon-Fri": "8 AM - 6 PM" } },
            ],
          },
        }),
        description: "Google Maps business leads on demand with key details including business name, category, phone, website, email, address, and operating hours. Get leads for $0.05 per record (minimum 1, up to 1,000). Simply enter your search query, target location, and required number of leads. Discover relevant business prospects in any city, anywhere in the world.\n\nPowered by Techforce Global — explore more at https://techforceglobal.com",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            method: "GET",
            input: {
              q: "Coffee shop",
              location: "London",
              max: 10,
            },
            inputSchema: {
              type: "object",
              properties: {
                q: { type: "string", description: "Search text / keyword, e.g. 'Coffee shop'" },
                location: { type: "string", description: "City or area, e.g. 'London'" },
                max: { type: "integer", description: "Number of leads to return (min 1, max 1000)" },
              },
              required: ["q", "location"],
            },
            output: {
              schema: {
                type: "object",
                properties: {
                  items: {
                    type: "array",
                    description: "Array of business leads",
                    items: {
                      type: "object",
                      properties: {
                        businessName: { type: "string", description: "Business name" },
                        category: { type: "string", description: "Business category" },
                        phone: { type: "string", description: "Phone number" },
                        website: { type: "string", description: "Website URL" },
                        companyEmail: { type: "string", description: "Email (if found)" },
                        address: { type: "string", description: "Full address" },
                        workingHours: { type: "object", description: "Opening hours by day" },
                      },
                    },
                  },
                },
              },
              example: { items: [{ businessName: "Monmouth Coffee", category: "Coffee shop", phone: "+44 20 7232 3010", website: "https://www.monmouthcoffee.co.uk", companyEmail: "", address: "27 Monmouth St, London WC2H 9EU, UK", workingHours: { "Mon-Sat": "8 AM - 6 PM" } }] },
            },
          }),
        },
      },
      "GET /api/amazon-products": {
        accepts: {
          scheme: "exact",
          network: CAIP,
          payTo: PAY_TO,
          price: (ctx) => priceFromCtx(ctx, "amazon-scraper"), // dynamic per-record price
        },
        resource: resourceFor("/api/amazon-products"),
        serviceName: "Techforce Agents Amazon Products", // shared prefix "Techforce Agents" => page header; card shows "Amazon Products"
        tags: ["data", "web-scraping", "data-extraction", "amazon", "products", "e-commerce", "price-tracking", "scraper"],
        unpaidResponseBody: () => ({
          contentType: "application/json",
          body: {
            note: "Sample preview. Pay $0.03/record via x402 to receive live results.",
            items: [
              { asin: "B09JZXQ3P1", title: "Wireless Earbuds Bluetooth 5.3, 40H Playtime, IPX7 Waterproof", brand: "SoundCore", price: 29.99, priceRaw: "$29.99", currency: "USD", rating: 4.4, reviewsCount: 12873, availability: "In stock", thumbnailUrl: "https://m.media-amazon.com/images/I/61sample1.jpg", url: "https://www.amazon.com/dp/B09JZXQ3P1" },
              { asin: "B0BDHWDR12", title: "Noise Cancelling Headphones Over Ear, 50H Playtime", brand: "Anker", price: 79.99, priceRaw: "$79.99", currency: "USD", rating: 4.6, reviewsCount: 5421, availability: "In stock", thumbnailUrl: "https://m.media-amazon.com/images/I/71sample2.jpg", url: "https://www.amazon.com/dp/B0BDHWDR12" },
              { asin: "B07PXGQC1Q", title: "USB-C Wireless Earbuds, Fast Charging, 30H", brand: "JBL", price: 24.99, priceRaw: "$24.99", currency: "USD", rating: 4.2, reviewsCount: 9310, availability: "In stock", thumbnailUrl: "https://m.media-amazon.com/images/I/51sample3.jpg", url: "https://www.amazon.com/dp/B07PXGQC1Q" },
            ],
          },
        }),
        description: "Amazon product data on demand with key details including ASIN, title, brand, price, currency, rating, review count, availability, thumbnail, and product URL. Get results for $0.03 per record (minimum 1, up to 1,000). Enter your search keywords, optionally choose an Amazon marketplace (com, in, co.uk, de, ca, com.au, ae), and the number of products you need. Discover live Amazon product listings in seconds.\n\nPowered by Techforce Global — explore more at https://techforceglobal.com",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            method: "GET",
            input: {
              q: "wireless earbuds",
              max: 10,
              domain: "www.amazon.com",
            },
            inputSchema: {
              type: "object",
              properties: {
                q: { type: "string", description: "Search keywords, e.g. 'wireless earbuds'" },
                max: { type: "integer", description: "Number of products to return (min 1, max 1000)" },
                domain: { type: "string", description: "Amazon marketplace (optional, default www.amazon.com)", enum: ["www.amazon.com", "www.amazon.in", "www.amazon.co.uk", "www.amazon.de", "www.amazon.ca", "www.amazon.com.au", "www.amazon.ae"] },
              },
              required: ["q"],
            },
            output: {
              schema: {
                type: "object",
                properties: {
                  items: {
                    type: "array",
                    description: "Array of Amazon products",
                    items: {
                      type: "object",
                      properties: {
                        asin: { type: "string", description: "Amazon Standard Identification Number" },
                        title: { type: "string", description: "Product title" },
                        brand: { type: "string", description: "Brand name" },
                        price: { type: "number", description: "Numeric price" },
                        priceRaw: { type: "string", description: "Formatted price with currency symbol" },
                        currency: { type: "string", description: "Currency code" },
                        rating: { type: "number", description: "Average rating out of 5" },
                        reviewsCount: { type: "integer", description: "Number of reviews" },
                        availability: { type: "string", description: "Stock availability" },
                        thumbnailUrl: { type: "string", description: "Product image URL" },
                        url: { type: "string", description: "Product page URL" },
                      },
                    },
                  },
                },
              },
              example: { items: [{ asin: "B09JZXQ3P1", title: "Wireless Earbuds Bluetooth 5.3, 40H Playtime", brand: "SoundCore", price: 29.99, priceRaw: "$29.99", currency: "USD", rating: 4.4, reviewsCount: 12873, availability: "In stock", thumbnailUrl: "https://m.media-amazon.com/images/I/61sample1.jpg", url: "https://www.amazon.com/dp/B09JZXQ3P1" }] },
            },
          }),
        },
      },
      "GET /api/all-events": {
        accepts: {
          scheme: "exact",
          network: CAIP,
          payTo: PAY_TO,
          price: (ctx) => priceFromCtx(ctx, "all-events-scraper"), // dynamic per-record price
        },
        resource: resourceFor("/api/all-events"),
        serviceName: "Techforce Agents All Events", // shared prefix "Techforce Agents" => page header; card shows "All Events"
        tags: ["data", "web-scraping", "data-extraction", "events", "tickets", "local-events", "allevents", "concerts"],
        unpaidResponseBody: () => ({
          contentType: "application/json",
          body: {
            note: "Sample preview. Pay $0.005/record via x402 to receive live results.",
            items: [
              { Title: "The Lion King at Lyceum Theatre - London", URL: "https://allevents.in/london/the-lion-king-at-lyceum-theatre-london", DateTime: "Tue, 11 Aug 07:30 PM + 175 more", Location: "Lyceum Theatre - London", Interested: "95+ Interested" },
              { Title: "London Tech Startup Meetup", URL: "https://allevents.in/london/tech-startup-meetup", DateTime: "Mon, 15 Sep 06:30 PM", Location: "WeWork Moorgate - London", Interested: "40+ Interested" },
              { Title: "Weekend Food & Craft Market", URL: "https://allevents.in/london/food-craft-market", DateTime: "Sat, 20 Sep 10:00 AM", Location: "Southbank Centre - London", Interested: "120+ Interested" },
            ],
          },
        }),
        description: "Local events on demand from AllEvents — event name, category, date & time, venue, city, and ticket link. Get results for $0.005 per record (minimum 1, up to 100). Simply enter a city and the number of events you want. Discover concerts, workshops, festivals, and more.\n\nPowered by Techforce Global — explore more at https://techforceglobal.com",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            method: "GET",
            input: {
              location: "London",
              max: 20,
            },
            inputSchema: {
              type: "object",
              properties: {
                location: { type: "string", description: "City to fetch events for, e.g. 'London'" },
                max: { type: "integer", description: "Number of events to return (min 1, max 100)" },
              },
              required: ["location"],
            },
            output: {
              schema: {
                type: "object",
                properties: {
                  items: {
                    type: "array",
                    description: "Array of local events",
                    items: {
                      type: "object",
                      properties: {
                        Title: { type: "string", description: "Event title" },
                        DateTime: { type: "string", description: "Event date & time" },
                        Location: { type: "string", description: "Venue / location" },
                        Interested: { type: "string", description: "Interest count" },
                        URL: { type: "string", description: "Event / ticket URL" },
                      },
                    },
                  },
                },
              },
              example: { items: [{ Title: "The Lion King at Lyceum Theatre - London", DateTime: "Tue, 11 Aug 07:30 PM + 175 more", Location: "Lyceum Theatre - London", Interested: "95+ Interested", URL: "https://allevents.in/london/the-lion-king-at-lyceum-theatre-london" }] },
            },
          }),
        },
      },
    };
    app.use(paymentMiddleware(routes, resourceServer));

    // Runs only after payment is verified/settled by the middleware.
    app.get("/api/business-leads", async (req, res) => {
      const { key } = actorFromReq(req);
      const cust = customerToken(req);
      try {
        const pr = pricingForReq(req);
        const result = await runActor(key, paramsFromReq(req), cust);
        result.priceUsd = pr.priceUsd;
        result.ratePerRecord = pr.rate;
        res.json(withMoney(result, true));
      } catch (e) {
        res.status(500).json({ error: String(e.message), billedTo: cust ? "customer" : "platform" });
      }
    });

    // Amazon Product Scraper — dedicated paid path (own price $0.03/record).
    app.get("/api/amazon-products", async (req, res) => {
      const key = "amazon-scraper";
      const cust = customerToken(req);
      try {
        const records = recordsFor(key, req.query.max, cust);
        const rate = rateFor(key);
        const result = await runActor(key, paramsFromReq(req), cust);
        result.priceUsd = +(records * rate).toFixed(4);
        result.ratePerRecord = rate;
        res.json(withMoney(result, true));
      } catch (e) {
        res.status(500).json({ error: String(e.message), billedTo: cust ? "customer" : "platform" });
      }
    });

    // All Events (AllEvents.in) — dedicated paid path (own price $0.005/record, capped at 100).
    app.get("/api/all-events", async (req, res) => {
      const key = "all-events-scraper";
      const cust = customerToken(req);
      try {
        const records = recordsFor(key, req.query.max, cust);
        const rate = rateFor(key);
        const result = await runActor(key, paramsFromReq(req), cust);
        result.priceUsd = +(records * rate).toFixed(4);
        result.ratePerRecord = rate;
        res.json(withMoney(result, true));
      } catch (e) {
        res.status(500).json({ error: String(e.message), billedTo: cust ? "customer" : "platform" });
      }
    });
    x402Enabled = true;
  }
} catch (e) {
  console.log("[x402] disabled:", e.message);
}

app.get("/health", (_req, res) =>
  res.json({ ok: true, x402: x402Enabled, network: NETWORK, pricing: "per-record", minRecords: MIN_RESULTS, capOurToken: CAP_OUR, rates: RATES, actors: Object.keys(ACTORS), mock: MOCK_DATA === "1" })
);
app.get("/actors", (_req, res) =>
  res.json(Object.entries(ACTORS).map(([key, d]) => ({ key, label: d.label, kind: d.kind, needs: d.needs, ratePerRecord: rateFor(key) })))
);

app.listen(PORT, () => {
  console.log(`\n  agentic-apify-bridge running: http://localhost:${PORT}`);
  console.log(`  actors:  ${Object.keys(ACTORS).join(", ")}`);
  console.log(`  x402:    ${x402Enabled ? "v2 on " + NETWORK + " (" + CAIP + ") -> " + PAY_TO : "DISABLED (set PAY_TO)"}`);
  console.log(`  compute: OUR token ${APIFY_TOKEN ? "set" : "MISSING"}; customers may pass x-apify-token\n`);
});

// Keep-alive: on Render free tier the instance sleeps after ~15 min idle, which makes the
// CDP Bazaar indexer's probe time out (10s) and skip listing. A periodic self-ping to the
// public URL keeps it warm so the indexer (and real agents) always reach a live 402.
const SELF_URL = process.env.RENDER_EXTERNAL_URL;
if (SELF_URL) {
  setInterval(() => {
    fetch(`${SELF_URL}/health`).catch(() => {});
  }, 10 * 60 * 1000); // every 10 minutes
  console.log(`  keep-alive: pinging ${SELF_URL}/health every 10 min`);
}
