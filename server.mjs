import express from "express";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");

const {
  PORT = 8080,
  PAY_TO,                                   // your Base wallet (USDC lands here)
  PRICE = "$0.05",                          // price per call
  NETWORK = "base-sepolia",                 // testnet: base-sepolia | mainnet: base
  FACILITATOR_URL = "https://x402.org/facilitator",
  APIFY_TOKEN,                              // your Apify API token
  ACTOR = "techforce.global~flipkart-scraper",
  MOCK_DATA,                                // "1" => return bundled sample data (no Apify needed)
} = process.env;

const app = express();
app.use(express.static(PUBLIC_DIR));
app.get("/", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));

// ---- sample data so the UI/demo works with zero setup ----
function sampleItems({ searchQuery, maxProducts }) {
  const base = [
    ["Samsung Galaxy M14 5G (6GB/128GB)", 13490, 17999, 25, 4.3],
    ["Redmi Note 13 5G (8GB/256GB)", 16999, 19999, 15, 4.4],
    ["realme NARZO 60x 5G", 12499, 15999, 21, 4.2],
    ["POCO X6 Pro 5G", 24999, 28999, 13, 4.5],
    ["iQOO Z9 5G", 19999, 23999, 16, 4.4],
    ["Motorola Edge 50 Fusion", 22999, 25999, 11, 4.3],
    ["OnePlus Nord CE4 Lite 5G", 19999, 22999, 13, 4.4],
    ["Vivo T3x 5G", 13499, 16999, 20, 4.4],
    ["Samsung Galaxy A15 5G", 15499, 19499, 20, 4.2],
    ["Nothing Phone (2a)", 23999, 27999, 14, 4.5],
    ["Infinix Note 40 Pro 5G", 19999, 24999, 20, 4.3],
    ["Lava Agni 2 5G", 17999, 26999, 33, 4.1],
  ];
  return base.slice(0, maxProducts).map((p, i) => ({
    productId: "DEMO" + String(i + 1).padStart(3, "0"),
    title: p[0],
    url: "https://www.flipkart.com/",
    currentPrice: p[1],
    originalPrice: p[2],
    discountPercent: p[3],
    rating: p[4],
    numRatings: 1200 + i * 137,
    numReviews: 90 + i * 11,
    fAssured: i % 2 === 0,
    _query: searchQuery,
  }));
}

function inputFromReq(req) {
  return {
    searchQuery: (req.query.q || "smartphone").toString(),
    maxProducts: Math.min(Number(req.query.max || 12), 50),
    sortBy: (req.query.sort || "relevance").toString(),
  };
}

// ---- run the Apify Actor (or sample data) ----
async function runActor(input) {
  if (MOCK_DATA === "1" || !APIFY_TOKEN) return sampleItems(input);
  const url = `https://api.apify.com/v2/acts/${ACTOR}/run-sync-get-dataset-items?token=${APIFY_TOKEN}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!r.ok) throw new Error(`Apify ${r.status}: ${await r.text()}`);
  return r.json();
}

// ---- DEMO route: no payment. For showing the client the data flow. ----
app.get("/demo/flipkart", async (req, res) => {
  try {
    res.json({ source: MOCK_DATA === "1" || !APIFY_TOKEN ? "sample" : "apify", items: await runActor(inputFromReq(req)) });
  } catch (e) {
    res.status(500).json({ error: String(e.message) });
  }
});

// ---- "Paying agent" demo: server pays its own x402 endpoint (one-click, no wallet UI) ----
app.get("/agent-pay/flipkart", async (req, res) => {
  const pk = process.env.PRIVATE_KEY;
  if (!PAY_TO || !pk) {
    return res.status(400).json({ paid: false, error: "Set PAY_TO + PRIVATE_KEY (a funded base-sepolia wallet) in .env to run the paying-agent demo." });
  }
  try {
    const { wrapFetchWithPayment } = await import("x402-fetch");
    const { privateKeyToAccount } = await import("viem/accounts");
    const account = privateKeyToAccount(pk.startsWith("0x") ? pk : "0x" + pk);
    const payFetch = wrapFetchWithPayment(globalThis.fetch.bind(globalThis), account);
    const q = encodeURIComponent((req.query.q || "laptop").toString());
    const max = Number(req.query.max || 12);
    const r = await payFetch(`http://localhost:${PORT}/api/flipkart?q=${q}&max=${max}`, { method: "GET" });
    const data = await r.json();
    res.json({ paid: true, payer: account.address, payTo: PAY_TO, price: PRICE, network: NETWORK, ...data });
  } catch (e) {
    const { privateKeyToAccount } = await import("viem/accounts");
    let addr = PAY_TO;
    try { addr = privateKeyToAccount(pk.startsWith("0x") ? pk : "0x" + pk).address; } catch {}
    res.status(502).json({ paid: false, error: String(e.message), hint: `Fund the payer wallet with Base Sepolia test USDC, then retry: ${addr}` });
  }
});

// ---- x402 PAID route: the real monetized endpoint agents/agentic.market call ----
let x402Enabled = false;
try {
  const { paymentMiddleware } = await import("x402-express");
  if (PAY_TO) {
    // Testnet (base-sepolia) uses the public URL facilitator.
    // Mainnet (base) settles real USDC via Coinbase CDP facilitator (needs CDP API keys).
    let facilitatorConfig = { url: FACILITATOR_URL };
    if (NETWORK === "base" && process.env.CDP_API_KEY_ID && process.env.CDP_API_KEY_SECRET) {
      try {
        const { facilitator } = await import("@coinbase/x402");
        facilitatorConfig = facilitator;
        console.log("[x402] using Coinbase CDP mainnet facilitator");
      } catch (e) {
        console.log("[x402] @coinbase/x402 not installed; run: npm i @coinbase/x402");
      }
    }
    app.use(
      paymentMiddleware(
        PAY_TO,
        {
          "GET /api/flipkart": {
            price: PRICE,
            network: NETWORK,
            // Discovery metadata → CDP Bazaar auto-lists this endpoint after the
            // first successful mainnet settlement (this is how agentic.market finds it).
            config: {
              discoverable: true,
              description: "Flipkart product search. Provide a query; returns structured products (title, price, MRP, discount %, rating, review count, F-Assured, URL).",
              inputSchema: {
                type: "object",
                properties: {
                  q: { type: "string", description: "Search text, e.g. 'gaming laptop'" },
                  max: { type: "integer", description: "Max products (1-2000)", default: 12 },
                  sort: { type: "string", enum: ["relevance", "popularity", "price_asc", "price_desc", "recency_desc"], default: "relevance" },
                },
                required: ["q"],
              },
              outputSchema: {
                type: "object",
                properties: { items: { type: "array", description: "Array of product objects" } },
              },
            },
          },
        },
        facilitatorConfig
      )
    );
    app.get("/api/flipkart", async (req, res) => {
      try {
        res.json({ source: "apify", items: await runActor(inputFromReq(req)) });
      } catch (e) {
        res.status(500).json({ error: String(e.message) });
      }
    });
    x402Enabled = true;
  }
} catch (e) {
  console.log("[x402] disabled (package not installed):", e.message);
}

app.get("/health", (_req, res) =>
  res.json({ ok: true, x402: x402Enabled, network: NETWORK, price: PRICE, actor: ACTOR, mock: MOCK_DATA === "1" })
);

app.listen(PORT, () => {
  console.log(`\n  agentic-apify-bridge running: http://localhost:${PORT}`);
  console.log(`  demo UI:        http://localhost:${PORT}/`);
  console.log(`  demo API:       http://localhost:${PORT}/demo/flipkart?q=phone`);
  console.log(`  x402 paid API:  ${x402Enabled ? "GET /api/flipkart  (" + PRICE + " on " + NETWORK + ", pay-to " + PAY_TO + ")" : "DISABLED (set PAY_TO + install x402-express)"}`);
  console.log(`  data source:    ${MOCK_DATA === "1" || !APIFY_TOKEN ? "SAMPLE (set APIFY_TOKEN for live)" : "LIVE Apify (" + ACTOR + ")"}\n`);
});
