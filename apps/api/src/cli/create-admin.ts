import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { AuditService } from '../modules/audit/audit.service';
import { AuthRepository } from '../modules/auth/auth.repository';
import { PasswordService } from '../modules/auth/password.service';

/**
 * Creates (or refuses to duplicate) a SUPER_ADMIN account. There is deliberately NO API endpoint
 * that can create platform accounts, so privilege escalation through the web is impossible.
 *
 *   ADMIN_EMAIL=you@example.com ADMIN_NAME="Your Name" ADMIN_PASSWORD='long unique passphrase' npm run admin:create
 *
 * Nothing is hardcoded; unset ADMIN_PASSWORD from your shell history/environment afterwards.
 * The admin must enrol MFA at first login (REQUIRE_ADMIN_MFA).
 */
async function main(): Promise<void> {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const name = process.env.ADMIN_NAME?.trim();
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !name || !password) throw new Error('ADMIN_EMAIL, ADMIN_NAME and ADMIN_PASSWORD are required.');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const passwords = app.get(PasswordService);
    const problems = passwords.policyProblems(password, { email, fullName: name });
    if (problems.length > 0) throw new Error(`Password rejected: ${problems.join(' ')}`);

    const user = await app.get(AuthRepository).createUser({
      email,
      phone: null,
      passwordHash: await passwords.hash(password),
      fullName: name,
      role: 'SUPER_ADMIN',
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    });
    if (!user) throw new Error('An account with that e-mail already exists. Nothing was changed.');
    await app.get(AuditService).record({
      action: 'admin.super_admin_created',
      targetType: 'user',
      targetId: user.id,
      metadata: { via: 'cli' },
    });
    // eslint-disable-next-line no-console
    console.log(`SUPER_ADMIN created: ${user.email} (${user.id}). MFA enrolment is required at first sign-in.`);
  } finally {
    await app.close();
  }
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
