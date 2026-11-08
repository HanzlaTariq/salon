import { Global, Module } from '@nestjs/common';
import { ENV, parseEnv } from './env';

@Global()
@Module({
  providers: [{ provide: ENV, useFactory: () => parseEnv() }],
  exports: [ENV],
})
export class AppConfigModule {}
