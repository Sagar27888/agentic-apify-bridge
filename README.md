# Agentic × Apify Bridge

Make any **Apify Actor** callable as a pay-per-request **x402** service — the format [agentic.market](https://agentic.market/) (Coinbase's x402 directory) consumes. Agents call an HTTP endpoint, pay per request in USDC, no API keys. The bridge verifies payment, runs your Actor server-side with **your** Apify token, and returns the data.

Configured out of the box for `techforce.global~flipkart-scraper`, but it's env-driven — point `ACTOR` at any Actor.

---

## Quick start (3 demo levels)

```bash
cd agentic-apify-bridge
npm install
cp .env.example .env      # Windows: copy .env.example .env
```

### Level 1 — Sample data (zero setup, instant client demo)
```bash
npm run demo              # forces MOCK_DATA=1
```
Open http://localhost:8080 → search box returns Flipkart-shaped products immediately. Nothing external needed. Good for the first client show-and-tell.

### Level 2 — Live Apify data
Put your Apify token in `.env`:
```
APIFY_TOKEN=apify_api_xxxxxxxx
```
```bash
npm start
```
Now http://localhost:8080 and `/demo/flipkart?q=laptop` return **real** Flipkart results scraped by your Actor.

### Level 3 — Real x402 paid call (the agentic.market part)
1. In `.env` set your receiving wallet + testnet:
   ```
   PAY_TO=0xYourWallet
   NETWORK=base-sepolia
   ```
2. Start the server: `npm start`
3. Prove the payment gate (no payment → 402):
   ```bash
   curl -i "http://localhost:8080/api/flipkart?q=phone"
   # HTTP/1.1 402 Payment Required  + JSON payment requirements
   ```
4. Make a **paid** call with a funded base-sepolia wallet:
   - Get a test wallet key, fund it with test ETH + test USDC (faucets: Coinbase CDP / Circle base-sepolia USDC faucet).
   - Put `PRIVATE_KEY=...` in `.env`, then:
   ```bash
   npm run pay -- "gaming laptop"
   # pays USDC, receives Actor results as JSON
   ```

---

## Endpoints
| Route | Payment | Purpose |
|---|---|---|
| `GET /` | none | Visual demo UI |
| `GET /demo/flipkart?q=&max=&sort=` | none | Data flow demo (sample or live Apify) |
| `GET /api/flipkart?q=&max=&sort=` | **x402** | The real monetized endpoint agents call |
| `GET /health` | none | Status |

---

## Going to production + listing on agentic.market
1. **Deploy** this service (Render / Fly.io / Railway / a VPS). You get a public HTTPS URL.
2. **Switch to mainnet**: set `NETWORK=base`, `PAY_TO` to your real Base wallet, and use the **Coinbase CDP facilitator** for mainnet settlement — see https://docs.cdp.coinbase.com/x402/welcome (needs CDP API keys). Set a `PRICE` above your per-run Apify cost so each call is profitable.
3. **Discovery**: agentic.market indexes x402 services (`GET https://agentic.market/v1/services`, search at `/v1/services/search?q=`). Register your live endpoint through the Coinbase x402 ecosystem / "Bazaar" per the CDP docs and `https://agentic.market/llms.txt`.
4. Add more Actors by running another instance (or extend the route map) with a different `ACTOR`.

## How it maps
```
AI agent ──HTTP──▶ /api/flipkart ──402──▶ pays USDC ──▶ bridge verifies
                                                         │
                                          your Apify token (server-side)
                                                         ▼
                              Apify run-sync-get-dataset-items  ──▶ products JSON
```

## Notes
- The agent never sees your Apify token — it stays server-side.
- `/demo/*` has no payment; keep it disabled or rate-limited in production (it's for demos).
- Package versions for `x402-express` / `x402-fetch` move fast; `npm install` pulls current. If an API name changed, check https://github.com/coinbase/x402.
