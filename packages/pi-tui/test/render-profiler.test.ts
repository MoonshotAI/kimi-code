import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { RenderProfiler } from "../src/render-profiler.ts";

describe("RenderProfiler", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rp-test-"));
	});

	afterEach(() => {
		try {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// ignore cleanup errors
		}
	});

	it("is disabled and writes nothing when env is unset", () => {
		const file = path.join(tmpDir, "nope.jsonl");
		const profiler = new RenderProfiler(undefined);
		assert.equal(profiler.enabled, false);
		profiler.recordWrite(1.2, 100, true);
		profiler.recordFrame({ fullRedraw: false, lines: 10, height: 5, buildMs: 0.1, totalMs: 0.2 });
		profiler.close();
		assert.equal(fs.existsSync(file), false);
	});

	it("records writes and frames as JSONL when enabled via a custom path", () => {
		const file = path.join(tmpDir, "profile.jsonl");
		const profiler = new RenderProfiler(file);
		assert.equal(profiler.enabled, true);
		profiler.recordWrite(1.2345, 5678, true);
		profiler.recordFrame({ fullRedraw: false, lines: 42, height: 24, buildMs: 0.567, totalMs: 3.1234 });
		profiler.close();

		const lines = fs.readFileSync(file, "utf8").trim().split("\n");
		assert.equal(lines.length, 2);

		const write = JSON.parse(lines[0]!);
		assert.equal(write.kind, "write");
		assert.equal(write.ok, true);
		assert.equal(write.bytes, 5678);
		// duration is rounded to millisecond precision
		assert.equal(write.ms, 1.235);

		const frame = JSON.parse(lines[1]!);
		assert.equal(frame.kind, "frame");
		assert.equal(frame.fullRedraw, false);
		assert.equal(frame.lines, 42);
		assert.equal(frame.height, 24);
		assert.equal(frame.buildMs, 0.567);
		assert.equal(frame.totalMs, 3.123);
		assert.equal(typeof frame.el.meanMs, "number");
		assert.equal(typeof frame.el.maxMs, "number");
	});

	it("creates the parent directory when it does not exist", () => {
		const nested = path.join(tmpDir, "a", "b", "profile.jsonl");
		const profiler = new RenderProfiler(nested);
		profiler.recordWrite(0.1, 1, true);
		profiler.close();
		assert.equal(fs.existsSync(nested), true);
	});

	it("records backpressure via the write ok flag", () => {
		const file = path.join(tmpDir, "bp.jsonl");
		const profiler = new RenderProfiler(file);
		profiler.recordWrite(10, 4096, false);
		profiler.close();
		const rec = JSON.parse(fs.readFileSync(file, "utf8").trim());
		assert.equal(rec.ok, false);
	});
});
