import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { SignJWT, errors, jwtVerify } from 'jose';
import { AppException } from '../../common/errors/app-exception';
import { ENV, Env } from '../../config/env';

export interface AccessClaims {
  userId: string;
  sessionId: string;
}

/**
 * Access tokens: short-lived HS256 JWTs carrying ONLY identity (sub) and session id (sid).
 * Role, status and permissions are deliberately NOT in the token: they are read from the database on
 * every request so suspensions, role changes and logouts take effect immediately.
 */
@Injectable()
export class TokenService {
  private readonly key: Uint8Array;

  constructor(@Inject(ENV) private readonly env: Env) {
    this.key = new TextEncoder().encode(env.JWT_ACCESS_SECRET);
  }

  async signAccessToken(c: AccessClaims): Promise<{ token: string; expiresInSec: number }> {
    const token = await new SignJWT({ sid: c.sessionId })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(c.userId)
      .setIssuer(this.env.JWT_ISSUER)
      .setAudience(this.env.JWT_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${this.env.ACCESS_TOKEN_TTL_SEC}s`)
      .sign(this.key);
    return { token, expiresInSec: this.env.ACCESS_TOKEN_TTL_SEC };
  }

  async verifyAccessToken(token: string): Promise<AccessClaims> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        algorithms: ['HS256'], // pins the algorithm: blocks alg=none / algorithm-confusion attacks
        issuer: this.env.JWT_ISSUER,
        audience: this.env.JWT_AUDIENCE,
        clockTolerance: 5,
      });
      if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') throw new Error('bad claims');
      return { userId: payload.sub, sessionId: payload.sid };
    } catch (e) {
      const expired = e instanceof errors.JWTExpired;
      throw new AppException(
        'UNAUTHENTICATED',
        expired ? 'Access token expired.' : 'Invalid access token.',
        401,
      );
    }
  }

  /** 256-bit opaque secret. Only its SHA-256 is ever stored. */
  newOpaqueToken(): { raw: string; hash: string } {
    const raw = randomBytes(32).toString('base64url');
    return { raw, hash: TokenService.hash(raw) };
  }

  static hash(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
  }
}
