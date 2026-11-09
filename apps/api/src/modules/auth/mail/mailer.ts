import { Inject, Injectable, Logger } from '@nestjs/common';
import { createTransport, Transporter } from 'nodemailer';
import { ENV, Env } from '../../../config/env';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export abstract class Mailer {
  abstract send(message: MailMessage): Promise<void>;
}

/**
 * Development/test transport: keeps messages in memory (bounded) so tests can read links, and logs
 * only recipient + subject. Refused in production by parseEnv (MAIL_TRANSPORT must be smtp).
 */
@Injectable()
export class ConsoleMailer extends Mailer {
  private readonly logger = new Logger('Mailer');
  readonly outbox: MailMessage[] = [];

  async send(message: MailMessage): Promise<void> {
    this.outbox.push(message);
    if (this.outbox.length > 100) this.outbox.shift();
    this.logger.log(`[dev mail] to=${message.to} subject="${message.subject}"`);
  }
}

@Injectable()
export class SmtpMailer extends Mailer {
  private readonly transporter: Transporter;

  constructor(@Inject(ENV) private readonly env: Env) {
    super();
    this.transporter = createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      requireTLS: !env.SMTP_SECURE, // refuse to downgrade to plaintext SMTP
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    });
  }

  async send(message: MailMessage): Promise<void> {
    await this.transporter.sendMail({ from: this.env.MAIL_FROM, to: message.to, subject: message.subject, text: message.text });
  }
}
