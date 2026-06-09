import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["*.ts"],
      exclude: ["index.ts", "vitest.config.ts", "tests/**"],
    },
  },
});
