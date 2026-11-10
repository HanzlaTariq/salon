import { Inject, Injectable, Logger } from '@nestjs/common';
import { ENV, Env } from '../../config/env';
import { Mailer } from '../auth/mail/mailer';

export interface InvitationMail {
  to: string;
  salonName: string;
  displayName: string;
  rawToken: string;
  expiresAt: Date;
}

/**
 * Sends the staff invitation e-mail. The token travels in the URL FRAGMENT (#token=...), like the other
 * auth e-mails, so it never reaches a server, proxy or Referer header. Failures are logged, never thrown:
 * the invitation row already exists and the owner can resend.
 */
@Injectable()
export class InvitationMailer {
  private readonly logger = new Logger(InvitationMailer.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly mailer: Mailer,
  ) {}

  async send(m: InvitationMail): Promise<void> {
    const link = `${this.env.WEB_APP_URL.replace(/\/$/, '')}/accept-invitation#token=${encodeURIComponent(m.rawToken)}`;
    try {
      await this.mailer.send({
        to: m.to,
        subject: `Invitation to join ${m.salonName}`,
        text:
          `Hello ${m.displayName},\n\n` +
          `${m.salonName} has invited you to join its team. Open this link to create your account ` +
          `(valid until ${m.expiresAt.toISOString()}, single use):\n${link}\n\n` +
          'If you were not expecting this invitation, ignore this message.',
      });
    } catch (err) {
      this.logger.error({ err }, 'Failed to send staff invitation e-mail');
    }
  }
}
