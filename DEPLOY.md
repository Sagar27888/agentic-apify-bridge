# Put it online (public link for the client)

Simple, free hosting on **Render**. ~5 minutes, no server admin.

## One-time
1. Create a free account at https://render.com (sign in with GitHub is easiest).
2. Put this project in a GitHub repo:
   - Make a new repo on github.com (e.g. `agentic-apify-bridge`).
   - Upload the folder contents (GitHub's "upload files" button works — drag the folder in), OR use `git push`.
   - Do NOT upload `.env` or `node_modules` (the included `.gitignore` already excludes them).

## Deploy
3. In Render: **New → Blueprint** → pick your repo. It reads `render.yaml` automatically.
4. Render will ask for the 3 secret values. Paste:
   - `APIFY_TOKEN` = your Apify token
   - `PAY_TO` = your wallet address (the throwaway testnet one for now: `0xEe6f10843818180ee727571227040d02F402D596`)
   - `PRIVATE_KEY` = the testnet key from your `.env`
5. Click **Apply / Deploy**. In ~2 minutes you get a public URL like:
   `https://agentic-apify-bridge.onrender.com`

Open that URL → same demo page → **Search** (free) and **Run as paying agent (x402)** both work. Hand this link to your client.

## Going to real money (later)
Change these env vars in the Render dashboard:
- `NETWORK` = `base`
- `FACILITATOR_URL` = Coinbase CDP mainnet facilitator (see https://docs.cdp.coinbase.com/x402/welcome)
- `PAY_TO` = your **real** Base wallet
- `APIFY_TOKEN` = your **paid** Apify token (removes the 5-product free cap)
- Remove `PRIVATE_KEY` (real agents pay with their own wallets).

## Notes
- Render free tier sleeps after inactivity; first hit may take ~30s to wake. Fine for demos. Paid tier stays awake.
- The free `/demo` route is for showing data; the paid `/api/flipkart` + `/agent-pay` routes are the x402 flow.
