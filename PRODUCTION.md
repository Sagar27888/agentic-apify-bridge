# Production Deployment Guide — Agentic × Apify Bridge

This turns the localhost demo into a **live, public, real-money** x402 service that AI agents (and agentic.market) can call and pay for.

There are two stages. Do Stage A first (public link, still test money). Do Stage B when you want real USDC.

---

## The values you need (and exactly where to get each)

| Variable | What it is | Where to generate it |
|---|---|---|
| `APIFY_TOKEN` | Auth for running your Actor. The account it belongs to must have the Actor's **paid** plan (removes the 5-product free cap). | **apify.com** → sign in → **Settings → Integrations → API tokens** (or Personal API token) → **Create / copy token**. The 5-item cap is your Actor's own free tier; run under the account that has the paid rental of `techforce.global/flipkart-scraper`. |
| `PAY_TO` | Your wallet address that **receives** USDC on Base. | Any Base-compatible wallet. Easiest: **Coinbase Wallet** app or **MetaMask** → add the **Base** network → copy your address (starts `0x…`). Or a **CDP Server Wallet** at portal.cdp.coinbase.com. |
| `NETWORK` | Which chain settles payments. | Just a value: `base-sepolia` = free test money; `base` = real USDC. Type it in. |
| `FACILITATOR_URL` | Who verifies/settles the payment. **Testnet only.** | Testnet value: `https://x402.org/facilitator`. On mainnet you do NOT use a URL — you use Coinbase CDP keys instead (see `CDP_*` below). |
| `PRICE` | What you charge per call. | You decide. Format `$0.05`. Rule: set it **above** your per-run Apify cost so each call earns margin. Type it in. |
| `PRIVATE_KEY` | Signer for the built-in **test** pay button/tool. | Leave **empty** in production — real agents pay with their own wallets. (Only used for the local testnet demo.) |
| `CDP_API_KEY_ID` | Coinbase key to settle **real** USDC on Base mainnet. | **portal.cdp.coinbase.com** → sign in → **API Keys** (or Access/Secret API Keys) → **Create key** → copy the **Key ID**. |
| `CDP_API_KEY_SECRET` | Secret half of the CDP key. | Same screen as above → copy the **Key Secret** at creation (shown once — save it). |

> The code auto-selects the right facilitator: `base-sepolia` → `FACILITATOR_URL`; `base` + `CDP_API_KEY_ID`/`CDP_API_KEY_SECRET` → Coinbase mainnet facilitator.

---

## Stage A — Put it online (public link, still testnet)

1. **Create accounts** (free): github.com and render.com (sign in to Render with GitHub).
2. **Push the project to GitHub**: new repo → upload this folder's files (drag-drop works). `.env` and `node_modules` are already excluded by `.gitignore` — do not upload them.
3. **Render → New → Blueprint** → select the repo. It reads `render.yaml` and asks for the secret values.
4. Paste (testnet):
   - `APIFY_TOKEN` = your token
   - `PAY_TO` = your wallet address
   - `PRIVATE_KEY` = your testnet key (from `.env`) — optional, only for the pay button
   - leave `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET` empty for now
   - (`NETWORK`, `PRICE`, `FACILITATOR_URL`, `ACTOR` come pre-filled from `render.yaml`)
5. **Deploy** → you get a public URL like `https://agentic-apify-bridge.onrender.com`.
6. Open it → **Search (free)** and **Run as paying agent (x402)** both work. Share this link with the client.

---

## Stage B — Switch to real money (Base mainnet)

Change these in the Render dashboard (Environment tab), then redeploy:

1. `NETWORK` = `base`
2. `PAY_TO` = your **real** Base wallet (make sure it's one you control and can withdraw from)
3. `CDP_API_KEY_ID` = your CDP key id
4. `CDP_API_KEY_SECRET` = your CDP key secret
5. `APIFY_TOKEN` = the token whose account has the Actor's **paid** plan (full results)
6. `PRIVATE_KEY` = **(empty)** — remove it
7. `PRICE` = your real per-call price (e.g. `$0.05`)
8. Keep `FACILITATOR_URL` as-is; it's ignored on mainnet when CDP keys are present.

Redeploy. Now `GET /api/flipkart` charges real USDC and settles to your wallet.

**Verify:** open the public URL → the paid button should complete against mainnet, and USDC should land in `PAY_TO`. (The built-in pay button needs a funded signer, so on mainnet test it with a real x402 client/agent instead, or a wallet you fund.)

---

## Stage C — Get listed on agentic.market (the CDP Bazaar)

**Key fact: there is NO submit form.** The Coinbase CDP facilitator **auto-catalogs your endpoint the first time it settles a real payment** for it. agentic.market reads from that CDP "Bazaar" index. So getting listed = being live on mainnet + taking one real paid call.

### What must be true for it to list
1. **On Base mainnet** with the CDP facilitator (Stage B done: `NETWORK=base` + `CDP_API_KEY_ID` + `CDP_API_KEY_SECRET`).
2. **Route declares discovery metadata** — already built into `server.mjs`:
   `discoverable: true`, `description`, `inputSchema`, `outputSchema`. (CDP needs these to catalog a rich listing.)
3. The settlement payload includes `paymentPayload.resource` = your endpoint URL. The x402 middleware sets this automatically to the public URL (that's why deploying with a real domain matters — it becomes your listed resource).

### Steps
1. Deploy live on mainnet (Stage B). Public URL, e.g. `https://<you>.onrender.com/api/flipkart`.
2. Confirm the 402 works: `curl -i https://<you>.onrender.com/api/flipkart?q=phone`
3. **Trigger one real paid call** — have an x402 client/agent (or a wallet you fund with real USDC) pay the endpoint once. That settlement is what registers you.
4. **Verify you're indexed** (read-only, no key needed):
   - Merchant lookup by your wallet:
     `GET https://api.cdp.coinbase.com/platform/v2/x402/discovery/merchant?payTo=<YOUR_PAY_TO>`
   - Full catalog: `GET https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources`
   - Search: `GET https://api.cdp.coinbase.com/platform/v2/x402/discovery/search`
   Your `resource` URL should appear.
5. agentic.market pulls from this index — cross-check `GET https://agentic.market/v1/services` and `/v1/services/search?q=flipkart`.

### If it doesn't show
- Make sure the paid call actually **settled** (check your wallet received USDC).
- Make sure `discoverable: true` + metadata are present (they are in `server.mjs`).
- The `resource` URL in the 402 must be your **public** URL, not `localhost` — deploy first.
- Confirm the exact discovery-extension API for your installed `@coinbase/x402` version at https://docs.cdp.coinbase.com/x402/bazaar (package APIs move fast; the metadata shape may need a minor tweak).

> Summary: **Deploy on mainnet with CDP keys → take one real paid call → you're auto-listed.** No application, no approval.

---

## Pricing sanity check
- Each `/api/flipkart` call runs the Actor once → you pay Apify compute for that run.
- Set `PRICE` above that cost. Example: if a run costs you ~$0.01–0.02 in Apify, price at `$0.05` → healthy margin per agent call.

## Security checklist
- [ ] **Rotate the Apify token** you shared earlier (Apify → API tokens → revoke & create new).
- [ ] Never commit `.env` (already gitignored).
- [ ] Testnet `PRIVATE_KEY` is throwaway — never fund it with real assets; remove it in production.
- [ ] `PAY_TO` on mainnet must be a wallet you can actually withdraw from.
- [ ] Keep `CDP_API_KEY_SECRET` secret (Render env vars only, never in code).

## Add more Actors
Deploy another instance (or extend the route map in `server.mjs`) with a different `ACTOR` env value — e.g. `ACTOR=techforce.global~amazon-scraper` — same bridge, new paid endpoint.
