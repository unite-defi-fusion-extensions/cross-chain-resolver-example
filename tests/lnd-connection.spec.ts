// tests/lnd-connection.spec.ts

import axios, { AxiosInstance } from 'axios';
import https from 'https';

// Make sure Jest is configured to load dotenv, e.g., in jest.config.js
const LND_RPC = process.env.LND_RPC;
const LND_MACAROON = process.env.LND_MACAROON;

describe('LND Node Connection Test', () => {
    let lnd: AxiosInstance;

    beforeAll(() => {
        // Basic validation
        if (!LND_RPC) throw new Error('LND_RPC must be set in your .env file');
        if (!LND_MACAROON) throw new Error('LND_MACAROON must be set in your .env file');

        // Create the axios instance
        lnd = axios.create({
            baseURL: LND_RPC,
            headers: { 'Grpc-Metadata-macaroon': LND_MACAROON },
            httpsAgent: new https.Agent({ rejectUnauthorized: false }),
        });
    });

    it('should successfully connect to the LND node and get info', async () => {
        try {
            console.log(`Attempting to connect to LND at: ${LND_RPC}/v1/getinfo`);
            
            const { data: info } = await lnd.get('/v1/getinfo');

            console.log('Successfully received response from LND:');
            console.log({
                identity_pubkey: info.identity_pubkey,
                alias: info.alias,
                version: info.version,
                synced_to_chain: info.synced_to_chain,
            });

            // Assert that we received a valid response
            expect(info.identity_pubkey).toBeDefined();
            expect(info.version).toBeDefined();

        } catch (error: any) {
            let helpfulMessage = 'LND connection failed. Please check your setup:\n';
            if (error.response) {
                // The request was made and the server responded with a status code
                // that falls out of the range of 2xx
                helpfulMessage += `- Server responded with status ${error.response.status} (${error.response.statusText}).\n`;
                helpfulMessage += `- Is your LND_RPC URL correct? Current value: ${LND_RPC}\n`;
                helpfulMessage += `- Is the path '/v1/getinfo' correct for your setup?\n`;

            } else if (error.request) {
                // The request was made but no response was received
                helpfulMessage += `- No response received from the server.\n`;
                helpfulMessage += `- Is your LND node running at the host and port specified in LND_RPC?\n`;
                helpfulMessage += `- Is a firewall blocking the connection?\n`;
            } else {
                // Something happened in setting up the request that triggered an Error
                helpfulMessage += `- An error occurred while setting up the request: ${error.message}\n`;
            }
            // Fail the test with a clear, actionable message
            throw new Error(helpfulMessage);
        }
    });
    it('should be able to create invoice', async () => {
        try {
            console.log(`Attempting to connect to LND at: ${LND_RPC}/v1/invoices`);
            
            const satsAmount = 2500;

            console.log(`[LND] Generating invoice for ${satsAmount} sats...`);
            const { data: invoiceResponse } = await lnd.post('/v1/invoices', {
                value: satsAmount.toString(), expiry: '3600', memo: '1inch Fusion Atomic Swap'
            });
            console.log(`[LND] Invoice generated: ${invoiceResponse.payment_request}`);

            // Assert that we received a valid response
            expect(invoiceResponse).toBeDefined();

        } catch (error: any) {
            let helpfulMessage = 'LND connection failed. Please check your setup:\n';
            if (error.response) {
                // The request was made and the server responded with a status code
                // that falls out of the range of 2xx
                helpfulMessage += `- Server responded with status ${error.response.status} (${error.response.statusText}).\n`;
                helpfulMessage += `- Is your LND_RPC URL correct? Current value: ${LND_RPC}\n`;
                helpfulMessage += `- Is the path '/v1/getinfo' correct for your setup?\n`;

            } else if (error.request) {
                // The request was made but no response was received
                helpfulMessage += `- No response received from the server.\n`;
                helpfulMessage += `- Is your LND node running at the host and port specified in LND_RPC?\n`;
                helpfulMessage += `- Is a firewall blocking the connection?\n`;
            } else {
                // Something happened in setting up the request that triggered an Error
                helpfulMessage += `- An error occurred while setting up the request: ${error.message}\n`;
            }
            // Fail the test with a clear, actionable message
            throw new Error(helpfulMessage);
        }
    });
});