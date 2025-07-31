import { toNano, Address, Dictionary } from '@ton/core';
import { Fluida, FluidaConfig } from '../tests/wrappers/FluidaDeploy';
import { compile, NetworkProvider } from '@ton/blueprint';
import fs from 'fs';
import path from 'path';

export async function run(provider: NetworkProvider) {
    console.log('🚀 Deploying Fluida contract to TON TESTNET...');
    
    // Get deployer info
    const deployer = provider.sender();
    const deployerAddress = deployer.address;
    
    if (!deployerAddress) {
        console.error('❌ No deployer address found. Make sure your wallet is configured.');
        process.exit(1);
    }
    
    console.log('👤 Deployer address:', deployerAddress.toString());
    
    // Check deployer balance
    const balance = await provider.provider().getBalance(deployerAddress);
    console.log('💰 Deployer balance:', (Number(balance) / 1e9).toFixed(4), 'TON');
    
    if (balance < toNano('0.1')) {
        console.error('❌ Insufficient balance. You need at least 0.1 TON for deployment.');
        console.log('💡 Get testnet TON from: https://t.me/testgiver_ton_bot');
        process.exit(1);
    }

    try {
        // 1. Compile the Fluida contract
        console.log('🔧 Compiling Fluida contract...');
        const fluidaCode = await compile('Fluida');
        console.log('✅ Contract compiled successfully');

        // 2. Initialize empty dictionaries for swaps and hashlock_map
        console.log('📚 Initializing contract data structures...');
        const emptySwaps = Dictionary.empty<bigint, {
            initiator: Address;
            recipient: Address;
            amount: bigint;
            hashLock: bigint;
            timeLock: bigint;
            isCompleted: boolean;
        }>(Dictionary.Keys.BigInt(256));
        
        const emptyHashlockMap = Dictionary.empty<bigint, bigint>(Dictionary.Keys.BigInt(256));

        // 3. Configure the Fluida contract
        // For testnet, we'll use a testnet USDT jetton wallet address
        const TESTNET_USDT_JETTON_WALLET = "EQC_1YoM8RBixN95lz7odcF3Vrkc_N8Ne7gQi7Abtlet_Efi"; // Example testnet address
        
        const fluidaConfig: FluidaConfig = {
            jettonWallet: Address.parse(TESTNET_USDT_JETTON_WALLET),
            swapCounter: 0n,
            swaps: emptySwaps,
            hashlock_map: emptyHashlockMap,
        };

        console.log('📋 Contract configuration:');
        console.log('  - Jetton wallet:', fluidaConfig.jettonWallet.toString());
        console.log('  - Initial swap counter:', fluidaConfig.swapCounter.toString());

        // 4. Create contract instance
        const fluida = provider.open(Fluida.createFromConfig(fluidaConfig, fluidaCode));
        console.log('📍 Contract will be deployed to:', fluida.address.toString());

        // 5. Check if contract is already deployed
        const isDeployed = await provider.isContractDeployed(fluida.address);
        if (isDeployed) {
            console.log('⚠️  Contract is already deployed at this address');
            console.log('🔍 Verifying existing contract...');
            
            try {
                const existingJettonWallet = await fluida.getJettonWallet();
                const existingSwapCounter = await fluida.getSwapCounter();
                
                console.log('✅ Existing contract verified:');
                console.log('  - Jetton wallet:', existingJettonWallet.toString());
                console.log('  - Swap counter:', existingSwapCounter.toString());
                
                // Save address anyway
                saveDeployedAddress(fluida.address.toString());
                return;
            } catch (error) {
                console.error('❌ Error reading existing contract:', error);
            }
        }

        // 6. Deploy the contract
        console.log('📤 Sending deployment transaction...');
        console.log('💸 Deployment cost: ~0.05 TON');
        
        await fluida.sendDeploy(deployer, toNano('0.05'));
        console.log('⏳ Waiting for deployment confirmation...');

        // 7. Wait for deployment
        await provider.waitForDeploy(fluida.address);
        console.log('✅ Contract deployed successfully!');

        // 8. Verify deployment
        console.log('🔍 Verifying deployment...');
        const deployedJettonWallet = await fluida.getJettonWallet();
        const deployedSwapCounter = await fluida.getSwapCounter();

        console.log('✅ Deployment verified:');
        console.log('  - Contract address:', fluida.address.toString());
        console.log('  - Jetton wallet:', deployedJettonWallet.toString());
        console.log('  - Initial swap counter:', deployedSwapCounter.toString());

        // 9. Save deployment info
        saveDeployedAddress(fluida.address.toString());
        saveDeploymentInfo(fluida.address.toString(), deployerAddress.toString(), fluidaConfig);

        console.log('\n🎉 TESTNET DEPLOYMENT SUCCESSFUL!');
        console.log('📋 Next steps:');
        console.log('  1. Note down the contract address:', fluida.address.toString());
        console.log('  2. Update your scripts to use this address');
        console.log('  3. Test with small amounts first');
        console.log('  4. Use testnet tokens only');

    } catch (error) {
        console.error('❌ Deployment failed:', error);
        
        if (error instanceof Error) {
            if (error.message.includes('insufficient funds')) {
                console.log('💡 Get more testnet TON from: https://t.me/testgiver_ton_bot');
            } else if (error.message.includes('network')) {
                console.log('💡 Check your internet connection and try again');
            }
        }
        
        process.exit(1);
    }
}

function saveDeployedAddress(address: string) {
    const addressFile = path.join(__dirname, '..', 'deployed-address.txt');
    fs.writeFileSync(addressFile, address, 'utf8');
    console.log('💾 Contract address saved to deployed-address.txt');
}

function saveDeploymentInfo(contractAddress: string, deployerAddress: string, config: FluidaConfig) {
    const deploymentInfo = {
        network: 'testnet',
        contractAddress,
        deployerAddress,
        jettonWallet: config.jettonWallet.toString(),
        deployedAt: new Date().toISOString(),
        initialSwapCounter: config.swapCounter.toString(),
    };
    
    const infoFile = path.join(__dirname, '..', 'deployment-info.json');
    fs.writeFileSync(infoFile, JSON.stringify(deploymentInfo, null, 2), 'utf8');
    console.log('💾 Deployment info saved to deployment-info.json');
}
