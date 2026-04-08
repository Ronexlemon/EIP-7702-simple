import { createPublicClient, http, parseAbi, encodeFunctionData, hexToBigInt } from "viem"
import { bsc } from "viem/chains"
import { privateKeyToAccount } from "viem/accounts"
import { createPimlicoClient } from "permissionless/clients/pimlico"
import { createSmartAccountClient } from "permissionless"
import { to7702SimpleSmartAccount } from "permissionless/accounts"

import { createBundlerClient, entryPoint06Address, entryPoint07Address, entryPoint08Address, toSimple7702SmartAccount } from "viem/account-abstraction"


const PIMLICO_API_KEY = process.env.PIMLICO_API_KEY
const PRIVATE_KEY = process.env.PrivateKey
const USDT_ADDRESS = "0x55d398326f99059fF775485246999027B3197955"
const RECIPIENT ="0xe3b63f67EB11680836a730A32b44fC6279E9Fb12"
const AMOUNT = "0.0001" // Amount of USDT to send

const pimlicoUrl = `https://api.pimlico.io/v2/56/rpc?apikey=${PIMLICO_API_KEY}`

async function main() {
    // 2. INITIALIZE CLIENTS
    const publicClient = createPublicClient({
        chain: bsc,
        transport: http()
    })

    const pimlicoClient = createPimlicoClient({
        chain: bsc,
        transport: http(pimlicoUrl),
        entryPoint:{
            address:entryPoint07Address,
            version:"0.7"
        }
    })

    const owner = privateKeyToAccount(PRIVATE_KEY as `0x${string}`)

    // 3. CREATE THE 7702 SMART ACCOUNT
    // This turns your EOA into a smart account for this transaction
    const account = await toSimple7702SmartAccount({
        client: publicClient,
        owner: owner,
        // entryPoint: {
        //     address: entryPoint08Address,
        //     version: "0.8" // Explicitly set version
        // }
    })

    console.log(`Smart Account (7702) Address: ${account.address}`)

    // 4. CREATE THE SMART ACCOUNT CLIENT (WITH PAYMASTER)
    //const fees = (await pimlicoClient.getUserOperationGasPrice()).fast
    
    const smartAccountClient = createSmartAccountClient({
        account,
        client:publicClient,
        chain: bsc,
        bundlerTransport: http(pimlicoUrl),
        paymaster: pimlicoClient, // This enables gasless transactions
       userOperation: {
        
            // Address the "Out of Gas" risk by ensuring gas prices are fetched correctly
             estimateFeesPerGas: async () => {
            const fees = await pimlicoClient.getUserOperationGasPrice()
            console.log("Thee fees",fees.fast)
            return fees.fast
        },
        
        
            
        },
        
        paymasterContext:{
           // token:USDT_ADDRESS
          sponsorshipPolicyId: PIMLICO_API_KEY,
        },
        
    })


    const authorization = await owner.signAuthorization({
  chainId: bsc.id,
  nonce: await publicClient.getTransactionCount({ address: owner.address }),
  contractAddress: account.authorization.address,
});

    // 5. ENCODE USDT TRANSFER DATA
    const usdtAbi = parseAbi(["function transfer(address to, uint256 amount)"])
    const amountInWei = BigInt(parseFloat(AMOUNT) * 10**18) // USDT on BSC uses 18 decimals

    console.log("Sending gasless USDT transaction...")

    // 6. EXECUTE TRANSACTION
    const txHash = await smartAccountClient.sendTransaction({
        to: USDT_ADDRESS,
        data: encodeFunctionData({
            abi: usdtAbi,
            functionName: "transfer",
            args: [RECIPIENT, amountInWei],
        }),
         authorization: authorization,
       
        // callGasLimit: 700000n,           // The execution gas (the "70k")
        // verificationGasLimit: 1000000n,  // Gas for the wallet to verify the signature
        // preVerificationGas: 500000n      // Gas to compensate the bundler for overhead
    
//         preVerificationGas: 5000000000000000000n,
//     verificationGasLimit: 5000000000000000000n,
//     callGasLimit: 5000000000000000000n,
//    paymasterVerificationGasLimit: 100000n,
//    // paymasterPostOpGasLimit: 500000n
    })

    console.log(`Transaction successful! Hash: https://bscscan.com/tx/${txHash}`)
}

main().catch((err) => {
    console.error("Error executing transaction:", err)
})