import {expect, jest} from '@jest/globals'
import {createServer, CreateServerReturnType} from 'prool'
import {anvil} from 'prool/instances'
import Sdk from '@1inch/cross-chain-sdk'

import {
    computeAddress, ContractFactory, JsonRpcProvider, MaxUint256, parseEther, parseUnits,
    randomBytes, Wallet as SignerWallet, getAddress, sha256
} from 'ethers'
import {uint8ArrayToHex, UINT_40_MAX} from '@1inch/byte-utils'
import assert from 'node:assert'

// Bitcoin specific imports
import BitcoinCore from 'bitcoin-core'
import * as bitcoin from 'bitcoinjs-lib'
import { ECPairFactory } from 'ecpair'
import * as ecc from 'tiny-secp256k1'

import { config, ChainConfig } from './config'
import {Wallet} from './wallet'
import {Resolver} from './resolver'
import {EscrowFactory} from './escrow-factory'

import factoryContract from '../dist/contracts/TestEscrowFactory.sol/TestEscrowFactory.json'
import resolverContract from '../dist/contracts/Resolver.sol/Resolver.json'

// Initialize bitcoinjs-lib
const ECPair = ECPairFactory(ecc);
bitcoin.initEccLib(ecc);

// --- Configuration ---
const { BTC_RPC_HOST, BTC_RPC_PORT, BTC_RPC_USER, BTC_RPC_PASS } = process.env;
const userPk = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
const resolverPk = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a'
const BTC_DUMMY_ASSET = '0x000000000000000000000000000000000000dEaD'

jest.setTimeout(1000 * 60 * 15) // 15 minute timeout for on-chain actions
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function witnessStackToScriptWitness(witness: Buffer[]): Buffer {
    const varInt = (n: number) => {
        if (n < 0xfd) return Buffer.from([n]);
        const buf = Buffer.alloc(3);
        buf.writeUInt8(0xfd, 0);
        buf.writeUInt16LE(n, 1);
        return buf;
    }
    
    let buffer = Buffer.concat([varInt(witness.length)]);
    for (const item of witness) {
        buffer = Buffer.concat([buffer, varInt(item.length), item]);
    }
    return buffer;
}
/**
 * A robust helper function to wait for a Bitcoin transaction to get confirmed.
 */
async function waitForConfirmation(btcClient: BitcoinCore, txid: string, timeoutMinutes = 15): Promise<boolean> {
    const checkInterval = 10000; // 10 seconds
    const maxAttempts = (timeoutMinutes * 60) / (checkInterval / 1000);
    for (let i = 0; i < maxAttempts; i++) {
        try {
            const txInfo = await btcClient.getRawTransaction(txid, true);
            if (txInfo && txInfo.confirmations > 0) {
                return true; // Success!
            }
        } catch (error: any) {
            // It's normal for the tx to not be found immediately. We only care about other errors.
            if (!error.message.includes("No such mempool or blockchain transaction")) {
                console.error(`Unexpected error while polling for tx ${txid}:`, error.message);
            }
        }
        await sleep(checkInterval);
    }
    return false; // Timed out
}
/**
 * Creates a Bitcoin Script for a Hash Time Locked Contract (HTLC).
 * This is the simplest possible HTLC script for an atomic swap.
 * It locks funds that can ONLY be spent by the recipient if they know the secret.
 * NOTE: A production script would also include a refund path with a timelock.
 */
function createSimpleHtlcScript(sha256Hash: Buffer, refundPubkey: Buffer, lockTime: number): Buffer {
    return bitcoin.script.compile([
        bitcoin.opcodes.OP_IF,
            // Claim path: ONLY checks if the provided data hashes to the correct value.
            bitcoin.opcodes.OP_SHA256,
            sha256Hash,
            bitcoin.opcodes.OP_EQUAL, // Note: OP_EQUAL, not OP_EQUALVERIFY. This pushes TRUE/FALSE to the stack.
        bitcoin.opcodes.OP_ELSE,
            // Refund path remains the same (requires a signature).
            bitcoin.script.number.encode(lockTime),
            bitcoin.opcodes.OP_CHECKLOCKTIMEVERIFY,
            bitcoin.opcodes.OP_DROP,
            refundPubkey,
            bitcoin.opcodes.OP_CHECKSIG,
        bitcoin.opcodes.OP_ENDIF,
    ]);
}

describe('1inch Fusion + Bitcoin Atomic Swap (BTC -> EVM)', () => {
    let src: any, dst: any;
    let user: Wallet, resolver: Wallet;
    let srcFactory: EscrowFactory;
    let srcTimestamp: bigint;
    let btcClient: BitcoinCore;
    const network = bitcoin.networks.regtest; 

    let secret: Buffer;
    let userKeyPair: ECPairInterface;
    let resolverKeyPair: ECPairInterface;
    let htlcScript: Buffer;
    let p2wsh: bitcoin.payments.Payment;
    let lockTxId: string;
    let htlcVout: number; // The output index of the HTLC
    const btcAmountSats = 20000;
    beforeEach(async () => {
        if (!BTC_RPC_HOST || !BTC_RPC_USER || !BTC_RPC_PASS) {
            throw new Error('Bitcoin Core RPC env vars missing');
        }
        
        btcClient = new BitcoinCore({ network: 'signet', host: BTC_RPC_HOST, username: BTC_RPC_USER, password: BTC_RPC_PASS });
        
        [src, dst] = await Promise.all([initChain(config.chain.source), initChain(config.chain.destination)]);
        user = new Wallet(userPk, src.provider);
        resolver = new Wallet(resolverPk, src.provider);
        srcFactory = new EscrowFactory(src.provider, src.escrowFactory);

        await resolver.topUpFromDonor(config.chain.source.tokens.USDC.address, config.chain.source.tokens.USDC.donor, parseUnits('1000', 6));
        await resolver.approveToken(config.chain.source.tokens.USDC.address, config.chain.source.limitOrderProtocol, MaxUint256);
        await user.topUpFromDonor(getAddress('0x0000000000000000000000000000000000000000'), getAddress('0x00000000219ab540356cBB839Cbe05303d7705Fa'), parseEther('10'));

        srcTimestamp = BigInt((await src.provider.getBlock('latest'))!.timestamp);
        const requiredBalanceSats = btcAmountSats + 5000;
        let balance = await btcClient.getBalance();
        if (balance * 1e8 < requiredBalanceSats) {
            const fundingAddress = await btcClient.getNewAddress("faucet_target");
            await btcClient.generateToAddress(101, fundingAddress);
            balance = await btcClient.getBalance();
            console.log(`[BTC] Wallet funded. New balance: ${balance} BTC`);
        } else {
            console.log(`[BTC] Sufficient balance found (${balance} BTC).`);
        }

        secret = Buffer.from(randomBytes(32));
        const hash = bitcoin.crypto.sha256(secret);
        const userKeyPair = ECPair.makeRandom({ network });
        console.log(`[SYSTEM] Generated Secret for this test: ${secret.toString('hex')}`);

        const currentBlockHeight = await btcClient.getBlockCount();
        const lockTime = currentBlockHeight + 10;
        htlcScript = createSimpleHtlcScript(hash, userKeyPair.publicKey, lockTime);
        const p2wsh = bitcoin.payments.p2wsh({ redeem: { output: htlcScript, network }, network });
        const htlcAddress = p2wsh.address!;

        const rawTx = await btcClient.createRawTransaction([], [{ [htlcAddress]: (btcAmountSats / 1e8).toFixed(8) }]);
        const fundedTx = await btcClient.fundRawTransaction(rawTx);
        const signedTx = await btcClient.signRawTransactionWithWallet(fundedTx.hex);
        expect(signedTx.complete).toBe(true);
        lockTxId = await btcClient.sendRawTransaction(signedTx.hex);
        
        await btcClient.generateToAddress(1, await btcClient.getNewAddress("mining_rewards"));
        const isConfirmed = await waitForConfirmation(btcClient, lockTxId);
        if (!isConfirmed) throw new Error("HTLC lock transaction did not confirm.");

        const confirmedTx = await btcClient.getRawTransaction(lockTxId, true);
        const htlcOutput = confirmedTx.vout.find(out => out.scriptPubKey.address === htlcAddress);
        if (!htlcOutput) throw new Error("Could not find HTLC output in confirmed transaction.");
        htlcVout = htlcOutput.n;
        
        console.log(`[SETUP COMPLETE] HTLC locked in tx ${lockTxId}:${htlcVout}`);
    });


    afterEach(async () => {
        if (src?.provider) src.provider.destroy();
        if (dst?.provider) dst.provider.destroy();
        if (src?.node) await src.node.stop();
        if (dst?.node) await dst.node.stop();
    });
    it('should create and fund a Bitcoin HTLC with a simple script', async () => {
        const requiredBalanceSats = btcAmountSats + 5000;
        let balance = await btcClient.getBalance();
        if (balance * 1e8 < requiredBalanceSats) {
            const fundingAddress = await btcClient.getNewAddress("faucet_target");
            await btcClient.generateToAddress(101, fundingAddress);
            balance = await btcClient.getBalance();
            console.log(`[BTC] Wallet funded. New balance: ${balance} BTC`);
        } else {
            console.log(`[BTC] Sufficient balance found (${balance} BTC).`);
        }

        const secret = Buffer.from(randomBytes(32));
        const hash = bitcoin.crypto.sha256(secret);
        const userKeyPair = ECPair.makeRandom({ network }); // Still needed for the refund path
        console.log(`[SYSTEM] Generated Secret: ${secret.toString('hex')}`);

        const currentBlockHeight = await btcClient.getBlockCount();
        const lockTime = currentBlockHeight + 10;
        // Use the simplified script which doesn't need a recipient key for the claim path
        const htlcScript = createSimpleHtlcScript(hash, userKeyPair.publicKey, lockTime);
        const p2wsh = bitcoin.payments.p2wsh({ redeem: { output: htlcScript, network }, network });
        const htlcAddress = p2wsh.address!;

        const rawTx = await btcClient.createRawTransaction([], [{ [htlcAddress]: (btcAmountSats / 1e8).toFixed(8) }]);
        const fundedTx = await btcClient.fundRawTransaction(rawTx);
        const signedTx = await btcClient.signRawTransactionWithWallet(fundedTx.hex);
        expect(signedTx.complete).toBe(true);
        const lockTxId = await btcClient.sendRawTransaction(signedTx.hex);
        console.log(`[BTC] HTLC lock transaction broadcasted: ${lockTxId}. Mining block to confirm...`);
        
        await btcClient.generateToAddress(1, await btcClient.getNewAddress("mining_rewards"));
        const isConfirmed = await waitForConfirmation(btcClient, lockTxId);
        expect(isConfirmed).toBe(true);

        const confirmedTx = await btcClient.getRawTransaction(lockTxId, true);
        const htlcOutput = confirmedTx.vout.find(out => out.scriptPubKey.address === htlcAddress);
        if (!htlcOutput) throw new Error("Could not find HTLC output in confirmed transaction.");
        const htlcVout = htlcOutput.n;
        
        console.log(`[BTC] Lock transaction confirmed. Funds are in HTLC at ${lockTxId}:${htlcVout}`);
        expect(lockTxId).toBeDefined();
    });

    it('should claim the funds from the simple HTLC with only the secret', async () => {
        if (!lockTxId) throw new Error("Cannot run claim test: HTLC creation step did not complete.");

        console.log(`[BTC] Attempting to claim funds from simple HTLC ${lockTxId}:${htlcVout}`);
        const resolverClaimAddress = await btcClient.getNewAddress("resolver_final_destination");
        const fee = 1000;

        const tx = new bitcoin.Transaction();
        tx.version = 2;
        tx.addInput(Buffer.from(lockTxId, 'hex').reverse(), htlcVout);
        tx.addOutput(bitcoin.address.toOutputScript(resolverClaimAddress, network), btcAmountSats - fee);

        // ======================= THE FINAL FIX =======================
        const witnessStack = [
            secret, // Already a Buffer
            Buffer.from([1]), // The minimal representation of TRUE for OP_IF
            htlcScript, // Already a Buffer
        ];

        tx.setWitness(0, witnessStack);
        // ===============================================================

        const claimTxId = await btcClient.sendRawTransaction(tx.toHex());
        console.log(`[BTC] Claim transaction broadcasted: ${claimTxId}. Mining block to confirm...`);
        
        await btcClient.generateToAddress(1, await btcClient.getNewAddress("mining_rewards"));

        const isClaimConfirmed = await waitForConfirmation(btcClient, claimTxId);
        expect(isClaimConfirmed).toBe(true);
        console.log(`[BTC] Claim transaction confirmed.`);
        
        const unspent = await btcClient.listUnspent(1, 9999999, [resolverClaimAddress]);
        const receivedAmount = unspent.find(u => u.txid === claimTxId)?.amount || 0;
        expect(receivedAmount * 1e8).toEqual(btcAmountSats - fee);
        console.log(`[SUCCESS] Verified that ${resolverClaimAddress} received ${receivedAmount * 1e8} sats.`);
    });
    it('should FAIL to claim the funds with the wrong secret', async () => {
        console.log(`[TEST 2] Attempting to claim with WRONG secret...`);
        const resolverClaimAddress = await btcClient.getNewAddress("resolver_bad_claim");
        const fee = 1000;

        // Generate a DIFFERENT, wrong secret
        const wrongSecret = Buffer.from(randomBytes(32));
        console.log(`[SYSTEM] Using wrong secret: ${wrongSecret.toString('hex')}`);
        
        const tx = new bitcoin.Transaction();
        tx.addInput(Buffer.from(lockTxId, 'hex').reverse(), htlcVout);
        tx.addOutput(bitcoin.address.toOutputScript(resolverClaimAddress, network), btcAmountSats - fee);
        
        const witnessStack = [ wrongSecret, Buffer.from([1]), htlcScript ];
        tx.setWitness(0, witnessStack);
        
        // We EXPECT this to fail.
        await expect(
            btcClient.sendRawTransaction(tx.toHex())
        ).rejects.toThrow(
            'mandatory-script-verify-flag-failed (Script evaluated without error but finished with a false/empty top stack element)'
        );
        
        console.log(`[SUCCESS] Transaction was correctly rejected by the node.`);
    });
    /*
    it('should swap User:BTC for Resolver:USDC', async () => {
        const btcAmountSats = 20000;
        const usdcAmount = parseUnits('10', 6);
        const requiredBalanceSats = btcAmountSats + 1000; // Amount needed + buffer for fees

        // --- 1. GENERATE BTC ADDRESS AND WAIT FOR FUNDING ---
        const userFundingAddress = await btcClient.getNewAddress("user_funding_wallet");
        console.log('\n\n\n================ ACTION REQUIRED ================');
        console.log(`Please send at least ${requiredBalanceSats} sats (Signet BTC) to this address:`);
        console.log(`\n${userFundingAddress}\n`);
        console.log('You can use a faucet like https://signet257.bublina.eu.org/');
        console.log('====================================================\n');
        console.log('Polling wallet for funds...');

        // Poll for balance
        let balanceSats = 0;
        for (let i = 0; i < 90; i++) { // Wait up to 15 minutes
            const unspent = await btcClient.listUnspent(1, 9999999, [userFundingAddress]);
            balanceSats = unspent.reduce((total, utxo) => total + Math.round(utxo.amount * 1e8), 0);
            if (balanceSats >= requiredBalanceSats) {
                console.log(`Funds received! Balance: ${balanceSats} sats. Continuing test...`);
                break;
            }
            await sleep(10000); // Wait 10 seconds before polling again
        }
        if (balanceSats < requiredBalanceSats) {
            throw new Error(`Test timed out. Wallet was not funded with at least ${requiredBalanceSats} sats.`);
        }
        // --- 1. SECRET & HASH GENERATION ---
        const secret_hex = uint8ArrayToHex(randomBytes(32));
        const hash_btc_hex = sha256(secret_hex);
        const hashLock_evm = Sdk.HashLock.forSingleFill(secret_hex);
        console.log(`[SYSTEM] Generated Secret: ${secret_hex}`);

        /* --- 2. RESOLVER LOCKS USDC ON 1INCH ---
        console.log('[EVM] Resolver is creating 1inch order to sell USDC...');
        const order = Sdk.CrossChainOrder.new(
            new Sdk.Address(src.escrowFactory),
            { maker: new Sdk.Address(await resolver.getAddress()), makingAmount: usdcAmount, takingAmount: BigInt(btcAmountSats), makerAsset: new Sdk.Address(config.chain.source.tokens.USDC.address), takerAsset: new Sdk.Address(BTC_DUMMY_ASSET) },
            { hashLock: hashLock_evm, timeLocks: Sdk.TimeLocks.new({ srcWithdrawal: 10n, srcPublicWithdrawal: 7200n, srcCancellation: 7201n, srcPublicCancellation: 7202n, dstWithdrawal: 10n, dstPublicWithdrawal: 3600n, dstCancellation: 3601n, }), srcChainId: src.chainId, dstChainId: Sdk.NetworkEnum.BINANCE, srcSafetyDeposit: parseEther('0.01'), dstSafetyDeposit: 0n },
            { auction: new Sdk.AuctionDetails({ startTime: srcTimestamp, duration: 120n, initialRateBump: 0, points: [] }), whitelist: [{ address: new Sdk.Address(await user.getAddress()), allowFrom: 0n }], resolvingStartTime: 0n },
            { nonce: Sdk.randBigInt(UINT_40_MAX), allowPartialFills: false, allowMultipleFills: false }
        );
        const signature = await resolver.signOrder(src.chainId, order);
        const resolverContract = new Resolver(src.resolver, '0x');
        const { blockHash: srcDeployBlock } = await resolver.send(resolverContract.deploySrc(src.chainId, order, signature, Sdk.TakerTraits.default().setExtension(order.extension).setAmountMode(Sdk.AmountMode.maker), order.makingAmount));
        const srcEscrowEvent = await srcFactory.getSrcDeployEvent(srcDeployBlock!);
        const srcEscrowAddress = new Sdk.EscrowFactory(new Sdk.Address(src.escrowFactory)).getSrcEscrowAddress(srcEscrowEvent[0], await srcFactory.getSourceImpl());
        console.log(`[EVM] Resolver's USDC is now locked in escrow: ${srcEscrowAddress}`);
        
        // --- 3. USER VERIFIES AND LOCKS BTC (DESCRIPTOR-COMPATIBLE) ---
        // Let the wallet generate addresses and manage keys internally.
        const userRefundAddress = await btcClient.getNewAddress("user_refund");
        const resolverClaimAddress = await btcClient.getNewAddress("resolver_claim");
        
        const userInfo = await btcClient.getAddressInfo(userRefundAddress);
        const resolverInfo = await btcClient.getAddressInfo(resolverClaimAddress);

        const userPubkey = Buffer.from(userInfo.pubkey, 'hex');
        const resolverPubkey = Buffer.from(resolverInfo.pubkey, 'hex');
        
        const balance = await btcClient.getBalance();
        if (balance * 1e8 < btcAmountSats + 1000) {
            throw new Error(`Insufficient BTC balance. Need at least ${btcAmountSats + 1000} sats. Please fund wallet from a Signet faucet.`);
        }
        
        const currentBlockHeight = await btcClient.getBlockCount();
        const lockTime = currentBlockHeight + 144;
        const htlcScript = createHtlcScript(Buffer.from(hash_btc_hex.substring(2), 'hex'), resolverPubkey, userPubkey, lockTime);
        const p2wsh = bitcoin.payments.p2wsh({ redeem: { output: htlcScript, network }, network });
        const htlcAddress = p2wsh.address!;
        
        // Let Bitcoin Core create, fund, sign, and send the transaction. This is the most robust method.
        const lockTxId = await btcClient.sendToAddress(htlcAddress, btcAmountSats / 1e8);
        console.log(`[BTC] User's BTC lock transaction broadcasted: ${lockTxId}. Waiting for confirmation...`);

        let confirmations = 0;
        for (let i = 0; i < 90; i++) {
            try { confirmations = (await btcClient.getRawTransaction(lockTxId, true)).confirmations || 0; if (confirmations > 0) break; } catch (e) {}
            await sleep(10000);
        }
        expect(confirmations).toBeGreaterThan(0);
        console.log(`[BTC] Lock transaction confirmed.`);
        /* --- 4. USER CLAIMS USDC & REVEALS SECRET ---
        console.log('[EVM] User is claiming the locked USDC...');
        await src.provider.send('evm_increaseTime', [11]);
        await src.provider.send('evm_mine', []);
        await user.send(resolverContract.withdraw('src', srcEscrowAddress, secret_hex, srcEscrowEvent[0]));
        console.log(`[EVM] User successfully claimed USDC. Secret is now public on-chain.`);
        
        console.log('[SUCCESS] Atomic swap is complete. Secret has been revealed, allowing Resolver to claim BTC.');
    });
    */
});

// Helper Functions
async function initChain(cnf: ChainConfig): Promise<any> {
    const {node, provider} = await getProvider(cnf);
    const deployer = new SignerWallet(cnf.ownerPrivateKey, provider);
    const escrowFactory = await deploy(factoryContract, [ cnf.limitOrderProtocol, cnf.wrappedNative, Sdk.Address.fromBigInt(0n).toString(), deployer.address, 60 * 30, 60 * 30 ], provider, deployer);
    console.log(`[${cnf.chainId}] Escrow factory contract deployed to`, escrowFactory);
    const resolver = await deploy(resolverContract, [ escrowFactory, cnf.limitOrderProtocol, computeAddress(resolverPk) ], provider, deployer);
    return {...cnf, node, provider, resolver, escrowFactory};
}
async function getProvider(cnf: ChainConfig): Promise<{node?: CreateServerReturnType; provider: JsonRpcProvider}> {
    if (!cnf.createFork) { return { provider: new JsonRpcProvider(cnf.url, cnf.chainId, { cacheTimeout: -1, staticNetwork: true }) }; }
    const node = createServer({ instance: anvil({forkUrl: cnf.url, chainId: cnf.chainId}), limit: 1 });
    await node.start();
    const address = node.address();
    assert(address);
    const provider = new JsonRpcProvider(`http://[${address.address}]:${address.port}/1`, cnf.chainId, {
        cacheTimeout: -1,
        staticNetwork: true
    });
    return { provider, node };
}
async function deploy(json: any, params: unknown[], provider: JsonRpcProvider, deployer: SignerWallet): Promise<string> {
    const deployed = await new ContractFactory(json.abi, json.bytecode, deployer).deploy(...params);
    await deployed.waitForDeployment();
    return await deployed.getAddress();
}