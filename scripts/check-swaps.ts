import { Address } from '@ton/core';
import { NetworkProvider } from '@ton/blueprint';
import { getFluidaAddress } from '../tests/utils/getFluidaAddress';
import { Fluida } from '../tests/wrappers/FluidaDeploy';
import fs from 'fs';

interface SwapSecret {
  preimage: string;
  hashLock: string;
  timeLock: string;
  tokenAmount: string;
  initiator: string;
  fluidaAddress: string;
  timestamp: number;
  status: string;
  completedAt?: number;
  completedBy?: string;
  cancelledAt?: number;
  cancelledBy?: string;
}

export async function run(provider: NetworkProvider) {
  console.log("📊 Checking cross-chain swap status...");

  // 1. Get the Fluida contract address
  const fluidaAddress = Address.parse(getFluidaAddress());
  console.log("🏭 Fluida Contract Address:", fluidaAddress.toString());

  // 2. Open the Fluida contract
  const fluida = provider.open(Fluida.createFromAddress(fluidaAddress));

  // 3. Get contract state
  try {
    const swapCounter = await fluida.getSwapCounter();
    const jettonWallet = await fluida.getJettonWallet();
    
    console.log("\n🏭 Contract State:");
    console.log("  - Swap counter:", swapCounter.toString());
    console.log("  - Jetton wallet:", jettonWallet.toString());
  } catch (error) {
    console.error("❌ Error reading contract state:", error);
  }

  // 4. Load local swap secrets
  const filePath = 'swap-secrets.json';
  let swapSecrets: SwapSecret[] = [];

  if (fs.existsSync(filePath)) {
    try {
      const data = fs.readFileSync(filePath, 'utf8');
      const parsedData = JSON.parse(data);
      swapSecrets = Array.isArray(parsedData) ? parsedData : [parsedData];
    } catch (error) {
      console.error("⚠️ Error reading swap secrets:", error);
    }
  }

  if (swapSecrets.length === 0) {
    console.log("\n📝 No local swap records found.");
    return;
  }

  console.log(`\n📋 Found ${swapSecrets.length} local swap record(s):`);

  // 5. Check each swap
  for (let i = 0; i < swapSecrets.length; i++) {
    const swap = swapSecrets[i];
    const swapNumber = i + 1;
    
    console.log(`\n${swapNumber}. 🔄 Swap ${swapNumber}`);
    console.log(`   Hash: ${swap.hashLock}`);
    console.log(`   Status: ${getStatusEmoji(swap.status)} ${swap.status.toUpperCase()}`);
    console.log(`   Amount: ${swap.tokenAmount} tokens`);
    console.log(`   Initiator: ${swap.initiator}`);
    console.log(`   Created: ${new Date(swap.timestamp).toISOString()}`);
    
    const timeLock = Number(swap.timeLock);
    const currentTime = Math.floor(Date.now() / 1000);
    const isExpired = currentTime > timeLock;
    
    console.log(`   Time lock: ${new Date(timeLock * 1000).toISOString()}`);
    console.log(`   Expiry status: ${isExpired ? '🔴 EXPIRED' : '🟢 ACTIVE'}`);
    
    if (swap.completedAt) {
      console.log(`   Completed: ${new Date(swap.completedAt).toISOString()}`);
      console.log(`   Completed by: ${swap.completedBy}`);
    }
    
    if (swap.cancelledAt) {
      console.log(`   Cancelled: ${new Date(swap.cancelledAt).toISOString()}`);
      console.log(`   Cancelled by: ${swap.cancelledBy}`);
    }

    // Try to check on-chain status
    try {
      const hashLock = BigInt(swap.hashLock);
      const hasSwap = await fluida.hasSwap(hashLock);
      
      if (hasSwap) {
        console.log(`   On-chain: ✅ EXISTS`);
        
        try {
          const swapData = await fluida.getSwap(hashLock);
          console.log(`   On-chain details:`);
          console.log(`     - Initiator: ${swapData.initiator.toString()}`);
          console.log(`     - Recipient: ${swapData.recipient.toString()}`);
          console.log(`     - Amount: ${swapData.amount.toString()}`);
          console.log(`     - Completed: ${swapData.isCompleted ? '✅ YES' : '❌ NO'}`);
        } catch (error) {
          console.log(`   On-chain details: ❌ Error reading swap data`);
        }
      } else {
        console.log(`   On-chain: ❌ NOT FOUND`);
      }
    } catch (error) {
      console.log(`   On-chain: ⚠️ Error checking status`);
    }
  }

  // 6. Summary
  const statusCounts = swapSecrets.reduce((acc, swap) => {
    acc[swap.status] = (acc[swap.status] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  console.log(`\n📊 Summary:`);
  Object.entries(statusCounts).forEach(([status, count]) => {
    console.log(`   ${getStatusEmoji(status)} ${status}: ${count}`);
  });

  // 7. Recommendations
  const pendingSwaps = swapSecrets.filter(s => s.status === 'initiated');
  const expiredSwaps = swapSecrets.filter(s => {
    const timeLock = Number(s.timeLock);
    const currentTime = Math.floor(Date.now() / 1000);
    return s.status === 'initiated' && currentTime > timeLock;
  });

  if (pendingSwaps.length > 0) {
    console.log(`\n💡 Recommendations:`);
    console.log(`   - ${pendingSwaps.length} swap(s) are still pending`);
    
    if (expiredSwaps.length > 0) {
      console.log(`   - ${expiredSwaps.length} swap(s) have expired and can be refunded`);
      console.log(`   - Run 'npx blueprint run cancel-swap' to refund expired swaps`);
    }
    
    const activeSwaps = pendingSwaps.filter(s => {
      const timeLock = Number(s.timeLock);
      const currentTime = Math.floor(Date.now() / 1000);
      return currentTime <= timeLock;
    });
    
    if (activeSwaps.length > 0) {
      console.log(`   - ${activeSwaps.length} swap(s) are still active`);
      console.log(`   - Run 'npx blueprint run complete-swap' to complete them`);
    }
  }
}

function getStatusEmoji(status: string): string {
  switch (status.toLowerCase()) {
    case 'initiated': return '🟡';
    case 'completed': return '✅';
    case 'cancelled': return '❌';
    default: return '❓';
  }
}

// Helper function to create Fluida from address
declare module '../tests/wrappers/FluidaDeploy' {
  namespace Fluida {
    function createFromAddress(address: Address): Fluida;
  }
}

// Add the static method to the Fluida class
(Fluida as any).createFromAddress = function(address: Address): Fluida {
  return new Fluida(address);
};
