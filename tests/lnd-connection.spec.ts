// tests/lnd-connection.spec.ts

import {beforeEach} from '@jest/globals'
import axios, {AxiosInstance} from 'axios'
import https from 'https'

// Make sure Jest is configured to load dotenv, e.g., in jest.config.js
const LND_RPC = process.env.LND_RPC
const LND_RPC2 = process.env.LND_RPC2
const LND_MACAROON = process.env.LND_MACAROON
const LND_MACAROON2 = process.env.LND_MACAROON2

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
describe('LND Node Connection Test', () => {
    let lnd: AxiosInstance
    let lnd2: AxiosInstance
    let invoiceToPay: any
    beforeEach(() => {
        // Basic validation
        if (!LND_RPC) throw new Error('LND_RPC must be set in your .env file')

        if (!LND_MACAROON) throw new Error('LND_MACAROON must be set in your .env file')

        if (!LND_RPC2) throw new Error('LND_RPC2 must be set in your .env file')

        if (!LND_MACAROON2) throw new Error('LND_MACAROON2 must be set in your .env file')

        // Create the axios instance
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
    })

    it('should successfully connect to the LND node and get info', async () => {
        try {
            console.log(`Attempting to connect to LND at: ${LND_RPC}/v1/getinfo`)

            const {data: info} = await lnd.get('/v1/getinfo')
            console.log('Successfully received response from LND:')
            console.log({
                identity_pubkey: info.identity_pubkey,
                alias: info.alias,
                version: info.version,
                synced_to_chain: info.synced_to_chain
            })

            // Assert that we received a valid response
            expect(info.identity_pubkey).toBeDefined()
            expect(info.version).toBeDefined()

            console.log(`Attempting to connect to LND2 at: ${LND_RPC2}/v1/getinfo`)

            const {data: info2} = await lnd2.get('/v1/getinfo')

            console.log('Successfully received response from LND:')
            console.log({
                identity_pubkey: info2.identity_pubkey,
                alias: info2.alias,
                version: info2.version,
                synced_to_chain: info2.synced_to_chain
            })

            // Assert that we received a valid response
            expect(info2.identity_pubkey).toBeDefined()
            expect(info2.version).toBeDefined()
        } catch (error: any) {
            let helpfulMessage = 'LND connection failed. Please check your setup:\n'

            if (error.response) {
                // The request was made and the server responded with a status code
                // that falls out of the range of 2xx
                helpfulMessage += `- Server responded with status ${error.response.status} (${error.response.statusText}).\n`
                helpfulMessage += `- Is your LND_RPC URL correct? Current value: ${LND_RPC}\n`
                helpfulMessage += `- Is the path '/v1/getinfo' correct for your setup?\n`
            } else if (error.request) {
                // The request was made but no response was received
                helpfulMessage += `- No response received from the server.\n`
                helpfulMessage += `- Is your LND node running at the host and port specified in LND_RPC?\n`
                helpfulMessage += `- Is a firewall blocking the connection?\n`
            } else {
                // Something happened in setting up the request that triggered an Error
                helpfulMessage += `- An error occurred while setting up the request: ${error.message}\n`
            }

            // Fail the test with a clear, actionable message
            throw new Error(helpfulMessage)
        }
    })
    it('should be able to create invoice', async () => {
        try {
            console.log(`Attempting to connect to LND at: ${LND_RPC}/v1/invoices`)

            const satsAmount = 10

            console.log(`[LND] Generating invoice for ${satsAmount} sats...`)
            const {data: invoiceResponse} = await lnd.post('/v1/invoices', {
                value: satsAmount.toString(),
                expiry: '3600',
                memo: '1inch Fusion Atomic Swap'
            })
            console.log(`[LND] Invoice generated: ${invoiceResponse.payment_request}`)
            invoiceToPay = invoiceResponse
            // Assert that we received a valid response
            expect(invoiceResponse).toBeDefined()
        } catch (error: any) {
            let helpfulMessage = 'LND connection failed. Please check your setup:\n'

            if (error.response) {
                // The request was made and the server responded with a status code
                // that falls out of the range of 2xx
                helpfulMessage += `- Server responded with status ${error.response.status} (${error.response.statusText}).\n`
                helpfulMessage += `- Is your LND_RPC URL correct? Current value: ${LND_RPC}\n`
                helpfulMessage += `- Is the path '/v1/getinfo' correct for your setup?\n`
            } else if (error.request) {
                // The request was made but no response was received
                helpfulMessage += `- No response received from the server.\n`
                helpfulMessage += `- Is your LND node running at the host and port specified in LND_RPC?\n`
                helpfulMessage += `- Is a firewall blocking the connection?\n`
            } else {
                // Something happened in setting up the request that triggered an Error
                helpfulMessage += `- An error occurred while setting up the request: ${error.message}\n`
            }

            // Fail the test with a clear, actionable message
            throw new Error(helpfulMessage)
        }
    })
    it('should be able to pay invoice from LND2', async () => {
        try {
            console.log(`Attempting to connect to LND2 at: ${LND_RPC2}/v1/invoices`)

            const bolt11Invoice = invoiceToPay.payment_request
            console.log(`LND2 Attempting to pay invoice: ${bolt11Invoice}`)

            const paymentResult = await sendStreamingPayment(lnd2, {
                payment_request: bolt11Invoice,
                timeout_seconds: 60,
                fee_limit_sat: '1'
            })
            console.log(paymentResult)
            const learnedSecret = '0x' + paymentResult.payment_preimage
            console.log(`[LND] Payment successful. Learned secret: ${learnedSecret}`)

            expect(learnedSecret).toBeDefined()
        } catch (error: any) {
            let helpfulMessage = 'LND connection failed. Please check your setup:\n'

            if (error.response) {
                // The request was made and the server responded with a status code
                // that falls out of the range of 2xx
                helpfulMessage += `- Server responded with status ${error.response.status} (${error.response.statusText}).\n`
                helpfulMessage += `- Is your LND_RPC URL correct? Current value: ${LND_RPC}\n`
                helpfulMessage += `- Is the path '/v1/getinfo' correct for your setup?\n`
            } else if (error.request) {
                // The request was made but no response was received
                helpfulMessage += `- No response received from the server.\n`
                helpfulMessage += `- Is your LND node running at the host and port specified in LND_RPC?\n`
                helpfulMessage += `- Is a firewall blocking the connection?\n`
            } else {
                // Something happened in setting up the request that triggered an Error
                helpfulMessage += `- An error occurred while setting up the request: ${error.message}\n`
            }

            // Fail the test with a clear, actionable message
            throw new Error(helpfulMessage)
        }
    })
})
