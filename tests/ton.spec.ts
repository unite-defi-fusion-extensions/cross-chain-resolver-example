// tests/ton.spec.ts
import 'dotenv/config'
import {beforeAll, describe, it, expect, jest} from '@jest/globals'
import {getHttpEndpoint} from '@orbs-network/ton-access'
import {mnemonicToWalletKey} from '@ton/crypto'
import {Address, Cell, TonClient, WalletContractV4, toNano, beginCell, Dictionary} from '@ton/ton'
import {keccak256} from 'ethers'
import * as fs from 'fs'
import {randomBytes} from 'crypto'

import {Escrow, EscrowConfig} from './ton-utils/EscrowDeploy'
import {getJettonWalletAddress} from './ton-utils/getwalletAddress'

jest.setTimeout(120 * 1000)

describe('Escrow Contract Interaction (Fusion+)', () => {
    let client: TonClient
    let walletContract: WalletContractV4
    let keyPair: {publicKey: Buffer; secretKey: Buffer}
    let userAddress: Address
    let escrowContract: Escrow

    beforeAll(async () => {
        console.log('\n--- Starting Escrow Contract Deployment & Setup ---')

        const endpoint = await getHttpEndpoint({network: 'testnet'})
        client = new TonClient({endpoint})
        const mnemonic = process.env.TON_USER_MNEMONIC

        if (!mnemonic) throw new Error('TON_USER_MNEMONIC not set in .env')

        keyPair = await mnemonicToWalletKey(mnemonic.split(' '))
        const wallet = WalletContractV4.create({publicKey: keyPair.publicKey, workchain: 0})
        walletContract = client.open(wallet)
        userAddress = walletContract.address
        console.log(`✅ Wallet loaded: ${userAddress.toString()}`)

        console.log("Loading contract code from 'build/escrow.cell'...")

        if (!fs.existsSync('build/escrow.cell')) throw new Error('build/escrow.cell not found.')

        const escrowCode = Cell.fromBoc(fs.readFileSync('build/escrow.cell'))[0]
        console.log('✅ Contract code loaded.')

        const config: EscrowConfig = {
            jettonWallet: Address.parse('kQDoy1cUAbGq253vwfoPcqSloODVAWkDBniR12PJFUHnK6Yf'),
            swapCounter: 0n,
            swaps: Dictionary.empty(),
            hashlock_map: Dictionary.empty()
        }
        escrowContract = Escrow.createFromConfig(config, escrowCode)
        console.log(`📍 Calculated contract address: ${escrowContract.address.toString()}`)

        const onchain = client.open(escrowContract)
        try {
            await onchain.getSwapCounter()
            console.log('✅ Contract is already deployed and state is readable.')
        } catch (e) {
            console.log('🚀 Contract not deployed or state not readable. Deploying now...')
            const sender = walletContract.sender(keyPair.secretKey)
            await onchain.sendDeploy(sender, toNano('0.1'))
            console.log('⏳ Waiting for deployment to be confirmed...')
            await new Promise((resolve) => setTimeout(resolve, 20000))
        }
        console.log('--- Setup Complete ---')
    })

    it('should have a valid initial state', async () => {
        console.log('\n--- Running Test: Verifying initial state ---')
        const onchain = client.open(escrowContract)
        const swapCounter = await onchain.getSwapCounter()
        expect(swapCounter).toBeGreaterThanOrEqual(0n)
        console.log(`✅ Test Passed: Initial swap_counter is ${swapCounter}.`)
    })

    it('should accept a jetton deposit and create a new swap entry', async () => {
        console.log('\n--- Running Test: Depositing jettons to create a swap ---')

        const onchain = client.open(escrowContract)
        const initialSwapCounter = await onchain.getSwapCounter()
        console.log(`[DEBUG] Initial swap counter: ${initialSwapCounter}`)

        const userJettonWalletAddress = await getJettonWalletAddress(client, userAddress.toString())
        console.log(`[DEBUG] User's jUSDT wallet: ${userJettonWalletAddress.toString()}`)

        const secret = randomBytes(32)
        const hash = BigInt(keccak256(secret))
        const timeLock = BigInt(Math.floor(Date.now() / 1000) + 3600)
        const depositAmount = 1n // 1 minimal unit

        const OP_DEPOSIT_NOTIFICATION = 0xdeadbeefn
        const recipientRef = beginCell().storeAddress(userAddress).endCell()
        const locksRef = beginCell().storeUint(hash, 256).storeUint(timeLock, 64).endCell()

        const depositPayload = beginCell()
            .storeUint(OP_DEPOSIT_NOTIFICATION, 32)
            .storeUint(depositAmount, 128)
            .storeAddress(userAddress)
            .storeRef(recipientRef)
            .storeRef(locksRef)
            .endCell()

        const transferMessage = beginCell()
            .storeUint(0x0f8a7ea5, 32)
            .storeUint(0n, 64)
            .storeCoins(depositAmount)
            .storeAddress(escrowContract.address)
            .storeAddress(userAddress)
            .storeBit(0)
            .storeCoins(toNano('0.05'))
            .storeBit(1)
            .storeRef(depositPayload)
            .endCell()

        console.log('📤 Sending jetton transfer to initiate swap...')
        const sender = walletContract.sender(keyPair.secretKey)
        await sender.send({to: userJettonWalletAddress, value: toNano('0.1'), body: transferMessage})

        console.log('⏳ Waiting 30 seconds for the swap to be processed...')
        await new Promise((resolve) => setTimeout(resolve, 30000))

        const finalSwapCounter = await onchain.getSwapCounter()
        console.log(`[DEBUG] Final swap counter: ${finalSwapCounter}`)

        const createdSwapId = initialSwapCounter
        console.log(`[DEBUG] Checking for swap with ID: ${createdSwapId}`)

        // ** THE FIX: Use the getter pattern method name **
        const swapExists = await onchain.getHasSwap(createdSwapId)

        expect(finalSwapCounter).toBe(initialSwapCounter + 1n)
        expect(swapExists).toBe(true)
        console.log(`✅ Test Passed: Swap with ID ${createdSwapId} was successfully created!`)
    })
})
