// tests/ton-utils/getwalletAddress.ts
import {Address, TonClient, TupleBuilder} from '@ton/ton'

// This is the Jetton Master address for jUSDT on the testnet.
const JETTON_MASTER_ADDRESS = 'kQDoy1cUAbGq253vwfoPcqSloODVAWkDBniR12PJFUHnK6Yf'

/**
 * Queries the `get_wallet_address` method on a Jetton master contract.
 * THIS VERSION USES THE PROVIDED TonClient FOR RELIABLE RPC CALLS.
 *
 * @param client - An initialized TonClient instance.
 * @param ownerAddress - The address of the wallet owner.
 * @returns The associated Jetton wallet address for the given owner.
 */
export async function getJettonWalletAddress(client: TonClient, ownerAddress: string): Promise<Address> {
    const owner = Address.parse(ownerAddress)
    const jettonMaster = Address.parse(JETTON_MASTER_ADDRESS)

    const args = new TupleBuilder()
    args.writeAddress(owner)

    try {
        // Use the client's built-in method, not a separate fetch call
        const {stack} = await client.callGetMethod(jettonMaster, 'get_wallet_address', args.build())

        return stack.readAddress()
    } catch (error) {
        console.error(`Failed to get Jetton wallet for owner ${ownerAddress}`, error)
        throw new Error('Could not execute getJettonWalletAddress on-chain.')
    }
}
