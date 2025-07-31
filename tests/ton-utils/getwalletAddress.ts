// tests/utils/getwalletAddress.ts
import { Address, Cell } from '@ton/core';

/**
 * Robust `fetch` shim: uses Node 18+ global fetch, or falls back to node-fetch if present.
 */
async function ensureFetch(): Promise<typeof fetch> {
  // @ts-ignore
  if (typeof fetch !== 'undefined') return fetch as typeof fetch;
  const mod = await import('node-fetch');
  // @ts-ignore
  return (mod.default ?? mod) as unknown as typeof fetch;
}

/**
 * Where to call runGetMethod for Testnet.
 * You can set TON_CONSOLE_ENDPOINT in .env to override.
 *
 * Example (Chainstack testnet endpoint):
 *   TON_CONSOLE_ENDPOINT=https://ton-testnet.core.chainstack.com/<YOUR_PROJECT_KEY>/api/v2/runGetMethod
 */
const RUN_GET = process.env.TON_CONSOLE_ENDPOINT?.trim()
  || 'https://ton-testnet.core.chainstack.com/1878c1c9d9781472f35552c5c909b388/api/v2/runGetMethod';

/**
 * Jetton master to derive wallets for (testnet).
 * Put a testnet master in .env as JETTON_MASTER; otherwise we fallback to the tgBTC master
 * you used in previous logs.
 */
const JETTON_MASTER = (process.env.JETTON_MASTER ?? 'kQDoy1cUAbGq253vwfoPcqSloODVAWkDBniR12PJFUHnK6Yf').trim();

/**
 * Decode a Chainstack stack item that contains an address.
 * It could be ["addr", "EQ..."] or ["cell", {bytes: "..."}] with the address inside.
 */
function readAddressFromStackItem(item: any): Address {
  if (Array.isArray(item)) {
    const [type, value] = item;
    if (type === 'addr') {
      return Address.parse(value);
    }
    if (type === 'cell' && value?.bytes) {
      const cell = Cell.fromBoc(Buffer.from(value.bytes, 'base64'))[0];
      const s = cell.beginParse();
      return s.loadAddress();
    }
  } else if (item?.type && item?.value) {
    // Some providers normalize to { type, value }
    if (item.type === 'addr') return Address.parse(item.value);
    if (item.type === 'cell') {
      const cell = Cell.fromBoc(Buffer.from(item.value.bytes, 'base64'))[0];
      const s = cell.beginParse();
      return s.loadAddress();
    }
  }
  throw new Error(`Unexpected get_wallet_address stack item: ${JSON.stringify(item)}`);
}

/**
 * Query `get_wallet_address` on a Jetton master for a given owner address.
 * @param ownerAddress base64url (user/contract) address string
 * @returns Wallet address (Address)
 */
export async function getJettonWalletAddress(ownerAddress: string): Promise<Address> {
  const f = await ensureFetch();

  const payload = {
    address: JETTON_MASTER,
    method: 'get_wallet_address',
    // Chainstack accepts ["addr", "<base64url>"] for MsgAddress
    stack: [['addr', ownerAddress]],
  };

  const res = await f(RUN_GET, {
    method: 'POST',
    headers: { accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`runGetMethod HTTP ${res.status}: ${t}`);
  }

  const json = await res.json();
  if (json.error) {
    throw new Error(`runGetMethod error: ${json.error.message}`);
  }

  // The wallet address should be the first stack item returned.
  const stack = json.result?.stack ?? [];
  if (!Array.isArray(stack) || stack.length === 0) {
    throw new Error(`Empty stack from get_wallet_address for owner ${ownerAddress}`);
  }

  return readAddressFromStackItem(stack[0]);
}

/**
 * Some of your code imports default; keep both export styles in ESM.
 */
export default getJettonWalletAddress;
