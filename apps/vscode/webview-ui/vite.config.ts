import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import cssInjectedByJsPlugin from "vite-plugin-css-injected-by-js";
import { resolve } from "node:path";

const webviewRoot = import.meta.dirname;

export default defineConfig({
  root: webviewRoot,
  plugins: [react(), tailwindcss(), cssInjectedByJsPlugin()],
  publicDir: resolve(webviewRoot, "public"),
  resolve: {
    alias: {
      "@": resolve(webviewRoot, "./src"),
      shared: resolve(webviewRoot, "../shared"),
    },
  },
  define: {
    "process.env.NODE_ENV": '"production"',
  },
  build: {
    outDir: resolve(webviewRoot, "../dist"),
    emptyOutDir: false,
    lib: {
      entry: resolve(webviewRoot, "src/main.tsx"),
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
