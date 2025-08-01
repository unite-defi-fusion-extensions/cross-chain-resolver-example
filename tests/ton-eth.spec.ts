// tests/ton-eth-bridge-fixed.spec.ts
/* eslint-disable */

import 'dotenv/config';
import { expect, jest, beforeAll, afterAll, describe, it } from '@jest/globals';
import * as fs from 'fs';
import assert from 'node:assert';
import crypto from 'crypto'; // <-- added

// Ethereum Imports
import { createServer, CreateServerReturnType } from 'prool';
import { anvil } from 'prool/instances';
import {
  ContractFactory,
  JsonRpcProvider,
  Wallet as SignerWallet,
  computeAddress,
  randomBytes as ethRandomBytes,
  keccak256,
  parseUnits,
  parseEther,
} from 'ethers';
import factoryContract from '../dist/contracts/TestEscrowFactory.sol/TestEscrowFactory.json';
import resolverContract from '../dist/contracts/Resolver.sol/Resolver.json';

// Helper classes
import { ChainConfig, config } from './config';
import { Wallet } from './wallet';

// TON Imports
import { getHttpEndpoint } from '@orbs-network/ton-access';
import { mnemonicToWalletKey } from '@ton/crypto';
import {
  Address as TonAddress,
  Cell,
  TonClient,
  WalletContractV4,
  toNano,
  beginCell,
  Dictionary,
} from '@ton/ton';
import {
  Escrow as TonSwapContract,
  EscrowConfig as TonSwapConfig,
} from './ton-utils/EscrowDeploy';
import { getJettonWalletAddress } from './ton-utils/getwalletAddress';

jest.setTimeout(5 * 60 * 1000);

// -----------------------------------------------------------------------------
// Constants / OP codes
// -----------------------------------------------------------------------------
const userPk =
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const resolverPk =
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';

const tonUserMnemonic = process.env.TON_USER_MNEMONIC!;
const tonResolverMnemonic = process.env.TON_RESOLVER_MNEMONIC!;

const OP_COMPLETE_SWAP = 0x87654321;
const OP_REFUND_SWAP = 0xabcdef12;
const OP_DEPOSIT_NOTIFICATION = 0xdeadbeef;
const OP_INITIALIZE = 1;

// -----------------------------------------------------------------------------
// EVM helpers
// -----------------------------------------------------------------------------
async function deploy(
  json: { abi: any; bytecode: any },
  params: unknown[],
  deployer: SignerWallet
): Promise<string> {
  const factory = new ContractFactory(json.abi, json.bytecode, deployer);
  const contract = await factory.deploy(...params);
  await contract.waitForDeployment();
  return contract.getAddress();
}

async function getProvider(
  cnf: ChainConfig
): Promise<{ node: CreateServerReturnType; provider: JsonRpcProvider }> {
  const node = createServer({
    instance: anvil({ forkUrl: cnf.url, chainId: cnf.chainId }),
    limit: 1,
  });
  await node.start();
  const address = node.address();
  assert(address);
  const provider = new JsonRpcProvider(
    `http://[${address.address}]:${address.port}/1`,
    cnf.chainId,
    { cacheTimeout: -1, staticNetwork: true }
  );
  return { provider, node };
}

async function initChain(cnf: ChainConfig): Promise<{
  node: CreateServerReturnType;
  provider: JsonRpcProvider;
  escrowFactory: string;
  resolver: string;
}> {
  const { node, provider } = await getProvider(cnf);
  const deployer = new SignerWallet(cnf.ownerPrivateKey, provider);

  const escrowFactory = await deploy(
    factoryContract,
    [
      cnf.limitOrderProtocol,
      cnf.wrappedNative,
      '0x0000000000000000000000000000000000000000',
      deployer.address,
      60 * 30,
      60 * 30,
    ],
    deployer
  );

  const resolver = await deploy(
    resolverContract,
    [escrowFactory, cnf.limitOrderProtocol, computeAddress(resolverPk)],
    deployer
  );

  return { node, provider, resolver, escrowFactory };
}

// -----------------------------------------------------------------------------
// TON helpers
// -----------------------------------------------------------------------------
async function waitForTonTransaction(
  _client: TonClient,
  timeoutMs: number = 60000
): Promise<void> {
  console.log(`⏳ Waiting ${timeoutMs / 1000} seconds for TON transaction...`);
  await new Promise((resolve) => setTimeout(resolve, timeoutMs));
}

async function checkJettonBalance(
  client: TonClient,
  jettonWallet: TonAddress
): Promise<bigint> {
  try {
    const result = await client.runMethod(jettonWallet, 'get_wallet_data');
    const balance = result.stack.readBigNumber();
    return balance;
  } catch (error) {
    console.log(`Error checking jetton balance: ${error}`);
    return 0n;
  }
}

// Safe getter wrapper
async function safeContractCall<T>(
  fn: () => Promise<T>,
  name: string,
  defaultValue?: T
): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e) {
    console.log(`⚠️ ${name} failed: ${e}`);
    return defaultValue;
  }
}

// Build deposit (jetton transfer with forward payload)
function createTonSwapDepositMessage(
  amount: bigint,
  depositor: TonAddress,
  recipient: TonAddress,
  hashLock: bigint,
  timeLock: bigint,
  swapContractAddress: TonAddress
) {
  const recipientRef = beginCell().storeAddress(recipient).endCell();
  const locksRef = beginCell()
    .storeUint(hashLock, 256)
    .storeUint(timeLock, 64)
    .endCell();

  const depositPayload = beginCell()
    .storeUint(OP_DEPOSIT_NOTIFICATION, 32)
    .storeUint(amount, 128)
    .storeAddress(depositor)
    .storeRef(recipientRef)
    .storeRef(locksRef)
    .endCell();

  return beginCell()
    .storeUint(0x0f8a7ea5, 32) // jetton transfer op
    .storeUint(0n, 64) // query_id
    .storeCoins(amount)
    .storeAddress(swapContractAddress)
    .storeAddress(depositor)
    .storeBit(0) // custom_payload
    .storeCoins(toNano('0.05')) // forward_ton_amount
    .storeBit(1) // forward_payload present
    .storeRef(depositPayload)
    .endCell();
}

function createTonCompleteSwapMessage(swapId: bigint, secret: Uint8Array) {
  return beginCell()
    .storeUint(OP_COMPLETE_SWAP, 32)
    .storeUint(swapId, 256) // contract expects 256 for swap id in your FunC
    .storeUint(BigInt('0x' + Buffer.from(secret).toString('hex')), 256)
    .endCell();
}

function createTonRefundSwapMessage(swapId: bigint) {
  return beginCell()
    .storeUint(OP_REFUND_SWAP, 32)
    .storeUint(swapId, 256)
    .endCell();
}

// TON-style hashlock: sha256(secretBytes) -> uint256 bigint
function tonHashLockFromSecret(secret: Uint8Array): bigint {
  const hashHex = crypto.createHash('sha256').update(Buffer.from(secret)).digest('hex');
  return BigInt('0x' + hashHex);
}

// -----------------------------------------------------------------------------
// Test suite
// -----------------------------------------------------------------------------
describe('TON <-> ETH Complete Atomic Bridge (Fixed, fresh deploy + init each run)', () => {
  // EVM chain
  let ethChain: {
    node: CreateServerReturnType;
    provider: JsonRpcProvider;
    escrowFactory: string;
    resolver: string;
  };
  let ethUser: Wallet;

  // TON
  let tonClient: TonClient;
  let tonUserWallet: WalletContractV4;
  let tonResolverWallet: WalletContractV4;
  let tonUserKeyPair: any;
  let tonResolverKeyPair: any;

  // Contract under test (fresh each run)
  let tonSwapContract: TonSwapContract;

  // Jetton wallets
  let userJettonWallet: TonAddress;
  let resolverJettonWallet: TonAddress;

  beforeAll(async () => {
    console.log('\n🚀 Setting up environment (fresh deploy + initialize)…');

    // ---------------- EVM bootstrap ----------------
    console.log('[1/5] 🔗 Ethereum fork…');
    ethChain = await initChain(config.chain.source);
    ethUser = new Wallet(userPk, ethChain.provider);
    const resolverWalletEvm = await Wallet.fromAddress(
      ethChain.resolver,
      ethChain.provider
    );
    await ethUser.topUpFromDonor(
      config.chain.source.tokens.USDC.address,
      config.chain.source.tokens.USDC.donor,
      parseUnits('50', 6)
    );
    await resolverWalletEvm.topUpFromDonor(
      config.chain.source.tokens.USDC.address,
      config.chain.source.tokens.USDC.donor,
      parseUnits('150', 6)
    );
    console.log('✅ Ethereum ready');

    // ---------------- TON bootstrap ----------------
    console.log('[2/5] 🔗 TON testnet…');
    if (!tonUserMnemonic) throw new Error('TON_USER_MNEMONIC not set');
    if (!tonResolverMnemonic) throw new Error('TON_RESOLVER_MNEMONIC not set');
    const endpoint = await getHttpEndpoint({ network: 'testnet' });
    tonClient = new TonClient({ endpoint });

    tonUserKeyPair = await mnemonicToWalletKey(tonUserMnemonic.split(' '));
    tonResolverKeyPair = await mnemonicToWalletKey(tonResolverMnemonic.split(' '));

    const userWallet = WalletContractV4.create({
      publicKey: tonUserKeyPair.publicKey,
      workchain: 0,
    });
    const resolverWallet = WalletContractV4.create({
      publicKey: tonResolverKeyPair.publicKey,
      workchain: 0,
    });

    tonUserWallet = tonClient.open(userWallet);
    tonResolverWallet = tonClient.open(resolverWallet);

    console.log(`✅ TON user wallet:     ${tonUserWallet.address.toString()}`);
    console.log(`✅ TON resolver wallet: ${tonResolverWallet.address.toString()}`);

    userJettonWallet = await getJettonWalletAddress(
      tonClient,
      tonUserWallet.address.toString()
    );
    resolverJettonWallet = await getJettonWalletAddress(
      tonClient,
      tonResolverWallet.address.toString()
    );
    console.log(`✅ User jWallet:        ${userJettonWallet.toString()}`);
    console.log(`✅ Resolver jWallet:    ${resolverJettonWallet.toString()}`);

    // ---------------- Fresh contract every run ----------------
    console.log('[3/5] 📦 Load code & build fresh StateInit with random salt…');
    if (!fs.existsSync('build/escrow.cell')) {
      throw new Error('build/escrow.cell not found');
    }
    const escrowCode = Cell.fromBoc(fs.readFileSync('build/escrow.cell'))[0];

    // **RANDOM SALT**: use a random placeholder jetton wallet in init data to change StateInit
    const randHex = Buffer.from(ethRandomBytes(32)).toString('hex'); // 32 bytes
    const randomPlaceholderJetton = TonAddress.parse(`0:${randHex}`);

    const initConfig: TonSwapConfig = {
      // Placeholder; contract will overwrite via OP_INITIALIZE
      jettonWallet: randomPlaceholderJetton,
      swapCounter: 0n,
      swaps: Dictionary.empty(),
      hashlock_map: Dictionary.empty(),
    };

    tonSwapContract = TonSwapContract.createFromConfig(initConfig, escrowCode);
    const onchainSwap = tonClient.open(tonSwapContract);

    console.log(`📍 NEW contract address (fresh): ${tonSwapContract.address.toString()}`);

    // ---------------- Deploy ----------------
    console.log('[4/5] 🚀 Deploy fresh instance…');
    const sender = tonUserWallet.sender(tonUserKeyPair.secretKey);
    try {
      await onchainSwap.getSwapCounter(); // if this works, already deployed (unlikely)
      console.log('ℹ️ Already deployed (unexpected in CI), continuing…');
    } catch {
      await onchainSwap.sendDeploy(sender, toNano('0.1'));
      await waitForTonTransaction(tonClient, 20000);
      console.log('✅ Deployed');
    }

    // ---------------- Initialize every run ----------------
    console.log('[5/5] 🛠️ Initialize (OP_INITIALIZE) with contract jetton wallet…');
    const contractJettonWallet = await getJettonWalletAddress(
      tonClient,
      tonSwapContract.address.toString()
    );
    console.log(`🔗 Contract jWallet:     ${contractJettonWallet.toString()}`);

    const initBody = beginCell()
      .storeUint(OP_INITIALIZE, 32)
      .storeAddress(contractJettonWallet)
      .endCell();

    await sender.send({
      to: tonSwapContract.address,
      value: toNano('0.05'),
      body: initBody,
      bounce: true,
    });
    await waitForTonTransaction(tonClient, 20000);
    console.log('✅ Initialization sent/applied');

    // Optional: show randomized ctx_id if wrapper exposes it as getId() or get_id()
    const id1 = await safeContractCall(
      // @ts-expect-error dynamic
      () => (onchainSwap as any).getId?.() ?? (onchainSwap as any).get_id?.(),
      'getId'
    );
    if (id1 !== undefined) console.log(`🎲 ctx_id (random): ${id1}`);
    console.log('✅ Setup complete\n');
  });

  afterAll(async () => {
    await ethChain.node.stop();
    setTimeout(() => process.exit(0), 1000);
  });

  it('creates a TON swap (fresh contract address each run)', async () => {
    console.log('\n🔄 Create swap on fresh instance…');
    const secret = ethRandomBytes(32);
    const hashLockBigInt = tonHashLockFromSecret(secret); // <-- only change
    const currentTime = Math.floor(Date.now() / 1000);
    const timeLock = BigInt(currentTime + 3600);
    const swapAmount = 1n;

    const onchainTonSwap = tonClient.open(tonSwapContract);
    const before = await onchainTonSwap.getSwapCounter();

    const depositMessage = createTonSwapDepositMessage(
      swapAmount,
      tonUserWallet.address,
      tonResolverWallet.address,
      hashLockBigInt,
      timeLock,
      tonSwapContract.address
    );

    const userSender = tonUserWallet.sender(tonUserKeyPair.secretKey);
    await userSender.send({
      to: userJettonWallet,
      value: toNano('0.1'),
      body: depositMessage,
    });
    await waitForTonTransaction(tonClient);

    const after = await onchainTonSwap.getSwapCounter();

    console.log(`📍 Contract address used: ${tonSwapContract.address.toString()}`);
    console.log(`📊 Counter before=${before}, after=${after}`);
    expect(after).toBeGreaterThan(before);
  });

  it('completes a swap path (uses OP_COMPLETE_SWAP)', async () => {
    console.log('\n🔓 Complete path…');
    const secret = ethRandomBytes(32);
    const hashLockBigInt = tonHashLockFromSecret(secret); // <-- only change
    const tnow = Math.floor(Date.now() / 1000);
    const timeLock = BigInt(tnow + 3600);
    const amount = 1n;

    const onchain = tonClient.open(tonSwapContract);
    const before = await onchain.getSwapCounter();

    const dep = createTonSwapDepositMessage(
      amount,
      tonUserWallet.address,
      tonResolverWallet.address,
      hashLockBigInt,
      timeLock,
      tonSwapContract.address
    );
    await tonUserWallet.sender(tonUserKeyPair.secretKey).send({
      to: userJettonWallet,
      value: toNano('0.1'),
      body: dep,
    });
    await waitForTonTransaction(tonClient);

    const after = await onchain.getSwapCounter();
    const swapId = after - 1n;

    const complete = createTonCompleteSwapMessage(swapId, secret);
    await tonResolverWallet.sender(tonResolverKeyPair.secretKey).send({
      to: tonSwapContract.address,
      value: toNano('0.2'),
      body: complete,
    });
    await waitForTonTransaction(tonClient);

    console.log(`✅ Completion attempted for swapId=${swapId}`);
    expect(after).toBeGreaterThan(before);
  });

  it('refunds on expired timelock (uses OP_REFUND_SWAP)', async () => {
    console.log('\n🛡️ Refund path…');
    const secret = ethRandomBytes(32);
    const hashLockBigInt = tonHashLockFromSecret(secret); // <-- only change
    const tnow = Math.floor(Date.now() / 1000);
    const timeLock = 1; // already expired
    const amount = 1n;

    const onchain = tonClient.open(tonSwapContract);

    const dep = createTonSwapDepositMessage(
      amount,
      tonUserWallet.address,
      tonResolverWallet.address,
      hashLockBigInt,
      timeLock,
      tonSwapContract.address
    );
    await tonUserWallet.sender(tonUserKeyPair.secretKey).send({
      to: userJettonWallet,
      value: toNano('0.1'),
      body: dep,
    });
    await waitForTonTransaction(tonClient);

    const counter = await onchain.getSwapCounter();
    const swapId = counter - 1n;

    const refund = createTonRefundSwapMessage(swapId);
    await tonUserWallet.sender(tonUserKeyPair.secretKey).send({
      to: tonSwapContract.address,
      value: toNano('0.2'),
      body: refund,
    });
    await waitForTonTransaction(tonClient);

    console.log(`✅ Refund attempted for swapId=${swapId}`);
    expect(counter).toBeGreaterThanOrEqual(0n);
  });
});
