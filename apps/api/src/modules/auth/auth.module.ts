import { Global, Module } from '@nestjs/common';
import { Clock } from '../../common/util/clock';
import { ENV, Env } from '../../config/env';
import { AuthController } from './auth.controller';
import { AuthRepository } from './auth.repository';
import { AuthService } from './auth.service';
import { AuthorizationGuard, JwtAuthGuard } from './guards';
import { MailService } from './mail/mail.service';
import { ConsoleMailer, Mailer, SmtpMailer } from './mail/mailer';
import { MfaCrypto } from './mfa-crypto';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';

@Global()
@Module({
  controllers: [AuthController],
  providers: [
    Clock,
    AuthRepository,
    AuthService,
    PasswordService,
    TokenService,
    MailService,
    JwtAuthGuard,
    AuthorizationGuard,
    { provide: MfaCrypto, inject: [ENV], useFactory: (env: Env) => new MfaCrypto(env.MFA_ENCRYPTION_KEY) },
    {
      provide: Mailer,
      inject: [ENV],
      useFactory: (env: Env) => (env.MAIL_TRANSPORT === 'smtp' ? new SmtpMailer(env) : new ConsoleMailer()),
    },
  ],
  exports: [Clock, AuthRepository, AuthService, TokenService, PasswordService, Mailer, JwtAuthGuard, AuthorizationGuard],
})
export class AuthModule {}
