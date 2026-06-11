import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import cssInjectedByJsPlugin from "vite-plugin-css-injected-by-js";
import { resolve } from "path";

export default defineConfig({
  plugins: [react(), tailwindcss(), cssInjectedByJsPlugin()],
  publicDir: "public",
  resolve: {
    alias: [
      { find: "@", replacement: resolve(__dirname, "./src") },
      { find: "shared", replacement: resolve(__dirname, "../shared") },
      { find: /^@moonshot-ai\/kimi-code-vscode-agent-sdk$/, replacement: resolve(__dirname, "../agent-sdk/index.ts") },
      { find: "@moonshot-ai/kimi-code-vscode-agent-sdk/errors", replacement: resolve(__dirname, "../agent-sdk/errors.ts") },
      { find: "@moonshot-ai/kimi-code-vscode-agent-sdk/schema", replacement: resolve(__dirname, "../agent-sdk/schema.ts") },
    ],
  },
  define: {
    "process.env.NODE_ENV": '"production"',
  },
  build: {
    outDir: "../dist",
    emptyOutDir: false,
    lib: {
      entry: resolve(__dirname, "src/main.tsx"),
      name: "KimiWebview",
      fileName: () => "webview.js",
      formats: ["iife"],
    },
    rollupOptions: {
      output: {
        entryFileNames: "webview.js",
        assetFileNames: "webview.css",
      },
    },
  },
});
