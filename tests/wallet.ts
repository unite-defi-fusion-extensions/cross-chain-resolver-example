// tests/ton.spec.ts
import 'dotenv/config'; // Ensures .env variables are loaded first
import * as fs from 'fs';
import { beforeAll, describe, it, expect, jest } from '@jest/globals';

// --- ADD THIS IMPORT ---
import { compile } from '@ton/blueprint'; // The tool to compile FunC code

import { getHttpEndpoint } from '@orbs-network/ton-access';
import { mnemonicToWalletKey } from '@ton/crypto';
import { Address, Cell, Dictionary, TonClient, WalletContractV4, toNano } from '@ton/ton';

// Assuming FluidaDeploy.ts is in a utils sub-folder
import { Fluida, FluidaConfig } from './ton-utils/FluidaDeploy';

// Set a long timeout for the entire test suite because deployment can be slow
jest.setTimeout(120 * 1000); // 120 seconds

describe('Fluida Contract Deployment', () => {
    let client: TonClient;
    let walletContract: WalletContractV4;
    let keyPair: { publicKey: Buffer; secretKey: Buffer };
    let fluidaContractAddress: Address;

    // This block runs ONCE before any tests in this suite
    beforeAll(async () => {
        // =================================================================================
        // ** STEP 1: COMPILE THE CONTRACT - THIS IS THE FIX **
        // =================================================================================
        console.log('--- Step 1: Compiling The Contract ---');
        // We will compile the contract and create the `fluida.cell` file automatically.
        // This assumes your FunC source code is in `contracts/fluida.fc`
        // and your contract is named 'Fluida' inside that file.
        if (!fs.existsSync('contracts/fluida.fc')) {
            throw new Error('🛑 Source file contracts/fluida.fc not found. Please ensure your contract source code is there.');
        }
        await compile('Fluida'); // This creates build/fluida.cell
        // Since blueprint compiles to the `build` directory, let's copy it to the root
        // so the rest of the script finds it.
        fs.copyFileSync('build/fluida.cell', 'fluida.cell');
        console.log('✅ Contract compiled successfully.');
        // =================================================================================


        console.log('\n--- Step 2: Starting Deployment Prerequisite Check ---');

        // Initialize a reliable TON client
        const endpoint = await getHttpEndpoint({ network: 'testnet' });
        client = new TonClient({ endpoint });
        console.log('✅ TON client initialized');

        // Load and validate the deployer's mnemonic from .env file
        const mnemonic = process.env.TON_USER_MNEMONIC;
        if (!mnemonic || mnemonic.split(' ').length !== 24) {
            throw new Error('🛑 A valid 24-word TON_USER_MNEMONIC must be set in your .env file.');
        }
        keyPair = await mnemonicToWalletKey(mnemonic.split(' '));
        console.log('✅ Mnemonic loaded');

        // Prepare the wallet and check its balance
        const wallet = WalletContractV4.create({ publicKey: keyPair.publicKey, workchain: 0 });
        walletContract = client.open(wallet);
        console.log(`Verifying deployer wallet: ${walletContract.address.toString()}`);

        if (!(await client.isContractDeployed(walletContract.address))) {
            throw new Error(`🛑 Your wallet (${walletContract.address.toString()}) is not deployed. Please send at least 0.1 TON to it.`);
        }

        const balance = await walletContract.getBalance();
        if (balance < toNano('0.1')) {
            throw new Error(`🛑 Insufficient wallet balance. Need at least 0.1 TON, but have ${balance / 10n ** 9n} TON.`);
        }
        console.log(`✅ Wallet is active with sufficient balance: ${balance / 10n ** 9n} TON`);

        // Prepare the contract for deployment
        const fluidaCode = Cell.fromBoc(fs.readFileSync('fluida.cell'))[0]; // This will now succeed

        const config: FluidaConfig = {
            jettonWallet: Address.parse('kQDoy1cUAbGq253vwfoPcqSloODVAWkDBniR12PJFUHnK6Yf'), // Testnet jUSDT Master
            swapCounter: 0n,
            swaps: Dictionary.empty(),
            hashlock_map: Dictionary.empty(),
        };

        const fluida = Fluida.createForDeploy(fluidaCode, config);
        fluidaContractAddress = fluida.address; // Store the address for the test
        console.log(`📍 Calculated contract address: ${fluidaContractAddress.toString()}`);

        // DEPLOY: Only if it's not already deployed
        if (await client.isContractDeployed(fluidaContractAddress)) {
            console.log('✅ Contract is already deployed. Skipping deployment step.');
        } else {
            console.log('🚀 Contract not found on-chain. Proceeding with deployment...');
            const sender = walletContract.sender(keyPair.secretKey);
            const seqno = await walletContract.getSeqno();

            const fluidaToDeploy = client.open(fluida);
            await fluidaToDeploy.sendDeploy(sender, toNano('0.05'));

            // Wait for the transaction to be confirmed
            console.log('⏳ Waiting for deployment transaction to be confirmed...');
            let currentSeqno = seqno;
            const maxAttempts = 30; // 60 seconds
            let attempt = 0;
            while (currentSeqno === seqno && attempt < maxAttempts) {
                await new Promise((resolve) => setTimeout(resolve, 2000));
                currentSeqno = await walletContract.getSeqno();
                attempt++;
            }
            if (currentSeqno <= seqno) {
                throw new Error("🛑 Deployment transaction was not confirmed after 60 seconds.");
            }
            console.log('🎉 Deployment transaction sent and confirmed!');
        }
        console.log('--- Prerequisite Check Complete ---');
    });

    // This is the actual test case that runs AFTER beforeAll is finished
    it('should be deployed successfully on the testnet blockchain', async () => {
        console.log(`\n--- Running Test: Checking contract at ${fluidaContractAddress.toString()} ---`);
        const isDeployed = await client.isContractDeployed(fluidaContractAddress);
        expect(isDeployed).toBe(true);
        console.log('✅ Test Passed: isContractDeployed returned true.');
    });

    it('should have the correct initial swapCounter state', async () => {
        console.log(`\n--- Running Test: Checking initial state of ${fluidaContractAddress.toString()} ---`);
        const contract = client.open(Fluida.createFromAddress(fluidaContractAddress));
        const swapCounter = await contract.getSwapCounter();
        console.log(`On-chain swapCounter value: ${swapCounter}`);
        expect(swapCounter).toBe(0n);
        console.log('✅ Test Passed: Initial swapCounter is 0.');
    });
});