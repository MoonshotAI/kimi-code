import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    index: './src/index.ts',
    protocol: './src/protocol/index.ts',
  },
  format: ['esm'],
  dts: true,
  outDir: 'dist',
  clean: true,
  deps: {
    neverBundle: [
      '@agentclientprotocol/sdk',
      '@moonshot-ai/agent-core',
      '@moonshot-ai/kimi-code-sdk',
      '@moonshot-ai/kosong',
      '@moonshot-ai/kaos',
    ],
  },
});
