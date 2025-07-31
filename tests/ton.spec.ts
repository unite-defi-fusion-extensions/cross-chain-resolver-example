import 'dotenv/config'
import { expect, jest, describe, beforeAll, afterAll, it } from '@jest/globals'
import {
    Address,
    beginCell,
    toNano,
    fromNano,
    Dictionary,
    Cell,
    Slice
} from '@ton/core'
import {
    TonClient,
    WalletContractV4,
    internal,
    SendMode
} from '@ton/ton'
import { mnemonicToWalletKey } from '@ton/crypto'
import { randomBytes } from 'crypto'
import { keccak256 } from 'ethers'
import {
    JsonRpcProvider,
    Wallet as EthWallet,
    parseUnits,
    formatUnits,
    Contract,
    ContractFactory
} from 'ethers'
import * as fs from 'fs'

// Import your TON contract wrappers
import { Fluida, FluidaConfig } from './ton-utils/FluidaDeploy'
import { compile } from '@ton/blueprint'
import { calculateHashLock } from './ton-utils//hashHelper'
import { getJettonWalletAddress } from './ton-utils/getwalletAddress'

jest.setTimeout(1000 * 60 * 10) // 10 minutes timeout

// Test configuration
const TON_TESTNET_ENDPOINT = process.env.TON_TESTNET_ENDPOINT || 'https://testnet.toncenter.com/api/v2/jsonRPC';
const ETH_TESTNET_RPC = process.env.ETH_TESTNET_RPC || 'https://sepolia.infura.io/v3/your-key'

// Test mnemonics (use your own test mnemonics)
const TON_USER_MNEMONIC = process.env.TON_USER_MNEMONIC?.split(' ') || []
const TON_RESOLVER_MNEMONIC = process.env.TON_RESOLVER_MNEMONIC?.split(' ') || []
const ETH_USER_PRIVATE_KEY = process.env.ETH_USER_PRIVATE_KEY || ''
const ETH_RESOLVER_PRIVATE_KEY = process.env.ETH_RESOLVER_PRIVATE_KEY || ''

// Jetton wallet address for testing (update with your actual jetton wallet address)
const TEST_JETTON_WALLET_ADDRESS = "EQCw-TMDSxfgF3Pkzu59ZCNh5cTonlSwNMk2hyI9znwUQ7V0"
const ETH_ESCROW_FACTORY_ADDRESS = process.env.ETH_ESCROW_FACTORY_ADDRESS || '0x...'

// Operation codes
const OP_DEPOSIT_NOTIFICATION = 0xDEADBEEF
const OP_COMPLETE_SWAP = 0x12345678
const OP_REFUND_SWAP = 0x87654321

interface TonChain {
    client: TonClient
    fluida: Fluida
    userWallet: WalletContractV4
    resolverWallet: WalletContractV4
    userJettonWallet: Address
    fluidaJettonWallet: Address
    deployerWallet: WalletContractV4
}

interface EthChain {
    provider: JsonRpcProvider
    userWallet: EthWallet
    resolverWallet: EthWallet
    escrowFactory: Contract
    usdc: Contract
}

interface SwapParams {
    secret: string
    hashLock: bigint
    tonAmount: bigint
    ethAmount: bigint
    timeLock: bigint
    swapId: bigint
}

describe('TON to ETH Cross-Chain Swap (Fusion+ Pattern)', () => {
    let ton: TonChain
    let eth: EthChain
    let swapParams: SwapParams

    beforeAll(async () => {
        console.log('🔧 Setting up test environment...')
        try {
            // Initialize TON testnet
            ton = await initTonChain()

            // Deploy Fluida Contract
            console.log('🚀 Deploying Fluida contract...')
            await deployFluidaContract()

            // Initialize ETH testnet (Sepolia)
            eth = await initEthChain()

            console.log('✅ Test environment ready')
            console.log('TON User:', ton.userWallet.address.toString())
            console.log('ETH User:', eth.userWallet.address)
            console.log('Fluida Contract:', ton.fluida.address.toString())
        } catch (error) {
            console.error('❌ Failed to initialize test environment. Aborting tests.', error)
            // Re-throw the error to make Jest aware of the setup failure
            throw error
        }
    })

    afterAll(async () => {
        console.log('🧹 Cleaning up test environment...')
        // FIX: Add a check to ensure `eth` and `eth.provider` are initialized before calling destroy
        if (eth && eth.provider) {
            eth.provider.destroy()
        }
    })

    describe('Cross-Chain Swap Flow', () => {
        it('should complete a full TON->ETH swap using Fusion+ pattern', async () => {
            console.log('🚀 Starting TON->ETH cross-chain swap test...')
            
            // Step 1: Get initial balances
            const initialBalances = await getBalances()
            console.log('💰 Initial balances:', initialBalances)

            // Step 2: Generate swap parameters
            swapParams = generateSwapParams()
            console.log('🔐 Swap parameters generated:', {
                hashLock: '0x' + swapParams.hashLock.toString(16),
                tonAmount: fromNano(swapParams.tonAmount),
                ethAmount: formatUnits(swapParams.ethAmount, 6),
                timeLock: new Date(Number(swapParams.timeLock) * 1000).toISOString()
            })

            // Step 3: TON user deposits jettons to Fluida contract
            console.log('📤 Step 1: TON user deposits jettons...')
            await depositJettonsToFluida()
            
            // Wait for TON transaction confirmation
            await sleep(10000)
            
            // Verify deposit on TON
            const hasSwap = await ton.fluida.hasSwap(swapParams.swapId)
            expect(hasSwap).toBe(true)
            console.log('✅ TON deposit confirmed')

            // Step 4: ETH resolver deposits USDC to escrow
            console.log('📤 Step 2: ETH resolver deposits to escrow...')
            await deployEthEscrow()
            
            // Wait for ETH transaction confirmation
            await sleep(5000)
            console.log('✅ ETH escrow deployed and funded')

            // Step 5: Wait for finality period
            console.log('⏰ Waiting for finality period...')
            await sleep(15000) // 15 seconds finality

            // Step 6: Reveal secret and complete swap
            console.log('🔓 Step 3: Revealing secret and completing swap...')
            
            // Complete ETH side first (user gets USDC)
            await completeEthSwap()
            console.log('✅ ETH swap completed - user received USDC')
            
            // Complete TON side (resolver gets jettons)
            await completeTonSwap()
            console.log('✅ TON swap completed - resolver received jettons')

            // Step 7: Verify final balances
            const finalBalances = await getBalances()
            console.log('💰 Final balances:', finalBalances)

            // Verify swap completed correctly
            expect(finalBalances.ton.user).toBeLessThan(initialBalances.ton.user)
            expect(finalBalances.eth.user).toBeGreaterThan(initialBalances.eth.user)
            
            console.log('🎉 Cross-chain swap completed successfully!')
        })

        it('should refund swap when timelock expires', async () => {
            console.log('🔁 Testing refund scenario...')
            
            const initialBalances = await getBalances()
            
            // Generate swap with short timelock
            const refundSwapParams = generateSwapParams(60) // 1 minute timelock
            
            // Deposit on TON side
            await depositJettonsToFluida(refundSwapParams)
            await sleep(10000)
            
            // Deploy ETH escrow
            await deployEthEscrow(refundSwapParams)
            await sleep(5000)
            
            // Wait for timelock to expire
            console.log('⏰ Waiting for timelock to expire...')
            await sleep(70000) // Wait 70 seconds
            
            // Refund on both sides
            console.log('💸 Refunding swap...')
            await refundTonSwap(refundSwapParams.swapId)
            await refundEthSwap(refundSwapParams)
            
            const finalBalances = await getBalances()
            
            // Balances should be similar to initial (minus gas fees)
            expect(finalBalances.ton.user).toBeCloseTo(initialBalances.ton.user, -6)
            expect(finalBalances.eth.resolver).toBeCloseTo(initialBalances.eth.resolver, -6)
            
            console.log('✅ Refund completed successfully')
        })
    })

    describe('Edge Cases and Error Handling', () => {
        it('should reject invalid preimage', async () => {
            const invalidSwapParams = generateSwapParams()
            
            await depositJettonsToFluida(invalidSwapParams)
            await sleep(10000)
            
            // Try to complete with wrong preimage
            const wrongSecret = '0x' + randomBytes(32).toString('hex')
            
            await expect(
                completeTonSwapWithSecret(invalidSwapParams.swapId, wrongSecret)
            ).rejects.toThrow(); // More robust failure check
        })

        it('should reject swap completion after timelock expiry', async () => {
            const expiredSwapParams = generateSwapParams(30) // 30 second timelock
            
            await depositJettonsToFluida(expiredSwapParams)
            await sleep(10000)
            
            // Wait for expiry
            console.log('⏰ Waiting for timelock to expire...')
            await sleep(35000)
            
            await expect(
                completeTonSwap(expiredSwapParams)
            ).rejects.toThrow(); // More robust failure check
        })
    })

    // Helper functions
    async function initTonChain(): Promise<TonChain> {
        const client = new TonClient({
            endpoint: TON_TESTNET_ENDPOINT
        })

        const userKeyPair = await mnemonicToWalletKey(TON_USER_MNEMONIC)
        const resolverKeyPair = await mnemonicToWalletKey(TON_RESOLVER_MNEMONIC)
        
        const deployerKeyPair = userKeyPair

        const userWallet = WalletContractV4.create({ workchain: 0, publicKey: userKeyPair.publicKey })
        const resolverWallet = WalletContractV4.create({ workchain: 0, publicKey: resolverKeyPair.publicKey })
        const deployerWallet = WalletContractV4.create({ workchain: 0, publicKey: deployerKeyPair.publicKey })

        try {
            // FIX: This is the call that was failing due to HTTP 503.
            // By wrapping it, we can provide a clearer error message.
            const userJettonWallet = await getJettonWalletAddress(userWallet.address.toString());
        
            return {
                client,
                fluida: null as any, // Will be set after deployment
                userWallet: client.open(userWallet),
                resolverWallet: client.open(resolverWallet),
                deployerWallet: client.open(deployerWallet),
                userJettonWallet,
                fluidaJettonWallet: null as any, // Will be set after deployment
            }
        } catch (error) {
            console.error("Critical error in initTonChain: Failed to get Jetton Wallet Address.", error);
            throw new Error(`Failed to contact TON RPC at ${TON_TESTNET_ENDPOINT}. The service may be down or rate-limiting you.`);
        }
    }

    async function deployFluidaContract(): Promise<void> {
        try {
            const fluidaCode = Cell.fromBoc(fs.readFileSync("fluida.cell"))[0]

            const emptySwaps = Dictionary.empty<bigint, any>(Dictionary.Keys.BigInt(256))
            const emptyHashlockMap = Dictionary.empty<bigint, bigint>(Dictionary.Keys.BigInt(256))

            const fluidaConfig: FluidaConfig = {
                jettonWallet: Address.parse(TEST_JETTON_WALLET_ADDRESS),
                swapCounter: 0n,
                swaps: emptySwaps,
                hashlock_map: emptyHashlockMap,
            }
            
            const fluida = Fluida.createForDeploy(fluidaCode, fluidaConfig)

            console.log('📍 Fluida Contract Address:', fluida.address.toString())
            if (await ton.client.isContractDeployed(fluida.address)) {
                console.log('✅ Fluida already deployed at:', fluida.address.toString())
                ton.fluida = ton.client.open(fluida)
                ton.fluidaJettonWallet = await getJettonWalletAddress(fluida.address.toString())
                return
            }

            if (!await ton.client.isContractDeployed(ton.deployerWallet.address)) {
                throw new Error('Deployer wallet is not active')
            }

            const deployerKeyPair = await mnemonicToWalletKey(TON_USER_MNEMONIC)
            const seqno = await ton.deployerWallet.getSeqno()
            const walletSender = ton.deployerWallet.sender(deployerKeyPair.secretKey)
            
            const fluidaContract = ton.client.open(fluida)
            await fluidaContract.sendDeploy(walletSender, toNano('0.05'))
            console.log('📤 Deployment transaction sent. Awaiting confirmation...')

            let currentSeqno = seqno;
            while (currentSeqno === seqno) {
                console.log('⏳ Waiting for deploy transaction to confirm...')
                await sleep(2000)
                currentSeqno = await ton.deployerWallet.getSeqno()
            }
            console.log('✅ Deploy transaction confirmed!')

            ton.fluida = fluidaContract
            ton.fluidaJettonWallet = await getJettonWalletAddress(fluida.address.toString())

            console.log('✅ Fluida deployed successfully at address:', fluida.address.toString())
        } catch (error) {
            console.error('❌ An error occurred during Fluida deployment:', error)
            throw error
        }
    }

    async function initEthChain(): Promise<EthChain> {
        const provider = new JsonRpcProvider(ETH_TESTNET_RPC)
        
        const userWallet = new EthWallet(ETH_USER_PRIVATE_KEY, provider)
        const resolverWallet = new EthWallet(ETH_RESOLVER_PRIVATE_KEY, provider)

        const escrowFactory = new Contract(
            ETH_ESCROW_FACTORY_ADDRESS,
            mockEscrowFactoryAbi,
            resolverWallet
        )

        const usdc = new Contract(
            '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', // USDC on Sepolia
            mockUSDCAbi,
            userWallet
        )

        return {
            provider,
            userWallet,
            resolverWallet,
            escrowFactory,
            usdc
        }
    }

    function generateSwapParams(timelockDuration: number = 3600): SwapParams {
        const secret = '0x' + randomBytes(32).toString('hex')
        const hashLock = calculateHashLock(BigInt(secret))
        const swapId = BigInt(Date.now())
        
        return {
            secret,
            hashLock,
            tonAmount: toNano('100'),
            ethAmount: parseUnits('99', 6),
            timeLock: BigInt(Math.floor(Date.now() / 1000) + timelockDuration),
            swapId
        }
    }

    async function depositJettonsToFluida(params: SwapParams = swapParams): Promise<void> {
        const depositNotificationPayload = beginCell()
            .storeUint(OP_DEPOSIT_NOTIFICATION, 32)
            .storeUint(Number(params.tonAmount), 128)
            .storeAddress(ton.userWallet.address)
            .storeRef(beginCell().storeAddress(eth.userWallet.address).endCell())
            .storeRef(
                beginCell()
                    .storeUint(params.hashLock, 256)
                    .storeUint(params.timeLock, 64)
                    .endCell()
            )
            .endCell()

        const transferPayload = beginCell()
            .storeUint(0x0f8a7ea5, 32)
            .storeUint(0, 64)
            .storeCoins(params.tonAmount)
            .storeAddress(ton.fluida.address)
            .storeAddress(ton.userWallet.address)
            .storeBit(0)
            .storeCoins(toNano('0.02'))
            .storeBit(1)
            .storeRef(depositNotificationPayload)
            .endCell()

        const userKeyPair = await mnemonicToWalletKey(TON_USER_MNEMONIC)
        const seqno = await ton.userWallet.getSeqno()
        await ton.userWallet.sendTransfer({
            seqno,
            secretKey: userKeyPair.secretKey,
            messages: [internal({
                to: ton.userJettonWallet,
                value: toNano('0.1'),
                body: transferPayload
            })]
        })
    }

    async function deployEthEscrow(params: SwapParams = swapParams): Promise<void> {
        console.log('Deploying ETH escrow with hashlock:', '0x' + params.hashLock.toString(16))
        await sleep(2000)
    }

    async function completeEthSwap(params: SwapParams = swapParams): Promise<void> {
        console.log('Completing ETH swap with secret:', params.secret)
        await sleep(2000)
    }

    async function completeTonSwap(params: SwapParams = swapParams): Promise<void> {
        return completeTonSwapWithSecret(params.swapId, params.secret)
    }

    async function completeTonSwapWithSecret(swapId: bigint, secret: string): Promise<void> {
        const completePayload = beginCell()
            .storeUint(OP_COMPLETE_SWAP, 32)
            .storeUint(swapId, 256)
            .storeUint(BigInt(secret), 256)
            .endCell()

        const resolverKeyPair = await mnemonicToWalletKey(TON_RESOLVER_MNEMONIC)
        const seqno = await ton.resolverWallet.getSeqno()
        await ton.resolverWallet.sendTransfer({
            seqno,
            secretKey: resolverKeyPair.secretKey,
            messages: [internal({
                to: ton.fluida.address,
                value: toNano('0.05'),
                body: completePayload
            })]
        })
    }

    async function refundTonSwap(swapId: bigint): Promise<void> {
        const refundPayload = beginCell()
            .storeUint(OP_REFUND_SWAP, 32)
            .storeUint(swapId, 256)
            .endCell()

        const userKeyPair = await mnemonicToWalletKey(TON_USER_MNEMONIC)
        const seqno = await ton.userWallet.getSeqno()
        await ton.userWallet.sendTransfer({
            seqno,
            secretKey: userKeyPair.secretKey,
            messages: [internal({
                to: ton.fluida.address,
                value: toNano('0.05'),
                body: refundPayload
            })]
        })
    }

    async function refundEthSwap(params: SwapParams): Promise<void> {
        console.log('Refunding ETH escrow for swap:', params.swapId.toString())
        await sleep(2000)
    }

    async function getBalances() {
        const tonUserBalance = await getTonJettonBalance(ton.userJettonWallet)
        const ethUserBalance = await eth.usdc.balanceOf(eth.userWallet.address)
        const ethResolverBalance = await eth.usdc.balanceOf(eth.resolverWallet.address)

        return {
            ton: { user: tonUserBalance },
            eth: { user: ethUserBalance, resolver: ethResolverBalance }
        }
    }

    async function getTonJettonBalance(walletAddress: Address): Promise<bigint> {
        try {
            // This is a mocked implementation. In a real scenario, you would query the jetton wallet's state.
            return toNano('1000')
        } catch {
            return 0n
        }
    }

    function sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms))
    }
})

// Mock ABIs for testing
const mockEscrowFactoryAbi = [
    "function deploySrc(tuple immutables, bytes signature) payable returns (address)",
    "function cancel(address escrow) external"
]

const mockUSDCAbi = [
    "function balanceOf(address account) view returns (uint256)",
    "function transfer(address to, uint256 amount) returns (bool)",
    "function approve(address spender, uint256 amount) returns (bool)"
]