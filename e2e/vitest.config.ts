import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      // The published ESM build of @1inch/swap-vm-sdk imports this CJS submodule
      // without a file extension, which Node's strict ESM loader rejects.
      '@1inch/byte-utils/dist/constants': '@1inch/byte-utils/dist/constants.js',
    },
  },
  test: {
    globals: true,
    globalSetup: './globalSetup.ts',
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    pool: 'forks',
    server: {
      deps: {
        inline: ['@1inch/swap-vm-sdk', '@1inch/aqua-sdk', '@1inch/sdk-core', '@1inch/byte-utils'],
      },
    },
  },
})
