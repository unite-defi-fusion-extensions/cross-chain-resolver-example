import {
  Address,
  beginCell,
  Cell,
  Contract,
  contractAddress,
  ContractProvider,
  Sender,
  SendMode,
  Dictionary,
} from '@ton/core';

export type FluidaConfig = {
  jettonWallet: Address; // The jetton wallet contract address
  swapCounter: bigint;
  swaps: Dictionary<bigint, {
    initiator: Address;
    recipient: Address;
    amount: bigint;
    hashLock: bigint;
    timeLock: bigint;
    isCompleted: boolean;
  }>;
  hashlock_map: Dictionary<bigint, bigint>;
};

export class Fluida implements Contract {
  constructor(
    readonly address: Address,
    readonly init?: { code: Cell; data: Cell }
  ) {}

  static createFromConfig(config: FluidaConfig, code: Cell): Fluida {
    const data = beginCell()
      .storeAddress(config.jettonWallet)
      .storeUint(config.swapCounter, 64)
      .storeDict(config.swaps)
      .storeDict(config.hashlock_map)
      .endCell();

    const init = { code, data };
    const address = contractAddress(0, init);
    return new Fluida(address, init);
  }

  async sendDeploy(provider: ContractProvider, via: Sender, value: bigint): Promise<void> {
    await provider.internal(via, {
      value,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      body: beginCell().endCell(),
    });
  }

  // sendCreateSwap triggers the onJettonTransfer logic.
  // Message layout:
  //   [ dummyOpCode (32 bits),
  //     tokenSender address,
  //     tokenAmount (128-bit),
  //     remainingGasTo address,
  //     ref cell: { hashLock (256-bit), timeLock (64-bit) } ]
  // In our tests, the sender’s address is used both as tokenSender and remainingGasTo.
  async sendCreateSwap(
    provider: ContractProvider,
    via: Sender,
    opts: {
      amount: bigint;      // token amount (128-bit)
      hashLock: bigint;
      timeLock: bigint;
      value: bigint;
    }
  ): Promise<void> {
    const dummyOpCode = 0n; // Dummy op code to fall through to onJettonTransfer
    await provider.internal(via, {
      value: opts.value,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      body: beginCell()
        .storeUint(dummyOpCode, 32)
        .storeAddress(via.address!)             // tokenSender (should match the jetton wallet)
        .storeUint(opts.amount, 128)            // token amount (128-bit)
        .storeAddress(via.address!)             // remainingGasTo (using same address for testing)
        .storeRef(
          beginCell()
            .storeUint(opts.hashLock, 256)      // hashLock (256-bit)
            .storeUint(opts.timeLock, 64)         // timeLock (64-bit)
            .endCell()
        )
        .endCell(),
    });
  }

  async sendCompleteSwap(
    provider: ContractProvider,
    via: Sender,
    opts: {
      swapId: bigint;
      preimage: bigint;
      value: bigint;
    }
  ): Promise<void> {
    const OP_COMPLETE_SWAP = 2271560481n; // 0x87654321
    await provider.internal(via, {
      value: opts.value,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      body: beginCell()
        .storeUint(OP_COMPLETE_SWAP, 32)
        .storeUint(opts.swapId, 256)
        .storeUint(opts.preimage, 256)
        .endCell(),
    });
  }

  async sendRefundSwap(
    provider: ContractProvider,
    via: Sender,
    opts: {
      swapId: bigint;
      value: bigint;
    }
  ): Promise<void> {
    const OP_REFUND_SWAP = 2882400018n; // 0xabcdef12
    await provider.internal(via, {
      value: opts.value,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      body: beginCell()
        .storeUint(OP_REFUND_SWAP, 32)
        .storeUint(opts.swapId, 256)
        .endCell(),
    });
  }

  async getSwapCounter(provider: ContractProvider): Promise<bigint> {
    const result = await provider.get('get_swap_counter', []);
    return result.stack.readBigNumber();
  }

  // Updated getter: now returns the jetton wallet address.
  async getJettonWallet(provider: ContractProvider): Promise<Address> {
    const result = await provider.get('get_jetton_wallet', []);
    return result.stack.readAddress();
  }

  async getSwap(provider: ContractProvider, swapId: bigint): Promise<{
    initiator: Address;
    recipient: Address;
    amount: bigint;
    hashLock: bigint;
    timeLock: bigint;
    isCompleted: boolean;
  }> {
    const result = await provider.get('get_swap', [{ type: 'int', value: swapId }]);
    const stack = result.stack;
    return {
      initiator: stack.readAddress(),
      recipient: stack.readAddress(),
      amount: stack.readBigNumber(),
      hashLock: stack.readBigNumber(),
      timeLock: stack.readBigNumber(),
      isCompleted: stack.readBoolean(),
    };
  }

  async hasSwap(provider: ContractProvider, swapId: bigint): Promise<boolean> {
    const result = await provider.get('has_swap', [{ type: 'int', value: swapId }]);
    return result.stack.readBoolean();
  }
}
