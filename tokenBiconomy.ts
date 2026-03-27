import { createWalletClient, http, parseUnits, formatUnits, parseAbi, createPublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc } from "viem/chains";

/*
 * ─── Why Biconomy over Pimlico for this use case ─────────────────────────
 *

 * Biconomy: Supertransaction API → EIP-7702 mode → EOA address preserved ✅
 *           + feeToken field → user pays gas in USDT/USDC ✅
 *           + 412 fallback → delegation + execution atomic in one tx ✅
 *
 * Flow (Biconomy 412 fallback pattern):
 *  1. POST /v1/quote (no auth) → 412 if EOA not yet delegated
 *  2. Sign the authorization returned in the 412 response
 *  3. POST /v1/quote again with signed authorization
 *  4. Sign the payload Biconomy returns
 *  5. POST /v1/execute → delegation + transfer happen in one supertransaction
 *
 * Already delegated? Steps 1 skips straight to 3 (no 412).
 */

/* ─── Config ─────────────────────────────────────────────────────────────── */

const PRIVATE_KEY  = process.env.PrivateKey  as `0x${string}`;
const API_BASE_URL = "https://api.biconomy.io";

// BSC USDT — 18 decimals
const USDT = "0x55d398326f99059fF775485246999027B3197955" as `0x${string}`;
// BSC USDC — 18 decimals
const USDC = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d" as `0x${string}`;

/* ─── Clients ────────────────────────────────────────────────────────────── */

const account = privateKeyToAccount(PRIVATE_KEY);

// walletClient — used only for signing (no on-chain calls from here)
const walletClient = createWalletClient({
  account,
  chain: bsc,
  transport: http(),
});

const publicClient = createPublicClient({
  chain: bsc,
  transport: http(),
});

/* ─── Helpers ────────────────────────────────────────────────────────────── */

async function getTokenDecimals(tokenAddress: `0x${string}`): Promise<number> {
  return publicClient.readContract({
    abi: parseAbi(["function decimals() view returns (uint8)"]),
    address: tokenAddress,
    functionName: "decimals",
  });
}

async function logBalance(tokenAddress: `0x${string}`, address: `0x${string}`) {
  const decimals = await getTokenDecimals(tokenAddress);
  const balance = await publicClient.readContract({
    abi: parseAbi(["function balanceOf(address) view returns (uint256)"]),
    address: tokenAddress,
    functionName: "balanceOf",
    args: [address],
  });
  console.log(`Balance: ${formatUnits(balance, decimals)} (decimals: ${decimals})`);
  return { balance, decimals };
}

/* ─── Biconomy API helpers ───────────────────────────────────────────────── */

async function fetchQuote(body: object): Promise<Response> {
  return fetch(`${API_BASE_URL}/v1/quote`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function executeQuote(body: object) {
  const res = await fetch(`${API_BASE_URL}/v1/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Execute failed: ${await res.text()}`);
  return res.json();
}

/* ─── Core: EIP-7702 Transfer ───────────────────────────────────────────── */

/**
 * Transfers an ERC-20 token on BSC using Biconomy's EIP-7702 mode.
 *
 * @param tokenAddress  Token to transfer (USDT, USDC, etc.)
 * @param feeToken      Token used to pay gas (can be same or different)
 * @param recipient     Recipient address
 * @param amount        Human-readable amount e.g. "1.5"
 */
async function transferTokenEip7702(
  tokenAddress: `0x${string}`,
  feeToken: `0x${string}`,
  recipient: `0x${string}`,
  amount: string
): Promise<string> {
  const decimals  = await getTokenDecimals(tokenAddress);
  const amountWei = parseUnits(amount, decimals).toString();

  // ── Build the base quote request ────────────────────────────────────────
  const quoteRequestBase = {
    mode: "eoa-7702",           // ✅ EIP-7702 mode — EOA address preserved
    ownerAddress: account.address,
    feeToken: {
      address: feeToken,        // ✅ user pays gas in this token (USDT or USDC)
      chainId: bsc.id,
    },
    composeFlows: [
      {
        // ERC-20 transfer instruction
        type: "/instructions/build",
        data: {
          functionSignature: "function transfer(address to, uint256 amount) returns (bool)",
          args: [recipient, amountWei],
          to: tokenAddress,
          chainId: bsc.id,
        },
      },
    ],
  };

  console.log("📤 Requesting quote from Biconomy...");
  console.log("   EOA (sender) :", account.address); // ✅ same address preserved
  console.log("   Fee token    :", feeToken === USDT ? "USDT" : "USDC");

  // ── Step 1: Try quote without authorization ──────────────────────────────
  let quoteResponse = await fetchQuote(quoteRequestBase);
  let quote;

  // ── Step 2: Handle 412 — EOA not yet delegated ──────────────────────────
  if (quoteResponse.status === 412) {
    console.log("⚡ EOA not yet delegated — signing EIP-7702 authorization...");

    const error = await quoteResponse.json();
    const authItems: Array<{ chainId: number; address: `0x${string}`; nonce: number }> =
      error.authorizations;

    // Sign each authorization with the EOA private key
    const signedAuths = await Promise.all(
      authItems.map(async (authItem) => {
        const authorization = await walletClient.signAuthorization({
          chainId: authItem.chainId,
          address: authItem.address,
          nonce:   authItem.nonce,
          account,
        });

        return {
          ...authorization,
          yParity: authorization.yParity,
          v: authorization.v?.toString(),
        };
      })
    );

    console.log("✅ Authorization signed — retrying quote...");

    

    // Step 3: Retry quote with signed authorization
    quoteResponse = await fetchQuote({
      ...quoteRequestBase,
      authorizations: signedAuths, // bundled into the supertransaction
    });

    if (!quoteResponse.ok) {
      throw new Error(`Quote failed after auth: ${await quoteResponse.text()}`);
    }

    console.log("ℹ️  Execution will atomically: delegate EOA → transfer tokens");
  } else if (!quoteResponse.ok) {
    throw new Error(`Quote failed: ${await quoteResponse.text()}`);
  } else {
    console.log("✅ EOA already delegated — executing directly");
  }

  quote = await quoteResponse.json();
  console.log("💰 Fee:", formatUnits(BigInt(quote.fee?.amount ?? "0"), decimals), "tokens");

  // ── Step 4: Sign the payload Biconomy returns ────────────────────────────
  const signedPayloads = await Promise.all(
    quote.payloadToSign.map(async (p: { message: string }) => {
      const signature = await walletClient.signMessage({
        account,
        message: p.message,
      });
      return { ...p, signature };
    })
  );

  // ── Step 5: Execute ──────────────────────────────────────────────────────
  console.log("🚀 Executing supertransaction...");
  const result = await executeQuote({
    ...quote,
    payloadToSign: signedPayloads,
  });
  console.log("The result",result)
  

  const txHash = result.transactionHash ?? result.userOps?.[0]?.transactionHash;
  console.log("✅ Tx hash:", txHash);
  console.log(`🔍 https://bscscan.com/tx/${txHash}`);
  return txHash;
}

/* ─── Main ───────────────────────────────────────────────────────────────── */

async function main() {
  if (!PRIVATE_KEY) throw new Error("Missing PrivateKey env var");

  console.log("─────────────────────────────────────────────");
  console.log("  Biconomy EIP-7702 Transfer on BSC");
  console.log("  EOA:", account.address);
  console.log("  Gas paid in: USDT");
  console.log("─────────────────────────────────────────────");

  // Check USDT balance on the EOA address directly
  await logBalance(USDT, account.address);

  // Transfer 0.0001 USDT — gas paid in USDT from the EOA's own balance
  await transferTokenEip7702(
    USDT,     // token to send
    USDT,     // token to pay gas with (can be USDC instead)
    "0xC36d344f77c296a0D35889FfaB47D2F3a45aaA0f",
    "1"
  );
}

main().catch(console.error);