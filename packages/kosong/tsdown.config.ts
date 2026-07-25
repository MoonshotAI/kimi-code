import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: [
    './src/index.ts',
    './src/providers/kimi.ts',
    './src/providers/openai-legacy.ts',
    './src/providers/openai-responses.ts',
    './src/providers/anthropic-profile.ts',
    './src/providers/anthropic.ts',
    './src/providers/google-genai.ts',
    './src/providers/openai-common.ts',
  ],
  format: ['esm'],
  dts: true,
  outDir: 'dist',
  clean: true,
});
