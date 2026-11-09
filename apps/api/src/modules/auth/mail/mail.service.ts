import { Inject, Injectable, Logger } from '@nestjs/common';
import { ENV, Env } from '../../../config/env';
import { Mailer } from './mailer';

/**
 * Transactional auth e-mails. Links carry the token in the URL FRAGMENT (#token=...), which browsers
 * never send to servers, proxies or Referer headers. A mail failure is logged, never surfaced to the
 * caller, so responses cannot be used to probe whether an address exists.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly mailer: Mailer,
  ) {}

  private link(path: string, token: string): string {
    return `${this.env.WEB_APP_URL.replace(/\/$/, '')}${path}#token=${encodeURIComponent(token)}`;
  }

  private async safeSend(to: string, subject: string, text: string): Promise<void> {
    try {
      await this.mailer.send({ to, subject, text });
    } catch (err) {
      this.logger.error({ err }, 'Failed to send e-mail');
    }
  }

  sendVerification(to: string, name: string, token: string) {
    return this.safeSend(
      to,
      'Verify your e-mail address',
      `Hello ${name},\n\nConfirm your e-mail address to activate your account (link valid for 24 hours):\n${this.link('/verify-email', token)}\n\nIf you did not create an account, ignore this message.`,
    );
  }

  sendAccountExists(to: string, name: string) {
    return this.safeSend(
      to,
      'You already have an account',
      `Hello ${name},\n\nSomeone tried to register with this e-mail address, but an account already exists. If this was you, sign in or use "Forgot password". If not, no action is needed.`,
    );
  }

  sendPasswordReset(to: string, name: string, token: string) {
    return this.safeSend(
      to,
      'Reset your password',
      `Hello ${name},\n\nUse this link to choose a new password (valid for 30 minutes, single use):\n${this.link('/reset-password', token)}\n\nIf you did not request this, ignore this message; your password has not changed.`,
    );
  }

  sendPasswordChanged(to: string, name: string) {
    return this.safeSend(
      to,
      'Your password was changed',
      `Hello ${name},\n\nYour password was just changed and all other devices were signed out. If this was not you, reset your password immediately and contact support.`,
    );
  }

  // ---- Phase 3: salon application lifecycle ----

  sendSalonSubmittedToAdmin(to: string, adminName: string, salonName: string, city: string) {
    return this.safeSend(
      to,
      'New salon application to review',
      `Hello ${adminName},\n\nA new salon application is waiting for review:\n  ${salonName} (${city})\n\nOpen the admin dashboard > Salons > Pending to review it.`,
    );
  }

  sendSalonApproved(to: string, name: string, salonName: string) {
    return this.safeSend(
      to,
      'Your salon has been approved',
      `Hello ${name},\n\nGood news: "${salonName}" has been approved and is now visible to customers.`,
    );
  }

  sendSalonRejected(to: string, name: string, salonName: string, reason: string) {
    return this.safeSend(
      to,
      'Your salon application needs changes',
      `Hello ${name},\n\nWe could not approve "${salonName}" yet.\n\nReason: ${reason}\n\nOpen the app, correct the details and submit again.`,
    );
  }

  sendSalonSuspended(to: string, name: string, salonName: string, reason: string) {
    return this.safeSend(
      to,
      'Your salon has been suspended',
      `Hello ${name},\n\n"${salonName}" is no longer visible to customers.\n\nReason: ${reason}\n\nPlease contact support if you believe this is a mistake.`,
    );
  }

  sendSalonReactivated(to: string, name: string, salonName: string) {
    return this.safeSend(
      to,
      'Your salon is active again',
      `Hello ${name},\n\n"${salonName}" has been reactivated and is visible to customers again.`,
    );
  }
}
