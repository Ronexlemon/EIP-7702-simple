import {
  createThirdwebClient,
  getContract,
  prepareContractCall,
  sendAndConfirmTransaction,
  readContract,
} from "thirdweb";
import { privateKeyToAccount } from "thirdweb/wallets";
import { smartWallet } from "thirdweb/wallets";
import { bsc } from "thirdweb/chains";
import { formatUnits, parseUnits } from "viem";

/*
 * ─── What thirdweb CAN and CANNOT do on BSC ───────────────────────────────
 *
 * ✅ CAN — developer sponsors gas (user pays nothing, dev's credits pay BNB)
 * ✅ CAN — EOA preserved IF using inAppWallet with EIP-7702 mode
 *          (inAppWallet = thirdweb manages the keys via social/email login)
 * ❌ CANNOT — user pays gas in USDT/USDC on BSC
 *             thirdweb's ERC-20 paymaster supports: Lisk LSK, Base USDC, Celo CUSD only
 *             BSC USDT/USDC are not supported as fee tokens
 *
 * For a PRIVATE KEY account (not inAppWallet) the only thirdweb sponsored
 * option is smartWallet (ERC-4337) with sponsorGas: true.
 * This creates a new smart account address — the EOA is the owner/signer
 * but the on-chain sender address changes.
 *
 * If you need SAME address + USDT fees on BSC → use Pimlico once they add
 * BSC to their ERC-20 paymaster list (check getTokenQuotes periodically).
 */

/* ─── Config ─────────────────────────────────────────────────────────────── */

//const CLIENT_ID = process.env.ThirdwebClientId as string;
const SECRET_KEY = process.env.SECRET_KEY as string; // needed for backend
const CLIENT_ID = process.env.CLIENT_ID as string;
const PRIVATE_KEY = process.env.PRIVATE_KEY as `0x${string}`;

// BSC USDT — 18 decimals
const USDT_ADDRESS = "0x55d398326f99059fF775485246999027B3197955" as const;
// BSC USDC — 18 decimals  
const USDC_ADDRESS = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d" as const;

/* ─── Client ─────────────────────────────────────────────────────────────── */

// secretKey is required for backend/server usage to enable gas sponsorship
const client = createThirdwebClient(
  SECRET_KEY ? { secretKey: SECRET_KEY } : { clientId: CLIENT_ID }
);

/* ─── Account ────────────────────────────────────────────────────────────── */

async function buildSponsoredAccount() {
  // Step 1 — EOA private key account (this is the owner/signer)
  const personalAccount = privateKeyToAccount({
    client,
    privateKey: PRIVATE_KEY,
  });

  console.log("EOA (owner)   :", personalAccount.address);

  // Step 2 — Wrap in smartWallet with sponsorGas: true
  // ⚠️  This creates a NEW smart contract address on-chain (ERC-4337)
  //     personalAccount.address is the owner, but sender changes
  //     If same address is required → wait for Pimlico BSC ERC-20 support
  const wallet = smartWallet({
    chain: bsc,
    sponsorGas: true, // developer's thirdweb credits pay the BNB gas
  });

  const smartAccount = await wallet.connect({
    client,
    personalAccount,
  });

  console.log("Smart account :", smartAccount.address);
  console.log("(gas sponsored by developer via thirdweb credits)");

  return smartAccount;
}

/* ─── Helpers ────────────────────────────────────────────────────────────── */

async function getTokenInfo(tokenAddress: `0x${string}`, ownerAddress: `0x${string}`) {
  const contract = getContract({ client, chain: bsc, address: tokenAddress });

  const [balance, decimals] = await Promise.all([
    readContract({
      contract,
      method: "function balanceOf(address) view returns (uint256)",
      params: [ownerAddress],
    }),
    readContract({
      contract,
      method: "function decimals() view returns (uint8)",
      params: [],
    }),
  ]);

  console.log(`Balance: ${formatUnits(balance, decimals)} (decimals: ${decimals})`);
  return { balance, decimals };
}

/* ─── Transfer ───────────────────────────────────────────────────────────── */

/**
 * Transfers an ERC-20 token on BSC.
 * Gas is sponsored by the developer (thirdweb credits pay BNB fees).
 * User pays zero — but gas is NOT paid in USDT/USDC (thirdweb doesn't
 * support ERC-20 fee tokens on BSC yet).
 */
async function transferToken(
  tokenAddress: `0x${string}`,
  recipient: `0x${string}`,
  amount: string
): Promise<string> {
  const smartAccount = await buildSponsoredAccount();

  const { decimals } = await getTokenInfo(tokenAddress, smartAccount.address as `0x${string}`);

  const contract = getContract({ client, chain: bsc, address: tokenAddress });

  const transaction = prepareContractCall({
    contract,
    method: "function transfer(address to, uint256 amount) returns (bool)",
    params: [recipient, parseUnits(amount, decimals)],
  });

  console.log(`\n📤 Transferring ${amount} tokens to ${recipient}...`);

  // ✅ No gasless engine config — smartWallet handles sponsorship automatically
  const receipt = await sendAndConfirmTransaction({
    transaction,
    account: smartAccount,
  });

  console.log("✅ Tx hash:", receipt.transactionHash);
  console.log(`🔍 https://bscscan.com/tx/${receipt.transactionHash}`);
  return receipt.transactionHash;
}

/* ─── Main ───────────────────────────────────────────────────────────────── */

async function main() {
  if (!CLIENT_ID && !SECRET_KEY) throw new Error("Missing ThirdwebClientId or ThirdwebSecretKey env var");
  if (!PRIVATE_KEY) throw new Error("Missing PrivateKey env var");

  console.log("─────────────────────────────────────────");
  console.log("  thirdweb Sponsored Transfer on BSC");
  console.log("  Gas: Developer sponsored (thirdweb credits)");
  console.log("  Note: User USDT/USDC fee payment not supported on BSC");
  console.log("─────────────────────────────────────────");

  await transferToken(
    USDT_ADDRESS,
    "0x2c42A2Aa6af553c7F6ef27Fcbcd27E6A5fA175ff",
    "0.0001"
  );
}

main().catch(console.error);