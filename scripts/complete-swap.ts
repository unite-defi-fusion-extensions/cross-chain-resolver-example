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
  console.log("🔓 Completing cross-chain swap...");

  // 1. Get the resolver's address
  const resolver = provider.sender().address!;
  console.log("👤 Resolver address:", resolver.toString());

  // 2. Get the Fluida contract address
  const fluidaAddress = Address.parse(getFluidaAddress());
  console.log("🏭 Fluida Contract Address:", fluidaAddress.toString());

  // 3. Load swap secrets
  const filePath = 'swap-secrets.json';
  if (!fs.existsSync(filePath)) {
    console.error("❌ No swap secrets file found. Please initiate a swap first.");
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

  // 4. Find pending swaps
  const pendingSwaps = swapSecrets.filter(swap => swap.status === 'initiated');
  if (pendingSwaps.length === 0) {
    console.error("❌ No pending swaps found.");
    process.exit(1);
  }

  console.log(`📋 Found ${pendingSwaps.length} pending swap(s):`);
  pendingSwaps.forEach((swap, index) => {
    console.log(`  ${index + 1}. Hash: ${swap.hashLock}`);
    console.log(`     Amount: ${swap.tokenAmount}`);
    console.log(`     Initiated: ${new Date(swap.timestamp).toISOString()}`);
  });

  // 5. Select the most recent swap (or you could add interactive selection)
  const selectedSwap = pendingSwaps[pendingSwaps.length - 1];
  console.log(`\n🎯 Completing swap with hash: ${selectedSwap.hashLock}`);

  // 6. Parse swap data
  const preimage = BigInt('0x' + selectedSwap.preimage);
  const hashLock = BigInt(selectedSwap.hashLock);
  const swapId = hashLock; // Assuming swapId is derived from hashLock

  console.log("🔐 Swap details:");
  console.log("  - Preimage:", '0x' + selectedSwap.preimage);
  console.log("  - Hash lock:", selectedSwap.hashLock);
  console.log("  - Time lock:", new Date(Number(selectedSwap.timeLock) * 1000).toISOString());

  // 7. Build the complete swap message
  const OP_COMPLETE_SWAP = 0x87654321n; // Complete swap op code
  
  const completeSwapMessage = beginCell()
    .storeUint(OP_COMPLETE_SWAP, 32) // op code
    .storeUint(swapId, 256) // swap ID
    .storeUint(preimage, 256) // preimage to reveal
    .endCell();

  console.log("📤 Sending swap completion transaction...");

  // 8. Send the completion transaction
  try {
    const result = await withRetry(async () => {
      return await provider.provider(fluidaAddress).internal(provider.sender(), {
        value: toNano("0.05"), // TON for gas
        sendMode: SendMode.PAY_GAS_SEPARATELY,
        bounce: true,
        body: completeSwapMessage,
      });
    }, "swap completion");

    console.log("✅ Swap completion transaction sent successfully!");
    console.log("📋 Transaction details:", {
      hash: result.hash?.toString('hex'),
      lt: result.lt?.toString(),
    });

    // 9. Update swap status in secrets file
    const swapIndex = swapSecrets.findIndex(s => s.hashLock === selectedSwap.hashLock);
    if (swapIndex !== -1) {
      swapSecrets[swapIndex].status = 'completed';
      swapSecrets[swapIndex].completedAt = Date.now();
      swapSecrets[swapIndex].completedBy = resolver.toString();
      
      fs.writeFileSync(filePath, JSON.stringify(swapSecrets, null, 2));
      console.log("💾 Updated swap status in secrets file");
    }

    console.log("\n🎉 Cross-chain swap completed successfully!");
    console.log("📝 Summary:");
    console.log("  - Preimage revealed:", '0x' + selectedSwap.preimage);
    console.log("  - Tokens should be released to resolver");
    console.log("  - Swap marked as completed");

  } catch (error) {
    console.error("❌ Error completing swap:", error);
    process.exit(1);
  }
}
