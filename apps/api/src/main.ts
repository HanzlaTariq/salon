import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap';
import { parseEnv } from './config/env';

async function main(): Promise<void> {
  const env = parseEnv(); // fail fast on bad config
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  configureApp(app, env);
  app.enableShutdownHooks();
  await app.listen(env.PORT);
  app.get(Logger).log(`API listening on :${env.PORT} (${env.NODE_ENV})`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
