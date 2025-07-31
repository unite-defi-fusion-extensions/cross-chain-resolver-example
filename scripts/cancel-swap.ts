import { toNano, Address, beginCell, SendMode } from '@ton/core';
import { NetworkProvider } from '@ton/blueprint';
import { getFluidaAddress } from '../tests/utils/getFluidaAddress';
import fs from 'fs';

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

interface SwapSecret {
  preimage: string;
  hashLock: string;
  timeLock: string;
  tokenAmount: string;
  initiator: string;
  fluidaAddress: string;
  timestamp: number;
  status: string;
}

export async function run(provider: NetworkProvider) {
  console.log("❌ Cancelling/refunding cross-chain swap...");

  // 1. Get the initiator's address
  const initiator = provider.sender().address!;
  console.log("👤 Initiator address:", initiator.toString());

  // 2. Get the Fluida contract address
  const fluidaAddress = Address.parse(getFluidaAddress());
  console.log("🏭 Fluida Contract Address:", fluidaAddress.toString());

  // 3. Load swap secrets
  const filePath = 'swap-secrets.json';
  if (!fs.existsSync(filePath)) {
    console.error("❌ No swap secrets file found. No swaps to cancel.");
    process.exit(1);
  }

  let swapSecrets: SwapSecret[];
  try {
    const data = fs.readFileSync(filePath, 'utf8');
    const parsedData = JSON.parse(data);
    swapSecrets = Array.isArray(parsedData) ? parsedData : [parsedData];
  } catch (error) {
    console.error("❌ Error reading swap secrets:", error);
    process.exit(1);
  }

  // 4. Find swaps that can be cancelled (initiated by this address and not completed)
  const cancellableSwaps = swapSecrets.filter(swap => 
    swap.status === 'initiated' && 
    swap.initiator === initiator.toString()
  );

  if (cancellableSwaps.length === 0) {
    console.error("❌ No cancellable swaps found for this address.");
    process.exit(1);
  }

  console.log(`📋 Found ${cancellableSwaps.length} cancellable swap(s):`);
  cancellableSwaps.forEach((swap, index) => {
    const timeLock = Number(swap.timeLock);
    const currentTime = Math.floor(Date.now() / 1000);
    const isExpired = currentTime > timeLock;
    
    console.log(`  ${index + 1}. Hash: ${swap.hashLock}`);
    console.log(`     Amount: ${swap.tokenAmount}`);
    console.log(`     Time lock: ${new Date(timeLock * 1000).toISOString()}`);
    console.log(`     Status: ${isExpired ? '🔴 EXPIRED (can refund)' : '🟡 Active (may fail)'}`);
  });

  // 5. Select the most recent swap (or you could add interactive selection)
  const selectedSwap = cancellableSwaps[cancellableSwaps.length - 1];
  console.log(`\n🎯 Cancelling swap with hash: ${selectedSwap.hashLock}`);

  // 6. Check if swap is expired
  const timeLock = Number(selectedSwap.timeLock);
  const currentTime = Math.floor(Date.now() / 1000);
  const isExpired = currentTime > timeLock;

  if (!isExpired) {
    console.warn("⚠️  WARNING: This swap has not expired yet!");
    console.warn("   Current time:", new Date().toISOString());
    console.warn("   Expires at:", new Date(timeLock * 1000).toISOString());
    console.warn("   The cancellation may fail if the contract enforces time locks.");
  }

  // 7. Parse swap data
  const hashLock = BigInt(selectedSwap.hashLock);
  const swapId = hashLock; // Assuming swapId is derived from hashLock

  console.log("🔐 Swap details:");
  console.log("  - Hash lock:", selectedSwap.hashLock);
  console.log("  - Time lock:", new Date(timeLock * 1000).toISOString());
  console.log("  - Token amount:", selectedSwap.tokenAmount);

  // 8. Build the refund swap message
  const OP_REFUND_SWAP = 0xabcdef12n; // Refund swap op code
  
  const refundSwapMessage = beginCell()
    .storeUint(OP_REFUND_SWAP, 32) // op code
    .storeUint(swapId, 256) // swap ID
    .endCell();

  console.log("📤 Sending swap cancellation transaction...");

  // 9. Send the refund transaction
  try {
    const result = await withRetry(async () => {
      return await provider.provider(fluidaAddress).internal(provider.sender(), {
        value: toNano("0.05"), // TON for gas
        sendMode: SendMode.PAY_GAS_SEPARATELY,
        bounce: true,
        body: refundSwapMessage,
      });
    }, "swap cancellation");

    console.log("✅ Swap cancellation transaction sent successfully!");
    console.log("📋 Transaction details:", {
      hash: result.hash?.toString('hex'),
      lt: result.lt?.toString(),
    });

    // 10. Update swap status in secrets file
    const swapIndex = swapSecrets.findIndex(s => s.hashLock === selectedSwap.hashLock);
    if (swapIndex !== -1) {
      swapSecrets[swapIndex].status = 'cancelled';
      swapSecrets[swapIndex].cancelledAt = Date.now();
      swapSecrets[swapIndex].cancelledBy = initiator.toString();
      
      fs.writeFileSync(filePath, JSON.stringify(swapSecrets, null, 2));
      console.log("💾 Updated swap status in secrets file");
    }

    console.log("\n🎉 Cross-chain swap cancelled successfully!");
    console.log("📝 Summary:");
    console.log("  - Swap cancelled and marked as cancelled");
    console.log("  - Tokens should be refunded to initiator");
    console.log("  - Hash lock:", selectedSwap.hashLock);

  } catch (error) {
    console.error("❌ Error cancelling swap:", error);
    console.error("💡 Possible reasons:");
    console.error("   - Swap has not expired yet");
    console.error("   - Swap has already been completed");
    console.error("   - Insufficient gas");
    console.error("   - Wrong initiator address");
    process.exit(1);
  }
}
