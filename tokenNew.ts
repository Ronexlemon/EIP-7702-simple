import { createSmartAccountClient } from "permissionless";
import { to7702SimpleSmartAccount } from "permissionless/accounts"; // ✅ correct name
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
  EntryPointVersion,
} from "viem/account-abstraction";
import { privateKeyToAccount } from "viem/accounts";
import { bsc } from "viem/chains";

/*
 * Previous failures root cause:
 *
 * ❌ toSimple7702SmartAccount  ← viem's version, NOT in permissionless
 *    When used with permissionless's createSmartAccountClient, the
 *    authorization is never properly signed → dummy r/s → bundler rejects
 *
 * ✅ to7702SimpleSmartAccount  ← permissionless's version (note word order)
 *    Fully integrated with createSmartAccountClient, handles authorization
 *    signing automatically before submission
 */

/* ─── Config ─────────────────────────────────────────────────────────────── */

const PRIVATE_KEY = process.env.PRIVATE_KEY as Hex;
const API_KEY     =  process.env.PIMLICO_API_KEY;

const USDT = "0x55d398326f99059fF775485246999027B3197955" as Hex; // BSC USDT, 18 decimals
const USDC = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d" as Hex; // BSC USDC, 18 decimals

const PIMLICO_URL = `https://api.pimlico.io/v2/${bsc.id}/rpc?apikey=${API_KEY}`;

const KNOWN_PAYMASTERS: Hex[] = [
  "0x777777777777AeC03fd955926DbF81597e66834C",
  "0x888888888888Ec68A58AB8094Cc1AD20Ba3D2402",
];

/* ─── Base clients ───────────────────────────────────────────────────────── */

const publicClient = createPublicClient({
  chain: bsc,
  transport: http(),
});

const pimlicoClient = createPimlicoClient({
  chain: bsc,
  transport: http(PIMLICO_URL),
  entryPoint: {
    address: entryPoint07Address,
    version: "0.8" as EntryPointVersion,
  },
});

/* ─── Account ────────────────────────────────────────────────────────────── */

async function buildAccount(privateKey: Hex) {
  const owner = privateKeyToAccount(privateKey);

  // ✅ to7702SimpleSmartAccount (permissionless naming)
  //    account.address === owner.address — same EOA, no new address
  const account = await to7702SimpleSmartAccount({
    client: publicClient,
    owner,
    
    // accountLogicAddress is optional — uses Pimlico's default Simple7702 impl
  });

  console.log("EOA address   :", owner.address);
  console.log("Smart account :", account.address);
  console.log("Same address? :", owner.address === account.address ? "✅ YES" : "❌ NO");

  return account;
}

/* ─── Smart account clients ─────────────────────────────────────────────── */

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
    paymasterContext: {
      sponsorshipPolicyId: "sp_lyrical_bulldozer", // ✅ your policy ID here
    },
    // No paymasterContext → Pimlico sponsors for free
  });
}

function buildTokenFeeClient(account: any, feeToken: Hex) {
  return createSmartAccountClient({
    account,
    chain: bsc,
    bundlerTransport: http(PIMLICO_URL),
    paymaster: pimlicoClient,
    userOperation: {
      estimateFeesPerGas: async () =>
        (await pimlicoClient.getUserOperationGasPrice()).fast,
    },
    paymasterContext: {
      //token: feeToken, // ✅ client level — not inside sendTransaction
      sponsorshipPolicyId: "sp_lyrical_bulldozer", 
    },
  });
}

/* ─── Helpers ────────────────────────────────────────────────────────────── */

async function getTokenDecimals(tokenAddress: Hex): Promise<number> {
  return publicClient.readContract({
    abi: parseAbi(["function decimals() view returns (uint8)"]),
    address: tokenAddress,
    functionName: "decimals",
  });
}

async function logBalance(label: string, tokenAddress: Hex, address: Hex) {
  const decimals = await getTokenDecimals(tokenAddress);
  const balance = await publicClient.readContract({
    abi: parseAbi(["function balanceOf(address) view returns (uint256)"]),
    address: tokenAddress,
    functionName: "balanceOf",
    args: [address],
  });
  console.log(`${label}: ${formatUnits(balance, decimals)}`);
  return { balance, decimals };
}

/* ─── Approval (one-time, sponsored) ────────────────────────────────────── */

async function ensurePaymasterApproved(
  account: any,
  feeToken: Hex
): Promise<void> {
  const [quote] = await pimlicoClient.getTokenQuotes({ tokens: [feeToken] });
  if (!quote?.paymaster) {
    throw new Error(
      `Token ${feeToken} not supported by Pimlico on BSC.\n` +
      "Check: https://docs.pimlico.io/guides/how-to/erc20-paymaster/supported-tokens"
    );
  }

  const paymasters = [
    quote.paymaster as Hex,
    ...KNOWN_PAYMASTERS,
  ].filter((v, i, a) => a.indexOf(v) === i);

  const allowances = await Promise.all(
    paymasters.map((pm) =>
      publicClient.readContract({
        abi: parseAbi(["function allowance(address,address) view returns (uint256)"]),
        address: feeToken,
        functionName: "allowance",
        args: [account.address, pm],
      })
    )
  );

  const needsApproval = paymasters.filter((_, i) => allowances[i] === 0n);

  if (needsApproval.length === 0) {
    console.log("✅ Already approved, skipping.");
    return;
  }

  const sponsoredClient = buildSponsoredClient(account);

  for (const pm of needsApproval) {
    console.log("🔐 Approving paymaster (sponsored):", pm);
    const txHash = await sponsoredClient.sendTransaction({
      calls: [
        {
          to: feeToken,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: "approve",
            args: [pm, maxUint256],
          }),
          value: 0n,
        },
      ],
    });
    console.log("   ✅ Approved. Tx:", txHash);
    console.log(`   🔍 https://bscscan.com/tx/${txHash}`);
  }
}

/* ─── Transfer ───────────────────────────────────────────────────────────── */

async function transferToken(
  account: any,
  tokenAddress: Hex,
  feeToken: Hex,
  recipient: Hex,
  amount: string
): Promise<Hex> {
  const decimals = await getTokenDecimals(tokenAddress);
  const tokenClient = buildTokenFeeClient(account, feeToken);

  console.log(`\n📤 Transferring ${amount} tokens to ${recipient}...`);
  console.log(`   From       : https://bscscan.com/address/${account.address}`);
  console.log(`   Fee token  : ${feeToken}`);

  const txHash = await tokenClient.sendTransaction({
    calls: [
      {
        to: getAddress(tokenAddress),
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: "transfer",
          args: [recipient, parseUnits(amount, decimals)],
        }),
        value: 0n,
      },
    ],
  });

  console.log("✅ Tx hash:", txHash);
  console.log(`🔍 https://bscscan.com/tx/${txHash}`);
  return txHash;
}

/* ─── Main ───────────────────────────────────────────────────────────────── */

async function main() {
  if (!PRIVATE_KEY) throw new Error("Missing PrivateKey env var");

  const account = await buildAccount(PRIVATE_KEY);

  await logBalance("USDT balance", USDT, account.address);

  // Step 1 — one-time sponsored approval
  await ensurePaymasterApproved(account, USDT);

  // Step 2 — transfer; gas paid in USDT from the EOA's own balance
  await transferToken(
    account,
    USDT,   // token to send
    USDT,   // token to pay gas with (can differ, e.g. pay in USDC, send USDT)
    "0x2c42A2Aa6af553c7F6ef27Fcbcd27E6A5fA175ff" as Hex,
    "0.0001"
  );
}

main().catch(console.error);