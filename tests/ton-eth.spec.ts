// tests/ton-eth.spec.ts
import 'dotenv/config';
import { expect, jest, beforeAll, afterAll, describe, it } from '@jest/globals';
import * as fs from 'fs';
import assert from 'node:assert';

// Ethereum Imports (from your working file)
import { createServer, CreateServerReturnType } from 'prool';
import { anvil } from 'prool/instances';
import { ContractFactory, JsonRpcProvider, Wallet as SignerWallet, computeAddress, randomBytes, keccak256, parseUnits, MaxUint256, parseEther } from 'ethers';
import factoryContract from '../dist/contracts/TestEscrowFactory.sol/TestEscrowFactory.json';
import resolverContract from '../dist/contracts/Resolver.sol/Resolver.json';

// Your existing helper classes and config
import { ChainConfig, config } from './config'; // This is your setup
import { Wallet } from './wallet';
import { Resolver } from './resolver';
import { EscrowFactory } from './escrow-factory';

// TON Imports
import { getHttpEndpoint } from '@orbs-network/ton-access';
import { mnemonicToWalletKey } from '@ton/crypto';
import { Address as TonAddress, Cell, TonClient, WalletContractV4, toNano, beginCell, Dictionary, fromNano, TupleBuilder } from '@ton/ton';
import { Escrow as TonSwapContract, EscrowConfig as TonSwapConfig } from './ton-utils/EscrowDeploy';
import { getJettonWalletAddress } from './ton-utils/getwalletAddress';

jest.setTimeout(3 * 60 * 1000); // 3 minute timeout

// Use the same PKs and Mnemonics from your setup
const userPk = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const resolverPk = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';
const tonUserMnemonic = process.env.TON_USER_MNEMONIC!;
const tonResolverMnemonic = process.env.TON_RESOLVER_MNEMONIC!;


// =================================================================================
// ETHEREUM HELPER FUNCTIONS (from your working setup, now inside this file)
// =================================================================================
async function deploy(json: { abi: any; bytecode: any }, params: unknown[], deployer: SignerWallet): Promise<string> {
    const factory = new ContractFactory(json.abi, json.bytecode, deployer);
    const contract = await factory.deploy(...params);
    await contract.waitForDeployment();
    return contract.getAddress();
}

async function getProvider(cnf: ChainConfig): Promise<{ node: CreateServerReturnType; provider: JsonRpcProvider }> {
    const node = createServer({ instance: anvil({ forkUrl: cnf.url, chainId: cnf.chainId }), limit: 1 });
    await node.start();
    const address = node.address();
    assert(address);
    const provider = new JsonRpcProvider(`http://[${address.address}]:${address.port}/1`, cnf.chainId, {
        cacheTimeout: -1,
        staticNetwork: true,
    });
    return { provider, node };
}

async function initChain(cnf: ChainConfig): Promise<{ node: CreateServerReturnType; provider: JsonRpcProvider; escrowFactory: string; resolver: string }> {
    const { node, provider } = await getProvider(cnf);
    const deployer = new SignerWallet(cnf.ownerPrivateKey, provider);

    const escrowFactory = await deploy(factoryContract, [
        cnf.limitOrderProtocol,
        cnf.wrappedNative, // feeToken,
        '0x0000000000000000000000000000000000000000', // accessToken,
        deployer.address, // owner
        60 * 30, // src rescue delay
        60 * 30, // dst rescue delay
    ], deployer);
    console.log(`[ETH Chain ${cnf.chainId}] EscrowFactory deployed to: ${escrowFactory}`);

    const resolver = await deploy(resolverContract, [
        escrowFactory,
        cnf.limitOrderProtocol,
        computeAddress(resolverPk), // resolver as owner of contract
    ], deployer);
    console.log(`[ETH Chain ${cnf.chainId}] Resolver contract deployed to: ${resolver}`);

    return { node, provider, resolver, escrowFactory };
}
// =================================================================================


describe('Cross-Chain Swaps (TON <-> Ethereum)', () => {
    // Chain setup
    let srcChain: { node: CreateServerReturnType; provider: JsonRpcProvider; escrowFactory: string; resolver: string };
    let dstChain: { node: CreateServerReturnType; provider: JsonRpcProvider; escrowFactory: string; resolver: string };
    
    // ETH Wallets
    let srcChainUser: Wallet;
    let dstChainUser: Wallet;
    let srcChainResolver: Wallet;
    let dstChainResolver: Wallet;

    // TON Wallets & Contract
    let tonClient: TonClient;
    let tonUserWallet: WalletContractV4;
    let tonResolverWallet: WalletContractV4;
    let tonSwapContract: TonSwapContract;

    beforeAll(async () => {
        // --- 1. SETUP ETHEREUM CHAINS (using your trusted pattern) ---
        console.log('\n--- Setting up Local Ethereum Forks ---');
        [srcChain, dstChain] = await Promise.all([initChain(config.chain.source), initChain(config.chain.destination)]);

        srcChainUser = new Wallet(userPk, srcChain.provider);
        dstChainUser = new Wallet(userPk, dstChain.provider);
        srcChainResolver = new Wallet(resolverPk, srcChain.provider);
        dstChainResolver = new Wallet(resolverPk, dstChain.provider);
        console.log(`✅ Ethereum wallets initialized.`);

        // Top up and approve funds on ETH chains
        const srcResolverContract = await Wallet.fromAddress(srcChain.resolver, srcChain.provider);
        const dstResolverContract = await Wallet.fromAddress(dstChain.resolver, dstChain.provider);
        await dstResolverContract.topUpFromDonor(config.chain.destination.tokens.USDC.address, config.chain.destination.tokens.USDC.donor, parseUnits('2000', 6));
        await dstChainResolver.transfer(dstChain.resolver, parseEther('1'));
        await dstResolverContract.unlimitedApprove(config.chain.destination.tokens.USDC.address, dstChain.escrowFactory);
        console.log(`✅ Ethereum resolver funded and approved.`);

        // --- 2. SETUP TON CHAIN ---
        console.log('\n--- Setting up TON Testnet Connection ---');
        const endpoint = await getHttpEndpoint({ network: 'testnet' });
        tonClient = new TonClient({ endpoint });

        const userKeyPair = await mnemonicToWalletKey(tonUserMnemonic.split(' '));
        tonUserWallet = tonClient.open(WalletContractV4.create({ publicKey: userKeyPair.publicKey, workchain: 0 }));
        const resolverKeyPair = await mnemonicToWalletKey(tonResolverMnemonic.split(' '));
        tonResolverWallet = tonClient.open(WalletContractV4.create({ publicKey: resolverKeyPair.publicKey, workchain: 0 }));
        console.log(`TON User Wallet: ${tonUserWallet.address}`);
        
        // Deploy TON Swap Contract
        const escrowCode = Cell.fromBoc(fs.readFileSync('build/escrow.cell'))[0];
        const tonConfig: TonSwapConfig = {
            jettonWallet: TonAddress.parse('kQDoy1cUAbGq253vwfoPcqSloODVAWkDBniR12PJFUHnK6Yf'), // jUSDT
            swapCounter: 0n,
            swaps: Dictionary.empty(),
            hashlock_map: Dictionary.empty(),
        };
        tonSwapContract = TonSwapContract.createFromConfig(tonConfig, escrowCode);
        const onchainSwap = tonClient.open(tonSwapContract);
        try {
            await onchainSwap.getSwapCounter();
            console.log(`TON Swap Contract is ready at: ${tonSwapContract.address}`);
        } catch (e) {
            console.log(`Deploying TON Swap Contract to: ${tonSwapContract.address}`);
            await onchainSwap.sendDeploy(tonUserWallet.sender(userKeyPair.secretKey), toNano('0.1'));
            await new Promise(resolve => setTimeout(resolve, 20000));
        }
    });

    afterAll(async () => {
        await Promise.all([srcChain.node.stop(), dstChain.node.stop()]);
    });

    // Your existing Ethereum tests can go here...

    it('should complete a full TON -> ETH swap', async () => {
        console.log('\n--- Running TON -> ETH Swap Test ---');
        const onchainTonSwap = tonClient.open(tonSwapContract);

        // --- Step 1: User deposits jUSDT on TON to create a swap ---
        console.log('\n[Step 1/5] User depositing 1 jUSDT on TON...');
        const initialSwapCounter = await onchainTonSwap.getSwapCounter();
        const userJettonWallet = await getJettonWalletAddress(tonClient, tonUserWallet.address.toString());
        
        const secret = randomBytes(32);
        const hash = BigInt(keccak256(secret));
        const timeLock = BigInt(Math.floor(Date.now() / 1000) + 3600);
        const depositAmount = 1n; // 1 minimal unit

        const OP_DEPOSIT_NOTIFICATION = 0xDEADBEEFn;
        const recipientRef = beginCell().storeAddress(tonResolverWallet.address).endCell();
        const locksRef = beginCell().storeUint(hash, 256).storeUint(timeLock, 64).endCell();
        const depositPayload = beginCell().storeUint(OP_DEPOSIT_NOTIFICATION, 32).storeUint(depositAmount, 128).storeAddress(tonUserWallet.address).storeRef(recipientRef).storeRef(locksRef).endCell();
        const transferMessage = beginCell().storeUint(0x0f8a7ea5, 32).storeUint(0n, 64).storeCoins(depositAmount).storeAddress(tonSwapContract.address).storeAddress(tonUserWallet.address).storeBit(0).storeCoins(toNano('0.05')).storeBit(1).storeRef(depositPayload).endCell();

        await tonUserWallet.sender((await mnemonicToWalletKey(tonUserMnemonic.split(' '))).secretKey).send({ to: userJettonWallet, value: toNano('0.1'), body: transferMessage });
        console.log('TON transaction sent. Waiting for confirmation...');
        await new Promise(resolve => setTimeout(resolve, 30000));

        // --- Step 2: Verify swap was created on TON ---
        console.log('\n[Step 2/5] Verifying swap creation on TON...');
        const finalSwapCounter = await onchainTonSwap.getSwapCounter();
        expect(finalSwapCounter).toBe(initialSwapCounter + 1n);
        const createdSwapId = initialSwapCounter;

        const swapExists = await onchainTonSwap.getHasSwap(createdSwapId);
        expect(swapExists).toBe(true);
        console.log(`✅ Swap ${createdSwapId} created successfully on TON.`);

        // --- Steps 3-5 remain simulated for now ---
        console.log('\n[Step 3/5] (Simulated) Resolver deploys ETH escrow...');
        console.log('\n[Step 4/5] (Simulated) User withdraws from ETH escrow...');
        console.log('\n[Step 5/5] (Simulated) Resolver withdraws from TON escrow...');
    });
});