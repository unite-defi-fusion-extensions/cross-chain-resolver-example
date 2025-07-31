// tests/ton-utils/EscrowDeploy.ts
import {
    Address,
    Cell,
    Contract,
    ContractProvider,
    Dictionary,
    Sender,
    beginCell,
    contractAddress,
    SendMode,
    TupleBuilder
} from '@ton/ton'

export interface EscrowConfig {
    jettonWallet: Address
    swapCounter: bigint
    swaps: Dictionary<bigint, Cell>
    hashlock_map: Dictionary<bigint, Cell>
}

export function escrowConfigToCell(config: EscrowConfig): Cell {
    return beginCell()
        .storeAddress(config.jettonWallet)
        .storeUint(config.swapCounter, 64)
        .storeDict(config.swaps)
        .storeDict(config.hashlock_map)
        .endCell()
}

export class Escrow implements Contract {
    constructor(
        readonly address: Address,
        readonly init?: {code: Cell; data: Cell}
    ) {}

    static createFromAddress(address: Address) {
        return new Escrow(address)
    }

    static createFromConfig(config: EscrowConfig, code: Cell, workchain = 0) {
        const data = escrowConfigToCell(config)
        const init = {code, data}

        return new Escrow(contractAddress(workchain, init), init)
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {value, sendMode: SendMode.PAY_GAS_SEPARATELY, body: beginCell().endCell()})
    }

    async getSwapCounter(provider: ContractProvider): Promise<bigint> {
        const {stack} = await provider.get('get_swap_counter', [])

        return stack.readBigNumber()
    }

    async getHasSwap(provider: ContractProvider, swapId: bigint): Promise<boolean> {
        const args = new TupleBuilder()
        args.writeNumber(swapId)
        const {stack} = await provider.get('get_has_swap', args.build())

        return stack.readNumber() === 1
    }
}
