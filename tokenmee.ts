import {
  createMeeClient,
  toMultichainNexusAccount,
  MEEVersion,
  getMEEVersion,
} from "@biconomy/abstractjs";
import {
  http,
  parseUnits,
  formatUnits,
  erc20Abi,
  createPublicClient,
  parseAbi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc } from "viem/chains";

/*
 * ─── Key fix vs your original ────────────────────────────────────────────
 *
 * ❌ Missing: accountAddress: signer.address in chainConfigurations
 *    Without this, toMultichainNexusAccount calculates a NEW counterfactual
 *    smart account address — different from your EOA.
 *
 * ✅ Fix: Set accountAddress: signer.address
 *    This tells Biconomy to treat the EOA address itself as the smart account
 *    via EIP-7702 delegation. Same address, no migration.
 *
 * ❌ walletClient not needed — MEE client handles all signing internally
 * ❌ buildComposable → use inline calls[] in instructions directly
 */

/* ─── Config ─────────────────────────────────────────────────────────────── */

const PRIVATE_KEY =process.env.PRIVATE_KEY as `0x${string}`;

const USDT      = "0x55d398326f99059fF775485246999027B3197955" as `0x${string}`;
const USDC      = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d" as `0x${string}`;
const RECIPIENT = "0x2c42A2Aa6af553c7F6ef27Fcbcd27E6A5fA175ff" as `0x${string}`;

/* ─── Public client for balance checks ───────────────────────────────────── */

const publicClient = createPublicClient({ chain: bsc, transport: http() });

async function logBalance(tokenAddress: `0x${string}`, address: string) {
  const [balance, decimals] = await Promise.all([
    publicClient.readContract({
      abi: parseAbi(["function balanceOf(address) view returns (uint256)"]),
      address: tokenAddress,
      functionName: "balanceOf",
      args: [address as `0x${string}`],
    }),
    publicClient.readContract({
      abi: parseAbi(["function decimals() view returns (uint8)"]),
      address: tokenAddress,
      functionName: "decimals",
    }),
  ]);
  console.log(`Balance: ${formatUnits(balance, decimals)} (decimals: ${decimals})`);
  return { balance, decimals };
}

/* ─── Main ───────────────────────────────────────────────────────────────── */

async function sendUsdtWith7702() {
  if (!PRIVATE_KEY) throw new Error("Missing PrivateKey env var");

  // ── 1. Signer ─────────────────────────────────────────────────────────────
  const signer = privateKeyToAccount(PRIVATE_KEY);
  console.log("─────────────────────────────────────────────");
  console.log("  Biconomy MEE EIP-7702 Transfer on BSC");
  console.log("  EOA:", signer.address);
  console.log("─────────────────────────────────────────────");

  // ── 2. Multichain Nexus Account (EIP-7702 mode) ───────────────────────────
  const nexusAccount = await toMultichainNexusAccount({
    signer,
    chainConfigurations: [
      {
        chain: bsc,
        transport: http(),
        version: getMEEVersion(MEEVersion.V2_1_0),
        accountAddress: signer.address, // ✅ EOA address IS the smart account
      },
    ],
  });

  console.log("Smart account:", nexusAccount.addressOn(bsc.id));
  console.log(
    "Same as EOA?  :",
    nexusAccount.addressOn(bsc.id) === signer.address ? "✅ YES" : "❌ NO"
  );

  // ── 3. MEE Client ─────────────────────────────────────────────────────────
  const meeClient = await createMeeClient({ account: nexusAccount });

  // ── 4. Check balance ──────────────────────────────────────────────────────
  await logBalance(USDT, signer.address as string);

  // ── 5. Build transfer instruction ────────────────────────────────────────
  // Use inline calls[] — direct and compatible with all MEE versions


  const instruction = await nexusAccount.buildComposable({
  type: "default",
  data: {
    chainId: bsc.id,
    to: USDT, // The USDT contract address
    abi: erc20Abi,
    functionName: "transfer",
    args: [RECIPIENT, parseUnits("0.001", 18)]
  }
});

   const composeFlows= 
        {
          // ERC-20 transfer instruction
          type: "/instructions/build",
          data: {
            functionSignature: "function transfer(address to, uint256 amount) returns (bool)",
            args: [RECIPIENT, parseUnits("0.001", 18)],
            to: USDT,
            chainId: bsc.id,
          },
        }
      
  const transferInstruction = {
    chainId: bsc.id,
    calls: [
      {
        to: USDT,
        abi: erc20Abi,
        functionName: "transfer" as const,
        args: [RECIPIENT, parseUnits("0.001", 18)] as [`0x${string}`, bigint],
      },
    ],
  };

  // ── 6. Get quote — paying gas in USDT ────────────────────────────────────
  console.log("\n💰 Getting quote (gas paid in USDT)...");
  const quote = await meeClient.getQuote({
    instructions: [instruction],
    feeToken: {
      address: USDT,     // ✅ user pays gas in USDT
      chainId: bsc.id,
    },
    delegate: true,      // ✅ required for EIP-7702 — enables delegation on first use
  });

  console.log(
    "Estimated fee:",
    quote.paymentInfo.tokenAmount,
    "USDT"
  );

  // ── 7. Execute ────────────────────────────────────────────────────────────
  console.log("\n🚀 Executing supertransaction...");
  const { hash } = await meeClient.executeQuote({ quote });
  console.log("Supertransaction hash:", hash);

  // ── 8. Wait for receipt ───────────────────────────────────────────────────
  console.log("⏳ Waiting for confirmation...");
  const receipt = await meeClient.waitForSupertransactionReceipt({ hash });

  console.log("✅ Complete!",receipt.receipts[0].transactionHash);
  console.log(
    "🔍 Explorer:",
    `https://meescan.biconomy.io/supertransaction/${hash}`
  );

  return receipt;
}

sendUsdtWith7702().catch(console.error);