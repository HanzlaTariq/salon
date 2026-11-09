import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { AuthenticatedUser } from '../../common/auth/authenticated-user';
import { AllowWithoutMfa, CurrentUser, Public } from '../../common/auth/decorators';
import { AppException } from '../../common/errors/app-exception';
import { clientContext } from '../../common/http/client-context';
import { ENV, Env } from '../../config/env';
import { AuthService } from './auth.service';
import { AuthResult } from './auth.types';
import {
  ChangePasswordDto,
  EmailOnlyDto,
  LoginDto,
  LogoutAllDto,
  MfaDisableDto,
  MfaEnableDto,
  MfaSetupDto,
  RefreshDto,
  RegisterDto,
  ResetPasswordDto,
  TokenOnlyDto,
} from './dto/auth.dto';
import {
  REFRESH_COOKIE,
  assertCookieRequestIsSameSite,
  clearRefreshCookie,
  isMobileClient,
  setRefreshCookie,
} from './web-session';

/**
 * Per-route limits (per client IP) on top of the global limit. `AUTH_RATE_LIMIT_FACTOR` exists only
 * so automated tests can run many flows from one IP; production leaves it at 1.
 */
const factor = () => Number(process.env.AUTH_RATE_LIMIT_FACTOR ?? 1) || 1;
const limit = (perMinute: number) => ({ default: { limit: () => perMinute * factor(), ttl: () => 60_000 } });

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Web: refresh token goes into an httpOnly cookie and is removed from the body. Mobile: body. */
  private deliver(req: Request, res: Response, r: AuthResult) {
    const { refreshToken, ...rest } = r;
    if (isMobileClient(req)) return { data: { ...rest, refreshToken } };
    setRefreshCookie(res, this.env, refreshToken);
    return { data: rest };
  }

  @Public()
  @Throttle(limit(5))
  @Post('register')
  @HttpCode(202)
  async register(@Body() dto: RegisterDto, @Req() req: Request) {
    await this.auth.register(dto, clientContext(req));
    return { data: { message: 'If the details are valid, a verification e-mail has been sent.' } };
  }

  @Public()
  @Throttle(limit(10))
  @Post('verify-email')
  @HttpCode(200)
  async verifyEmail(@Body() dto: TokenOnlyDto, @Req() req: Request) {
    await this.auth.verifyEmail(dto.token, clientContext(req));
    return { data: { verified: true } };
  }

  @Public()
  @Throttle(limit(3))
  @Post('resend-verification')
  @HttpCode(202)
  async resendVerification(@Body() dto: EmailOnlyDto) {
    await this.auth.resendVerification(dto.email);
    return { data: { message: 'If the account needs verification, an e-mail has been sent.' } };
  }

  @Public()
  @Throttle(limit(10))
  @Post('login')
  @HttpCode(200)
  async login(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.deliver(req, res, await this.auth.login(dto, clientContext(req)));
  }

  @Public()
  @Throttle(limit(30))
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Body() dto: RefreshDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const mobile = isMobileClient(req);
    let token: string | undefined;
    if (mobile) {
      token = dto.refreshToken;
    } else {
      assertCookieRequestIsSameSite(req, this.env);
      token = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
    }
    if (!token) throw new AppException('UNAUTHENTICATED', 'Session is no longer valid. Please sign in again.', 401);
    try {
      return this.deliver(req, res, await this.auth.refresh(token, clientContext(req)));
    } catch (e) {
      if (!mobile) clearRefreshCookie(res, this.env); // dead cookie: stop the browser resending it
      throw e;
    }
  }

  /** Public so a browser whose access token already expired can still sign out via its cookie. */
  @Public()
  @Throttle(limit(30))
  @Post('logout')
  @HttpCode(204)
  async logout(@Body() dto: RefreshDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const mobile = isMobileClient(req);
    if (!mobile) assertCookieRequestIsSameSite(req, this.env);
    const token = mobile ? dto.refreshToken : (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
    await this.auth.logout(token ?? null, null, clientContext(req));
    if (!mobile) clearRefreshCookie(res, this.env);
  }

  @Public()
  @Throttle(limit(5))
  @Post('forgot-password')
  @HttpCode(202)
  async forgotPassword(@Body() dto: EmailOnlyDto, @Req() req: Request) {
    await this.auth.forgotPassword(dto.email, clientContext(req));
    return { data: { message: 'If an account exists for that address, a reset e-mail has been sent.' } };
  }

  @Public()
  @Throttle(limit(10))
  @Post('reset-password')
  @HttpCode(204)
  async resetPassword(@Body() dto: ResetPasswordDto, @Req() req: Request) {
    await this.auth.resetPassword(dto.token, dto.newPassword, clientContext(req));
  }

  // ---------------- authenticated ----------------

  @ApiBearerAuth()
  @AllowWithoutMfa()
  @Get('me')
  me(@CurrentUser() user: AuthenticatedUser) {
    return this.auth.me(user).then((data) => ({ data }));
  }

  @ApiBearerAuth()
  @AllowWithoutMfa()
  @Post('logout-all')
  @HttpCode(200)
  async logoutAll(@CurrentUser() user: AuthenticatedUser, @Body() dto: LogoutAllDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const revoked = await this.auth.logoutAll(user, dto.keepCurrent === true, clientContext(req));
    if (dto.keepCurrent !== true) clearRefreshCookie(res, this.env);
    return { data: { revoked } };
  }

  @ApiBearerAuth()
  @Get('sessions')
  async sessions(@CurrentUser() user: AuthenticatedUser) {
    return { data: await this.auth.listSessions(user) };
  }

  @ApiBearerAuth()
  @Delete('sessions/:id')
  @HttpCode(204)
  async revokeSession(@CurrentUser() user: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request) {
    await this.auth.revokeOwnSession(user, id, clientContext(req));
  }

  @ApiBearerAuth()
  @Throttle(limit(5))
  @Post('change-password')
  @HttpCode(204)
  async changePassword(@CurrentUser() user: AuthenticatedUser, @Body() dto: ChangePasswordDto, @Req() req: Request) {
    await this.auth.changePassword(user, dto, clientContext(req));
  }

  @ApiBearerAuth()
  @AllowWithoutMfa()
  @Throttle(limit(5))
  @Post('mfa/setup')
  @HttpCode(200)
  async mfaSetup(@CurrentUser() user: AuthenticatedUser, @Body() dto: MfaSetupDto) {
    return { data: await this.auth.mfaSetup(user, dto.password) };
  }

  @ApiBearerAuth()
  @AllowWithoutMfa()
  @Throttle(limit(10))
  @Post('mfa/enable')
  @HttpCode(200)
  async mfaEnable(@CurrentUser() user: AuthenticatedUser, @Body() dto: MfaEnableDto, @Req() req: Request) {
    return { data: await this.auth.mfaEnable(user, dto.code, clientContext(req)) };
  }

  @ApiBearerAuth()
  @AllowWithoutMfa()
  @Throttle(limit(5))
  @Post('mfa/disable')
  @HttpCode(204)
  async mfaDisable(@CurrentUser() user: AuthenticatedUser, @Body() dto: MfaDisableDto, @Req() req: Request) {
    await this.auth.mfaDisable(user, dto.password, dto.code, clientContext(req));
  }
}
