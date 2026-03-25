import { maxUint256, erc20Abi, parseErc6492Signature, getContract } from "viem";

// Adapted from https://github.com/vacekj/wagmi-permit/blob/main/src/permit.ts
const eip2612Permit=async({
  token,
  chain,
  ownerAddress,
  spenderAddress,
  value,
}:{token:any,chain:any,ownerAddress:any,spenderAddress:any,value:any})=> {
  return {
    types: {
      // Required for compatibility with Circle PW Sign Typed Data API
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      Permit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Permit",
    domain: {
      name: await token.read.name(),
      version: await token.read.version(),
      chainId: chain.id,
      verifyingContract: token.address,
    },
    message: {
      // Convert bigint fields to string to match EIP-712 JSON schema expectations
      owner: ownerAddress,
      spender: spenderAddress,
      value: value.toString(),
      nonce: (await token.read.nonces([ownerAddress])).toString(),
      // The paymaster cannot access block.timestamp due to 4337 opcode
      // restrictions, so the deadline must be MAX_UINT256.
      deadline: maxUint256.toString(),
    },
  };
}

 const eip2612Abi = [
  ...erc20Abi,
  {
    inputs: [
      {
        internalType: "address",
        name: "owner",
        type: "address",
      },
    ],
    stateMutability: "view",
    type: "function",
    name: "nonces",
    outputs: [
      {
        internalType: "uint256",
        name: "",
        type: "uint256",
      },
    ],
  },
  {
    inputs: [],
    name: "version",
    outputs: [{ internalType: "string", name: "", type: "string" }],
    stateMutability: "view",
    type: "function",
  },
];

const  signPermit=async({
  tokenAddress,
  client,
  account,
  spenderAddress,
  permitAmount,
}:{tokenAddress:string,client:any,account:any,spenderAddress:any,permitAmount:any})=> {
  const token = getContract({
    client,
    address: tokenAddress as `0x${string}`,
    abi: eip2612Abi,
  });
  const permitData = await eip2612Permit({
    token,
    chain: client.chain,
    ownerAddress: account.address,
    spenderAddress,
    value: permitAmount,
  });

  const wrappedPermitSignature = await account.signTypedData(permitData);

  const isValid = await client.verifyTypedData({
    ...permitData,
    address: account.address,
    signature: wrappedPermitSignature,
  });

  if (!isValid) {
    throw new Error(
      `Invalid permit signature for ${account.address}: ${wrappedPermitSignature}`,
    );
  }

  const { signature } = parseErc6492Signature(wrappedPermitSignature);
  return signature;
}


export {signPermit,eip2612Abi,eip2612Permit}