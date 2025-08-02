
# Cross-Chain Atomic Swaps with 1inch Fusion

This repository provides a working proof-of-concept for performing trust-minimized, cross-chain atomic swaps between EVM-based assets and native Bitcoin assets (both on-chain and via the Lightning Network).

The core of the EVM-side logic is powered by the **1inch Fusion SDK**, which enables users to sign sophisticated, hash-locked limit orders off-chain. A **Resolver** then submits these signed orders to the blockchain to execute the swap.

## Core Concept: The Atomic Swap

An atomic swap is a smart contract mechanism that enables the exchange of cryptocurrencies between two different blockchains without relying on a trusted third party. The "atomicity" guarantees that the swap is an "all-or-nothing" operation: either both parties successfully receive their funds, or the entire transaction is reverted and no one loses their original assets (minus transaction fees).

This is achieved using a **Hashed Time-Lock Contract (HTLC)**.

> **Key Technical Note:** A critical detail is the use of different hashing algorithms. Ethereum and the 1inch SDK use `keccak256`, while Bitcoin and the Lightning Network use `sha256`. The swap logic must correctly generate and use the appropriate hash for each respective chain from the same original secret.

## Example 1: Lightning Swap (User Buys USDC with Sats)

This example demonstrates a user **buying** an EVM-based asset (USDC) from a resolver and **paying** for it with Satoshis on the Bitcoin Lightning Network.

-   **User's Goal:** Buy USDC, pay with Lightning Sats.
-   **Resolver's Goal:** Sell USDC, receive Lightning Sats.
-   **Test File:** `lightning.spec.ts`

### The Flow
1.  **Secret Generation (User):** The User (buyer) generates a secret (`S`) and its corresponding `keccak256` and `sha256` hashes.
2.  **Order Signing (User):** The User creates and **signs an off-chain 1inch Fusion order**. This signed message is a cryptographic promise: "I am ready to receive USDC from a resolver if they lock it against my `keccak256` hash."
3.  **HODL Invoice (Resolver):** The User presents this signed order to the Resolver. The Resolver provides a **HODL Invoice** to the User, locked with the `sha256` hash, to receive the Sats payment.
4.  **Payment Held (User):** The User pays the HODL invoice. This is their commitment. The Resolver's LND node sees the incoming payment and moves the invoice to an `ACCEPTED` state. **Crucially, the Resolver does not learn the secret yet.** They only know that a payment is being held, ready to be settled *if* the secret is provided later. The invoice and the EVM contract both have timeouts, creating a safe window for the swap.
5.  **On-Chain Execution (Resolver):** The Resolver, seeing the held payment, trusts the User is committed. They take the User's signed order and **submit it to the EVM chain**, paying the gas to deploy the escrow contract and lock their USDC.
6.  **Claim & Reveal (User):** The User sees their USDC is now locked on-chain. They call the `withdraw` function on the 1inch escrow contract. **This on-chain transaction requires them to submit the secret `S`, making it publicly visible on the blockchain.** This is the "reveal" step.
7.  **Final Settle (Resolver):** The Resolver, who was monitoring the EVM chain, now **learns the secret `S`** from the User's public withdrawal transaction. They use this learned secret to go back to their LND node and **settle** the HODL invoice, which finalizes the Lightning payment and pulls the Sats into their wallet.

## Example 2: On-Chain Bitcoin Swap (User Buys USDC with BTC)

This example demonstrates a user **buying** an EVM-based asset (USDC) from a resolver and **paying** for it with a native, on-chain Bitcoin transaction.

-   **User's Goal:** Buy USDC, pay with BTC.
-   **Resolver's Goal:** Sell USDC, receive BTC.
-   **Test File:** `bitcoin.spec.ts`

### The Flow
1.  **Secret Generation (User):** The User (buyer) generates a secret (`S`) and its `keccak256` and `sha256` hashes.
2.  **Order Signing (User):** The User creates and **signs an off-chain 1inch Fusion order** to buy USDC, locked with the `keccak256` hash.
3.  **Bitcoin HTLC (User):** The User presents the signed order to the Resolver. As their commitment, the User creates a Bitcoin HTLC by sending their BTC to a special script address, locked with the `sha256` hash.
4.  **On-Chain Execution (Resolver):** The Resolver sees the confirmed HTLC on the Bitcoin blockchain. Now confident the User is committed, the Resolver takes the User's signed order and **submits it to the EVM chain**, paying the gas to deploy the escrow contract and lock their USDC.
5.  **Claim & Reveal (User):** The User sees the USDC is locked. They claim it by calling `withdraw` on the 1inch contract, which requires providing the secret `S`. **This action reveals the secret on the EVM chain.**
6.  **Final Claim (Resolver):** The Resolver monitors the EVM chain. Once they **learn the secret `S`** from the User's withdrawal, they use it to construct a final Bitcoin transaction to claim the BTC locked in the HTLC.

---

## Getting Started

### Prerequisites
-   Node.js (v18+)
-   `pnpm` package manager (`npm install -g pnpm`)
-   Docker
-   [Polar](https://lightningpolar.com/) - A desktop application for running local Lightning and Bitcoin test networks.

### 1. Clone Repository
```bash
git clone https://github.com/unite-defi-fusion-extensions/cross-chain-resolver-example.git
cd cross-chain-resolver-example
```

### 2. Install Dependencies
```bash
pnpm install
```

### 3. Set Up Local Bitcoin & Lightning Network with Polar

Polar makes it incredibly easy to get a local testing environment running.

1.  **Download and install Polar** from [lightningpolar.com](https://lightningpolar.com/).
2.  Launch Polar and click **"Create Network"**.
3.  On the network design screen, create a network with **2 LND nodes** and **1 Bitcoin Core node**.
4.  Click **"Start Network"**. Polar will download the necessary Docker images and start the nodes.
5.  Open a balanced channel between LND1 and LND2.

### 4. Configure Environment

Once your Polar network is running, you need to get the connection details for your `.env` file.

1.  Copy the example environment file:
    ```bash
    cp .env.example .env
    ```
2.  Open the `.env` file and fill it with the credentials from your running Polar network:

    *   **For LND Nodes (`lnd`, `lnd2`):**
        *   In Polar, click on an LND node (e.g., `alice`).
        *   Go to the **"Connect"** tab.
        *   Copy the **"REST Host"** URL for `LND_RPC`.
        *   Copy the **"Admin Macaroon"** (Hex format) for `LND_MACAROON`.
        *   Repeat for the second LND node (`bob`) and fill in `LND_RPC2` and `LND_MACAROON2`.

    *   **For the Bitcoin Node (`bitcoind`):**
        *   In Polar, click on the `bitcoind` node.
        *   Go to the **"Connect"** tab.
        *   Copy the **"RPC URL"** for `BTC_RPC_HOST`.
        *   The default `BTC_RPC_USER` is `polaruser` and `BTC_RPC_PASS` is `polarpass`.

    Your final `.env` file should look similar to this:
    ```dotenv
    SRC_CHAIN_RPC=https://eth.merkle.io
    DST_CHAIN_RPC=wss://bsc-rpc.publicnode.com
    SRC_CHAIN_CREATE_FORK=true
    DST_CHAIN_CREATE_FORK=true
    
    # LND POLAR
    LND_RPC=https://127.0.0.1:8080
    LND_MACAROON=0201036c6e...
    LND_RPC2=https://127.0.0.1:8081
    LND_MACAROON2=0201036c6e...

    # Bitcoin Core (polar) RPC credentials
    BTC_RPC_HOST="http://127.0.0.1:18443"
    BTC_RPC_USER="polaruser"
    BTC_RPC_PASS="polarpass"
    ```

### 5. Running the Tests

Execute the tests for each swap type individually.

**To run the Lightning Network swap test:**
```bash
pnpm test -- lightning.spec.ts
```

**To run the on-chain Bitcoin swap tests:**
```bash
pnpm test -- bitcoin.spec.ts
```


# cross-chain-resolver-example (fork's readme)

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

To run tests you need to provide fork urls for Ethereum and Bsc

```shell
SRC_CHAIN_RPC=ETH_FORK_URL DST_CHAIN_RPC=BNB_FORK_URL pnpm test
```

### Public rpc

| Chain    | Url                          |
|----------|------------------------------|
| Ethereum | https://eth.merkle.io        |
| BSC      | wss://bsc-rpc.publicnode.com |

## Test accounts

### Available Accounts

```
(0) 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" Owner of EscrowFactory
(1) 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" User
(2) 0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" Resolver
```
