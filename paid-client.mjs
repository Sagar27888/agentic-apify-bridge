// Real x402 paid call demo.
// Proves an agent can pay in USDC (testnet) and get Actor results back.
// Requires: PRIVATE_KEY (a funded base-sepolia wallet) in .env, and the server running.
import dotenv from "dotenv";
dotenv.config();

const BASE = process.env.BRIDGE_URL || "http://localhost:8080";
const URL = `${BASE}/api/flipkart?q=${encodeURIComponent(process.argv[2] || "laptop")}&max=6`;

const pk = process.env.PRIVATE_KEY;
if (!pk) {
  console.error("Set PRIVATE_KEY in .env (a base-sepolia wallet with test USDC). See README.");
  process.exit(1);
}

const { wrapFetchWithPayment } = await import("x402-fetch");
const { privateKeyToAccount } = await import("viem/accounts");

const account = privateKeyToAccount(pk.startsWith("0x") ? pk : "0x" + pk);
const fetchWithPay = wrapFetchWithPayment(globalThis.fetch.bind(globalThis), account);

console.log("Paying + calling:", URL, "as", account.address);
const res = await fetchWithPay(URL, { method: "GET" });
console.log("HTTP", res.status);
const body = await res.json();
console.log(JSON.stringify(body, null, 2));
