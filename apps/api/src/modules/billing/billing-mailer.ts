import { Inject, Injectable, Logger } from '@nestjs/common';
import { ENV, Env } from '../../config/env';
import { Mailer } from '../auth/mail/mailer';

/**
 * E-mails for the manual payment workflow. Failures are logged and never thrown: the decision is already saved and
 * the owner also sees it in the app. No receipt, transaction id or account number is ever put in an e-mail.
 * (Push notifications and scheduled expiry reminders arrive with Phase 10.)
 */
@Injectable()
export class BillingMailer {
  private readonly logger = new Logger(BillingMailer.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly mailer: Mailer,
  ) {}

  private async send(to: string, subject: string, text: string): Promise<void> {
    try {
      await this.mailer.send({ to, subject, text });
    } catch (err) {
      this.logger.error({ err }, 'Failed to send billing e-mail');
    }
  }

  async paymentSubmitted(reviewers: Array<{ email: string; fullName: string }>, p: { salonName: string; invoiceNo: string; amount: string }): Promise<void> {
    const link = `${this.env.WEB_APP_URL.replace(/\/$/, '')}/payments`;
    await Promise.all(reviewers.map((r) => this.send(r.email, `Payment to verify: ${p.salonName}`,
      `Hello ${r.fullName},\n\n${p.salonName} submitted a payment of Rs. ${p.amount} for invoice ${p.invoiceNo}. Check the receipt against your account and decide here:\n${link}\n`)));
  }

  paymentApproved(to: { email: string; fullName: string }, p: { salonName: string; invoiceNo: string; amount: string }): Promise<void> {
    return this.send(to.email, `Payment verified: ${p.invoiceNo}`,
      `Hello ${to.fullName},\n\nYour payment of Rs. ${p.amount} for invoice ${p.invoiceNo} (${p.salonName}) was verified. Your subscription is up to date.\n`);
  }

  paymentRejected(to: { email: string; fullName: string }, p: { salonName: string; invoiceNo: string; reason: string }): Promise<void> {
    return this.send(to.email, `Payment could not be verified: ${p.invoiceNo}`,
      `Hello ${to.fullName},\n\nWe could not verify your payment for invoice ${p.invoiceNo} (${p.salonName}).\nReason: ${p.reason}\n\nInvoice ${p.invoiceNo} is still open: you can submit a new payment in the app.\n`);
  }

  infoRequested(to: { email: string; fullName: string }, p: { salonName: string; invoiceNo: string; message: string }): Promise<void> {
    return this.send(to.email, `More information needed: ${p.invoiceNo}`,
      `Hello ${to.fullName},\n\nTo verify your payment for invoice ${p.invoiceNo} (${p.salonName}) we need more information:\n${p.message}\n\nOpen the app, go to Subscription, and answer the request.\n`);
  }
}
