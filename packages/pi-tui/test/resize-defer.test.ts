import assert from "node:assert";
import { describe, it } from "node:test";
import { type Component, TUI } from "../src/tui.ts";
import { LoggingVirtualTerminal } from "./virtual-terminal.ts";

class TestComponent implements Component {
	lines: string[] = [];
	render(_w: number): string[] {
		return this.lines;
	}
	invalidate(): void {}
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Env vars that make isMultiplexerSession() return true. The non-mux fast path is
// gated on `!isMultiplexerSession()`, so a non-mux test must clear these — the
// developer/CI shell often runs inside tmux/cmux, which would otherwise force the
// mux path and make the assertions vacuous.
const MUX_ENV_KEYS = ["TMUX", "STY", "ZELLIJ", "CMUX_WORKSPACE_ID", "CMUX_SURFACE_ID"] as const;

function snapshotMuxEnv(): Record<string, string | undefined> {
	const snap: Record<string, string | undefined> = {};
	for (const key of MUX_ENV_KEYS) snap[key] = process.env[key];
	return snap;
}

function restoreMuxEnv(snap: Record<string, string | undefined>): void {
	for (const key of MUX_ENV_KEYS) {
		if (snap[key] === undefined) delete process.env[key];
		else process.env[key] = snap[key];
	}
}

function clearMuxEnv(): void {
	for (const key of MUX_ENV_KEYS) delete process.env[key];
}

async function withLedger<T>(run: () => Promise<T>): Promise<T> {
	const prevEngine = process.env["PI_TUI_ENGINE"];
	const prevMux = snapshotMuxEnv();
	process.env["PI_TUI_ENGINE"] = "ledger";
	clearMuxEnv();
	try {
		return await run();
	} finally {
		if (prevEngine === undefined) delete process.env["PI_TUI_ENGINE"];
		else process.env["PI_TUI_ENGINE"] = prevEngine;
		restoreMuxEnv(prevMux);
	}
}

async function withLedgerMux<T>(run: () => Promise<T>): Promise<T> {
	const prevEngine = process.env["PI_TUI_ENGINE"];
	const prevMux = snapshotMuxEnv();
	process.env["PI_TUI_ENGINE"] = "ledger";
	process.env["TMUX"] = "x";
	try {
		return await run();
	} finally {
		if (prevEngine === undefined) delete process.env["PI_TUI_ENGINE"];
		else process.env["PI_TUI_ENGINE"] = prevEngine;
		restoreMuxEnv(prevMux);
	}
}

const ALT_ENTER = "\x1b[?1049h";
const ALT_EXIT = "\x1b[?1049l";
const ED3 = "\x1b[3J";

describe("ledger resize viewport defer", () => {
	it("uses the alt-screen fast path during a resize drag (no ED3)", async () => {
		await withLedger(async () => {
			const terminal = new LoggingVirtualTerminal(40, 10);
			const tui = new TUI(terminal);
			const c = new TestComponent();
			tui.addChild(c);
			c.lines = ["alpha", "beta", "gamma"];
			tui.start();
			await terminal.waitForRender();
			terminal.clearWrites();

			// Fire several resizes in quick succession to mimic a drag.
			for (const [w, h] of [[42, 10], [44, 12], [46, 12], [48, 14]] as const) {
				terminal.resize(w, h);
				tui.requestRender();
				await terminal.waitForRender();
			}

			const writes = terminal.getWrites();
			assert.ok(writes.includes(ALT_ENTER), `drag should enter the alt-screen; got: ${JSON.stringify(writes)}`);
			assert.ok(!writes.includes(ED3), `drag must not clear scrollback (ED3); got: ${JSON.stringify(writes)}`);
			tui.stop();
		});
	});

	it("performs an authoritative repaint after the drag settles", async () => {
		await withLedger(async () => {
			const terminal = new LoggingVirtualTerminal(40, 10);
			const tui = new TUI(terminal);
			const c = new TestComponent();
			tui.addChild(c);
			c.lines = ["alpha", "beta", "gamma"];
			tui.start();
			await terminal.waitForRender();

			for (const [w, h] of [[42, 10], [44, 12], [46, 12]] as const) {
				terminal.resize(w, h);
				tui.requestRender();
				await terminal.waitForRender();
			}

			const redrawsAfterDrag = tui.fullRedraws;
			terminal.clearWrites();

			// Settle is 120ms; wait well past it with no further renders so the
			// deferred authoritative repaint fires.
			await sleep(250);

			const writes = terminal.getWrites();
			assert.ok(writes.includes(ALT_EXIT), `settle should exit the alt-screen; got: ${JSON.stringify(writes)}`);
			assert.ok(
				tui.fullRedraws > redrawsAfterDrag,
				`settle should trigger an authoritative repaint (fullRedraws ${redrawsAfterDrag} -> ${tui.fullRedraws})`,
			);
			tui.stop();
		});
	});

	it("skips the alt-screen path under a multiplexer session", async () => {
		await withLedgerMux(async () => {
			const terminal = new LoggingVirtualTerminal(40, 10);
			const tui = new TUI(terminal);
			const c = new TestComponent();
			tui.addChild(c);
			c.lines = ["alpha", "beta", "gamma"];
			tui.start();
			await terminal.waitForRender();
			terminal.clearWrites();

			terminal.resize(48, 14);
			tui.requestRender();
			await terminal.waitForRender();

			const writes = terminal.getWrites();
			assert.ok(!writes.includes(ALT_ENTER), `mux must not enter the alt-screen; got: ${JSON.stringify(writes)}`);
			tui.stop();
		});
	});
});
