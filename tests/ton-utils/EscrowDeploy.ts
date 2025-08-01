// tests/ton-utils/EscrowDeploy.ts
/* eslint-disable */
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
    TupleBuilder,
  } from '@ton/ton';
  
  export interface EscrowConfig {
    id: number;
    jettonWallet: Address | null;
    swapCounter: bigint;
    swaps: Dictionary<bigint, Cell>;
    hashlock_map: Dictionary<bigint, Cell>;
    initialized: boolean;
  }
  
  export interface LegacyEscrowConfig {
    jettonWallet: Address | null;
    swapCounter?: bigint;
    swaps?: Dictionary<bigint, Cell>;
    hashlock_map?: Dictionary<bigint, Cell>;
  }
  
  const MASK32  = (1n << 32n)  - 1n;
  const MASK64  = (1n << 64n)  - 1n;
  const MASK256 = (1n << 256n) - 1n;
  
  function u32(n: number | bigint | undefined): bigint   { return (BigInt(n ?? 0) & MASK32); }
  function u64(n: number | bigint | undefined): bigint   { return (BigInt(n ?? 0) & MASK64); }
  function u256(n: number | bigint | undefined): bigint  { return (BigInt(n ?? 0) & MASK256); }
  
  function isFullConfig(c: any): c is EscrowConfig {
    return typeof c?.id !== 'undefined' && typeof c?.initialized !== 'undefined';
  }
  
  function randomU32(): number {
    return Math.floor(Math.random() * 0xffffffff) >>> 0;
  }
  
  function normalizeConfig(cfg: EscrowConfig | LegacyEscrowConfig): EscrowConfig {
    if (isFullConfig(cfg)) return cfg;
    return {
      id: randomU32(),
      jettonWallet: (cfg as LegacyEscrowConfig).jettonWallet ?? null,
      swapCounter: (cfg as LegacyEscrowConfig).swapCounter ?? 0n,
      swaps: (cfg as LegacyEscrowConfig).swaps ?? Dictionary.empty(),
      hashlock_map: (cfg as LegacyEscrowConfig).hashlock_map ?? Dictionary.empty(),
      initialized: false,
    };
  }
  
  export function escrowConfigToCell(config: EscrowConfig): Cell {
    return beginCell()
      .storeUint(u32(config.id), 32)
      .storeAddress(config.jettonWallet)
      .storeUint(u64(config.swapCounter), 64)
      .storeDict(config.swaps)
      .storeDict(config.hashlock_map)
      .storeUint(config.initialized ? 1 : 0, 1)
      .endCell();
  }
  
  export class Escrow implements Contract {
    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}
  
    static createFromAddress(address: Address) {
      return new Escrow(address);
    }
  
    static createFromConfig(config: EscrowConfig | LegacyEscrowConfig, code: Cell, workchain = 0) {
      const full = normalizeConfig(config);
      const data = escrowConfigToCell(full);
      const init = { code, data };
      return new Escrow(contractAddress(workchain, init), init);
    }
  
    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
      await provider.internal(via, {
        value,
        sendMode: SendMode.PAY_GAS_SEPARATELY,
        bounce: true,
        body: beginCell().endCell(),
      });
    }
  
    async sendInitialize(provider: ContractProvider, via: Sender, params: { jettonWallet: Address; value: bigint }) {
      const body = beginCell().storeUint(1, 32).storeAddress(params.jettonWallet).endCell();
      await provider.internal(via, {
        value: params.value,
        sendMode: SendMode.PAY_GAS_SEPARATELY,
        bounce: true,
        body,
      });
    }
  
    async sendCompleteSwap(
      provider: ContractProvider,
      via: Sender,
      params: { swapId: bigint | number; preimage: bigint | Uint8Array; value: bigint }
    ) {
      const preimageBig =
        params.preimage instanceof Uint8Array
          ? BigInt('0x' + Buffer.from(params.preimage).toString('hex'))
          : BigInt(params.preimage);
  
      const body = beginCell()
        .storeUint(0x87654321, 32)
        .storeUint(0, 64)
        .storeUint(u256(params.swapId), 256)
        .storeUint(u256(preimageBig), 256)
        .endCell();
  
      await provider.internal(via, {
        value: params.value,
        sendMode: SendMode.PAY_GAS_SEPARATELY,
        bounce: true,
        body,
      });
    }
  
    async sendRefundSwap(provider: ContractProvider, via: Sender, params: { swapId: bigint | number; value: bigint }) {
      const body = beginCell()
        .storeUint(0xabcdef12, 32)
        .storeUint(0, 64)
        .storeUint(u256(params.swapId), 256)
        .endCell();
  
      await provider.internal(via, {
        value: params.value,
        sendMode: SendMode.PAY_GAS_SEPARATELY,
        bounce: true,
        body,
      });
    }
  
    async getSwapCounter(provider: ContractProvider): Promise<bigint> {
      const { stack } = await provider.get('get_swap_counter', []);
      return stack.readBigNumber();
    }
  
    async getHasSwap(provider: ContractProvider, swapId: bigint | number): Promise<boolean> {
      const args = new TupleBuilder();
      args.writeBigNumber(u256(swapId));
      const { stack } = await provider.get('has_swap', args.build());
      return stack.readNumber() === 1;
    }
  
    async getId(provider: ContractProvider): Promise<bigint> {
      const { stack } = await provider.get('get_id', []);
      return stack.readBigNumber();
    }
  
    async isInitialized(provider: ContractProvider): Promise<boolean> {
      const { stack } = await provider.get('is_initialized', []);
      return stack.readNumber() === 1;
    }
  
    async getJettonWallet(provider: ContractProvider): Promise<Address | null> {
      const { stack } = await provider.get('get_jetton_wallet', []);
      try {
        const s = stack.readSlice();
        return s.loadAddress();
      } catch {
        const c = stack.readCell();
        const s = c.beginParse();
        return s.loadAddress();
      }
    }
  }
  