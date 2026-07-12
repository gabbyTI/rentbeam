import type { Config } from 'jest';

const config: Config = {
  // CJS preset: ts-jest compiles .ts → CommonJS so jest.mock factories work reliably.
  // The source code still ships as ESM; only the test runner uses CJS output.
  preset: 'ts-jest/presets/default',
  testEnvironment: 'node',
  moduleNameMapper: {
    // Strip .js extensions from imports so ts-jest resolves .ts source files
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: {
          esModuleInterop: true,
          // Override module to CommonJS for the test environment only
          module: 'CommonJS',
        },
      },
    ],
  },
  testMatch: ['**/tests/**/*.test.ts'],
  collectCoverageFrom: [
    'src/services/**/*.ts',
    'src/jobs/**/*.ts',
    'src/routes/**/*.ts',
    '!src/**/*.d.ts',
  ],
  clearMocks: true,
};

export default config;
