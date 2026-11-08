// E2E and security tests (no real database needed in Phase 1)
module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
  testMatch: ['<rootDir>/test/**/*.e2e-spec.ts'],
};
