import { toNano, Dictionary, Address } from '@ton/core';
import { Fluida, FluidaConfig } from '../wrappers/FluidaDeploy';
import { compile, NetworkProvider } from '@ton/blueprint';
import fs from 'fs';
import path from 'path';

export async function run(provider: NetworkProvider) {
    try {
        // 1) Compile the Fluida contract
        console.log('🔧 Compiling Fluida contract...');
        const fluidaCode = await compile('Fluida');

        // 2) Initialize empty dictionaries for swaps and hashlock_map
        console.log('📚 Initializing empty swaps and hashlock_map dictionaries...');
        const emptySwaps = Dictionary.empty<bigint, {
            initiator: Address;
            recipient: Address;
            amount: bigint;
            hashLock: bigint;
            timeLock: bigint;
            isCompleted: boolean;
        }>(Dictionary.Keys.BigInt(256));
        const emptyHashlockMap = Dictionary.empty<bigint, bigint>(Dictionary.Keys.BigInt(256));
        console.log('✅ Empty dictionaries initialized.');

        // 3) Configure the Fluida contract including hashlock_map.
        const fluidaConfig: FluidaConfig = {
            jettonWallet: Address.parse("EQCw-TMDSxfgF3Pkzu59ZCNh5cTonlSwNMk2hyI9znwUQ7V0"),
            swapCounter: 0n,
            swaps: emptySwaps,
            hashlock_map: emptyHashlockMap,
        };
        console.log('📋 Configuring Fluida with:', {
            jettonWallet: fluidaConfig.jettonWallet.toString(),
            swapCounter: fluidaConfig.swapCounter.toString(),
            swaps: 'Empty Dictionary',
            hashlock_map: 'Empty Dictionary',
        });

        // 4) Deploy the Fluida contract
        console.log('🚀 Deploying Fluida contract with the above configuration...');
        const fluida = provider.open(Fluida.createFromConfig(fluidaConfig, fluidaCode));

        console.log('📤 Sending deployment transaction for Fluida...');
        await fluida.sendDeploy(provider.sender(), toNano('0.05'));
        console.log('📤 Deployment transaction sent. Awaiting confirmation...');

        await provider.waitForDeploy(fluida.address);
        console.log('✅ Fluida deployed successfully at address:', fluida.address.toString());

        // Save the deployed address to a file for later use
        const deployedAddress = fluida.address.toString();
        const filePath = path.join(__dirname, 'utils', 'fluidaAddress.txt');
        fs.writeFileSync(filePath, deployedAddress, { encoding: 'utf8' });
        console.log(`💾 Deployed address saved to ${filePath}`);

        // 5) Verification of Deployment
        console.log('\n--- Deployment Summary ---');
        console.log('📦 Fluida Address:', deployedAddress);

        const storedJettonWallet = await fluida.getJettonWallet();
        console.log('🔗 Stored jettonWallet in Fluida:', storedJettonWallet.toString());

        const swapCounter = await fluida.getSwapCounter();
        console.log('🔢 Initial Swap Counter:', swapCounter.toString());
    } catch (error) {
        console.error('❌ An error occurred during deployment:', error);
        process.exit(1);
    }
}
