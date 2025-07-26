import {RegtestUtils} from 'regtest-client'
import ECPairFactory, {ECPairInterface} from 'ecpair'
import * as ecc from 'tiny-secp256k1'
import * as bitcoin from 'bitcoinjs-lib'
import {randomBytes} from 'crypto'
import {config} from './config'

const ECPair = ECPairFactory(ecc)
const REGTEST = bitcoin.networks.regtest
const regtestUtils = new RegtestUtils({APIURL: config.chain.btc.url})

const rng = (size?: number): Buffer => (size ? randomBytes(size) : Buffer.from([]))

let makerWallet: ECPairInterface
let resolverWallet: ECPairInterface

describe('Fusion+ Bitcoin integration', () => {
    beforeAll(async () => {
        makerWallet = ECPair.makeRandom({rng})
        resolverWallet = ECPair.makeRandom({rng})
    })

    it('can get funds from faucet and make a payment from resolver to maker', async () => {
        const makerPayment = bitcoin.payments.p2pkh({
            pubkey: Buffer.from(makerWallet.publicKey),
            network: REGTEST
        })
        const resolverPayment = bitcoin.payments.p2pkh({
            pubkey: Buffer.from(resolverWallet.publicKey),
            network: REGTEST
        })

        console.log(`Sending 5000 satoshi from ${makerPayment.address} to ${resolverPayment.address}`)

        console.log('getting funds from faucet')
        const input = await getUnspentTransaction(5e4, makerPayment)
        console.log('done')

        const psbt = new bitcoin.Psbt({network: REGTEST})
            .addInput(input)
            .addOutput({
                address: resolverPayment.address!,
                value: 2e4
            }) // (in)5e4 - (out)2e4 = (fee)3e4, this is the miner fee
            .signInput(0, ecPairToSigner(makerWallet))

        psbt.finalizeAllInputs()
        console.log('broadcasting tx')
        await regtestUtils.broadcast(psbt.extractTransaction().toHex())
        console.log('done')
    })
})

async function getUnspentTransaction(
    amount: number,
    payment: bitcoin.payments.Payment
): Promise<{hash: string; index: number; nonWitnessUtxo: Buffer}> {
    const unspent = await regtestUtils.faucetComplex(Buffer.from(payment.output!), amount)
    const utx = await regtestUtils.fetch(unspent.txId)
    const nonWitnessUtxo = Buffer.from(utx.txHex, 'hex')

    return {
        hash: unspent.txId,
        index: unspent.vout,
        nonWitnessUtxo
    }
}

function ecPairToSigner(input: ECPairInterface): bitcoin.Signer {
    return {
        publicKey: Buffer.from(input.publicKey),
        network: input.network,
        sign: (hash: Buffer, lowR?: boolean) => Buffer.from(input.sign(hash, lowR)),
        signSchnorr: (hash: Buffer) => Buffer.from(input.signSchnorr(hash))
    }
}
