import { defineConfig } from "vitest/config";

// pi-tui's suite is written for `node:test` and runs through the package
// `test` script (`node --test test/*.test.ts`). Vitest cannot execute
// `node:test`-style tests, so the repo's projects-mode `vitest run` is
// pointed at no files here and allowed to pass with none. Convert a test
// file to vitest's API and add it to `include` to opt it in.
export default defineConfig({
	test: {
		include: [],
		passWithNoTests: true,
	},
});
