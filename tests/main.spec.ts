import 'dotenv/config'
import {jest} from '@jest/globals'

import {createServer, CreateServerReturnType} from 'prool'
import {anvil} from 'prool/instances'
import factoryContract from '../dist/contracts/TestEscrowFactory.sol/TestEscrowFactory.json'

import Sdk from "@1inch/cross-chain-sdk";
import {ChainConfig, config} from "./config";
import {ContractFactory, JsonRpcProvider, Wallet} from "ethers";
import assert from "node:assert";


const {Address} = Sdk

jest.setTimeout(1000 * 60)

describe('Resolving example', () => {
    let srcChain: CreateServerReturnType
    let dstChain: CreateServerReturnType

    let srcProvider: JsonRpcProvider
    let dstProvider: JsonRpcProvider

    beforeAll(async () => {
        [{node: srcChain, provider: srcProvider}, {
            node: dstChain,
            provider: dstProvider
        }] = await Promise.all([initChain(config.chain.source), initChain(config.chain.destination)])
    })

    afterAll(async () => {
        srcProvider.destroy()
        dstProvider.destroy()
        await Promise.all([
            srcChain.stop(),
            dstChain.stop()
        ])
    })

    it('should be 4', () => {
        expect(2 + 2).toBe(4);
    });
});


async function initChain(cnf: ChainConfig): Promise<{ node: CreateServerReturnType, provider: JsonRpcProvider }> {
    const node = createServer({
        instance: anvil({forkUrl: cnf.url, chainId: cnf.chainId}),
        limit: 1
    })
    await node.start()

    const address = node.address()
    assert(address)

    const provider = new JsonRpcProvider(`http://[${address.address}]:${address.port}/1`, cnf.chainId, {
        cacheTimeout: -1,
        staticNetwork: true
    })
    const deployer = new Wallet(cnf.ownerPrivateKey, provider)
    const Factory = new ContractFactory(factoryContract.abi, factoryContract.bytecode, deployer)

    const owner = deployer.address
    const rescueDelaySrc = 12
    const rescueDelayDst = 12

    const escrowFactory = await Factory.deploy(
        cnf.limitOrderProtocol,
        cnf.wrappedNative,// feeToken,
        Address.fromBigInt(0n).toString(),// accessToken,
        owner,
        rescueDelaySrc,
        rescueDelayDst
    )

    await escrowFactory.waitForDeployment()

    const code = await provider.getCode(await escrowFactory.getAddress())
    await provider.send('anvil_setCode', [cnf.escrowFactoryAddress, code])

    console.log(`[${cnf.chainId}]`, `Escrow factory contract deployed to`, cnf.escrowFactoryAddress)
    return {node: node, provider}
}
