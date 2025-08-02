import {expect, jest} from '@jest/globals'
import {createServer, CreateServerReturnType} from 'prool'
import {anvil} from 'prool/instances'
import axios, {AxiosInstance} from 'axios'
import Sdk from '@1inch/cross-chain-sdk'
import {
    computeAddress,
    ContractFactory,
    JsonRpcProvider,
    MaxUint256,
    parseEther,
    parseUnits,
    Wallet as SignerWallet,
    getAddress,
    randomBytes,
    sha256 // We need sha256 for the Lightning payment hash
} from 'ethers'
import {uint8ArrayToHex, UINT_40_MAX} from '@1inch/byte-utils'
import https from 'https'
import {Buffer} from 'buffer'
import assert from 'node:assert'
import readlineSync from 'readline-sync' // A simple library for synchronous user input

import {afterEach} from 'node:test'
import {config, ChainConfig} from './config'
import {Wallet} from './wallet'
import {Resolver} from './resolver'
import {EscrowFactory} from './escrow-factory'

import factoryContract from '../dist/contracts/TestEscrowFactory.sol/TestEscrowFactory.json'
import resolverContract from '../dist/contracts/Resolver.sol/Resolver.json'

// Point to your tapd REST proxies
const TAPD_RPC = process.env.TAPD_RPC
const TAPD_MACAROON = process.env.TAPD_MACAROON
const TAPD_RPC2 = process.env.TAPD_RPC2
const TAPD_MACAROON2 = process.env.TAPD_MACAROON2

// This is the unique ID of your Taproot Asset. You must mint this beforehand.
const MY_TAPROOT_ASSET_ID = process.env.MY_TAPROOT_ASSET_ID

// Create a unique, conventional "address" on the EVM side to represent our specific Taproot Asset.
// This is derived from the asset ID to avoid collisions.
const TAPROOT_ASSET_EVM_ADDRESS = getAddress(
    sha256(Buffer.from(MY_TAPROOT_ASSET_ID, 'hex')).substring(0, 42)
)

const userPk = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
const resolverPk = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a'

jest.setTimeout(1000 * 60 * 5)
/**
 * Converts a standard Base64 string to a URL-safe Base64 string.
 * This replaces '+' with '-' and '/' with '_'.
 * @param {string} base64 - The standard Base64 encoded string.
 * @returns {string} The URL-safe Base64 encoded string.
 */
function toUrlSafeBase64(base64) {
    return base64.replace(/\+/g, '-').replace(/\//g, '_');
  }
// This helper function remains unchanged. It correctly handles the payment stream.
function sendStreamingPayment(lnd: AxiosInstance, payload: any): Promise<any> {
    return new Promise(async (resolve, reject) => {
        try {
            const responseStream = await lnd.post('/v1/taproot-assets/channels/send-payment', payload, {
                responseType: 'stream'
            })
            responseStream.data.on('data', (chunk: Buffer) => {
                try {
                    const response = JSON.parse(chunk.toString())
                    if (response.result?.status === 'SUCCEEDED') {
                        resolve(response.result)
                        responseStream.data.destroy()
                    }
                    if (response.result?.status === 'FAILED') {
                        reject(new Error(`LND/TAPD payment failed! Reason: ${response.result.failure_reason}`))
                        responseStream.data.destroy()
                    }
                } catch (e) {}
            })
            responseStream.data.on('end', () => {
                reject(new Error('LND/TAPD payment stream ended without a final SUCCEEDED status.'))
            })
            responseStream.data.on('error', (err: Error) => {
                reject(new Error(`LND/TAPD payment stream error: ${err.message}`))
            })
        } catch (error) {
            reject(error)
        }
    })
}

describe('1inch Fusion Swap: EVM to a REAL Taproot Asset', () => {
    let src: any
    let dst: any
    let user: Wallet
    let resolver: Wallet
    let srcFactory: EscrowFactory
    let srcTimestamp: bigint
    let tapd: AxiosInstance
    let tapd2: AxiosInstance

    beforeEach(async () => {
        if (!TAPD_RPC) throw new Error('TAPD_RPC must be set in your .env file')
        if (!TAPD_MACAROON) throw new Error('TAPD_MACAROON must be set in your .env file')
        if (!TAPD_RPC2) throw new Error('TAPD_RPC2 must be set in your .env file')
        if (!TAPD_MACAROON2) throw new Error('TAPD_MACAROON2 must be set in your .env file')

        tapd = axios.create({
            baseURL: TAPD_RPC,
            headers: {'Grpc-Metadata-macaroon': TAPD_MACAROON},
            httpsAgent: new https.Agent({rejectUnauthorized: false})
        })
        tapd2 = axios.create({
            baseURL: TAPD_RPC2,
            headers: {'Grpc-Metadata-macaroon': TAPD_MACAROON2},
            httpsAgent: new https.Agent({rejectUnauthorized: false})
        })
        ;[src, dst] = await Promise.all([initChain(config.chain.source), initChain(config.chain.destination)])

        user = new Wallet(userPk, src.provider)
        resolver = new Wallet(resolverPk, src.provider)
        srcFactory = new EscrowFactory(src.provider, src.escrowFactory)

        await user.topUpFromDonor(
            config.chain.source.tokens.USDC.address,
            config.chain.source.tokens.USDC.donor,
            parseUnits('1000', 6)
        )
        await resolver.topUpFromDonor(
            getAddress('0x0000000000000000000000000000000000000000'),
            getAddress('0x00000000219ab540356cBB839Cbe05303d7705Fa'),
            parseEther('10')
        )
        await user.approveToken(
            config.chain.source.tokens.USDC.address,
            config.chain.source.limitOrderProtocol,
            MaxUint256
        )
        srcTimestamp = BigInt((await src.provider.getBlock('latest'))!.timestamp)
    })

    afterEach(async () => {
        if (src?.provider) src.provider.destroy()
        if (dst?.provider) dst.provider.destroy()
        if (src?.node) await src.node.stop()
        if (dst?.node) await dst.node.stop()
    })

    it('should swap User:USDC for Resolver:TaprootAsset via a TAPD HODL invoice', async () => {
        const usdcAmount = parseUnits('100', 6)
        const taprootAssetAmount = 1000;
        console.log(`[TAPD] Preparing to swap for ${taprootAssetAmount} units of asset ${MY_TAPROOT_ASSET_ID}...`)
        
        // ======================= REVISED: SECRET & HASH GENERATION =======================
        // 1. Generate the secret. This is the single source of truth for the atomic swap.
        const secret_hex = uint8ArrayToHex(randomBytes(32))
        const secret_bytes = Buffer.from(secret_hex.substring(2), 'hex')
        console.log(`[SYSTEM] Generated secret (preimage): ${secret_hex}`)

        // 2. Create the EVM-side hashLock using keccak256. The 1inch SDK handles this.
        const evmHashLock = Sdk.HashLock.forSingleFill(secret_hex)
        console.log(`[EVM] Created on-chain keccak256 hashLock: ${evmHashLock}`)

        // 3. Create the Lightning-side payment hash using SHA-256. This is required for HODL invoices.
        const lightning_payment_hash_hex = sha256(secret_bytes)
        const lightning_payment_hash_bytes = Buffer.from(lightning_payment_hash_hex.substring(2), 'hex')
        const payment_hash_base64 = lightning_payment_hash_bytes.toString('base64')
        console.log(`[LND/TAPD] Created off-chain SHA256 payment hash: ${lightning_payment_hash_hex}`)

        // 4. Base64-encode the Taproot Asset ID for the API call.
        const asset_id_base64 = Buffer.from(MY_TAPROOT_ASSET_ID, 'hex').toString('base64')
        // 5. Create the HODL invoice on the recipient's tapd node.
        console.log(`[TAPD] Generating invoice...`)
        /*
        // Cant make it work yet, always error 500
        const { data: invoiceResponse } = await tapd.post(
            '/v1/taproot-assets/channels/invoice', 
            {
                // Asset details are at the top level
                asset_id: toUrlSafeBase64(asset_id_base64),
                asset_amount: taprootAssetAmount.toString(),
                
            }
        )
        */
        // ======================= STEP 3: SCRIPT PAUSES AND INSTRUCTS THE USER =======================
        console.log('\n\n================================== ACTION REQUIRED ==================================');
        console.log('Go to your bob Lightning Polar node terminal.');
        console.log('Run the following command to create the invoice. This command uses `ln` as proven to work:');
        console.log('\n\x1b[33m%s\x1b[0m', `litcli ln addinvoice --asset_id ${MY_TAPROOT_ASSET_ID} --asset_amount ${taprootAssetAmount} --preimage ${secret_hex.substring(2)}`);
        console.log('\n===================================================================================');

        const bolt11Invoice = readlineSync.question('\n[SCRIPT] Please paste the resulting Lightning invoice (lntb...) here and press Enter: ');
        assert(bolt11Invoice.startsWith('lnb'), 'Invalid invoice provided. It should start with "lntb".');
        console.log(`[SCRIPT] Invoice received. Simulating payment...`);
        //assert(invoiceResponse.invoice_result?.payment_request, 'Failed to get payment_request from tapd response')
        console.log(`[TAPD] HODL invoice created: ${bolt11Invoice.substring(0, 80)}...`);
        // =================================================================================

        const order = Sdk.CrossChainOrder.new(
            new Sdk.Address(src.escrowFactory),
            {
                maker: new Sdk.Address(await user.getAddress()),
                makingAmount: usdcAmount,
                takingAmount: BigInt(taprootAssetAmount),
                makerAsset: new Sdk.Address(config.chain.source.tokens.USDC.address),
                takerAsset: new Sdk.Address(TAPROOT_ASSET_EVM_ADDRESS) // Use our conventional address
            },
            {
                hashLock: evmHashLock, // Use the keccak256 hashLock on-chain
                timeLocks: Sdk.TimeLocks.new({
                    srcWithdrawal: 10n,
                    srcPublicWithdrawal: 7200n,
                    srcCancellation: 7201n,
                    srcPublicCancellation: 7202n,
                    dstWithdrawal: 10n,
                    dstPublicWithdrawal: 3600n,
                    dstCancellation: 3601n
                }),
                srcChainId: src.chainId,
                dstChainId: Sdk.NetworkEnum.BINANCE,
                srcSafetyDeposit: parseEther('0.01'),
                dstSafetyDeposit: 0n
            },
            {
                auction: new Sdk.AuctionDetails({ startTime: srcTimestamp, duration: 120n, initialRateBump: 0, points: [] }),
                whitelist: [{address: new Sdk.Address(src.resolver), allowFrom: 0n}],
                resolvingStartTime: 0n
            },
            {nonce: Sdk.randBigInt(UINT_40_MAX), allowPartialFills: false, allowMultipleFills: false}
        )

        const signature = await user.signOrder(src.chainId, order)
        const resolverContract = new Resolver(src.resolver, '0x')

        const {blockHash: srcDeployBlock} = await resolver.send(
            resolverContract.deploySrc(
                src.chainId,
                order,
                signature,
                Sdk.TakerTraits.default().setExtension(order.extension).setAmountMode(Sdk.AmountMode.maker),
                order.makingAmount
            )
        )
        const srcEscrowEvent = await srcFactory.getSrcDeployEvent(srcDeployBlock!)
        const srcEscrowAddress = new Sdk.EscrowFactory(new Sdk.Address(src.escrowFactory)).getSrcEscrowAddress(
            srcEscrowEvent[0],
            await srcFactory.getSourceImpl()
        )
        console.log(`[EVM] Source Escrow deployed at ${srcEscrowAddress}`)

        console.log('[TAPD] Automating payment of the Taproot Asset invoice...')
        const paymentResult = await sendStreamingPayment(tapd2, {
            payment_request: bolt11Invoice,
        })
        const learnedSecret = '0x' + paymentResult.payment_preimage
        console.log(`[TAPD2] Payment successful. Learned secret: ${learnedSecret}`)

        // The learned secret from the payment must match our original secret
        expect(learnedSecret).toEqual(secret_hex)

        await src.provider.send('evm_increaseTime', [11])
        await src.provider.send('evm_mine', [])
        await resolver.send(resolverContract.withdraw('src', srcEscrowAddress, learnedSecret, srcEscrowEvent[0]))

        const finalUserBalance = await user.tokenBalance(config.chain.source.tokens.USDC.address)
        console.log(`[SUCCESS] Swap complete!`)

        expect(learnedSecret).toBeDefined()
    })
})

// Helper Functions (No changes needed here)
async function initChain(cnf: ChainConfig): Promise<any> {
    const {node, provider} = await getProvider(cnf)
    const deployer = new SignerWallet(cnf.ownerPrivateKey, provider)
    const escrowFactory = await deploy(
        factoryContract,
        [cnf.limitOrderProtocol, cnf.wrappedNative, Sdk.Address.fromBigInt(0n).toString(), deployer.address, 60 * 30, 60 * 30],
        provider,
        deployer
    )
    console.log(`[${cnf.chainId}] Escrow factory contract deployed to`, escrowFactory)
    const resolver = await deploy(
        resolverContract,
        [escrowFactory, cnf.limitOrderProtocol, computeAddress(resolverPk)],
        provider,
        deployer
    )
    return {...cnf, node, provider, resolver, escrowFactory}
}
async function getProvider(cnf: ChainConfig): Promise<{node?: CreateServerReturnType; provider: JsonRpcProvider}> {
    if (!cnf.createFork) {
        return {provider: new JsonRpcProvider(cnf.url, cnf.chainId, {cacheTimeout: -1, staticNetwork: true})}
    }
    const node = createServer({instance: anvil({forkUrl: cnf.url, chainId: cnf.chainId}), limit: 1})
    await node.start()
    const address = node.address()
    assert(address)
    const provider = new JsonRpcProvider(`http://[${address.address}]:${address.port}/1`, cnf.chainId, {
        cacheTimeout: -1,
        staticNetwork: true
    })
    return {provider, node}
}
async function deploy(json: any, params: unknown[], provider: JsonRpcProvider, deployer: SignerWallet): Promise<string> {
    const deployed = await new ContractFactory(json.abi, json.bytecode, deployer).deploy(...params)
    await deployed.waitForDeployment()
    return await deployed.getAddress()
}