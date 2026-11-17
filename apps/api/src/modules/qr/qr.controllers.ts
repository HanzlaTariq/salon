import { Controller, Get, Header, Param, Query, Req, Res, StreamableFile } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { AuthenticatedUser } from '../../common/auth/authenticated-user';
import { CurrentUser, Public, Roles } from '../../common/auth/decorators';
import { clientContext } from '../../common/http/client-context';
import { PosterQuery, QrImageQuery } from './dto/qr.dto';
import { LANDING_CSP } from './landing';
import { OwnerQrService, PublicQrService } from './qr.service';

/** Per-route limit (per client IP). The factor exists only so automated tests can run many flows from one IP. */
const factor = () => Number(process.env.AUTH_RATE_LIMIT_FACTOR ?? 1) || 1;
const limit = (perMinute: number) => ({ default: { limit: () => perMinute * factor(), ttl: () => 60_000 } });

function file(res: Response, f: { body: Buffer; contentType: string; filename: string }, download: boolean | undefined): StreamableFile {
  res.set({
    'Content-Type': f.contentType,
    'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${f.filename}"`,
    'Cache-Control': 'private, no-store',
  });
  return new StreamableFile(f.body);
}

@ApiTags('salons')
@ApiBearerAuth()
@Roles('SALON_OWNER')
@Controller('salons/mine/qr')
export class OwnerQrController {
  constructor(private readonly svc: OwnerQrService) {}

  /** The permanent link and code. 409 until the salon is approved. */
  @Get()
  @Throttle(limit(60))
  async info(@CurrentUser() u: AuthenticatedUser, @Req() req: Request) {
    return { data: await this.svc.info(u, clientContext(req)) };
  }

  /** PNG or SVG of the QR code (binary response, not wrapped in { data }). */
  @Get('image')
  @Throttle(limit(30))
  async image(@CurrentUser() u: AuthenticatedUser, @Query() q: QrImageQuery, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return file(res, await this.svc.image(u, q.format ?? 'png', q.size, clientContext(req)), q.download);
  }

  /** One-page printable PDF poster (binary response). */
  @Get('poster')
  @Throttle(limit(10))
  async poster(@CurrentUser() u: AuthenticatedUser, @Query() q: PosterQuery, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return file(res, await this.svc.poster(u, q.size ?? 'A4', q.theme ?? 'light', clientContext(req)), q.download);
  }
}

@ApiTags('public')
@Public()
@Controller('public/qr')
export class PublicQrController {
  constructor(private readonly svc: PublicQrService) {}

  /** Resolves a scanned (or typed) code to a salon id. 404 for anything that is not a live, listed salon. */
  @Get(':code')
  @Throttle(limit(60))
  async resolve(@Param('code') code: string) {
    return { data: await this.svc.resolve(code) };
  }
}

/** The address printed in the QR code: <PUBLIC_LINK_BASE_URL>/s/<code>. Served WITHOUT the /api/v1 prefix (see bootstrap.ts). */
@ApiTags('public')
@Public()
@Controller('s')
export class SalonLandingController {
  constructor(private readonly svc: PublicQrService) {}

  @Get(':code')
  @Throttle(limit(60))
  @Header('Content-Security-Policy', LANDING_CSP)
  @Header('Cache-Control', 'no-store')
  async landing(@Param('code') code: string, @Res() res: Response) {
    const r = await this.svc.landing(code);
    res.status(r.status).type('html').send(r.html);
  }
}
