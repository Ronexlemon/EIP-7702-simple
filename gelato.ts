import { createSmartAccountClient } from "permissionless";
import { to7702SimpleSmartAccount } from "permissionless/accounts";
import { createPublicClient, http, encodeFunctionData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

// Standard ERC-20 ABI for the transfer function
const erc20Abi = [
  {
    name: "transfer",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "recipient", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

async function main() {
  // Configuration
 const PRIVATE_KEY = process.env.PRIVATE_KEY as `0x${string}`;
  const BUNDLER_URL = process.env.BUNDLER_URL;
  const TOKEN_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"; // Replace with ERC-20 contract address
  const RECIPIENT_ADDRESS = "0x2c42A2Aa6af553c7F6ef27Fcbcd27E6A5fA175ff"; // Replace with receiver address
  const AMOUNT = 1000000n; // 1.0 token (assuming 18 decimals)

  const owner = privateKeyToAccount(PRIVATE_KEY);

  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(),
  });

  // 1. Initialize the 7702 Smart Account
  const account = await to7702SimpleSmartAccount({
    client: publicClient,
    owner,
  });

  const bundlerClient = createSmartAccountClient({
    account,
    chain: baseSepolia,
    bundlerTransport: http(BUNDLER_URL),
  });

  // 2. Encode the ERC-20 transfer data
  const callData = encodeFunctionData({
    abi: erc20Abi,
    functionName: "transfer",
    args: [RECIPIENT_ADDRESS, AMOUNT],
  });

  console.log("Sending EIP-7702 transaction...");

  // 3. Execute the transaction with authorization
  const hash = await bundlerClient.sendTransaction({
    to: TOKEN_ADDRESS,
    data: callData,
    value: 0n,
    authorization: await owner.signAuthorization({
      contractAddress: account.authorization?.address ?? owner.address,
      chainId: 84532, // Base Sepolia
  nonce: await publicClient.getTransactionCount({ address: owner.address }),
    }),
  });

  console.log(`Transaction successful! Hash: ${hash}`);
}

// Entry point with error handling
main().catch((error) => {
  console.error("Execution failed:");
  console.error(error);
 // process.exit(1);
});