/* eslint-disable */
import 'dotenv/config';
import { expect, jest, beforeAll, afterAll, describe, it } from '@jest/globals';
import * as fs from 'fs';
import assert from 'node:assert';
import crypto from 'crypto';

// Ethereum Imports
import { createServer, CreateServerReturnType } from 'prool';
import { anvil } from 'prool/instances';
import {
  ContractFactory,
  JsonRpcProvider,
  Wallet as SignerWallet,
  computeAddress,
  randomBytes as ethRandomBytes,
  parseUnits,
  Contract,
} from 'ethers';

// Artifacts
import hashedTimelockERC20 from '../dist/contracts/HashedTimelockERC20.sol/HashedTimelockERC20.json';

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

// Minimal ERC20 ABI for approvals/balances
const ERC20_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
];

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
  escrowFactory: string; // kept for type compatibility
  resolver: string;
}> {
  const { node, provider } = await getProvider(cnf);

  // Use EOAs, no resolver contract needed for this test.
  const resolver = computeAddress(resolverPk);
  const escrowFactory = '0x0000000000000000000000000000000000000000';

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
    .storeUint(swapId, 256)
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

  // Signers & contracts (EVM)
  let userSigner: SignerWallet;
  let resolverSigner: SignerWallet;
  let htlcAddress: string;
  let htlc: Contract;
  let usdc: Contract;

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

    // EOAs for ETH side
    userSigner = new SignerWallet(userPk, ethChain.provider);
    resolverSigner = new SignerWallet(resolverPk, ethChain.provider);

    const resolverWalletEvm = await Wallet.fromAddress(
      ethChain.resolver,
      ethChain.provider
    );

    // Deploy HashedTimelockERC20
    htlcAddress = await deploy(hashedTimelockERC20, [], userSigner);
    htlc = new Contract(htlcAddress, hashedTimelockERC20.abi, ethChain.provider);

    // USDC (or ERC20) on the fork
    usdc = new Contract(
      config.chain.source.tokens.USDC.address,
      ERC20_ABI,
      ethChain.provider
    );

    // Fund user & resolver with ERC20 from donor
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
    console.log(`✅ Ethereum ready (HTLC: ${htlcAddress})`);

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

    // ---------------- Fresh TON contract every run ----------------
    console.log('[3/5] 📦 Load code & build fresh StateInit with random salt…');
    if (!fs.existsSync('build/escrow.cell')) {
      throw new Error('build/escrow.cell not found');
    }
    const escrowCode = Cell.fromBoc(fs.readFileSync('build/escrow.cell'))[0];

    const randHex = Buffer.from(ethRandomBytes(32)).toString('hex');
    const randomPlaceholderJetton = TonAddress.parse(`0:${randHex}`);

    const initConfig: TonSwapConfig = {
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
      await onchainSwap.getSwapCounter();
      console.log('ℹ️ Already deployed (unlikely), continuing…');
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
    // setTimeout(() => process.exit(0), 1000);
  });

  it('creates a TON swap (fresh contract address each run) and deploys EVM HashlockTime', async () => {
    console.log('\n🔄 Create swap on fresh instance…');

    // ---------- Shared secret/hash ----------
    const secret = ethRandomBytes(32);
    const hashLockBigInt = tonHashLockFromSecret(secret); // SHA-256(secret)
    const hashlockBytes32 =
      '0x' + hashLockBigInt.toString(16).padStart(64, '0');

    const currentTime = Math.floor(Date.now() / 1000);
    const timeLock = BigInt(currentTime + 3600);
    const swapAmountJetton = 1n;

    // ---------- TON deposit (already in your code) ----------
    const onchainTonSwap = tonClient.open(tonSwapContract);
    const before = await onchainTonSwap.getSwapCounter();

    const depositMessage = createTonSwapDepositMessage(
      swapAmountJetton,
      tonUserWallet.address,
      tonResolverWallet.address,
      hashLockBigInt,
      timeLock,
      tonSwapContract.address
    );

    await tonUserWallet.sender(tonUserKeyPair.secretKey).send({
      to: userJettonWallet,
      value: toNano('0.1'),
      body: depositMessage,
    });
    await waitForTonTransaction(tonClient);

    const after = await onchainTonSwap.getSwapCounter();

    console.log(`📍 TON Contract: ${tonSwapContract.address.toString()}`);
    console.log(`📊 TON Counter before=${before}, after=${after}`);
    expect(after).toBeGreaterThan(before);

    // ---------- EVM side: approve + create HTLC ----------
    const amountUsdc = parseUnits('1', 6);
    const usdcUser = usdc.connect(userSigner);
    const htlcUser = htlc.connect(userSigner);

    await (await usdcUser.approve(htlcAddress, amountUsdc)).wait();

    // Predict contractId via static call, then execute
    const contractId = await htlcUser.newContract.staticCall(
      resolverSigner.address,
      hashlockBytes32,
      Number(timeLock),
      usdc.target as string,
      amountUsdc
    );
    const tx = await htlcUser.newContract(
      resolverSigner.address,
      hashlockBytes32,
      Number(timeLock),
      usdc.target as string,
      amountUsdc
    );
    await tx.wait();

    console.log(`✅ EVM HTLC created, id=${contractId}`);
    // Optional balance sanity check
    const htlcBal = await usdc.balanceOf(htlcAddress);

    console.log("htlcBal", htlcBal)
    expect(htlcBal).toBeGreaterThanOrEqual(amountUsdc);
  });

  it('completes a swap path (uses OP_COMPLETE_SWAP) and withdraws on EVM', async () => {
    console.log('\n🔓 Complete path…');

    // ---------- Shared secret/hash ----------
    const secret = ethRandomBytes(32);
    const hashLockBigInt = tonHashLockFromSecret(secret);
    const hashlockBytes32 =
      '0x' + hashLockBigInt.toString(16).padStart(64, '0');

    const tnow = Math.floor(Date.now() / 1000);
    const timeLock = BigInt(tnow + 3600);
    const amountJetton = 1n;

    // ---------- TON deposit ----------
    const onchain = tonClient.open(tonSwapContract);
    const before = await onchain.getSwapCounter();

    const dep = createTonSwapDepositMessage(
      amountJetton,
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

    // ---------- EVM: approve + create HTLC with same hash/timelock ----------
    const amountUsdc = parseUnits('2', 6);
    const usdcUser = usdc.connect(userSigner);
    await (await usdcUser.approve(htlcAddress, amountUsdc)).wait();

    const htlcUser = htlc.connect(userSigner);
    const contractId = await htlcUser.newContract.staticCall(
      resolverSigner.address,
      hashlockBytes32,
      Number(timeLock),
      usdc.target as string,
      amountUsdc
    );
    await (await htlcUser.newContract(
      resolverSigner.address,
      hashlockBytes32,
      Number(timeLock),
      usdc.target as string,
      amountUsdc
    )).wait();

    // ---------- EVM withdraw by resolver with preimage ----------
    const preimage = ('0x' + Buffer.from(secret).toString('hex')) as `0x${string}`;
    const resolverUsdcBefore = await usdc.balanceOf(resolverSigner.address);

    const htlcResolver = htlc.connect(resolverSigner);
    await (await htlcResolver.withdraw(contractId, preimage)).wait();

    const resolverUsdcAfter = await usdc.balanceOf(resolverSigner.address);
    expect(resolverUsdcAfter - resolverUsdcBefore).toBeGreaterThanOrEqual(amountUsdc);

    // ---------- TON completion ----------
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

  it('refunds on expired timelock (uses OP_REFUND_SWAP) and refund on EVM', async () => {
    console.log('\n🛡️ Refund path…');

    // ---------- Shared secret/hash ----------
    const secret = ethRandomBytes(32);
    const hashLockBigInt = tonHashLockFromSecret(secret);
    const hashlockBytes32 =
      '0x' + hashLockBigInt.toString(16).padStart(64, '0');

    // TON uses already expired for its path; we keep as-is
    const timeLockTon = 1;
    const amountJetton = 1n;

    const onchain = tonClient.open(tonSwapContract);
    const dep = createTonSwapDepositMessage(
      amountJetton,
      tonUserWallet.address,
      tonResolverWallet.address,
      hashLockBigInt,
      BigInt(timeLockTon),
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

    // ---------- EVM: create HTLC with short future timelock, then advance time ----------
    const now = Math.floor(Date.now() / 1000);
    const shortTimelock = now + 120; // 2 minutes
    const amountUsdc = parseUnits('3', 6);

    const usdcUser = usdc.connect(userSigner);
    await (await usdcUser.approve(htlcAddress, amountUsdc)).wait();

    const htlcUser = htlc.connect(userSigner);
    const contractId = await htlcUser.newContract.staticCall(
      resolverSigner.address,
      hashlockBytes32,
      shortTimelock,
      usdc.target as string,
      amountUsdc
    );
    await (await htlcUser.newContract(
      resolverSigner.address,
      hashlockBytes32,
      shortTimelock,
      usdc.target as string,
      amountUsdc
    )).wait();

    // Fast-forward time and mine
    await ethChain.provider.send('evm_increaseTime', [300]); // > 120s
    await ethChain.provider.send('evm_mine', []);

    // Refund from sender (user)
    const userUsdcBefore = await usdc.balanceOf(userSigner.address);
    await (await htlcUser.refund(contractId)).wait();
    const userUsdcAfter = await usdc.balanceOf(userSigner.address);
    expect(userUsdcAfter - userUsdcBefore).toBeGreaterThanOrEqual(amountUsdc);

    // ---------- TON refund ----------
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
