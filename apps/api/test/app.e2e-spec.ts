// Env must be set BEFORE importing AppModule (it validates env at import time).
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://x:x@localhost:5432/x';
process.env.CORS_ORIGINS = 'https://admin.example.test';
process.env.LOG_LEVEL = 'silent';
process.env.JWT_ACCESS_SECRET = 'test-secret-'.padEnd(48, 'x');
process.env.MFA_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
process.env.RATE_LIMIT_MAX = '5';
process.env.RATE_LIMIT_TTL_MS = '60000';

import { Controller, Get, INestApplication, Post, Body } from '@nestjs/common';
import { Public } from '../src/common/auth/decorators';
import { Test } from '@nestjs/testing';
import { IsString } from 'class-validator';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { parseEnv } from '../src/config/env';
import { PrismaService } from '../src/prisma/prisma.service';

class EchoDto {
  @IsString() name!: string;
}

@Public()
@Controller('probe')
class ProbeController {
  @Get('boom') boom() {
    throw new Error('SELECT * FROM secrets -- internal detail');
  }
  @Post('echo') echo(@Body() dto: EchoDto) {
    return { data: dto };
  }
}

describe('API foundation (security + conventions)', () => {
  it('protects every non-@Public route by default (401 without a token)', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/auth/me').expect(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule], controllers: [ProbeController] })
      .overrideProvider(PrismaService)
      .useValue({
        $connect: async () => undefined,
        $disconnect: async () => undefined,
        $queryRaw: async () => [{ '?column?': 1 }],
      })
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app, parseEnv());
    await app.init();
  });

  afterAll(async () => app.close());

  it('GET /api/v1/health returns ok', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/health').expect(200);
    expect(res.body).toEqual({ data: { status: 'ok' } });
  });

  it('GET /api/v1/health/ready checks the database', async () => {
    await request(app.getHttpServer()).get('/api/v1/health/ready').expect(200);
  });

  it('sets security headers and hides x-powered-by', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('unknown routes use the error envelope with a requestId', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/nope').expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.error.requestId).toBe(res.headers['x-request-id']);
  });

  it('never leaks internals on unhandled errors', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/probe/boom').expect(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(res.body)).not.toMatch(/SELECT|secrets|stack|at Object/i);
  });

  it('rejects unknown body properties (mass-assignment protection)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/probe/echo')
      .send({ name: 'ok', role: 'SUPER_ADMIN', salonId: 'other-salon' })
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('allows only allowlisted CORS origins', async () => {
    const ok = await request(app.getHttpServer())
      .get('/api/v1/health')
      .set('Origin', 'https://admin.example.test');
    expect(ok.headers['access-control-allow-origin']).toBe('https://admin.example.test');
    const bad = await request(app.getHttpServer()).get('/api/v1/health/').set('Origin', 'https://evil.test');
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('rate limits non-exempt routes (429 in error envelope)', async () => {
    let last = 0;
    for (let i = 0; i < 8; i++) {
      const r = await request(app.getHttpServer()).post('/api/v1/probe/echo').send({ name: 'x' });
      last = r.status;
      if (last === 429) {
        expect(r.body.error.code).toBe('RATE_LIMITED');
        return;
      }
    }
    throw new Error(`expected a 429, last status was ${last}`);
  });
});
