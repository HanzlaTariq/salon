import { Injectable } from '@nestjs/common';

/** Injectable time source so expiry/lockout logic can be tested deterministically. */
@Injectable()
export class Clock {
  now(): Date {
    return new Date();
  }
}
