import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

const apiPort = Number(process.env.PORT) || 5174;
const webPort = Number(process.env.WEB_PORT) || 5173;

// When set, build a single self-contained index.html (JS+CSS inlined) into
// `dist-single/` so it can be embedded into the kimi CLI. The normal `dist/`
// build is unaffected.
const singlefile = process.env.VIS_SINGLEFILE === '1';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    ...(singlefile
      ? [
          viteSingleFile({
            useRecommendedBuildConfig: true,
            deleteInlinedFiles: true,
          }),
        ]
      : []),
  ],
  server: {
    port: webPort,
    strictPort: false,
    proxy: {
      '/api': {
        target: `http://localhost:${apiPort}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: singlefile ? 'dist-single' : 'dist',
    emptyOutDir: true,
    target: 'es2022',
  },
});
