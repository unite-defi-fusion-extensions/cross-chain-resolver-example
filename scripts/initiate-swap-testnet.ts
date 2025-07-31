import { toNano, Address, beginCell, SendMode } from '@ton/core';
import { NetworkProvider } from '@ton/blueprint';
import { calculateHashLock } from '../tests/utils/hashHelper';
import fs from 'fs';
import { getFluidaAddress } from '../tests/utils/getFluidaAddress';
import { getJettonWalletAddress } from '../tests/utils/getwalletAddress';
import { randomBytes } from 'crypto';

// --- Throttling Helper ---
async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry<T>(
  operation: () => Promise<T>,
  operationName: string,
  retryCount = 0
): Promise<T> {
  try {
    if (retryCount > 0) await sleep(1500 * retryCount);
    const result = await operation();
    await sleep(1500);
    return result;
  } catch (error: any) {
    if (error.response?.status === 429 && retryCount < 5) {
      console.warn(`Rate limit hit for ${operationName}. Retrying...`);
      return withRetry(operation, operationName, retryCount + 1);
    }
    throw error;
  }
}

export async function run(provider: NetworkProvider) {
  console.log("🚀 Initiating cross-chain swap on TON TESTNET...");
  console.log("⚠️  TESTNET MODE - Use only testnet tokens!");

  // 1. Get the sender's (owner's) address
  const owner = provider.sender().address!;
  console.log("👤 Owner address:", owner.toString());

  // Check owner balance
  const ownerBalance = await provider.provider().getBalance(owner);
  console.log("💰 Owner balance:", (Number(ownerBalance) / 1e9).toFixed(4), "TON");
  
  if (ownerBalance < toNano('0.2')) {
    console.error("❌ Insufficient TON balance. You need at least 0.2 TON for transaction fees.");
    console.log("💡 Get testnet TON from: https://t.me/testgiver_ton_bot");
    process.exit(1);
  }

  // 2. Get the user's jetton wallet address
  let jettonWalletAddress: Address;
  try {
    jettonWalletAddress = await getJettonWalletAddress(owner.toString());
    console.log("💰 USER jetton wallet address:", jettonWalletAddress.toString());
  } catch (error) {
    console.error("❌ Error calculating jetton wallet address:", error);
    console.log("💡 Make sure you have the correct jetton minter address configured");
    process.exit(1);
  }

  // 3. Get the Fluida contract address
  let fluidaAddress: Address;
  try {
    const addressString = getFluidaAddress();
    fluidaAddress = Address.parse(addressString);
    console.log("🏭 Fluida Contract Address:", fluidaAddress.toString());
  } catch (error) {
    console.error("❌ Error getting Fluida address:", error);
    console.log("💡 Deploy the contract first using: npx blueprint run deployFluida --testnet");
    process.exit(1);
  }

  // 4. Get Fluida's jetton wallet address (where tokens will be sent)
  let fluidaJettonWalletAddress: Address;
  try {
    fluidaJettonWalletAddress = await getJettonWalletAddress(fluidaAddress.toString());
    console.log("🏦 Fluida jetton wallet address:", fluidaJettonWalletAddress.toString());
  } catch (error) {
    console.error("❌ Error calculating Fluida jetton wallet address:", error);
    process.exit(1);
  }

  // 5. Define swap parameters (TESTNET AMOUNTS - SMALL VALUES!)
  const tokenAmount = 1000000n; // 1 token (assuming 6 decimals) - SMALL TESTNET AMOUNT
  const forwardTonAmount = toNano("0.05"); // Forward TON amount for notification
  const totalTonAmount = toNano("0.15"); // Total TON for fees

  console.log("📊 TESTNET Swap Parameters:");
  console.log("  - Token amount:", tokenAmount.toString(), "(TESTNET - small amount)");
  console.log("  - Forward TON:", (Number(forwardTonAmount) / 1e9).toFixed(4), "TON");
  console.log("  - Total TON for fees:", (Number(totalTonAmount) / 1e9).toFixed(4), "TON");

  // 6. Generate swap secrets
  const preimage = BigInt('0x' + randomBytes(32).toString('hex'));
  const hashLock = calculateHashLock(preimage);
  
  console.log("🔐 Generated swap secrets:");
  console.log("  - Preimage:", '0x' + preimage.toString(16));
  console.log("  - Hash lock:", '0x' + hashLock.toString(16));

  // 7. Define time lock (1 hour from now for testnet)
  const currentTimestamp = Math.floor(Date.now() / 1000);
  const timeLock = BigInt(currentTimestamp + 3600); // 1 hour for testnet
  console.log("⏰ Time lock:", new Date(Number(timeLock) * 1000).toISOString());

  // 8. Save swap secrets to testnet file
  const filePath = 'testnet-swap-secrets.json';
  let swapSecrets = [];

  if (fs.existsSync(filePath)) {
    try {
      const existingData = fs.readFileSync(filePath, 'utf8');
      const parsedData = JSON.parse(existingData);
      swapSecrets = Array.isArray(parsedData) ? parsedData : [parsedData];
    } catch (error) {
      console.error('⚠️ Error reading existing testnet swap secrets:', error);
    }
  }

  const newSwapData = {
    network: 'testnet',
    preimage: preimage.toString(16),
    hashLock: '0x' + hashLock.toString(16),
    timeLock: timeLock.toString(),
    tokenAmount: tokenAmount.toString(),
    initiator: owner.toString(),
    fluidaAddress: fluidaAddress.toString(),
    fluidaJettonWallet: fluidaJettonWalletAddress.toString(),
    userJettonWallet: jettonWalletAddress.toString(),
    timestamp: Date.now(),
    status: 'initiated'
  };

  swapSecrets.push(newSwapData);
  fs.writeFileSync(filePath, JSON.stringify(swapSecrets, null, 2));
  console.log("💾 Testnet swap secrets saved to", filePath);

  // 9. Build the deposit notification forward payload
  const OP_DEPOSIT_NOTIFICATION = 0xDEADBEEFn;

  // Create the extra cell with hashLock and timeLock
  const extraCell = beginCell()
    .storeUint(hashLock, 256)
    .storeUint(timeLock, 64)
    .endCell();

  // Build the deposit notification payload
  const depositNotificationPayload = beginCell()
    .storeUint(OP_DEPOSIT_NOTIFICATION, 32) // op code
    .storeUint(tokenAmount, 128) // deposit amount
    .storeAddress(owner) // initiator address
    .storeRef(
      beginCell()
        .storeAddress(fluidaJettonWalletAddress) // Fluida's jetton wallet
        .endCell()
    )
    .storeRef(extraCell) // hashLock and timeLock
    .endCell();

  // 10. Build the jetton transfer message
  const transferMessage = beginCell()
    .storeUint(0x0f8a7ea5, 32) // jetton transfer op code
    .storeUint(0, 64) // query_id
    .storeCoins(tokenAmount) // amount to transfer
    .storeAddress(fluidaAddress) // destination (Fluida contract)
    .storeAddress(owner) // response destination
    .storeBit(0) // custom payload flag (0 = none)
    .storeCoins(forwardTonAmount) // forward TON amount
    .storeBit(1) // forward payload flag (1 = referenced cell)
    .storeRef(depositNotificationPayload) // forward payload
    .endCell();

  console.log("📤 Sending TESTNET jetton transfer transaction...");
  console.log("⚠️  This will use real testnet tokens and TON!");

  // 11. Send the transaction
  try {
    const result = await withRetry(async () => {
      return await provider.provider(jettonWalletAddress).internal(provider.sender(), {
        value: totalTonAmount,
        sendMode: SendMode.PAY_GAS_SEPARATELY,
        bounce: true,
        body: transferMessage,
      });
    }, "testnet jetton transfer with swap initiation");

    console.log("✅ TESTNET transaction sent successfully!");
    console.log("📋 Transaction details:");
    console.log("  - Hash:", result.hash?.toString('hex'));
    console.log("  - LT:", result.lt?.toString());

    // Update status in secrets file
    const updatedSecrets = [...swapSecrets];
    updatedSecrets[updatedSecrets.length - 1].status = 'transaction_sent';
    updatedSecrets[updatedSecrets.length - 1].transactionHash = result.hash?.toString('hex');
    updatedSecrets[updatedSecrets.length - 1].transactionLt = result.lt?.toString();
    fs.writeFileSync(filePath, JSON.stringify(updatedSecrets, null, 2));

    console.log("\n🎉 TESTNET Cross-chain swap initiated successfully!");
    console.log("📝 Next steps:");
    console.log("  1. Wait for transaction confirmation on testnet");
    console.log("  2. Check transaction on testnet explorer:");
    console.log("     https://testnet.tonscan.org/tx/" + result.hash?.toString('hex'));
    console.log("  3. Monitor the Fluida contract for swap creation");
    console.log("  4. Create corresponding escrow on Ethereum Sepolia testnet");
    console.log("  5. Use saved preimage to complete the swap");
    console.log("  6. Run: npx blueprint run check-swaps --testnet");

  } catch (error) {
    console.error("❌ TESTNET transaction failed:", error);
    
    // Remove the failed swap from secrets file
    swapSecrets.pop();
    fs.writeFileSync(filePath, JSON.stringify(swapSecrets, null, 2));
    console.log("🗑️ Removed failed swap from testnet secrets file");
    
    if (error instanceof Error) {
      if (error.message.includes('insufficient funds')) {
        console.log("💡 Get more testnet TON from: https://t.me/testgiver_ton_bot");
      } else if (error.message.includes('jetton')) {
        console.log("💡 Make sure you have testnet jettons in your wallet");
      }
    }
    
    process.exit(1);
  }
}
