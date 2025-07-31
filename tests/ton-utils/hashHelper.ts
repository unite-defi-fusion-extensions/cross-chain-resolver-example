import crypto from 'crypto';

export function generatePreimage(): bigint {
    // Generate 32 random bytes
    const randomBytes = crypto.randomBytes(32);
    // Convert to BigInt
    return BigInt('0x' + randomBytes.toString('hex'));
}

export function calculateHashLock(preimage: bigint): bigint {
    // Convert preimage to 32-byte (256-bit) hex string, padded with zeros
    const preimageHex = preimage.toString(16).padStart(64, '0');
    
    // Calculate SHA256 hash
    const hash = crypto.createHash('sha256')
        .update(Buffer.from(preimageHex, 'hex'))
        .digest();
    
    // Convert hash to BigInt
    return BigInt('0x' + hash.toString('hex'));
}