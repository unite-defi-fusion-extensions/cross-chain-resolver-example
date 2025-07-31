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
    randomBytes
} from 'ethers'
import {uint8ArrayToHex, UINT_40_MAX} from '@1inch/byte-utils'
import https from 'https'
import {Buffer} from 'buffer'
import assert from 'node:assert'

import {afterEach} from 'node:test'
import {config, ChainConfig} from './config'
import {Wallet} from './wallet'
import {Resolver} from './resolver'
import {EscrowFactory} from './escrow-factory'

import factoryContract from '../dist/contracts/TestEscrowFactory.sol/TestEscrowFactory.json'
import resolverContract from '../dist/contracts/Resolver.sol/Resolver.json'

const LND_RPC = process.env.LND_RPC
const LND_MACAROON = process.env.LND_MACAROON
const LND_RPC2 = process.env.LND_RPC2
const LND_MACAROON2 = process.env.LND_MACAROON2

const LIGHTNING_SATS_ASSET = '0x000000000000000000000000000000000000dEaD'
const userPk = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
const resolverPk = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a'

jest.setTimeout(1000 * 60 * 5)

/**
 * A helper to properly handle the streaming response from LND's /v2/router/send endpoint.
 * It resolves ONLY when a final SUCCEEDED status is received.
 * It rejects if a FAILED status is received or if the stream errors out.
 */
function sendStreamingPayment(lnd: AxiosInstance, payload: any): Promise<any> {
    return new Promise(async (resolve, reject) => {
        try {
            const responseStream = await lnd.post('/v2/router/send', payload, {
                responseType: 'stream'
            })

            responseStream.data.on('data', (chunk: Buffer) => {
                try {
                    const response = JSON.parse(chunk.toString())

                    if (response.result?.status === 'SUCCEEDED') {
                        resolve(response.result) // Resolve with the final, successful payment data
                        responseStream.data.destroy() // We are done, close the stream
                    }

                    if (response.result?.status === 'FAILED') {
                        reject(new Error(`LND payment failed! Reason: ${response.result.failure_reason}`))
                        responseStream.data.destroy()
                    }
                } catch (e) {
                    // Ignore parsing errors for potential empty chunks, etc.
                }
            })

            responseStream.data.on('end', () => {
                reject(new Error('LND payment stream ended without a final SUCCEEDED status.'))
            })

            responseStream.data.on('error', (err: Error) => {
                reject(new Error(`LND payment stream error: ${err.message}`))
            })
        } catch (error) {
            reject(error) // Rejects on initial connection errors (e.g., 404)
        }
    })
}

describe('1inch Fusion Swap: EVM to a REAL Lightning Node', () => {
    let src: any
    let dst: any
    let user: Wallet
    let resolver: Wallet
    let srcFactory: EscrowFactory
    let srcTimestamp: bigint
    let lnd: AxiosInstance
    let lnd2: AxiosInstance

    beforeEach(async () => {
        if (!LND_RPC) throw new Error('LND_RPC must be set in your .env file')

        if (!LND_MACAROON) throw new Error('LND_MACAROON must be set in your .env file')

        if (!LND_RPC2) throw new Error('LND_RPC2 must be set in your .env file')

        if (!LND_MACAROON2) throw new Error('LND_MACAROON2 must be set in your .env file')

        lnd = axios.create({
            baseURL: LND_RPC,
            headers: {'Grpc-Metadata-macaroon': LND_MACAROON},
            httpsAgent: new https.Agent({rejectUnauthorized: false})
        })
        lnd2 = axios.create({
            baseURL: LND_RPC2,
            headers: {'Grpc-Metadata-macaroon': LND_MACAROON2},
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

    it('should swap User:USDC for Resolver:LightningSats via a real LND node', async () => {
        const usdcAmount = parseUnits('100', 6)
        const satsAmount = 10
        const initialUserBalance = await user.tokenBalance(config.chain.source.tokens.USDC.address)

        console.log(`[LND] Generating invoice for ${satsAmount} sats...`)
        // ======================= NEW "SECRET-FIRST" WORKFLOW =======================
        // 1. Generate the secret in our test. This is the source of truth for the swap.
        const secret_hex = uint8ArrayToHex(randomBytes(32))
        console.log(`[SYSTEM] Generated secret: ${secret_hex}`)

        // 2. Create the 1inch on-chain hashLock. The SDK uses keccak256 internally.
        const hashLock = Sdk.HashLock.forSingleFill(secret_hex)
        console.log(`[EVM] Created on-chain keccak256-based hashLock: ${hashLock}`)

        // 3. Create the LND invoice, PROVIDING our secret as the r_preimage.
        // The secret must be base64 encoded for the LND API.
        const secret_base64 = Buffer.from(secret_hex.substring(2), 'hex').toString('base64')
        console.log(`[LND] Generating invoice with a PRE-DEFINED secret...`)
        const {data: invoiceResponse} = await lnd.post('/v1/invoices', {
            value: satsAmount.toString(),
            expiry: '3600',
            memo: '1inch Fusion Atomic Swap',
            r_preimage: secret_base64 // Provide the secret here
        })
        const bolt11Invoice = invoiceResponse.payment_request

        // 4. Create the on-chain order using the keccak256-based hashLock.
        const order = Sdk.CrossChainOrder.new(
            new Sdk.Address(src.escrowFactory),
            {
                maker: new Sdk.Address(await user.getAddress()),
                makingAmount: usdcAmount,
                takingAmount: BigInt(satsAmount),
                makerAsset: new Sdk.Address(config.chain.source.tokens.USDC.address),
                takerAsset: new Sdk.Address(LIGHTNING_SATS_ASSET)
            },
            {
                hashLock,
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
                auction: new Sdk.AuctionDetails({
                    startTime: srcTimestamp,
                    duration: 120n,
                    initialRateBump: 0,
                    points: []
                }),
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

        console.log('[LND] Automating payment of the invoice...')
        const paymentResult = await sendStreamingPayment(lnd2, {
            payment_request: bolt11Invoice,
            timeout_seconds: 60,
            fee_limit_sat: '1'
        })
        const learnedSecret = '0x' + paymentResult.payment_preimage
        console.log(`[LND2] Payment successful. Learned secret: ${learnedSecret}`)

        await src.provider.send('evm_increaseTime', [11])
        await src.provider.send('evm_mine', [])
        await resolver.send(resolverContract.withdraw('src', srcEscrowAddress, learnedSecret, srcEscrowEvent[0]))

        const finalUserBalance = await user.tokenBalance(config.chain.source.tokens.USDC.address)
        expect(learnedSecret).toBeDefined()
        console.log(`[SUCCESS] Swap complete!`)
    })
})

// Helper Functions
async function initChain(cnf: ChainConfig): Promise<any> {
    const {node, provider} = await getProvider(cnf)
    const deployer = new SignerWallet(cnf.ownerPrivateKey, provider)
    const escrowFactory = await deploy(
        factoryContract,
        [
            cnf.limitOrderProtocol,
            cnf.wrappedNative,
            Sdk.Address.fromBigInt(0n).toString(),
            deployer.address,
            60 * 30,
            60 * 30
        ],
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
async function deploy(
    json: any,
    params: unknown[],
    provider: JsonRpcProvider,
    deployer: SignerWallet
): Promise<string> {
    const deployed = await new ContractFactory(json.abi, json.bytecode, deployer).deploy(...params)
    await deployed.waitForDeployment()

    return await deployed.getAddress()
}
