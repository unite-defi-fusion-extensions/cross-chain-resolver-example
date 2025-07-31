import {Blockchain, SandboxContract, TreasuryContract} from '@ton/sandbox'
import {Cell, toNano, beginCell, Address, Dictionary} from '@ton/core'
import {Fluida, FluidaConfig} from '../wrappers/FluidaDeploy'
import '@ton/test-utils'
import {compile} from '@ton/blueprint'
import {calculateHashLock} from '../scripts/utils/hashHelper'
import {randomBytes} from 'crypto'

describe('Fluida Contract Tests', () => {
    let code: Cell
    let blockchain: Blockchain
    let deployer: SandboxContract<TreasuryContract>
    let user1: SandboxContract<TreasuryContract>
    let user2: SandboxContract<TreasuryContract>
    let fluida: SandboxContract<Fluida>
    let jettonWalletAddress: Address

    beforeAll(async () => {
        code = await compile('Fluida')
    })

    beforeEach(async () => {
        blockchain = await Blockchain.create()
        deployer = await blockchain.treasury('deployer')
        user1 = await blockchain.treasury('user1')
        user2 = await blockchain.treasury('user2')

        // Mock jetton wallet address for testing
        jettonWalletAddress = Address.parse('EQCw-TMDSxfgF3Pkzu59ZCNh5cTonlSwNMk2hyI9znwUQ7V0')

        // Initialize empty dictionaries
        const emptySwaps = Dictionary.empty<
            bigint,
            {
                initiator: Address
                recipient: Address
                amount: bigint
                hashLock: bigint
                timeLock: bigint
                isCompleted: boolean
            }
        >(Dictionary.Keys.BigInt(256))
        const emptyHashlockMap = Dictionary.empty<bigint, bigint>(Dictionary.Keys.BigInt(256))

        const fluidaConfig: FluidaConfig = {
            jettonWallet: jettonWalletAddress,
            swapCounter: 0n,
            swaps: emptySwaps,
            hashlock_map: emptyHashlockMap
        }

        fluida = blockchain.openContract(Fluida.createFromConfig(fluidaConfig, code))

        const deployResult = await fluida.sendDeploy(deployer.getSender(), toNano('0.05'))
        expect(deployResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: fluida.address,
            deploy: true,
            success: true
        })
    })

    describe('Deployment', () => {
        it('should deploy successfully', async () => {
            // Contract should be deployed and accessible
            expect(fluida.address).toBeDefined()
        })

        it('should initialize with correct jetton wallet', async () => {
            const storedJettonWallet = await fluida.getJettonWallet()
            expect(storedJettonWallet.toString()).toBe(jettonWalletAddress.toString())
        })

        it('should initialize with zero swap counter', async () => {
            const swapCounter = await fluida.getSwapCounter()
            expect(swapCounter).toBe(0n)
        })
    })

    describe('Deposit Notification (Swap Creation)', () => {
        let preimage: bigint
        let hashLock: bigint
        let timeLock: bigint
        let depositAmount: bigint

        beforeEach(() => {
            preimage = BigInt('0x' + randomBytes(32).toString('hex'))
            hashLock = calculateHashLock(preimage)
            timeLock = BigInt(Math.floor(Date.now() / 1000) + 3600) // 1 hour from now
            depositAmount = 1000000n // 1 TGBTC in minimal units
        })

        it('should create a new swap on deposit notification', async () => {
            const OP_DEPOSIT_NOTIFICATION = 0xdeadbeefn

            // Build extra cell with hashLock and timeLock
            const extraCell = beginCell().storeUint(hashLock, 256).storeUint(timeLock, 64).endCell()

            // Build deposit notification payload
            const depositNotificationPayload = beginCell()
                .storeUint(OP_DEPOSIT_NOTIFICATION, 32)
                .storeUint(depositAmount, 128)
                .storeAddress(user1.address) // initiator
                .storeRef(
                    beginCell()
                        .storeAddress(jettonWalletAddress) // jetton wallet of fluida contract
                        .endCell()
                )
                .storeRef(extraCell)
                .endCell()

            // Simulate jetton transfer with deposit notification
            const result = await fluida.sendDepositNotification(deployer.getSender(), {
                value: toNano('0.1'),
                body: depositNotificationPayload
            })

            expect(result.transactions).toHaveTransaction({
                from: deployer.address,
                to: fluida.address,
                success: true
            })

            // Check that swap counter increased
            const newSwapCounter = await fluida.getSwapCounter()
            expect(newSwapCounter).toBe(1n)

            // Check that swap was created correctly
            const swap = await fluida.getSwap(0n)
            expect(swap.initiator.toString()).toBe(user1.address.toString())
            expect(swap.amount).toBe(depositAmount)
            expect(swap.hashLock).toBe(hashLock)
            expect(swap.timeLock).toBe(timeLock)
            expect(swap.isCompleted).toBe(false)
        })

        it('should reject deposit notification with invalid op code', async () => {
            const INVALID_OP = 0x12345678n

            const extraCell = beginCell().storeUint(hashLock, 256).storeUint(timeLock, 64).endCell()

            const invalidPayload = beginCell()
                .storeUint(INVALID_OP, 32)
                .storeUint(depositAmount, 128)
                .storeAddress(user1.address)
                .storeRef(beginCell().storeAddress(jettonWalletAddress).endCell())
                .storeRef(extraCell)
                .endCell()

            const result = await fluida.sendDepositNotification(deployer.getSender(), {
                value: toNano('0.1'),
                body: invalidPayload
            })

            // Should fail with invalid op code
            expect(result.transactions).toHaveTransaction({
                from: deployer.address,
                to: fluida.address,
                success: false
            })
        })
    })

    describe('Complete Swap', () => {
        let preimage: bigint
        let hashLock: bigint
        let timeLock: bigint
        let depositAmount: bigint
        let swapId: bigint

        beforeEach(async () => {
            preimage = BigInt('0x' + randomBytes(32).toString('hex'))
            hashLock = calculateHashLock(preimage)
            timeLock = BigInt(Math.floor(Date.now() / 1000) + 3600) // 1 hour from now
            depositAmount = 1000000n
            swapId = 0n

            // Create a swap first
            const OP_DEPOSIT_NOTIFICATION = 0xdeadbeefn
            const extraCell = beginCell().storeUint(hashLock, 256).storeUint(timeLock, 64).endCell()

            const depositNotificationPayload = beginCell()
                .storeUint(OP_DEPOSIT_NOTIFICATION, 32)
                .storeUint(depositAmount, 128)
                .storeAddress(user1.address)
                .storeRef(beginCell().storeAddress(jettonWalletAddress).endCell())
                .storeRef(extraCell)
                .endCell()

            await fluida.sendDepositNotification(deployer.getSender(), {
                value: toNano('0.1'),
                body: depositNotificationPayload
            })
        })

        it('should complete swap with correct preimage', async () => {
            const result = await fluida.sendCompleteSwap(user2.getSender(), {
                swapId,
                preimage,
                value: toNano('0.2')
            })

            expect(result.transactions).toHaveTransaction({
                from: user2.address,
                to: fluida.address,
                success: true
            })

            // Check that swap is marked as completed
            const completedSwap = await fluida.getSwap(swapId)
            expect(completedSwap.isCompleted).toBe(true)
        })

        it('should reject completion with wrong preimage', async () => {
            const wrongPreimage = BigInt('0x' + randomBytes(32).toString('hex'))

            const result = await fluida.sendCompleteSwap(user2.getSender(), {
                swapId,
                preimage: wrongPreimage,
                value: toNano('0.2')
            })

            expect(result.transactions).toHaveTransaction({
                from: user2.address,
                to: fluida.address,
                success: false
            })

            // Swap should remain incomplete
            const swap = await fluida.getSwap(swapId)
            expect(swap.isCompleted).toBe(false)
        })

        it('should reject completion of already completed swap', async () => {
            // Complete the swap first
            await fluida.sendCompleteSwap(user2.getSender(), {
                swapId,
                preimage,
                value: toNano('0.2')
            })

            // Try to complete again
            const result = await fluida.sendCompleteSwap(user2.getSender(), {
                swapId,
                preimage,
                value: toNano('0.2')
            })

            expect(result.transactions).toHaveTransaction({
                from: user2.address,
                to: fluida.address,
                success: false
            })
        })

        it('should reject completion of non-existent swap', async () => {
            const nonExistentSwapId = 999n

            const result = await fluida.sendCompleteSwap(user2.getSender(), {
                swapId: nonExistentSwapId,
                preimage,
                value: toNano('0.2')
            })

            expect(result.transactions).toHaveTransaction({
                from: user2.address,
                to: fluida.address,
                success: false
            })
        })
    })

    describe('Refund Swap', () => {
        let preimage: bigint
        let hashLock: bigint
        let timeLock: bigint
        let depositAmount: bigint
        let swapId: bigint

        beforeEach(async () => {
            preimage = BigInt('0x' + randomBytes(32).toString('hex'))
            hashLock = calculateHashLock(preimage)
            timeLock = BigInt(Math.floor(Date.now() / 1000) + 1) // 1 second from now (will expire quickly)
            depositAmount = 1000000n
            swapId = 0n

            // Create a swap first
            const OP_DEPOSIT_NOTIFICATION = 0xdeadbeefn
            const extraCell = beginCell().storeUint(hashLock, 256).storeUint(timeLock, 64).endCell()

            const depositNotificationPayload = beginCell()
                .storeUint(OP_DEPOSIT_NOTIFICATION, 32)
                .storeUint(depositAmount, 128)
                .storeAddress(user1.address)
                .storeRef(beginCell().storeAddress(jettonWalletAddress).endCell())
                .storeRef(extraCell)
                .endCell()

            await fluida.sendDepositNotification(deployer.getSender(), {
                value: toNano('0.1'),
                body: depositNotificationPayload
            })
        })

        it('should allow refund after timelock expires', async () => {
            // Wait for timelock to expire (simulate time passage)
            // In a real test, you might need to advance blockchain time

            const result = await fluida.sendRefundSwap(user1.getSender(), {
                swapId,
                value: toNano('0.2')
            })

            // Note: This test might need adjustment based on how your contract handles time
            // You may need to mock the current time or use blockchain time manipulation
        })

        it('should reject refund before timelock expires', async () => {
            // Try to refund immediately (before timelock expires)
            const result = await fluida.sendRefundSwap(user1.getSender(), {
                swapId,
                value: toNano('0.2')
            })

            expect(result.transactions).toHaveTransaction({
                from: user1.address,
                to: fluida.address,
                success: false
            })
        })

        it('should reject refund from non-initiator', async () => {
            const result = await fluida.sendRefundSwap(user2.getSender(), {
                swapId,
                value: toNano('0.2')
            })

            expect(result.transactions).toHaveTransaction({
                from: user2.address,
                to: fluida.address,
                success: false
            })
        })
    })

    describe('Hash Lock Validation', () => {
        it('should correctly validate hash locks', () => {
            const testPreimage = BigInt('0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef')
            const expectedHashLock = calculateHashLock(testPreimage)

            // Test that the same preimage always produces the same hash
            const secondHashLock = calculateHashLock(testPreimage)
            expect(expectedHashLock).toBe(secondHashLock)

            // Test that different preimages produce different hashes
            const differentPreimage = BigInt('0xfedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321')
            const differentHashLock = calculateHashLock(differentPreimage)
            expect(expectedHashLock).not.toBe(differentHashLock)
        })
    })

    describe('Multiple Swaps', () => {
        it('should handle multiple concurrent swaps', async () => {
            const swapCount = 3
            const swapData = []

            // Create multiple swaps
            for (let i = 0; i < swapCount; i++) {
                const preimage = BigInt('0x' + randomBytes(32).toString('hex'))
                const hashLock = calculateHashLock(preimage)
                const timeLock = BigInt(Math.floor(Date.now() / 1000) + 3600)
                const depositAmount = BigInt(1000000 + i * 100000) // Different amounts

                swapData.push({preimage, hashLock, timeLock, depositAmount})

                const OP_DEPOSIT_NOTIFICATION = 0xdeadbeefn
                const extraCell = beginCell().storeUint(hashLock, 256).storeUint(timeLock, 64).endCell()

                const depositNotificationPayload = beginCell()
                    .storeUint(OP_DEPOSIT_NOTIFICATION, 32)
                    .storeUint(depositAmount, 128)
                    .storeAddress(user1.address)
                    .storeRef(beginCell().storeAddress(jettonWalletAddress).endCell())
                    .storeRef(extraCell)
                    .endCell()

                await fluida.sendDepositNotification(deployer.getSender(), {
                    value: toNano('0.1'),
                    body: depositNotificationPayload
                })
            }

            // Verify all swaps were created
            const finalSwapCounter = await fluida.getSwapCounter()
            expect(finalSwapCounter).toBe(BigInt(swapCount))

            // Verify each swap has correct data
            for (let i = 0; i < swapCount; i++) {
                const swap = await fluida.getSwap(BigInt(i))
                expect(swap.amount).toBe(swapData[i].depositAmount)
                expect(swap.hashLock).toBe(swapData[i].hashLock)
                expect(swap.isCompleted).toBe(false)
            }

            // Complete one of the swaps
            const swapToComplete = 1
            await fluida.sendCompleteSwap(user2.getSender(), {
                swapId: BigInt(swapToComplete),
                preimage: swapData[swapToComplete].preimage,
                value: toNano('0.2')
            })

            // Verify only the completed swap is marked as completed
            for (let i = 0; i < swapCount; i++) {
                const swap = await fluida.getSwap(BigInt(i))
                expect(swap.isCompleted).toBe(i === swapToComplete)
            }
        })
    })

    describe('Edge Cases', () => {
        it('should handle zero amount deposits', async () => {
            const preimage = BigInt('0x' + randomBytes(32).toString('hex'))
            const hashLock = calculateHashLock(preimage)
            const timeLock = BigInt(Math.floor(Date.now() / 1000) + 3600)
            const depositAmount = 0n // Zero amount

            const OP_DEPOSIT_NOTIFICATION = 0xdeadbeefn
            const extraCell = beginCell().storeUint(hashLock, 256).storeUint(timeLock, 64).endCell()

            const depositNotificationPayload = beginCell()
                .storeUint(OP_DEPOSIT_NOTIFICATION, 32)
                .storeUint(depositAmount, 128)
                .storeAddress(user1.address)
                .storeRef(beginCell().storeAddress(jettonWalletAddress).endCell())
                .storeRef(extraCell)
                .endCell()

            const result = await fluida.sendDepositNotification(deployer.getSender(), {
                value: toNano('0.1'),
                body: depositNotificationPayload
            })

            // Depending on your contract logic, this might succeed or fail
            // Adjust the expectation based on your contract's behavior
        })

        it('should handle maximum value deposits', async () => {
            const preimage = BigInt('0x' + randomBytes(32).toString('hex'))
            const hashLock = calculateHashLock(preimage)
            const timeLock = BigInt(Math.floor(Date.now() / 1000) + 3600)
            const depositAmount = 2n ** 128n - 1n // Maximum 128-bit value

            const OP_DEPOSIT_NOTIFICATION = 0xdeadbeefn
            const extraCell = beginCell().storeUint(hashLock, 256).storeUint(timeLock, 64).endCell()

            const depositNotificationPayload = beginCell()
                .storeUint(OP_DEPOSIT_NOTIFICATION, 32)
                .storeUint(depositAmount, 128)
                .storeAddress(user1.address)
                .storeRef(beginCell().storeAddress(jettonWalletAddress).endCell())
                .storeRef(extraCell)
                .endCell()

            const result = await fluida.sendDepositNotification(deployer.getSender(), {
                value: toNano('0.1'),
                body: depositNotificationPayload
            })

            expect(result.transactions).toHaveTransaction({
                from: deployer.address,
                to: fluida.address,
                success: true
            })
        })
    })
})
