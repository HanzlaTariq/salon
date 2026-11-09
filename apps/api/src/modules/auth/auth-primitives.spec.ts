import { normalizePhone } from '../../common/util/phone';
import { MfaCrypto } from './mfa-crypto';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';
import { base32Decode, base32Encode, hotp, timeStep, verifyTotp } from './totp';

const env: any = {
  JWT_ACCESS_SECRET: 'k'.repeat(40),
  JWT_ISSUER: 'iss',
  JWT_AUDIENCE: 'aud',
  ACCESS_TOKEN_TTL_SEC: 900,
  ARGON2_MEMORY_KIB: 8192,
  ARGON2_TIME_COST: 1,
  ARGON2_PARALLELISM: 1,
};

describe('TOTP (RFC 6238)', () => {
  const secret = Buffer.from('12345678901234567890');
  it('matches the RFC 6238 SHA-1 test vectors (6-digit truncation)', () => {
    expect(hotp(secret, Math.floor(59 / 30))).toBe('287082');
    expect(hotp(secret, Math.floor(1111111109 / 30))).toBe('081804');
    expect(hotp(secret, Math.floor(1234567890 / 30))).toBe('005924');
    expect(hotp(secret, Math.floor(20000000000 / 30))).toBe('353130');
  });
  it('base32 round-trips', () => {
    const b = Buffer.from('hello salon!');
    expect(base32Decode(base32Encode(b)).equals(b)).toBe(true);
  });
  it('accepts +/-1 step, rejects far codes, bad formats and replays', () => {
    const b32 = base32Encode(secret);
    const now = 1_700_000_000_000;
    const step = timeStep(now);
    const code = hotp(secret, step);
    expect(verifyTotp(b32, code, now, null)).toBe(step);
    expect(verifyTotp(b32, hotp(secret, step - 1), now, null)).toBe(step - 1);
    expect(verifyTotp(b32, hotp(secret, step + 5), now, null)).toBeNull();
    expect(verifyTotp(b32, code, now, step)).toBeNull(); // replay of the same step
    expect(verifyTotp(b32, '12345', now, null)).toBeNull();
    expect(verifyTotp(b32, 'abcdef', now, null)).toBeNull();
  });
});

describe('MfaCrypto', () => {
  const c = new MfaCrypto(Buffer.alloc(32, 3).toString('base64'));
  it('round-trips and never stores plaintext', () => {
    const enc = c.encrypt('JBSWY3DPEHPK3PXP', 'user-1');
    expect(enc).not.toContain('JBSWY3DPEHPK3PXP');
    expect(c.decrypt(enc, 'user-1')).toBe('JBSWY3DPEHPK3PXP');
  });
  it('rejects tampering and use under another user id', () => {
    const enc = c.encrypt('JBSWY3DPEHPK3PXP', 'user-1');
    expect(() => c.decrypt(enc, 'user-2')).toThrow();
    const parts = enc.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => c.decrypt(parts.join('.'), 'user-1')).toThrow();
  });
  it('requires a 32-byte key', () => expect(() => new MfaCrypto('c2hvcnQ=')).toThrow());
});

describe('TokenService', () => {
  const svc = new TokenService(env);
  it('signs and verifies, exposing only sub + sid', async () => {
    const { token } = await svc.signAccessToken({ userId: 'u1', sessionId: 's1' });
    expect(await svc.verifyAccessToken(token)).toEqual({ userId: 'u1', sessionId: 's1' });
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    expect(Object.keys(payload).sort()).toEqual(['aud', 'exp', 'iat', 'iss', 'sid', 'sub']);
  });
  it('rejects tampered, foreign-key, alg=none and wrong-audience tokens', async () => {
    const { token } = await svc.signAccessToken({ userId: 'u1', sessionId: 's1' });
    const [h, p, s] = token.split('.');
    await expect(svc.verifyAccessToken(`${h}.${p}.${s.slice(0, -2)}xx`)).rejects.toMatchObject({ status: 401 });
    const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${p}.`;
    await expect(svc.verifyAccessToken(none)).rejects.toMatchObject({ status: 401 });
    const other = new TokenService({ ...env, JWT_ACCESS_SECRET: 'z'.repeat(40) });
    await expect(other.verifyAccessToken(token)).rejects.toMatchObject({ status: 401 });
    const wrongAud = new TokenService({ ...env, JWT_AUDIENCE: 'other' });
    await expect(wrongAud.verifyAccessToken(token)).rejects.toMatchObject({ status: 401 });
    await expect(svc.verifyAccessToken('garbage')).rejects.toMatchObject({ status: 401 });
  });
  it('rejects expired tokens', async () => {
    const short = new TokenService({ ...env, ACCESS_TOKEN_TTL_SEC: -60 });
    const { token } = await short.signAccessToken({ userId: 'u1', sessionId: 's1' });
    await expect(svc.verifyAccessToken(token)).rejects.toMatchObject({ status: 401 });
  });
  it('generates unique 256-bit opaque tokens whose hash is deterministic', () => {
    const a = svc.newOpaqueToken();
    const b = svc.newOpaqueToken();
    expect(a.raw).not.toBe(b.raw);
    expect(Buffer.from(a.raw, 'base64url')).toHaveLength(32);
    expect(TokenService.hash(a.raw)).toBe(a.hash);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('PasswordService', () => {
  const svc = new PasswordService(env);
  it('hashes with Argon2id and verifies; wrong or malformed hashes never match', async () => {
    const h = await svc.hash('correct horse battery');
    expect(h.startsWith('$argon2id$')).toBe(true);
    expect(await svc.verify(h, 'correct horse battery')).toBe(true);
    expect(await svc.verify(h, 'wrong')).toBe(false);
    expect(await svc.verify('not-a-hash', 'x')).toBe(false);
  });
  it('enforces the password policy', () => {
    expect(svc.policyProblems('short')).not.toHaveLength(0);
    expect(svc.policyProblems('x'.repeat(129))).not.toHaveLength(0);
    expect(svc.policyProblems('Password123')).toContain('This password is too common.');
    expect(svc.policyProblems('1234567890123')).not.toHaveLength(0);
    expect(svc.policyProblems('aliraza-2024-ok', { email: 'aliraza@x.com' })).toContain(
      'Password must not contain your e-mail name.',
    );
    expect(svc.policyProblems('Muhammad-secret-42', { fullName: 'Ali Muhammad' })).toContain(
      'Password must not contain your name.',
    );
    expect(svc.policyProblems('violet-Harbor-lamp-91', { email: 'a@b.com', fullName: 'Sana Ahmed' })).toEqual([]);
  });
});

describe('normalizePhone', () => {
  it.each([
    ['0300 1234567', '+923001234567'],
    ['03001234567', '+923001234567'],
    ['3001234567', '+923001234567'],
    ['923001234567', '+923001234567'],
    ['+92 300 1234567', '+923001234567'],
    ['0092-300-1234567', '+923001234567'],
    ['+14155552671', '+14155552671'],
  ])('%s -> %s', (i, o) => expect(normalizePhone(i)).toBe(o));
  it.each(['', 'abc', '12345', '0200123456', '+0123456789', '+9212345', '0300123456'])('rejects %p', (i) =>
    expect(normalizePhone(i)).toBeNull(),
  );
});
