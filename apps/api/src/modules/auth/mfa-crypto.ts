import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

/** AES-256-GCM envelope for TOTP secrets at rest: `v1.<iv>.<tag>.<ciphertext>` (all base64url). */
export class MfaCrypto {
  private readonly key: Buffer;

  constructor(keyBase64: string) {
    this.key = Buffer.from(keyBase64, 'base64');
    if (this.key.length !== 32) throw new Error('MFA key must be 32 bytes');
  }

  encrypt(plain: string, aad: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    // Bind the ciphertext to its owner so a secret copied to another user's row will not decrypt.
    cipher.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
  }

  decrypt(envelope: string, aad: string): string {
    const [v, iv, tag, ct] = envelope.split('.');
    if (v !== 'v1' || !iv || !tag || !ct) throw new Error('Unsupported MFA envelope');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
  }
}
