import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Forces the token cache off, pins its path into a temp dir, and fails the
    // suite if anything reached the real ~/.myhotlunchbox-mcp — see tests/_setup.ts.
    setupFiles: ['./tests/_setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
    },
  },
});
