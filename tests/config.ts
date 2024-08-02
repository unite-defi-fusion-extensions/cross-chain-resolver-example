import {z} from "zod";
import * as process from "node:process";
import Sdk from '@1inch/cross-chain-sdk'

const ConfigSchema = z.object({
    SRC_CHAIN_RPC: z.string().url(),
    DST_CHAIN_RPC: z.string().url(),
})

const fromEnv = ConfigSchema.parse(process.env)


export const config = {
    chain: {
        source: {
            chainId: Sdk.NetworkEnum.ETHEREUM,
            url: fromEnv.SRC_CHAIN_RPC,
            escrowFactoryAddress: Sdk.Address.fromBigInt(1n).toString(),
            limitOrderProtocol: '0x111111125421ca6dc452d289314280a0f8842a65',
            wrappedNative: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
            ownerPrivateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
        },
        destination: {
            chainId: Sdk.NetworkEnum.ARBITRUM,
            url: fromEnv.DST_CHAIN_RPC,
            escrowFactoryAddress: Sdk.Address.fromBigInt(1n).toString(),
            limitOrderProtocol: '0x111111125421ca6dc452d289314280a0f8842a65',
            wrappedNative: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1',
            ownerPrivateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
        }
    }
}

export type ChainConfig = typeof config.chain['source' | 'destination']
