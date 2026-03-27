


import { createSmartAccountClient } from "permissionless";
import { createPimlicoClient } from "permissionless/clients/pimlico";
import {
  createPublicClient,
  erc20Abi,
  encodeFunctionData,
  formatUnits,
  getAddress,
  Hex,
  http,
  maxUint256,
  parseAbi,
  parseUnits,
} from "viem";
import {
  entryPoint07Address,
  entryPoint08Address,
  EntryPointVersion,
  toSimple7702SmartAccount,
} from "viem/account-abstraction";
import { privateKeyToAccount } from "viem/accounts";
import { bsc } from "viem/chains";

/* ─── Constants ─────────────────────────────────────────────────────────── */

//const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as Hex;
const USDC = "0x55d398326f99059fF775485246999027B3197955"
const API_KEY = process.env.API_KEY;
const PIMLICO_URL = `https://api.pimlico.io/v2/${bsc.id}/rpc?apikey=${API_KEY}`;



/* ─── Client Setup ──────────────────────────────────────────────────────── */

const publicClient = createPublicClient({
  chain: bsc,
  transport: http("https://bsc.nodereal.io"),
});

const pimlicoClient = createPimlicoClient({
  chain: bsc,
  transport: http(PIMLICO_URL),
  entryPoint: {
    address: entryPoint07Address,
    version: "0.7" as EntryPointVersion,
  },
});

/* ─── Account ───────────────────────────────────────────────────────────── */

async function buildAccount(privateKey: Hex) {
  return toSimple7702SmartAccount({
    client: publicClient,
    owner: privateKeyToAccount(privateKey),
  });
}

/* ─── Two clients — sponsored (approve) and USDC (transfer) ────────────── */

/**
 * SPONSORED client — used for the one-time USDC approval only.
 * Pimlico pays the gas so no allowance is needed yet.
 */
function buildSponsoredClient(account: any) {
  return createSmartAccountClient({
    account,
    chain: bsc,
    bundlerTransport: http(PIMLICO_URL),
    paymaster: pimlicoClient,
    userOperation: {
      estimateFeesPerGas: async () =>
        (await pimlicoClient.getUserOperationGasPrice()).fast,
    },
    // ✅ No paymasterContext → Pimlico sponsors this tx for free
  });
}

/**
 * USDC client — used for all actual transfers.
 * ✅ paymasterContext goes here at the CLIENT level, not inside sendTransaction
 */
function buildUsdcClient(account: any) {
  return createSmartAccountClient({
    account,
    chain: bsc,
    bundlerTransport: http(PIMLICO_URL),
    paymaster: pimlicoClient,
    userOperation: {
      estimateFeesPerGas: async () =>
        (await pimlicoClient.getUserOperationGasPrice()).fast,
    },
    // paymasterContext: {
    //   //token: USDC, // ✅ correct place — client level, not sendTransaction level
    //  // sponsorshipPolicyId: SPONSORSHIP_POLICY_ID,
    // },
  });
}

/* ─── Helpers ───────────────────────────────────────────────────────────── */

async function ensureUsdcBalance(address: Hex) {
  const balance = await publicClient.readContract({
    abi: parseAbi(["function balanceOf(address) view returns (uint256)"]),
    address: USDC,
    functionName: "balanceOf",
    args: [address],
  });
  console.log("USDC balance:", formatUnits(balance, 6));
  if (balance < 1_000_000n) {
    throw new Error(
      `Insufficient USDC at ${address}: ${formatUnits(balance, 6)} USDC. Need at least 1.`
    );
  }
  return balance;
}

/**
 * Approves BOTH known Pimlico ERC-20 paymaster contracts.
 * Uses the SPONSORED client so no USDC allowance is required yet.
 * Skips any address that already has a non-zero allowance.
 */
async function ensurePaymasterApproved(account: any) {
  // Fetch the active paymaster address dynamically
  const [quote] = await pimlicoClient.getTokenQuotes({ tokens: [USDC] });
  if (!quote?.paymaster) throw new Error("Could not resolve paymaster address");

  // Both known Pimlico ERC-20 paymaster addresses — approve both to be safe
  const paymasters: string[] = [
    quote.paymaster as Hex,
    "0x777777777777AeC03fd955926DbF81597e66834C",
    "0x888888888888Ec68A58AB8094Cc1AD20Ba3D2402",
  ].filter((v, i, a) => a.indexOf(v) === i); // deduplicate

  const allowances = await Promise.all(
    paymasters.map((pm) =>
      publicClient.readContract({
        abi: parseAbi([
          "function allowance(address,address) view returns (uint256)",
        ]),
        address: USDC,
        functionName: "allowance",
        args: [account.address, pm as `0x${string}`],
      })
    )
  );

  const needsApproval = paymasters.filter((_, i) => allowances[i] === 0n);

  if (needsApproval.length === 0) {
    console.log("✅ Paymaster already approved, skipping.");
    return;
  }

  const sponsoredClient = buildSponsoredClient(account);

  for (const pm of needsApproval) {
    console.log("🔐 Approving paymaster (sponsored):", pm);
    const txHash = await sponsoredClient.sendTransaction({
        calls:[
            {
                to: USDC,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [pm as `0x${string}`, maxUint256],
      }),
      value: 0n,
            }
        ]
      
    });
    console.log("   ✅ Approved. Tx:", txHash);
    console.log(`   🔍 https://sepolia.basescan.org/tx/${txHash}`);
  }
}

/* ─── Transfer ──────────────────────────────────────────────────────────── */

/**
 * Transfers USDC to a recipient. Gas is paid in the sender's USDC.
 *
 * ✅ Only the transfer happens here — approve is a separate one-time step.
 *    Batching approve + transfer in the same UserOp causes AA50 postOp revert
 *    because the paymaster's postOp tries to pull USDC *after* the transfer
 *    has already moved tokens out, leaving insufficient balance for fees.
 */
async function transferUsdc(account: any, recipient: Hex, amount: string) {
  const usdcClient = buildUsdcClient(account);

  console.log(`📤 Transferring ${amount} USDC to ${recipient}...`);
  console.log(`   Sender: https://sepolia.basescan.org/address/${account.address}`);

  const txHash = await usdcClient.sendTransaction({
   calls:[
    {
         to: getAddress(USDC),
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [recipient, parseUnits(amount, 6)],
    }),
    value: 0n,
    }
   ]
    // ✅ No paymasterContext here — it belongs on the client, not the tx
  });

  console.log("✅ Tx hash:", txHash);
  console.log(`🔍 https://sepolia.basescan.org/tx/${txHash}`);
  return txHash;
}

/* ─── Main ──────────────────────────────────────────────────────────────── */

async function main() {
  const privateKey = process.env.PrivateKey as Hex;
  if (!privateKey) throw new Error("Missing privateKey env var");

  const account = await buildAccount(privateKey);
  console.log("Smart account:", account.address);

  // Step 1 — ensure USDC balance is sufficient
  //await ensureUsdcBalance(account.address);

  // Step 2 — one-time sponsored approval (skipped if already done)
  //await ensurePaymasterApproved(account);

  // Step 3 — transfer USDC; fees paid from sender's USDC balance
  await transferUsdc(
    account,
    "0x2c42A2Aa6af553c7F6ef27Fcbcd27E6A5fA175ff" as Hex,
    "0.0001"
  );
}

main().catch(console.error);