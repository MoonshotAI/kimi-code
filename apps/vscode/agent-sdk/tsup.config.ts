import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "index.ts",
    schema: "schema.ts",
    errors: "errors.ts",
    utils: "utils.ts",
    paths: "paths.ts",
  },

  format: ["esm", "cjs"],
  outDir: "dist",

  dts: {
    entry: {
      index: "index.ts",
      schema: "schema.ts",
      errors: "errors.ts",
      utils: "utils.ts",
      paths: "paths.ts",
    },
  },

  splitting: false,
  clean: true,
  sourcemap: true,
  treeshake: true,

  target: "node18",
  platform: "node",
  external: ["node:*"],

  define: {
    "process.env.BROWSER": "false",
  },
});
