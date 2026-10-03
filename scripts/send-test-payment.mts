// Pay a Clearmark invoice on Arc TESTNET from the command line, using a throwaway key.
//
//   TEST_PAYER_PRIVATE_KEY=0x... npm run send-test-payment -- http://localhost:3000/pay/<id> [amount] [full|part] [--untagged]
//
// Fund the throwaway wallet with testnet USDC at https://faucet.circle.com first.
// Never put a real or mainnet key here.

import { createPublicClient, createWalletClient, encodeFunctionData, erc20Abi, http, parseAbi, parseUnits, stringToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const CHAIN_ID = 5042002;
const RPC = process.env.ARC_RPC_URL || "https://rpc.testnet.arc.io";
const USDC = "0x3600000000000000000000000000000000000000";
const MEMO = "0x5294E9927c3306DcBaDb03fe70b92e01cCede505";
const memoAbi = parseAbi(["function memo(address target, bytes data, bytes32 memoId, bytes memoData)"]);

const [link, amountArg, intentArg = "full"] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const untagged = process.argv.includes("--untagged");
if (!link) throw new Error("Usage: send-test-payment <payment link> [amount] [full|part] [--untagged]");
const key = process.env.TEST_PAYER_PRIVATE_KEY as `0x${string}` | undefined;
if (!key) throw new Error("Set TEST_PAYER_PRIVATE_KEY to a throwaway testnet key.");

const url = new URL(link);
const id = url.pathname.split("/").pop()!;
const inv = await (await fetch(`${url.origin}/api/pay/${id}`)).json();
if (inv.error) throw new Error(inv.error);

const chain = { id: CHAIN_ID, name: "Arc Testnet", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const;
const pub = createPublicClient({ chain, transport: http(RPC) });
if ((await pub.getChainId()) !== CHAIN_ID) throw new Error("RPC is not Arc testnet. Refusing to send.");
const account = privateKeyToAccount(key);
const wallet = createWalletClient({ account, chain, transport: http(RPC) });

const amount = amountArg ? parseUnits(amountArg, 6) : BigInt(inv.state.balance);
const transfer = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [inv.merchant.address, amount] });
console.log(`Paying ${inv.number}: ${Number(amount) / 1e6} USDC from ${account.address}${untagged ? " (no memo)" : ""}`);

const hash = untagged
  ? await wallet.sendTransaction({ to: USDC, data: transfer })
  : await wallet.writeContract({
      address: MEMO,
      abi: memoAbi,
      functionName: "memo",
      args: [USDC, transfer, inv.memoId, stringToHex(`cm1;inv=${inv.number};pay=${intentArg}`)],
    });
const rc = await pub.waitForTransactionReceipt({ hash });
console.log(`Settled in block ${rc.blockNumber}: ${hash}`);

const res = await (await fetch(`${url.origin}/api/pay/${id}/confirm`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ txHash: hash }) })).json();
console.log(res.error ? `Clearmark: ${res.error}` : `Clearmark: ${res.invoice.state.label}. Receipt: ${url.origin}${res.receipts[0] ?? ""}`);
