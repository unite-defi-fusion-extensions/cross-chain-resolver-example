# cross-chain-resolver-example

## Installation

Install example deps

```shell
pnpm install
```

Install [foundry](https://book.getfoundry.sh/getting-started/installation)

```shell
curl -L https://foundry.paradigm.xyz | bash
```

Install contract deps
```shell
forge install
```

## Running

To run tests you need to provide fork urls for Ethereum and Arbitrum

```shell
SRC_CHAIN_RPC=ETH_FORK_URL DST_CHAIN_RPC=ARB_FORK_URL pnpm test
```

### Public rpc

| Chain    | Url                           |
|----------|-------------------------------|
| Ethereum | https://eth.merkle.io         |
| Arbitrum | https://rpc.ankr.com/arbitrum |

## Test accounts

### Available Accounts

```
(0) 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" Owner of EscrowFactory
(1) 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" User A
(2) 0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" User B
(3) 0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6: "0x90F79bf6EB2c4f870365E785982E1f101E93b906" User C
(4) 0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a: "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65" 
```
