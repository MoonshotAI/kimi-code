/**
 * Opt-in render profiler for diagnosing TUI render and stdout-write cost.
 *
 * Enabled via the `PI_TUI_RENDER_PROFILE` environment variable:
 *   - unset / empty   -> disabled (near-zero overhead)
 *   - "1" / "true"    -> write JSONL to ~/.pi/agent/pi-render-profile.jsonl
 *   - any other value -> treated as the output file path
 *
 * Records every terminal write (duration, byte size, backpressure signal) and a
 * per-frame summary (build time, line count, full-redraw flag, event-loop lag).
 * Used to investigate streaming render stutter, especially on Windows where
 * ConPTY / Windows Terminal stdout writes are significantly more expensive than
 * on Unix pseudoterminals.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";

type EventLoopHistogram = ReturnType<typeof monitorEventLoopDelay>;

const FLUSH_RECORD_THRESHOLD = 100;

function resolveProfilePath(envValue: string): string {
	if (envValue === "1" || envValue.toLowerCase() === "true") {
		return path.join(os.homedir(), ".pi", "agent", "pi-render-profile.jsonl");
	}
	return envValue;
}

function roundMs(value: number): number {
	return Math.round(value * 1000) / 1000;
}

function nsToMs(ns: number): number {
	return Math.round((ns / 1e6) * 1000) / 1000;
}

export class RenderProfiler {
	readonly enabled: boolean;
	private readonly filePath: string;
	private pending: string[] = [];
	private histogram: EventLoopHistogram | undefined;
	private closed = false;

	constructor(envValue: string | undefined) {
		this.enabled = Boolean(envValue);
		if (!this.enabled) {
			this.filePath = "";
			return;
		}
		this.filePath = resolveProfilePath(envValue as string);
		try {
			fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
			// Start each profiled run with a clean file so sessions do not interleave.
			fs.writeFileSync(this.filePath, "");
		} catch {
			// Best-effort: if the file cannot be prepared, profiling silently no-ops.
		}
		try {
			const histogram = monitorEventLoopDelay({ resolution: 20 });
			histogram.enable();
			this.histogram = histogram;
		} catch {
			this.histogram = undefined;
		}
	}

	/** Record a single stdout write: how long it took, its size, and whether the
	 *  stream signalled backpressure (`write` returned false). */
	recordWrite(durationMs: number, bytes: number, ok: boolean): void {
		this.record({
			kind: "write",
			ms: roundMs(durationMs),
			bytes,
			ok,
		});
	}

	/** Record a completed render frame with build cost and a since-last-frame
	 *  event-loop lag snapshot. */
	recordFrame(fields: {
		fullRedraw: boolean;
		lines: number;
		height: number;
		buildMs: number;
		totalMs: number;
	}): void {
		this.record({
			kind: "frame",
			fullRedraw: fields.fullRedraw,
			lines: fields.lines,
			height: fields.height,
			buildMs: roundMs(fields.buildMs),
			totalMs: roundMs(fields.totalMs),
			el: this.snapshotEventLoop(),
		});
	}

	private record(entry: Record<string, unknown>): void {
		if (!this.enabled || this.closed) return;
		this.pending.push(`${JSON.stringify({ t: Date.now(), ...entry })}\n`);
		if (this.pending.length >= FLUSH_RECORD_THRESHOLD) {
			this.flushAsync();
		}
	}

	private snapshotEventLoop(): { meanMs: number; maxMs: number } | undefined {
		if (!this.histogram) return undefined;
		// `mean` is NaN while the histogram has no samples yet (e.g. the very
		// first frame); coerce to 0 so the JSONL stays numeric for parsers.
		const mean = this.histogram.mean;
		const snapshot = {
			meanMs: Number.isFinite(mean) ? nsToMs(mean) : 0,
			maxMs: nsToMs(this.histogram.max),
		};
		this.histogram.reset();
		return snapshot;
	}

	private flushAsync(): void {
		if (this.pending.length === 0) return;
		const chunk = this.pending.join("");
		this.pending = [];
		fs.promises.appendFile(this.filePath, chunk).catch(() => {});
	}

	/** Synchronously flush any buffered records. Safe to call at shutdown. */
	flush(): void {
		if (!this.enabled || this.pending.length === 0) return;
		try {
			fs.appendFileSync(this.filePath, this.pending.join(""));
		} catch {
			// Ignore flush errors
		}
		this.pending = [];
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.flush();
		this.histogram?.disable();
		this.histogram = undefined;
	}
}

let singleton: RenderProfiler | undefined;

export function getRenderProfiler(): RenderProfiler {
	if (!singleton) {
		singleton = new RenderProfiler(process.env["PI_TUI_RENDER_PROFILE"]);
	}
	return singleton;
}
