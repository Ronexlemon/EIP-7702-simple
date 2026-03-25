
import {
  createPublicClient,
  EntryPointVersion,
  erc20Abi,
  Hex,
  http,
  parseUnits,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bscTestnet } from "viem/chains";
import { createPimlicoClient } from "permissionless/clients/pimlico";
import { createSmartAccountClient } from "permissionless";
import { entryPoint06Abi, entryPoint07Address, toSimple7702SmartAccount } from "viem/account-abstraction";
import { toSimpleSmartAccount } from "permissionless/accounts";


// ─── Config ───────────────────────────────────────────────────────────────────

const USER_PRIVATE_KEY = process.env.Key as Hex;
const PIMLICO_API_KEY = "pim_jhiDshGQPyNzWd3igHghTV";
const SPONSORSHIP_POLICY_ID = "sp_lyrical_bulldozer";

const USDC_ADDRESS = "0x84b9b910527ad5c03a9ca831909e21e236ea7b06" as Hex //"0x036CbD53842c5426634e7929541eC2318f3dCF7e" as Hex;
const PIMLICO_RPC = `https://api.pimlico.io/v2/97/rpc?apikey=${PIMLICO_API_KEY}`;

// ─── Clients ──────────────────────────────────────────────────────────────────

const userEoa = privateKeyToAccount(USER_PRIVATE_KEY);

const publicClient = createPublicClient({
  chain: bscTestnet,
  transport: http(),
});

const pimlicoClient = createPimlicoClient({
  chain: bscTestnet,
  transport: http(PIMLICO_RPC),
  entryPoint: {
    address: entryPoint07Address,
    version: "0.7" as EntryPointVersion,
  },
});

// ─── Logic ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("─────────────────────────────────────────");
  console.log("  EIP-7702: EOA as Smart Account");
  console.log("  Network : Base Sepolia");
  console.log("  EOA Addr: ", userEoa.address);
  console.log("─────────────────────────────────────────");

  // 1. Initialize the 7702 Account
  // This account uses your EOA address as the 'sender'
  const simple7702Account = await toSimple7702SmartAccount({
    client: publicClient,
    owner: userEoa,
  });

  // 2. Create the Smart Account Client with Pimlico Sponsorship
  const smartAccountClient = createSmartAccountClient({
    account: simple7702Account,
    chain: bscTestnet,
    bundlerTransport: http(PIMLICO_RPC),
    paymaster: pimlicoClient,
    paymasterContext: {
      sponsorshipPolicyId: SPONSORSHIP_POLICY_ID,
    },
    userOperation: {
      estimateFeesPerGas: async () =>
        (await pimlicoClient.getUserOperationGasPrice()).fast,
    },
  });

  // 3. Prepare the Transaction (Sending 1 USDC)
  const recipient = "0x2c42A2Aa6af553c7F6ef27Fcbcd27E6A5fA175ff" as Hex;
  const amount = parseUnits("5", 18);

  console.log(`📤 Sending 1 USDC from ${userEoa.address} (Gasless via Pimlico)...`);

  try {
    const balance = await publicClient.readContract({
  address: USDC_ADDRESS,
  abi: erc20Abi,
  functionName: 'balanceOf',
  args: [smartAccountClient.account.address],
});
console.log(`📊 Actual USDC Adddress: ${smartAccountClient.account.address}`);
console.log(`📊 Actual USDC Balance found: ${parseUnits(balance.toString(), -18)} USDC`);
    // sendUserOperation handles the EIP-7702 authorization signature automatically
    const userOpHash = await smartAccountClient.sendUserOperation({
      account:simple7702Account,
      calls: [
        {
          to: USDC_ADDRESS,
          abi: erc20Abi,
          functionName: "transfer",
          args: [recipient, amount],
        },
      ],
      authorization:await userEoa.signAuthorization({
    chainId: bscTestnet.id,
    nonce: await publicClient.getTransactionCount({ address: userEoa.address }),
    contractAddress: simple7702Account.authorization?.address ?? userEoa.address,
  })
    });

    console.log("⏳ UserOperation sent! Hash:", userOpHash);
    console.log("Waiting for block inclusion...");

    const receipt = await pimlicoClient.waitForUserOperationReceipt({
      hash: userOpHash,
    });

    console.log("✅ Transaction successful!");
    console.log(`🔗 https://sepolia.basescan.org/tx/${receipt.receipt.transactionHash}`);

  } catch (error: any) {
    console.error("\n❌ Execution Failed:");
    if (error.message.includes("transfer amount exceeds balance")) {
        console.error("Error: Your EOA does not have enough USDC on Base Sepolia.");
    } else {
        console.error(error);
    }
  }
}

main().catch(console.error);