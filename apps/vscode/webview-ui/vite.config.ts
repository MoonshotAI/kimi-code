import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import cssInjectedByJsPlugin from "vite-plugin-css-injected-by-js";
import { resolve } from "path";

export default defineConfig({
  plugins: [react(), tailwindcss(), cssInjectedByJsPlugin()],
  publicDir: "public",
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
      shared: resolve(__dirname, "../shared"),
    },
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
