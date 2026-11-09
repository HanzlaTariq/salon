import { Algorithm, hash, verify } from '@node-rs/argon2';
import { Inject, Injectable } from '@nestjs/common';
import { ENV, Env } from '../../config/env';

const COMMON = new Set([
  'password', 'password1', 'password12', 'password123', 'password1234', 'passw0rd123', 'qwertyuiop', 'qwerty12345',
  'qwerty123456', '1234567890', '12345678910', '123456789012', '0123456789', 'abcdefghij', 'abc1234567', 'iloveyou123',
  'letmein1234', 'welcome1234', 'welcome123', 'admin12345', 'admin123456', 'administrator', 'changeme123', 'trustno1234',
  'pakistan123', 'pakistan1234', 'karachi123', 'lahore12345', 'islamabad123', 'salon12345', 'salon123456', 'barber12345',
  'monkey12345', 'dragon12345', 'football123', 'cricket1234', 'cricket12345', 'bismillah123', 'mohammad123', 'muhammad123',
  '1q2w3e4r5t', '1qaz2wsx3edc', 'zaq12wsxcde3', 'asdfghjkl1', 'asdfghjkl123', 'superman123', 'baseball123', 'sunshine123',
]);

export interface PasswordContext {
  email?: string;
  fullName?: string;
}

@Injectable()
export class PasswordService {
  private dummyHash?: Promise<string>;

  constructor(@Inject(ENV) private readonly env: Env) {}

  private get options() {
    return {
      algorithm: Algorithm.Argon2id,
      memoryCost: this.env.ARGON2_MEMORY_KIB,
      timeCost: this.env.ARGON2_TIME_COST,
      parallelism: this.env.ARGON2_PARALLELISM,
    };
  }

  hash(password: string): Promise<string> {
    return hash(password, this.options);
  }

  async verify(passwordHash: string, password: string): Promise<boolean> {
    try {
      return await verify(passwordHash, password);
    } catch {
      return false; // malformed hash must never behave like a match
    }
  }

  /** Spends the same CPU/memory as a real check so unknown accounts are not distinguishable by timing. */
  async verifyDummy(password: string): Promise<void> {
    this.dummyHash ??= this.hash('dummy-password-for-timing-equalisation');
    await this.verify(await this.dummyHash, password);
  }

  /** Returns human-readable problems; empty array means acceptable. */
  policyProblems(password: string, ctx: PasswordContext = {}): string[] {
    const problems: string[] = [];
    if (password.length < 10) problems.push('Password must be at least 10 characters.');
    if (password.length > 128) problems.push('Password must be at most 128 characters.');
    const lower = password.toLowerCase();
    const alnum = lower.replace(/[^a-z0-9]/g, '');
    if (COMMON.has(lower) || COMMON.has(alnum)) problems.push('This password is too common.');
    if (/^(.)\1+$/.test(password) || /^\d+$/.test(password)) {
      problems.push('Password must not be only digits or one repeated character.');
    }
    const local = ctx.email?.split('@')[0]?.toLowerCase().replace(/[^a-z0-9]/g, '') ?? '';
    if (local.length >= 4 && alnum.includes(local)) problems.push('Password must not contain your e-mail name.');
    const nameParts = (ctx.fullName ?? '').toLowerCase().split(/\s+/).filter((p) => p.length >= 4);
    if (nameParts.some((p) => alnum.includes(p.replace(/[^a-z0-9]/g, '')))) {
      problems.push('Password must not contain your name.');
    }
    return [...new Set(problems)];
  }
}
