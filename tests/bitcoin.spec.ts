import {afterAll, beforeAll, expect, jest} from '@jest/globals'
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
import { before, beforeEach } from 'node:test'

// Initialize bitcoinjs-lib
const ECPair = ECPairFactory(ecc);
bitcoin.initEccLib(ecc);

// --- Configuration ---
const { BTC_RPC_HOST, BTC_RPC_PORT, BTC_RPC_USER, BTC_RPC_PASS } = process.env;
const userPk = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
const resolverPk = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a'
const BTC_DUMMY_ASSET = '0x000000000000000000000000000000000000dEaD'
const BTC_SAT_ASSET = '0x000000000000000000000000000000000000dEaD'

jest.setTimeout(1000 * 60 * 15) // 15 minute timeout for on-chain actions
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

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
function createHtlcScript(sha256Hash: Buffer, recipientPubkey: Buffer, refundPubkey: Buffer, lockTime: number): Buffer {
    return bitcoin.script.compile([
        bitcoin.opcodes.OP_IF,
            // Claim path: requires secret and signature
            bitcoin.opcodes.OP_SHA256,
            sha256Hash,
            bitcoin.opcodes.OP_EQUALVERIFY,
            recipientPubkey,
            bitcoin.opcodes.OP_CHECKSIG,
        bitcoin.opcodes.OP_ELSE,
            // Refund path: requires timelock to have passed and signature
            bitcoin.script.number.encode(lockTime),
            bitcoin.opcodes.OP_CHECKLOCKTIMEVERIFY, // This does NOT leave a value on the stack
            refundPubkey,
            bitcoin.opcodes.OP_CHECKSIG, // This will be the last operation, leaving TRUE on the stack
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

    beforeAll(async () => {
        if (!BTC_RPC_HOST || !BTC_RPC_USER || !BTC_RPC_PASS) {
            throw new Error('Bitcoin Core RPC env vars missing');
        }
        
        btcClient = new BitcoinCore({ 
            network: 'signet', 
            host: BTC_RPC_HOST, 
            username: BTC_RPC_USER, 
            password: BTC_RPC_PASS,
        });
        userKeyPair = ECPair.makeRandom({ network });
        resolverKeyPair = ECPair.makeRandom({ network });   
        
        [src, dst] = await Promise.all([initChain(config.chain.source), initChain(config.chain.destination)]);
        user = new Wallet(userPk, src.provider);
        resolver = new Wallet(resolverPk, src.provider);
        srcFactory = new EscrowFactory(src.provider, src.escrowFactory);


        await user.topUpFromDonor(
            config.chain.source.tokens.USDC.address,
            config.chain.source.tokens.USDC.donor,
            parseUnits('1000', 6)
        )
        await resolver.topUpFromDonor(config.chain.source.tokens.USDC.address, config.chain.source.tokens.USDC.donor, parseUnits('1000', 6));
        await resolver.approveToken(
            config.chain.source.tokens.USDC.address,
            config.chain.source.limitOrderProtocol,
            MaxUint256
        );
        await user.approveToken(
            config.chain.source.tokens.USDC.address,
            config.chain.source.limitOrderProtocol,
            MaxUint256
        );
        await resolver.approveToken(
            config.chain.source.tokens.USDC.address,
            config.chain.source.limitOrderProtocol,
            MaxUint256
        )
        srcTimestamp = BigInt((await src.provider.getBlock('latest'))!.timestamp);

    });


    afterAll(async () => {
        if (src?.provider) src.provider.destroy();
        if (dst?.provider) dst.provider.destroy();
        if (src?.node) await src.node.stop();
        if (dst?.node) await dst.node.stop();
    });

    it('should create and fund a Bitcoin HTLC with a simple script', async () => {

        // 4. Use the RPC client to import the private key into the node's wallet
        // The node will now manage this key.
        // The `false` argument means we don't want to rescan the blockchain for past transactions.
 
        // Get the private key in Wallet Import Format (WIF)
        const privateKeyWIF = userKeyPair.toWIF();

        console.log(`Private Key (WIF): ${privateKeyWIF}`); // Keep this secret!
        // Get the corresponding P2PKH address
        const { address } = bitcoin.payments.p2pkh({ pubkey: Buffer.from(userKeyPair.publicKey), network });
        console.log(`Generated Address: ${address}`);
        // The 'importdescriptors' command takes an array of descriptor objects.
        const descriptor = `pkh(${privateKeyWIF})`;

        const importRequest = [{
            desc: descriptor,
            timestamp: "now",    // Start scanning for transactions from this point.
            active: true,        // Make this descriptor active for receiving funds.
            label: "my-external-key" // A label for your reference.
        }];

        // Use the generic .command() method to call the RPC.
        await btcClient.command('importdescriptors', importRequest);
        await btcClient.generateToAddress(101, address);

        console.log(`Successfully imported private key for address ${address} into the node's wallet.`);
    
        // Now you can use the node's wallet to receive and send from this address.
        // For example, let's get the balance of this specific address (will be 0 initially).
        const unspent = await btcClient.listUnspent(0, 999999, [address]);
        console.log(`Unspent outputs for ${address}:`, unspent);
        secret = Buffer.from(randomBytes(32));
        const hash = bitcoin.crypto.sha256(secret);
        console.log(`[SYSTEM] Generated Secret: ${secret.toString('hex')}`);
        const userPubkey = Buffer.from(userKeyPair.publicKey, 'hex');
        const resolverPubkey = Buffer.from(resolverKeyPair.publicKey, 'hex');
        const currentBlockHeight = await btcClient.getBlockCount();
        const lockTime = currentBlockHeight + 10;
        // Use the simplified script which doesn't need a recipient key for the claim path
        htlcScript = createHtlcScript(hash,resolverPubkey, userPubkey, lockTime);
        p2wsh = bitcoin.payments.p2wsh({ redeem: { output: htlcScript, network }, network });
        const htlcAddress = p2wsh.address!;

        const rawTx = await btcClient.createRawTransaction([], [{ [htlcAddress]: (btcAmountSats / 1e8).toFixed(8) }]);
        const fundedTx = await btcClient.fundRawTransaction(rawTx);
        const signedTx = await btcClient.signRawTransactionWithWallet(fundedTx.hex);
        expect(signedTx.complete).toBe(true);
        lockTxId = await btcClient.sendRawTransaction(signedTx.hex);
        console.log(`[BTC] HTLC lock transaction broadcasted: ${lockTxId}. Mining block to confirm...`);
        
        await btcClient.generateToAddress(1, await btcClient.getNewAddress("mining_rewards"));
        const isConfirmed = await waitForConfirmation(btcClient, lockTxId);
        expect(isConfirmed).toBe(true);

        const confirmedTx = await btcClient.getRawTransaction(lockTxId, true);
        const htlcOutput = confirmedTx.vout.find(out => out.scriptPubKey.address === htlcAddress);
        if (!htlcOutput) throw new Error("Could not find HTLC output in confirmed transaction.");
        htlcVout = htlcOutput.n;
        
        console.log(`[BTC] Lock transaction confirmed. Funds are in HTLC at ${lockTxId}:${htlcVout}`);
        expect(lockTxId).toBeDefined();
    });

    it('should claim the funds from the simple HTLC with only the secret', async () => {
        if (!lockTxId) throw new Error("Cannot run claim test: HTLC creation step did not complete.");

        console.log(`[BTC] Attempting to claim funds from simple HTLC ${lockTxId}:${htlcVout}`);
        const privateKeyWIF = resolverKeyPair.toWIF();

        // Get the corresponding P2PKH address
        const { address: resolverClaimAddress } = bitcoin.payments.p2pkh({ pubkey: Buffer.from(resolverKeyPair.publicKey), network });
        // The 'importdescriptors' command takes an array of descriptor objects.
        const descriptor = `pkh(${privateKeyWIF})`;

        const importRequest = [{
            desc: descriptor,
            timestamp: "now",    // Start scanning for transactions from this point.
            active: true,        // Make this descriptor active for receiving funds.
            label: "my-external-key-resolver" // A label for your reference.
        }];

        // Use the generic .command() method to call the RPC.
        await btcClient.command('importdescriptors', importRequest);
        await btcClient.generateToAddress(101, resolverClaimAddress);
        const fee = 1000;

        const tx = new bitcoin.Transaction();
        tx.version = 2;

        // 2. Add the HTLC UTXO as the input.
        tx.addInput(Buffer.from(lockTxId, 'hex').reverse(), htlcVout);
        tx.addOutput(bitcoin.address.toOutputScript(resolverClaimAddress, network), btcAmountSats - fee);

        // 3. Get the sighash for the input we want to spend from this specific transaction object.
        const sighashType = bitcoin.Transaction.SIGHASH_ALL;
        const signatureHash = tx.hashForWitnessV0(
            0, // input index
            htlcScript, // the redeem script
            btcAmountSats, // value of the input being spent
            sighashType,
        );

        // 4. Create the signature with the correct keypair and encode it.
        const rawSignature = resolverKeyPair.sign(signatureHash);
        const encodedSignature = bitcoin.script.signature.encode(
            Buffer.from(rawSignature),
            sighashType,
        );

        // 5. Construct the final witness stack for the "claim" path.
        const witnessStack = bitcoin.payments.p2wsh({
            redeem: {
                input: bitcoin.script.compile([
                    encodedSignature,
                    secret, // The original secret Buffer
                    bitcoin.opcodes.OP_TRUE,
                ]),
                output: htlcScript,
            },
        }).witness;

        // 6. Set the witness directly on the transaction's input.
        tx.setWitness(0, witnessStack!);
        // ===============================================================

        const claimTxId = await btcClient.sendRawTransaction(tx.toHex());
        console.log(`[BTC] Claim transaction broadcasted: ${claimTxId}. Mining block to confirm...`);
        
        await btcClient.generateToAddress(1, await btcClient.getNewAddress("mining_rewards"));

        const isClaimConfirmed = await waitForConfirmation(btcClient, claimTxId);
        expect(isClaimConfirmed).toBe(true);
        console.log(`[BTC] Claim transaction confirmed.`);
        /* Check balance
        const unspent = await btcClient.listUnspent(1, 9999999, [resolverClaimAddress]);
        const receivedAmount = unspent.find(u => u.txid === claimTxId)?.amount || 0;
        expect(receivedAmount * 1e8).toEqual(btcAmountSats - fee);
        console.log(`[SUCCESS] Verified that ${resolverClaimAddress} received ${receivedAmount * 1e8} sats.`);
        */
    });
    it('should FAIL to claim the funds with the wrong secret', async () => {
        
        // Get the private key in Wallet Import Format (WIF)
        const privateKeyWIFUser = userKeyPair.toWIF();

        // Get the corresponding P2PKH address
        const { address } = bitcoin.payments.p2pkh({ pubkey: Buffer.from(userKeyPair.publicKey), network });
        // The 'importdescriptors' command takes an array of descriptor objects.
        const descriptorUser = `pkh(${privateKeyWIFUser})`;

        const importRequestUser = [{
            desc: descriptorUser,
            timestamp: "now",    // Start scanning for transactions from this point.
            active: true,        // Make this descriptor active for receiving funds.
            label: "my-external-key" // A label for your reference.
        }];

        // Use the generic .command() method to call the RPC.
        await btcClient.command('importdescriptors', importRequestUser);
        await btcClient.generateToAddress(101, address);

        console.log(`Successfully imported private key for address ${address} into the node's wallet.`);
    
        // Now you can use the node's wallet to receive and send from this address.
        // For example, let's get the balance of this specific address (will be 0 initially).
        const unspent = await btcClient.listUnspent(0, 999999, [address]);
        console.log(`Unspent outputs for ${address}:`, unspent);
        secret = Buffer.from(randomBytes(32));
        const hash = bitcoin.crypto.sha256(secret);
        console.log(`[SYSTEM] Generated Secret: ${secret.toString('hex')}`);
        const userPubkey = Buffer.from(userKeyPair.publicKey, 'hex');
        const resolverPubkey = Buffer.from(resolverKeyPair.publicKey, 'hex');
        const currentBlockHeight = await btcClient.getBlockCount();
        const lockTime = currentBlockHeight + 10;
        // Use the simplified script which doesn't need a recipient key for the claim path
        htlcScript = createHtlcScript(hash,resolverPubkey, userPubkey, lockTime);
        p2wsh = bitcoin.payments.p2wsh({ redeem: { output: htlcScript, network }, network });
        const htlcAddress = p2wsh.address!;

        const rawTx = await btcClient.createRawTransaction([], [{ [htlcAddress]: (btcAmountSats / 1e8).toFixed(8) }]);
        const fundedTx = await btcClient.fundRawTransaction(rawTx);
        const signedTx = await btcClient.signRawTransactionWithWallet(fundedTx.hex);
        lockTxId = await btcClient.sendRawTransaction(signedTx.hex);
        console.log(`[BTC] HTLC lock transaction broadcasted: ${lockTxId}. Mining block to confirm...`);
        
        await btcClient.generateToAddress(1, await btcClient.getNewAddress("mining_rewards"));
        const isConfirmed = await waitForConfirmation(btcClient, lockTxId);

        const confirmedTx = await btcClient.getRawTransaction(lockTxId, true);
        const htlcOutput = confirmedTx.vout.find(out => out.scriptPubKey.address === htlcAddress);
        if (!htlcOutput) throw new Error("Could not find HTLC output in confirmed transaction.");
        htlcVout = htlcOutput.n;
        await btcClient.generateToAddress(1, await btcClient.getNewAddress("mining_rewards"));

        console.log(`[BTC] Lock transaction confirmed. Funds are in HTLC at ${lockTxId}:${htlcVout}`);
        
            
        console.log(`[TEST 2] Attempting to claim with WRONG secret...`);
        const fee = 1000;

        // Generate a DIFFERENT, wrong secret
        const wrongSecret = Buffer.from(randomBytes(32));
        console.log(`[SYSTEM] Using wrong secret: ${wrongSecret.toString('hex')}`);
        
        const privateKeyWIF = resolverKeyPair.toWIF();

        // Get the corresponding P2PKH address
        const { address: resolverClaimAddress } = bitcoin.payments.p2pkh({ pubkey: Buffer.from(resolverKeyPair.publicKey), network });
        // The 'importdescriptors' command takes an array of descriptor objects.
        const descriptor = `pkh(${privateKeyWIF})`;

        const importRequest = [{
            desc: descriptor,
            timestamp: "now",    // Start scanning for transactions from this point.
            active: true,        // Make this descriptor active for receiving funds.
            label: "my-external-key-resolver" // A label for your reference.
        }];

        // Use the generic .command() method to call the RPC.
        await btcClient.command('importdescriptors', importRequest);
        await btcClient.generateToAddress(101, resolverClaimAddress);

        const tx = new bitcoin.Transaction();
        tx.version = 2;

        // 2. Add the HTLC UTXO as the input.
        tx.addInput(Buffer.from(lockTxId, 'hex').reverse(), htlcVout);
        tx.addOutput(bitcoin.address.toOutputScript(resolverClaimAddress, network), btcAmountSats - fee);

        // 3. Get the sighash for the input we want to spend from this specific transaction object.
        const sighashType = bitcoin.Transaction.SIGHASH_ALL;
        const signatureHash = tx.hashForWitnessV0(
            0, // input index
            htlcScript, // the redeem script
            btcAmountSats, // value of the input being spent
            sighashType,
        );

        // 4. Create the signature with the correct keypair and encode it.
        const rawSignature = resolverKeyPair.sign(signatureHash);
        const encodedSignature = bitcoin.script.signature.encode(
            Buffer.from(rawSignature),
            sighashType,
        );

        // 5. Construct the final witness stack for the "claim" path.
        const witnessStack = bitcoin.payments.p2wsh({
            redeem: {
                input: bitcoin.script.compile([
                    encodedSignature,
                    wrongSecret, // The wrong secret
                    bitcoin.opcodes.OP_TRUE,
                ]),
                output: htlcScript,
            },
        }).witness;

        // 6. Set the witness directly on the transaction's input.
        tx.setWitness(0, witnessStack!);
        // We EXPECT this to fail.
        await expect(
            btcClient.sendRawTransaction(tx.toHex())
        ).rejects.toThrow(
            'mandatory-script-verify-flag-failed (Script failed an OP_EQUALVERIFY operation)'
        );
        
        console.log(`[SUCCESS] Transaction was correctly rejected by the node.`);
    });
    

    it('should FAIL to claim the funds with the correct secret but wrong recipient wallet', async () => {
        
        // Get the private key in Wallet Import Format (WIF)
        const privateKeyWIFUser = userKeyPair.toWIF();

        // Get the corresponding P2PKH address
        const { address } = bitcoin.payments.p2pkh({ pubkey: Buffer.from(userKeyPair.publicKey), network });
        // The 'importdescriptors' command takes an array of descriptor objects.
        const descriptorUser = `pkh(${privateKeyWIFUser})`;

        const importRequestUser = [{
            desc: descriptorUser,
            timestamp: "now",    // Start scanning for transactions from this point.
            active: true,        // Make this descriptor active for receiving funds.
            label: "my-external-key" // A label for your reference.
        }];

        // Use the generic .command() method to call the RPC.
        await btcClient.command('importdescriptors', importRequestUser);
        await btcClient.generateToAddress(101, address);

        console.log(`Successfully imported private key for address ${address} into the node's wallet.`);
    
        // Now you can use the node's wallet to receive and send from this address.
        // For example, let's get the balance of this specific address (will be 0 initially).
        const unspent = await btcClient.listUnspent(0, 999999, [address]);
        console.log(`Unspent outputs for ${address}:`, unspent);
        secret = Buffer.from(randomBytes(32));
        const hash = bitcoin.crypto.sha256(secret);
        console.log(`[SYSTEM] Generated Secret: ${secret.toString('hex')}`);
        const userPubkey = Buffer.from(userKeyPair.publicKey, 'hex');
        const resolverPubkey = Buffer.from(resolverKeyPair.publicKey, 'hex');
        const currentBlockHeight = await btcClient.getBlockCount();
        const lockTime = currentBlockHeight + 10;
        // Use the simplified script which doesn't need a recipient key for the claim path
        htlcScript = createHtlcScript(hash,resolverPubkey, userPubkey, lockTime);
        p2wsh = bitcoin.payments.p2wsh({ redeem: { output: htlcScript, network }, network });
        const htlcAddress = p2wsh.address!;

        const rawTx = await btcClient.createRawTransaction([], [{ [htlcAddress]: (btcAmountSats / 1e8).toFixed(8) }]);
        const fundedTx = await btcClient.fundRawTransaction(rawTx);
        const signedTx = await btcClient.signRawTransactionWithWallet(fundedTx.hex);
        lockTxId = await btcClient.sendRawTransaction(signedTx.hex);
        console.log(`[BTC] HTLC lock transaction broadcasted: ${lockTxId}. Mining block to confirm...`);
        
        await btcClient.generateToAddress(1, await btcClient.getNewAddress("mining_rewards"));
        const isConfirmed = await waitForConfirmation(btcClient, lockTxId);

        const confirmedTx = await btcClient.getRawTransaction(lockTxId, true);
        const htlcOutput = confirmedTx.vout.find(out => out.scriptPubKey.address === htlcAddress);
        if (!htlcOutput) throw new Error("Could not find HTLC output in confirmed transaction.");
        htlcVout = htlcOutput.n;
        await btcClient.generateToAddress(1, await btcClient.getNewAddress("mining_rewards"));

        console.log(`[BTC] Lock transaction confirmed. Funds are in HTLC at ${lockTxId}:${htlcVout}`);
        
            
        console.log(`[TEST 2] Attempting to claim with correct secret and wrong key ...`);
        const fee = 1000;


        const wrongKeyPair = ECPair.makeRandom({ network });
        const privateKeyWIF = wrongKeyPair.toWIF();
        // Get the corresponding P2PKH address
        const { address: resolverClaimAddress } = bitcoin.payments.p2pkh({ pubkey: Buffer.from(wrongKeyPair.publicKey), network });
        // The 'importdescriptors' command takes an array of descriptor objects.
        const descriptor = `pkh(${privateKeyWIF})`;

        const importRequest = [{
            desc: descriptor,
            timestamp: "now",    // Start scanning for transactions from this point.
            active: true,        // Make this descriptor active for receiving funds.
            label: "my-external-key-resolver" // A label for your reference.
        }];

        // Use the generic .command() method to call the RPC.
        await btcClient.command('importdescriptors', importRequest);
        await btcClient.generateToAddress(101, resolverClaimAddress);

        const tx = new bitcoin.Transaction();
        tx.version = 2;

        // 2. Add the HTLC UTXO as the input.
        tx.addInput(Buffer.from(lockTxId, 'hex').reverse(), htlcVout);
        tx.addOutput(bitcoin.address.toOutputScript(resolverClaimAddress, network), btcAmountSats - fee);

        // 3. Get the sighash for the input we want to spend from this specific transaction object.
        const sighashType = bitcoin.Transaction.SIGHASH_ALL;
        const signatureHash = tx.hashForWitnessV0(
            0, // input index
            htlcScript, // the redeem script
            btcAmountSats, // value of the input being spent
            sighashType,
        );

        // 4. Create the signature with the correct keypair and encode it.
        const rawSignature = wrongKeyPair.sign(signatureHash);
        const encodedSignature = bitcoin.script.signature.encode(
            Buffer.from(rawSignature),
            sighashType,
        );

        // 5. Construct the final witness stack for the "claim" path.
        const witnessStack = bitcoin.payments.p2wsh({
            redeem: {
                input: bitcoin.script.compile([
                    encodedSignature,
                    secret, // The wrong secret
                    bitcoin.opcodes.OP_TRUE,
                ]),
                output: htlcScript,
            },
        }).witness;

        // 6. Set the witness directly on the transaction's input.
        tx.setWitness(0, witnessStack!);
        // We EXPECT this to fail.
        await expect(
            btcClient.sendRawTransaction(tx.toHex())
        ).rejects.toThrow(
            'mandatory-script-verify-flag-failed (Script evaluated without error but finished with a false/empty top stack element)'
        );
        
        console.log(`[SUCCESS] Transaction was correctly rejected by the node.`);
    });
    it('should allow the original funder to refund the BTC after the timelock expires', async () => {
        // --- 1. SETUP: Create and fund a new HTLC for this test ---
        console.log('Setting up a new HTLC for the refund test...');
        const localSecret = Buffer.from(randomBytes(32));
        const localHash = bitcoin.crypto.sha256(localSecret);
        const localUserKeyPair = ECPair.makeRandom({ network });
        const localResolverKeyPair = ECPair.makeRandom({ network });
    
        // The user is the one who funds and can get a refund.
        const userPubkey = localUserKeyPair.publicKey;
        // The resolver is the one who can normally claim with the secret.
        const resolverPubkey = localResolverKeyPair.publicKey;
        
        // Import the user's key into the wallet so we can fund the HTLC from it.
        const { address: userFundingAddress } = bitcoin.payments.p2pkh({ pubkey: Buffer.from(userPubkey), network });
        await btcClient.command('importdescriptors', [{
            desc: `pkh(${localUserKeyPair.toWIF()})`,
            timestamp: "now",
            active: true,
            label: "htlc-funder"
        }]);
        await btcClient.generateToAddress(101, userFundingAddress); // Mine coins for the funder
    
        const currentBlockHeight = await btcClient.getBlockCount();
        const lockTime = currentBlockHeight + 10; // Set a specific, short timelock (10 blocks)
    
        console.log(`[SYSTEM] HTLC will be refundable after block height: ${lockTime}`);
    
        const localHtlcScript = createHtlcScript(localHash, resolverPubkey, userPubkey, lockTime);
        const localP2wsh = bitcoin.payments.p2wsh({ redeem: { output: localHtlcScript, network }, network });
        const htlcAddress = localP2wsh.address!;
    
        // Fund the HTLC from the node's wallet
        const fee = 1000;
        const rawTx = await btcClient.createRawTransaction([], [{ [htlcAddress]: (btcAmountSats / 1e8).toFixed(8) }]);
        const fundedTx = await btcClient.fundRawTransaction(rawTx);
        const signedTx = await btcClient.signRawTransactionWithWallet(fundedTx.hex);
        const localLockTxId = await btcClient.sendRawTransaction(signedTx.hex);
        
        await btcClient.generateToAddress(1, await btcClient.getNewAddress("mining_rewards"));
        const isConfirmed = await waitForConfirmation(btcClient, localLockTxId);
        expect(isConfirmed).toBe(true);
    
        const confirmedTx = await btcClient.getRawTransaction(localLockTxId, true);
        const htlcOutput = confirmedTx.vout.find(out => out.scriptPubKey.address === htlcAddress);
        if (!htlcOutput) throw new Error("Could not find HTLC output for refund test.");
        const localHtlcVout = htlcOutput.n;
        
        console.log(`[BTC] Lock transaction confirmed. Funds are in HTLC at ${localLockTxId}:${localHtlcVout}`);
        
        // --- 2. ADVANCE TIME: Mine blocks until the timelock expires ---
        const initialHeight = await btcClient.getBlockCount();
        const blocksToMine = lockTime - initialHeight + 1; // Mine one more than needed to be safe
        
        console.log(`[SYSTEM] Current height is ${initialHeight}. Mining ${blocksToMine} blocks to pass locktime ${lockTime}...`);
        await btcClient.generateToAddress(blocksToMine, await btcClient.getNewAddress("mining_rewards"));
        
        const finalHeight = await btcClient.getBlockCount();
        console.log(`[SYSTEM] Blockchain advanced to height ${finalHeight}. Timelock is now expired.`);
        expect(finalHeight).toBeGreaterThanOrEqual(lockTime);
    
        // --- 3. CONSTRUCT & SEND REFUND TRANSACTION ---
        console.log('[BTC] Constructing the refund transaction...');
        const refundAddress = userFundingAddress; // Refund back to the original funder
    
        const tx = new bitcoin.Transaction();
        tx.version = 2;
        // CRITICAL: The transaction's locktime must be >= the script's locktime.
        tx.locktime = lockTime; 
        
        // Add the HTLC UTXO as input. 
        // The nSequence MUST be less than 0xffffffff for CLTV to be evaluated.
        // bitcoinjs-lib's default is fine, but we set it explicitly for clarity.
        tx.addInput(Buffer.from(localLockTxId, 'hex').reverse(), localHtlcVout, 0xfffffffe);
        tx.addOutput(bitcoin.address.toOutputScript(refundAddress, network), btcAmountSats - fee);
    
        // Create the signature hash for the refund transaction
        const sighashType = bitcoin.Transaction.SIGHASH_ALL;
        const signatureHash = tx.hashForWitnessV0(
            0, // input index
            localHtlcScript, // the redeem script
            btcAmountSats, // value of the input
            sighashType
        );
    
        // Sign the transaction with the FUNDER's key (user's key)
        const rawSignature = localUserKeyPair.sign(signatureHash);

        const encodedSignature = bitcoin.script.signature.encode(Buffer.from(rawSignature), sighashType);
    
        // Construct the witness for the REFUND path (the OP_ELSE branch)
        const witnessStack = bitcoin.payments.p2wsh({
            redeem: {
                input: bitcoin.script.compile([
                    encodedSignature,
                    // Provide an empty buffer (OP_FALSE) to trigger the OP_ELSE path
                    Buffer.from([]), 
                ]),
                output: localHtlcScript,
            },
        }).witness;
        
        tx.setWitness(0, witnessStack!);
    
        // --- 4. BROADCAST & VERIFY ---
        const refundTxId = await btcClient.sendRawTransaction(tx.toHex());
        console.log(`[BTC] Refund transaction broadcasted: ${refundTxId}. Mining block to confirm...`);
    
        await btcClient.generateToAddress(1, await btcClient.getNewAddress("mining_rewards"));
        const isRefundConfirmed = await waitForConfirmation(btcClient, refundTxId);
        expect(isRefundConfirmed).toBe(true);
        
        console.log(`[SUCCESS] Refund transaction confirmed.`);
    
        // Optional but recommended: Verify the balance was received
        const unspent = await btcClient.listUnspent(1, 9999999, [refundAddress]);
        const receivedAmount = unspent.find(u => u.txid === refundTxId)?.amount || 0;
        expect(receivedAmount * 1e8).toEqual(btcAmountSats - fee);
        console.log(`[SUCCESS] Verified that ${refundAddress} received ${receivedAmount * 1e8} sats.`);
    });
    it('should swap User:BTC for Resolver:USDC', async () => {
        const btcAmountSats = 20000;
        const usdcAmount = parseUnits('10', 6);
        let resultBalances = await getBalances(
            config.chain.source.tokens.USDC.address,
            config.chain.destination.tokens.USDC.address
        )
        console.log(resultBalances)
        // --- 1. SECRET & HASH GENERATION ---
        const secret_hex = uint8ArrayToHex(randomBytes(32));
        const hash_btc_buffer = bitcoin.crypto.sha256(Buffer.from(secret_hex.substring(2), 'hex'));
        const hashLock_evm = Sdk.HashLock.forSingleFill(secret_hex);

        console.log(`[SYSTEM] Generated Secret: ${secret_hex}`);
        
                // 4. Create the on-chain order using the keccak256-based hashLock.
                const order = Sdk.CrossChainOrder.new(
                    new Sdk.Address(src.escrowFactory),
                    {
                        maker: new Sdk.Address(await user.getAddress()),
                        makingAmount: usdcAmount,
                        takingAmount: BigInt(btcAmountSats),
                        makerAsset: new Sdk.Address(config.chain.source.tokens.USDC.address),
                        takerAsset: new Sdk.Address(BTC_SAT_ASSET)
                    },
                    {
                        hashLock: hashLock_evm,
                        timeLocks: Sdk.TimeLocks.new({
                            srcWithdrawal: 10n,
                            srcPublicWithdrawal: 7200n,
                            srcCancellation: 7201n,
                            srcPublicCancellation: 7202n,
                            dstWithdrawal: 10n,
                            dstPublicWithdrawal: 3600n,
                            dstCancellation: 3601n
                        }),
                        srcChainId: src.chainId,
                        dstChainId: Sdk.NetworkEnum.BINANCE,
                        srcSafetyDeposit: parseEther('0.01'),
                        dstSafetyDeposit: 0n
                    },
                    {
                        auction: new Sdk.AuctionDetails({
                            startTime: srcTimestamp,
                            duration: 120n,
                            initialRateBump: 0,
                            points: []
                        }),
                        whitelist: [{address: new Sdk.Address(src.resolver), allowFrom: 0n}],
                        resolvingStartTime: 0n
                    },
                    {nonce: Sdk.randBigInt(UINT_40_MAX), allowPartialFills: false, allowMultipleFills: false}
                )
        
                const signature = await user.signOrder(src.chainId, order)
                const resolverContract = new Resolver(src.resolver, '0x')
        
                const {blockHash: srcDeployBlock} = await resolver.send(
                    resolverContract.deploySrc(
                        src.chainId,
                        order,
                        signature,
                        Sdk.TakerTraits.default().setExtension(order.extension).setAmountMode(Sdk.AmountMode.maker),
                        order.makingAmount
                    )
                )
                const srcEscrowEvent = await srcFactory.getSrcDeployEvent(srcDeployBlock!)
                const srcEscrowAddress = new Sdk.EscrowFactory(new Sdk.Address(src.escrowFactory)).getSrcEscrowAddress(
                    srcEscrowEvent[0],
                    await srcFactory.getSourceImpl()
                )
                console.log(`[EVM] Source Escrow deployed at ${srcEscrowAddress}`)
        // --- 4. USER VERIFIES AND LOCKS BTC ---
        const balance = await btcClient.getBalance();
        if (balance * 1e8 < btcAmountSats + 1000) throw new Error(`Insufficient BTC balance.`);
        
        const userRefundAddress = await btcClient.getNewAddress("user_refund");
        const resolverClaimAddress = await btcClient.getNewAddress("resolver_claim");
        const userInfo = await btcClient.getAddressInfo(userRefundAddress);
        const resolverInfo = await btcClient.getAddressInfo(resolverClaimAddress);
        const userPubkey = Buffer.from(userInfo.pubkey, 'hex');
        const resolverPubkey = Buffer.from(resolverInfo.pubkey, 'hex');
        
        const currentBlockHeight = await btcClient.getBlockCount();
        const lockTime = currentBlockHeight + 144;
        const htlcScript = createHtlcScript(hash_btc_buffer,resolverPubkey, userPubkey, lockTime);
        p2wsh = bitcoin.payments.p2wsh({ redeem: { output: htlcScript, network }, network });
        const htlcAddress = p2wsh.address!;
        
        const lockTxId = await btcClient.sendToAddress(htlcAddress, btcAmountSats / 1e8);
        console.log(`[BTC] User's BTC lock transaction broadcasted: ${lockTxId}. Waiting for confirmation...`);


        await btcClient.generateToAddress(1, await btcClient.getNewAddress("mining_rewards"));
        const isConfirmed = await waitForConfirmation(btcClient, lockTxId);
        expect(isConfirmed).toBe(true);
        console.log(`[BTC] Lock transaction confirmed.`);
        // --- 2. RESOLVER (MAKER) CREATES AND SIGNS THE 1INCH ORDER ---
        console.log('[EVM] Resolver is creating 1inch order to sell USDC...');

        


        // --- 5. USER CLAIMS USDC & REVEALS SECRET ---
        console.log('[EVM] User is claiming the locked USDC...');
        await src.provider.send('evm_increaseTime', [11]);
        await src.provider.send('evm_mine', []);
        await user.send(resolverContract.withdraw('src', srcEscrowAddress, secret_hex, srcEscrowEvent[0]));
        resultBalances = await getBalances(
            config.chain.source.tokens.USDC.address,
            config.chain.destination.tokens.USDC.address
        )
        console.log(resultBalances)
        console.log(`[EVM] User successfully claimed USDC. Secret is now public on-chain.`);
        
        console.log('[SUCCESS] Atomic swap is complete. Secret has been revealed, allowing Resolver to claim BTC.');
    });
    
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

async function getBalances(
    srcToken: string,
    dstToken: string
): Promise<{src: {user: bigint; resolver: bigint}; dst: {user: bigint; resolver: bigint}}> {
    return {
        src: {
            user: await srcChainUser.tokenBalance(srcToken),
            resolver: await srcResolverContract.tokenBalance(srcToken)
        },
        dst: {
            user: await dstChainUser.tokenBalance(dstToken),
            resolver: await dstResolverContract.tokenBalance(dstToken)
        }
    }
}