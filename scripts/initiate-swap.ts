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
  console.log("🚀 Initiating cross-chain swap via jetton transfer...");

  // 1. Get the sender's (owner's) address
  const owner = provider.sender().address!;
  console.log("👤 Owner address:", owner.toString());

  // 2. Get the user's jetton wallet address
  let jettonWalletAddress: Address;
  try {
    jettonWalletAddress = await getJettonWalletAddress(owner.toString());
    console.log("💰 USER TGBTC jetton wallet address:", jettonWalletAddress.toString());
  } catch (error) {
    console.error("❌ Error calculating jetton wallet address:", error);
    process.exit(1);
  }

  // 3. Get the Fluida contract address
  const fluidaAddress = Address.parse(getFluidaAddress());
  console.log("🏭 Fluida Contract Address:", fluidaAddress.toString());

  // 4. Get Fluida's jetton wallet address (where tokens will be sent)
  let fluidaJettonWalletAddress: Address;
  try {
    fluidaJettonWalletAddress = await getJettonWalletAddress(fluidaAddress.toString());
    console.log("🏦 Fluida TGBTC jetton wallet address:", fluidaJettonWalletAddress.toString());
  } catch (error) {
    console.error("❌ Error calculating Fluida jetton wallet address:", error);
    process.exit(1);
  }

  // 5. Define swap parameters
  const tokenAmount = 1000000n; // 1 TGBTC (assuming 6 decimals)
  const forwardTonAmount = toNano("0.05"); // Forward TON amount for notification
  const totalTonAmount = toNano("0.15"); // Total TON for fees

  console.log("📊 Swap Parameters:");
  console.log("  - Token amount:", tokenAmount.toString());
  console.log("  - Forward TON:", forwardTonAmount.toString());
  console.log("  - Total TON:", totalTonAmount.toString());

  // 6. Generate swap secrets
  const preimage = BigInt('0x' + randomBytes(32).toString('hex'));
  const hashLock = calculateHashLock(preimage);
  
  console.log("🔐 Generated swap secrets:");
  console.log("  - Preimage:", '0x' + preimage.toString(16));
  console.log("  - Hash lock:", '0x' + hashLock.toString(16));

  // 7. Define time lock (1 hour from now)
  const currentTimestamp = Math.floor(Date.now() / 1000);
  const timeLock = BigInt(currentTimestamp + 3600); // 1 hour
  console.log("⏰ Time lock:", new Date(Number(timeLock) * 1000).toISOString());

  // 8. Save swap secrets to file
  const filePath = 'swap-secrets.json';
  let swapSecrets = [];

  if (fs.existsSync(filePath)) {
    try {
      const existingData = fs.readFileSync(filePath, 'utf8');
      const parsedData = JSON.parse(existingData);
      swapSecrets = Array.isArray(parsedData) ? parsedData : [parsedData];
    } catch (error) {
      console.error('⚠️ Error reading existing swap-secrets.json:', error);
    }
  }

  const newSwapData = {
    preimage: preimage.toString(16),
    hashLock: '0x' + hashLock.toString(16),
    timeLock: timeLock.toString(),
    tokenAmount: tokenAmount.toString(),
    initiator: owner.toString(),
    fluidaAddress: fluidaAddress.toString(),
    timestamp: Date.now(),
    status: 'initiated'
  };

  swapSecrets.push(newSwapData);
  fs.writeFileSync(filePath, JSON.stringify(swapSecrets, null, 2));
  console.log("💾 Swap secrets saved to", filePath);

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

  console.log("📤 Sending jetton transfer transaction...");

  // 11. Send the transaction
  try {
    const result = await withRetry(async () => {
      return await provider.provider(jettonWalletAddress).internal(provider.sender(), {
        value: totalTonAmount,
        sendMode: SendMode.PAY_GAS_SEPARATELY,
        bounce: true,
        body: transferMessage,
      });
    }, "jetton transfer with swap initiation");

    console.log("✅ Transaction sent successfully!");
    console.log("📋 Transaction details:", {
      hash: result.hash?.toString('hex'),
      lt: result.lt?.toString(),
    });

    console.log("\n🎉 Cross-chain swap initiated successfully!");
    console.log("📝 Next steps:");
    console.log("  1. Wait for transaction confirmation");
    console.log("  2. Monitor the Fluida contract for swap creation");
    console.log("  3. Create corresponding escrow on destination chain");
    console.log("  4. Use the saved preimage to complete the swap");

  } catch (error) {
    console.error("❌ Error sending jetton transfer:", error);
    
    // Remove the failed swap from secrets file
    swapSecrets.pop();
    fs.writeFileSync(filePath, JSON.stringify(swapSecrets, null, 2));
    console.log("🗑️ Removed failed swap from secrets file");
    
    process.exit(1);
  }
}
