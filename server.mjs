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
const MIN_RESULTS = 10;
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
    input: (p) => ({ searchKeywords: [p.q || "wireless earbuds"], maxItemsPerSearch: Number(p.max), amazonDomain: "www.amazon.in", proxyConfiguration: { useApifyProxy: true, apifyProxyGroups: ["RESIDENTIAL"] } }),
    row: (r) => ({ title: r.title, sub: r.priceRaw || (r.price != null ? r.price : ""), meta: [r.brand, r.rating ? "★" + r.rating : "", r.reviewsCount ? r.reviewsCount + " reviews" : ""].filter(Boolean).join(" · "), url: r.url }),
  },
  "google-maps-leads-sales-intelligence-tool": {
    apify: "techforce.global~google-maps-leads-sales-intelligence-tool",
    label: "Google Maps Business Leads",
    kind: "lead-gen",
    needs: ["q", "location", "max"],
    input: (p) => ({ searchQuery: p.q || "Coffee shop", location: p.location || "Ahmedabad", maxResults: Number(p.max), includeSalesStrategy: false, includeWebsiteHealthScorecard: false, includeServiceRecommendations: false, includeTechnicalIntel: false, proxyConfiguration: { useApifyProxy: false } }),
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
};

const app = express();
app.set("trust proxy", true); // behind Render proxy → detect real https for x402 resource URL
app.use(express.static(PUBLIC_DIR));
app.get("/", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));

// ---- helpers ----
function actorFromReq(req) {
  const key = (req.query.actor || "flipkart-scraper").toString();
  return { key, def: ACTORS[key] };
}
function paramsFromReq(req) {
  return {
    q: (req.query.q || "").toString(),
    location: (req.query.location || "").toString(),
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
  "google-maps-leads-sales-intelligence-tool": 0.10, // premium leads
  "amazon-scraper": 0.01,
  "flipkart-scraper": 0.008,
  "eventbrite-scraper": 0.006,
};
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
// x402 v2 DynamicPrice: compute "$X" from the request's records × actor rate (reads x402 request context)
function priceFromCtx(ctx) {
  const a = ctx.adapter;
  const q = (n) => { const v = a.getQueryParam ? a.getQueryParam(n) : undefined; return Array.isArray(v) ? v[0] : v; };
  const actor = q("actor") || "flipkart-scraper";
  const token = (a.getHeader && (a.getHeader("x-apify-token") || "")) || q("apify_token") || "";
  const records = amountFor(q("max"), token);
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
    const qs = new URLSearchParams({ actor: key, q: req.query.q || "", location: req.query.location || "", max: String(req.query.max || 10) }).toString();
    const r = await payFetch(`http://localhost:${PORT}/api/run?${qs}`, {
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
      "GET /api/run": {
        accepts: {
          scheme: "exact",
          network: CAIP,
          payTo: PAY_TO,
          price: (ctx) => priceFromCtx(ctx), // dynamic per-record price
        },
        description: "Apify Actor bridge, priced per record. Google Maps business leads (name, phone, website, email, address) and more. Query params: actor, q, location, max (min 10). Optional x-apify-token header bills Apify compute to the caller.",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            method: "GET",
            inputSchema: {
              type: "object",
              properties: {
                actor: { type: "string", description: "Actor key (default google-maps-leads-sales-intelligence-tool)" },
                q: { type: "string", description: "Search text / keyword" },
                location: { type: "string", description: "Location (Google Maps / Eventbrite)" },
                max: { type: "integer", description: "Records to return (min 10, max 1000)" },
              },
            },
            output: {
              example: { items: [{ businessName: "Vince cafe", category: "Cafe", phone: "+91 63526 10595", address: "Ahmedabad, Gujarat, India", website: "" }] },
            },
          }),
        },
      },
    };
    app.use(paymentMiddleware(routes, resourceServer));

    // Runs only after payment is verified/settled by the middleware.
    app.get("/api/run", async (req, res) => {
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
  console.log(`  x402:    ${x402Enabled ? PRICE + " on " + NETWORK + " -> " + PAY_TO : "DISABLED (set PAY_TO)"}`);
  console.log(`  compute: OUR token ${APIFY_TOKEN ? "set" : "MISSING"}; customers may pass x-apify-token\n`);
});
