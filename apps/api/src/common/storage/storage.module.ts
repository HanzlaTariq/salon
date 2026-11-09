import { Global, Module } from '@nestjs/common';
import { ENV, Env } from '../../config/env';
import { MemoryObjectStorage, ObjectStorage, SupabaseObjectStorage } from './object-storage';

@Global()
@Module({
  providers: [
    {
      provide: ObjectStorage,
      inject: [ENV],
      useFactory: (env: Env): ObjectStorage => (env.STORAGE_DRIVER === 'supabase' ? new SupabaseObjectStorage(env) : new MemoryObjectStorage()),
    },
  ],
  exports: [ObjectStorage],
})
export class StorageModule {}
