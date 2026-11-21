import { Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectThrottlerOptions, InjectThrottlerStorage, ThrottlerGuard, ThrottlerModuleOptions, ThrottlerStorage } from '@nestjs/throttler';
import { TokenService } from '../../modules/auth/token.service';

/**
 * Rate-limit key: the signed-in USER when the request carries a valid access token, otherwise the client IP.
 * Why: on Pakistani mobile networks (carrier-grade NAT) hundreds of customers share one public IP, so an IP-only limit
 * blocks innocent people while one abuser with several accounts is not slowed down per account. The token is VERIFIED
 * (signature, issuer, expiry), so a client cannot choose another user's bucket or an empty one by sending junk; junk falls
 * back to the IP bucket. Public routes (login, register, ...) have no token and stay limited per IP.
 */
@Injectable()
export class UserAwareThrottlerGuard extends ThrottlerGuard {
  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storage: ThrottlerStorage,
    reflector: Reflector,
    private readonly tokens: TokenService,
  ) {
    super(options, storage, reflector);
  }

  protected override async getTracker(req: Record<string, any>): Promise<string> {
    const header = req.headers?.authorization;
    const m = typeof header === 'string' ? /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/.exec(header) : null;
    if (m) {
      try {
        const claims = await this.tokens.verifyAccessToken(m[1]);
        return `user:${claims.userId}`;
      } catch {
        // invalid / expired token: the auth guard rejects it later; it only gets the IP bucket here
      }
    }
    return `ip:${req.ip}`;
  }
}
