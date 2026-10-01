// Real x402 paid call.
// Pays in USDC and gets Actor results back from any live endpoint on this bridge.
// Requires: PRIVATE_KEY (a funded wallet on the server's NETWORK) in the environment.
//
// Usage:
//   BRIDGE_URL=https://techforce-agents.onrender.com PRIVATE_KEY=0x... \
//     node paid-client.mjs "/api/all-events?location=London&max=1"
import dotenv from "dotenv";
dotenv.config();

const BASE = process.env.BRIDGE_URL || "http://localhost:8080";
const path = process.argv[2];
if (!path) {
  console.error('Usage: node paid-client.mjs "/api/<endpoint>?param=value..."');
  console.error("Endpoints: /api/business-leads?q=&location=&max=1  /api/amazon-products?q=&max=1");
  console.error("           /api/all-events?location=&max=1  /api/linkedin-candidates?role=&max=1");
  console.error('           /api/youtube-transcript?videoUrl=  /api/all-jobs?keyword=&max=1');
  process.exit(1);
}
const URL = `${BASE}${path}`;

const pk = process.env.PRIVATE_KEY;
if (!pk) {
  console.error("Set PRIVATE_KEY (a wallet funded on the server's NETWORK, e.g. Base mainnet).");
  process.exit(1);
}

const { wrapFetchWithPaymentFromConfig } = await import("@x402/fetch");
const { ExactEvmScheme } = await import("@x402/evm");
const { privateKeyToAccount } = await import("viem/accounts");

const account = privateKeyToAccount(pk.startsWith("0x") ? pk : "0x" + pk);
const fetchWithPay = wrapFetchWithPaymentFromConfig(globalThis.fetch.bind(globalThis), {
  schemes: [{ network: "eip155:*", client: new ExactEvmScheme(account) }],
});

console.log("Paying + calling:", URL, "as", account.address);
const res = await fetchWithPay(URL, { method: "GET" });
console.log("HTTP", res.status);
const body = await res.json();
console.log(JSON.stringify(body, null, 2));
