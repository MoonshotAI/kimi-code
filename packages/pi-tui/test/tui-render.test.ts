import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Terminal as XtermTerminalType } from "@xterm/headless";
import { type AnimationClock, AnimationFrameScheduler } from "../src/animation-frame.ts";
import { Box } from "../src/components/box.ts";
import { Image } from "../src/components/image.ts";
import { Input } from "../src/components/input.ts";
import { Text } from "../src/components/text.ts";
import type { Terminal } from "../src/terminal.ts";
import {
	deleteKittyImage,
	encodeKitty,
	resetCapabilitiesCache,
	setCapabilities,
	setCellDimensions,
} from "../src/terminal-image.ts";
import {
	offsetRenderLine,
	prefixRenderLine,
	RENDER_LINES,
	renderComponentLines,
	renderLineTexts,
	truncateRenderLine,
	type TuiRenderLine,
	withRenderLineSelectionRegion,
} from "../src/render-line.ts";
import {
	type Component,
	compositeTuiRenderLine,
	Container,
	CURSOR_MARKER,
	renderFakeCursor,
	type TUI,
} from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { sliceByColumn } from "../src/utils.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class TestComponent implements Component {
	lines: string[] = [];
	render(_width: number): string[] {
		return this.lines;
	}
	invalidate(): void {}
}

class InputComponent extends TestComponent {
	renderCount = 0;

	override render(width: number): string[] {
		this.renderCount += 1;
		return super.render(width);
	}

	handleInput(data: string): void {
		this.lines = [data];
	}
}

const MAX_RENDER_WRITE_CHARS = 1024 * 1024;

class BoundedWriteTerminal implements Terminal {
	readonly writes: string[] = [];
	columns = 80;
	rows = 24;
	readonly kittyProtocolActive = false;

	start(_onInput: (data: string) => void, _onResize: () => void): void {}
	stop(): void {}
	async drainInput(_maxMs?: number, _idleMs?: number): Promise<void> {}
	write(data: string): void {
		this.writes.push(data);
	}
	moveBy(_lines: number): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}
	setProgramStatus(): void {}
}

class LoggingVirtualTerminal extends VirtualTerminal {
	private writes: string[] = [];

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}

	getWrites(): string {
		return this.writes.join("");
	}

	clearWrites(): void {
		this.writes = [];
	}
}

async function withEnv<T>(updates: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
	const previousValues = new Map<string, string | undefined>();
	for (const [key, value] of Object.entries(updates)) {
		previousValues.set(key, process.env[key]);
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}

	try {
		return await run();
	} finally {
		for (const [key, value] of previousValues) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	}
}

function getCellItalic(terminal: VirtualTerminal, row: number, col: number): number {
	const xterm = (terminal as unknown as { xterm: XtermTerminalType }).xterm;
	const buffer = xterm.buffer.active;
	const line = buffer.getLine(buffer.viewportY + row);
	assert.ok(line, `Missing buffer line at row ${row}`);
	const cell = line.getCell(col);
	assert.ok(cell, `Missing cell at row ${row} col ${col}`);
	return cell.isItalic();
}

class ManualClock implements AnimationClock {
	private time = 0;
	private nextId = 1;
	private readonly timers = new Map<number, { readonly due: number; readonly callback: () => void }>();

	get pendingTimers(): number {
		return this.timers.size;
	}

	now(): number {
		return this.time;
	}

	setTimeout(callback: () => void, delayMs: number): unknown {
		const id = this.nextId++;
		this.timers.set(id, { due: this.time + delayMs, callback });
		return id;
	}

	clearTimeout(handle: unknown): void {
		this.timers.delete(handle as number);
	}

	advance(ms: number): void {
		const end = this.time + ms;
		for (let next = this.earliest(); next !== undefined && next[1].due <= end; next = this.earliest()) {
			this.timers.delete(next[0]);
			this.time = Math.max(this.time, next[1].due);
			next[1].callback();
		}
		this.time = end;
	}

	/** Fires the earliest timer at `time`, which may be before its due time or long after it. */
	runNextTimerAt(time: number): void {
		const next = this.earliest();
		assert.ok(next, "no pending timer");
		this.timers.delete(next[0]);
		this.time = time;
		next[1].callback();
	}

	private earliest(): [number, { readonly due: number; readonly callback: () => void }] | undefined {
		let earliest: [number, { readonly due: number; readonly callback: () => void }] | undefined;
		for (const entry of this.timers) {
			if (earliest === undefined || entry[1].due < earliest[1].due) earliest = entry;
		}
		return earliest;
	}
}

function animatedTui(): { clock: ManualClock; tui: TuiMainScreen } {
	const clock = new ManualClock();
	return { clock, tui: new TuiMainScreen(new VirtualTerminal(40, 10), undefined, undefined, clock) };
}

describe("TUI animation frames", () => {
	it("runs every request of a frame once with the same timestamp on the frame grid", () => {
		const { clock, tui } = animatedTui();
		clock.advance(50);
		const times: number[] = [];
		tui.requestAnimationFrame((time) => times.push(time));
		tui.requestAnimationFrame((time) => times.push(time));

		clock.advance(69);
		assert.deepStrictEqual(times, []);
		clock.advance(1);
		assert.deepStrictEqual(times, [120, 120]);
		clock.advance(1000);
		assert.deepStrictEqual(times, [120, 120]);
		assert.strictEqual(clock.pendingTimers, 0);
	});

	it("runs a request made inside a callback on the next frame", () => {
		const { clock, tui } = animatedTui();
		const times: number[] = [];
		const step = (time: number): void => {
			times.push(time);
			if (times.length < 3) tui.requestAnimationFrame(step);
		};
		tui.requestAnimationFrame(step);

		clock.advance(120);
		assert.deepStrictEqual(times, [120]);
		clock.advance(240);
		assert.deepStrictEqual(times, [120, 240, 360]);
		assert.strictEqual(clock.pendingTimers, 0);
	});

	it("keeps no timer without requests and ignores repeated and unknown cancels", () => {
		const { clock, tui } = animatedTui();
		const calls: string[] = [];
		assert.strictEqual(clock.pendingTimers, 0);

		const first = tui.requestAnimationFrame(() => calls.push("first"));
		let third = 0;
		tui.requestAnimationFrame(() => {
			calls.push("second");
			tui.cancelAnimationFrame(third);
		});
		third = tui.requestAnimationFrame(() => calls.push("third"));
		assert.strictEqual(clock.pendingTimers, 1);
		tui.cancelAnimationFrame(first);
		tui.cancelAnimationFrame(first);
		tui.cancelAnimationFrame(12345);
		clock.advance(120);
		assert.deepStrictEqual(calls, ["second"]);
		assert.strictEqual(clock.pendingTimers, 0);

		tui.cancelAnimationFrame(tui.requestAnimationFrame(() => calls.push("fourth")));
		assert.strictEqual(clock.pendingTimers, 0);
		clock.advance(1000);
		assert.deepStrictEqual(calls, ["second"]);
	});

	it("keeps the grid timestamp when a timer fires early or late and skips missed frames", () => {
		const { clock, tui } = animatedTui();
		const times: number[] = [];
		const step = (time: number): void => {
			times.push(time);
			if (times.length < 3) tui.requestAnimationFrame(step);
		};
		tui.requestAnimationFrame(step);

		clock.runNextTimerAt(118);
		assert.deepStrictEqual(times, [120]);
		clock.runNextTimerAt(370);
		assert.deepStrictEqual(times, [120, 360]);
		clock.advance(109);
		assert.deepStrictEqual(times, [120, 360]);
		clock.advance(1);
		assert.deepStrictEqual(times, [120, 360, 480]);
	});

	it("pauses on stop and resumes on the next frame after start without replaying missed frames", () => {
		const { clock, tui } = animatedTui();
		tui.start();
		const times: number[] = [];
		const step = (time: number): void => {
			times.push(time);
			tui.requestAnimationFrame(step);
		};
		tui.requestAnimationFrame(step);
		clock.advance(120);
		assert.deepStrictEqual(times, [120]);

		tui.stop();
		assert.strictEqual(clock.pendingTimers, 0);
		clock.advance(1000);
		assert.deepStrictEqual(times, [120]);

		tui.start();
		clock.advance(79);
		assert.deepStrictEqual(times, [120]);
		clock.advance(1);
		assert.deepStrictEqual(times, [120, 1200]);
		tui.stop();
	});

	it("runs frames at the rate the host sets", () => {
		const { clock, tui } = animatedTui();
		const times: number[] = [];
		const step = (time: number): void => {
			times.push(time);
			if (times.length < 3) tui.requestAnimationFrame(step);
		};
		tui.requestAnimationFrame(step);
		tui.setAnimationFrameRate(20);

		clock.advance(49);
		assert.deepStrictEqual(times, []);
		clock.advance(1);
		assert.deepStrictEqual(times, [50]);
		clock.advance(100);
		assert.deepStrictEqual(times, [50, 100, 150]);
		assert.strictEqual(clock.pendingTimers, 0);
	});

	it("waits one new interval after the last frame when the rate changes, however often it changes", () => {
		const { clock, tui } = animatedTui();
		const times: number[] = [];
		const step = (time: number): void => {
			times.push(time);
			if (times.length < 3) tui.requestAnimationFrame(step);
		};
		tui.requestAnimationFrame(step);
		clock.advance(130);
		assert.deepStrictEqual(times, [120]);

		for (const fps of [1, 2, 1, 20]) tui.setAnimationFrameRate(fps);
		clock.advance(39);
		assert.deepStrictEqual(times, [120]);
		clock.advance(1);
		assert.deepStrictEqual(times, [120, 170]);
		clock.advance(50);
		assert.deepStrictEqual(times, [120, 170, 220]);
		assert.strictEqual(clock.pendingTimers, 0);
	});

	it("accepts whole frame rates from 1 to 60 and rejects the rest without changing the current one", () => {
		const { clock, tui } = animatedTui();
		tui.setAnimationFrameRate(60);
		tui.setAnimationFrameRate(1);
		for (const fps of [0, 61, 0.5, 30.5, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
			assert.throws(() => tui.setAnimationFrameRate(fps), RangeError, `accepted ${fps}`);
		}
		const times: number[] = [];
		tui.requestAnimationFrame((time) => times.push(time));
		clock.advance(1000);
		assert.deepStrictEqual(times, [1000]);
	});

	it("runs the other callbacks and later frames when a callback throws, then rethrows the first error", (t) => {
		const queued: (() => void)[] = [];
		t.mock.method(globalThis, "queueMicrotask", (callback: () => void) => {
			queued.push(callback);
		});
		const { clock, tui } = animatedTui();
		const calls: string[] = [];
		tui.requestAnimationFrame(() => {
			throw new Error("first failure");
		});
		tui.requestAnimationFrame(() => {
			throw new Error("second failure");
		});
		tui.requestAnimationFrame((time) => {
			calls.push(`frame ${time}`);
			tui.requestAnimationFrame((next) => calls.push(`frame ${next}`));
		});

		clock.advance(120);
		assert.deepStrictEqual(calls, ["frame 120"]);
		assert.strictEqual(queued.length, 1);
		assert.throws(() => queued[0]?.(), /first failure/);
		clock.advance(120);
		assert.deepStrictEqual(calls, ["frame 120", "frame 240"]);
	});

	it("lets the process exit while a callback keeps requesting frames", () => {
		const scheduler = new URL("../src/animation-frame.ts", import.meta.url).href;
		const script = `
			import { AnimationFrameScheduler } from ${JSON.stringify(scheduler)};
			const frames = new AnimationFrameScheduler();
			let count = 0;
			const step = () => {
				count += 1;
				frames.requestAnimationFrame(step);
			};
			frames.requestAnimationFrame(step);
			setTimeout(() => console.log(count), 500);
		`;
		const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
			encoding: "utf8",
			timeout: 10_000,
		});

		assert.strictEqual(child.signal, null, "the process kept running until the timeout killed it");
		assert.strictEqual(child.status, 0, child.stderr);
		assert.ok(Number(child.stdout) >= 1, `frames ran ${child.stdout.trim()} times`);
	});

	it("keeps the timers and clock it was created with when the globals are replaced later", async (t) => {
		const frames = new AnimationFrameScheduler();
		const replacedSetTimeout = t.mock.method(globalThis, "setTimeout");
		const replacedNow = t.mock.method(performance, "now");

		await new Promise((resolve) => frames.requestAnimationFrame(resolve));

		assert.strictEqual(replacedSetTimeout.mock.callCount(), 0, "the frame was scheduled on the replaced setTimeout");
		assert.strictEqual(replacedNow.mock.callCount(), 0, "the frame read the replaced performance.now");
	});
});

describe("TUI input dispatch", () => {
	for (const mode of ["regular", "fullscreen"] as const) {
		it(`routes public input through listeners to the focused component in ${mode} mode`, async () => {
			const terminal = new VirtualTerminal(40, 10);
			const tui: TUI = mode === "regular" ? new TuiMainScreen(terminal) : new TuiAltScreen(terminal);
			const component = new InputComponent();
			const receivedByListener: string[] = [];
			tui.addChild(component);
			tui.setFocus(component);
			tui.addInputListener((data) => {
				receivedByListener.push(data);
				return { data: data.toUpperCase() };
			});
			tui.start();
			try {
				await terminal.waitForRender();
				tui.dispatchInput("paste");
				assert.deepStrictEqual(receivedByListener, ["paste"]);
				assert.deepStrictEqual(component.lines, ["PASTE"]);
			} finally {
				tui.stop();
			}
		});
	}
});

describe("TUI render scheduling", () => {
	it("renders keyboard input without waiting for a throttled frame", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui: TUI = new TuiMainScreen(terminal);
		const component = new InputComponent();
		component.lines = ["initial"];
		tui.addChild(component);
		tui.setFocus(component);
		tui.start();
		tui.renderNow();
		const renderCountBeforeInput = component.renderCount;

		// Queue a normal throttled render first. Keyboard input should preempt it.
		component.lines = ["pending"];
		tui.requestRender();
		terminal.sendInput("first");
		terminal.sendInput("second");
		terminal.sendInput("typed");
		await new Promise<void>((resolve) => process.nextTick(resolve));

		assert.strictEqual(component.renderCount, renderCountBeforeInput + 1);
		assert.deepStrictEqual(component.lines, ["typed"]);
		tui.stop();
	});
});

describe("TUI debug logging", () => {
	it("writes redraw logs to the provided directory", async () => {
		const logDir = mkdtempSync(join(tmpdir(), "pi-tui-log-"));
		try {
			await withEnv({ PI_TUI_DEBUG_REDRAW: "1" }, async () => {
				const terminal = new VirtualTerminal(40, 10);
				const tui: TUI = new TuiMainScreen(terminal, undefined, logDir);
				const component = new TestComponent();
				tui.addChild(component);
				component.lines = ["test"];
				tui.start();
				await terminal.waitForRender();

				assert.match(readFileSync(join(logDir, "pi-tui-debug.log"), "utf-8"), /fullRender: first render/);
				tui.stop();
			});
		} finally {
			rmSync(logDir, { recursive: true, force: true });
		}
	});
});

describe("TUI bounded render output", () => {
	it("does not write duplicate cursor markers to the terminal", () => {
		const terminal = new BoundedWriteTerminal();
		const tui = new TuiMainScreen(terminal);
		const component = new TestComponent();
		// Regression for #9257: terminals may render the payload of a leaked APC marker.
		component.lines = [`\x1b[31m界🙂\x1b[0m${CURSOR_MARKER} world${CURSOR_MARKER}`];
		tui.addChild(component);

		tui.renderNow();

		const output = terminal.writes.join("");
		assert.ok(output.includes("\x1b[31m界🙂\x1b[0m world"), "visible styled text should be preserved");
		assert.ok(!output.includes(CURSOR_MARKER), "internal cursor markers must not reach the terminal");
		assert.ok(output.includes("\x1b[5G"), "the first marker should keep the cursor at visible column 4");
	});

	it("does not write cursor markers from other visible or scrollback lines", () => {
		const terminal = new BoundedWriteTerminal();
		terminal.rows = 2;
		const tui = new TuiMainScreen(terminal);
		const component = new TestComponent();
		// Regression for #9257: cursor extraction must not leave markers on other rendered lines.
		component.lines = [`offscreen${CURSOR_MARKER}`, `a${CURSOR_MARKER}`, `visible-b${CURSOR_MARKER}`];
		tui.addChild(component);

		tui.renderNow();

		const output = terminal.writes.join("");
		assert.ok(output.includes("offscreen"), "full renders should preserve scrollback content");
		assert.ok(output.includes("a"), "full renders should preserve other visible lines");
		assert.ok(!output.includes(CURSOR_MARKER), "internal cursor markers must not reach the terminal");
		assert.ok(output.includes("\x1b[10G"), "the bottom visible marker should determine the cursor column");
	});

	it("splits a large full render without changing its output", () => {
		const terminal = new BoundedWriteTerminal();
		const tui = new TuiMainScreen(terminal);
		const component = new TestComponent();
		const kittyLine = `\x1b_Ga=T,f=100;${"A".repeat(1_200_000)}\x1b\\`;
		component.lines = [kittyLine, kittyLine];
		tui.addChild(component);

		tui.renderNow();

		assert.ok(terminal.writes.length > 2, "large output should be split across terminal writes");
		assert.ok(
			terminal.writes.every((write) => write.length <= MAX_RENDER_WRITE_CHARS),
			"each terminal write should stay below the configured limit",
		);
		assert.strictEqual(
			terminal.writes.join(""),
			`\x1b[?2026h${kittyLine}\r\n${kittyLine}\x1b[?2026l`,
			"chunking must preserve the synchronized render output",
		);
	});

	it("splits large differential updates without a full redraw", () => {
		const terminal = new BoundedWriteTerminal();
		const tui = new TuiMainScreen(terminal);
		const component = new TestComponent();
		tui.addChild(component);
		component.lines = ["before"];
		tui.renderNow();
		terminal.writes.length = 0;

		const kittyLine = `\x1b_Ga=T,f=100;${"A".repeat(1_200_000)}\x1b\\`;
		component.lines = ["before", kittyLine, kittyLine];
		tui.renderNow();

		assert.ok(terminal.writes.length > 2, "large output should be split across terminal writes");
		assert.ok(terminal.writes.every((write) => write.length <= MAX_RENDER_WRITE_CHARS));
		const output = terminal.writes.join("");
		assert.ok(output.startsWith("\x1b[?2026h"));
		assert.ok(output.endsWith("\x1b[?2026l"));
		assert.ok(!output.includes("\x1b[2J"), "the update should stay on the differential render path");
	});
});

describe("TUI OSC 133 markers", () => {
	it("does not write OSC 133 prompt markers to the terminal", () => {
		// Terminals read 133;A as a new shell prompt and drop the OSC 7501 program status.
		const terminal = new BoundedWriteTerminal();
		const tui = new TuiMainScreen(terminal);
		const component = new TestComponent();
		tui.addChild(component);
		component.lines = ["\x1b]133;A\x07prompt", "\x1b]133;B\x07\x1b]133;C\x07output"];
		tui.renderNow();
		component.lines = [...component.lines, "\x1b]133;A\x1b\\reply", "\x1b]133;B\x1b\\\x1b]133;C\x1b\\done"];
		tui.renderNow();

		const output = terminal.writes.join("");
		assert.ok(!output.includes("\x1b]133;"), "regular mode must not emit OSC 133 markers");
		for (const text of ["prompt", "output", "reply", "done"]) assert.ok(output.includes(text));
	});
});

describe("TUI Kitty image cleanup", () => {
	it("clears reserved Kitty image rows before drawing appended image placements", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		try {
			const terminal = new LoggingVirtualTerminal(40, 10);
			const tui: TUI = new TuiMainScreen(terminal);
			const component = new TestComponent();
			tui.addChild(component);

			component.lines = ["before"];
			tui.start();
			await terminal.waitForRender();
			terminal.clearWrites();

			const image = new Image(
				"AAAA",
				"image/png",
				{ fallbackColor: (value) => value },
				{ maxWidthCells: 2 },
				{ widthPx: 20, heightPx: 20 },
			);
			const imageLines = image.render(40);
			const imageSequence = imageLines[0];
			component.lines = ["before", ...imageLines, "after"];
			tui.requestRender();
			await terminal.waitForRender();

			const writes = terminal.getWrites();
			assert.ok(
				writes.includes(`\x1b[2K\r\n\x1b[2K\x1b[1A${imageSequence}\x1b[1B`),
				"reserved rows should be cleared before the image placement is drawn",
			);
			assert.ok(
				!writes.includes(`${imageSequence}\r\n\x1b[2K`),
				"reserved row clears must not run after the image placement is drawn",
			);

			tui.stop();
		} finally {
			resetCapabilitiesCache();
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	it("falls back to full redraw when Kitty image pre-clear would scroll", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		try {
			const terminal = new LoggingVirtualTerminal(40, 2);
			const tui: TUI = new TuiMainScreen(terminal);
			const component = new TestComponent();
			tui.addChild(component);

			component.lines = ["before"];
			tui.start();
			await terminal.waitForRender();
			const redrawsBeforeImage = tui.fullRedraws;
			terminal.clearWrites();

			const image = new Image(
				"AAAA",
				"image/png",
				{ fallbackColor: (value) => value },
				{ maxWidthCells: 3 },
				{ widthPx: 30, heightPx: 30 },
			);
			component.lines = ["before", ...image.render(40), "after"];
			tui.requestRender();
			await terminal.waitForRender();

			assert.ok(tui.fullRedraws > redrawsBeforeImage, "unsafe image pre-clear should force a full redraw");
			assert.ok(terminal.getWrites().includes("\x1b[2J"), "fallback should clear and fully redraw");

			tui.stop();
		} finally {
			resetCapabilitiesCache();
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	it("reserves Kitty image rows before drawing during full redraw fallbacks", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		try {
			const terminal = new LoggingVirtualTerminal(40, 5);
			const tui: TUI = new TuiMainScreen(terminal);
			const component = new TestComponent();
			tui.addChild(component);

			component.lines = ["l0", "l1", "l2", "l3", "l4"];
			tui.start();
			await terminal.waitForRender();
			const redrawsBeforeImage = tui.fullRedraws;
			terminal.clearWrites();

			const image = new Image(
				"AAAA",
				"image/png",
				{ fallbackColor: (value) => value },
				{ maxWidthCells: 3 },
				{ widthPx: 30, heightPx: 30 },
			);
			const imageLines = image.render(40);
			const imageSequence = imageLines[0];
			component.lines = ["l0", "l1", "l2", "l3", "l4", ...imageLines, "after"];
			tui.requestRender();
			await terminal.waitForRender();

			const writes = terminal.getWrites();
			assert.ok(tui.fullRedraws > redrawsBeforeImage, "scrolling image append should force a full redraw");
			assert.ok(
				writes.includes(`\r\n\r\n\x1b[2A${imageSequence}\x1b[2B`),
				"full redraw should reserve visible image rows before drawing the placement",
			);
			assert.ok(
				!writes.includes(`${imageSequence}\r\n\x1b[0m`),
				"full redraw must not write reserved padding rows after drawing the placement",
			);

			tui.stop();
		} finally {
			resetCapabilitiesCache();
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	it("does not use cursor-up placement for Kitty images taller than the viewport", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		try {
			const terminal = new LoggingVirtualTerminal(40, 5);
			const tui: TUI = new TuiMainScreen(terminal);
			const component = new TestComponent();
			tui.addChild(component);

			component.lines = ["before"];
			tui.start();
			await terminal.waitForRender();
			terminal.clearWrites();

			const image = new Image(
				"AAAA",
				"image/png",
				{ fallbackColor: (value) => value },
				{ maxWidthCells: 6 },
				{ widthPx: 60, heightPx: 60 },
			);
			const imageLines = image.render(40);
			const imageSequence = imageLines[0];
			assert.ok(imageLines.length > terminal.rows, "test image should exceed the viewport height");

			component.lines = ["before", ...imageLines, "after"];
			tui.requestRender(true);
			await terminal.waitForRender();

			const writes = terminal.getWrites();
			assert.ok(writes.includes(imageSequence), "image placement should be drawn");
			assert.ok(
				!writes.includes(`\x1b[${imageLines.length - 1}A${imageSequence}`),
				"taller-than-viewport images must keep the #4461 first-row placement path",
			);

			tui.stop();
		} finally {
			resetCapabilitiesCache();
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	it("deletes changed image ids before drawing moved placements", async () => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui: TUI = new TuiMainScreen(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		const oldImage = encodeKitty("AAAA", { columns: 2, rows: 2, imageId: 42, moveCursor: false });
		component.lines = ["top", oldImage];
		tui.start();
		await terminal.waitForRender();
		terminal.clearWrites();

		const newImage = encodeKitty("BBBB", { columns: 2, rows: 1, imageId: 42, moveCursor: false });
		component.lines = [newImage, ""];
		tui.requestRender();
		await terminal.waitForRender();

		const writes = terminal.getWrites();
		const deleteIndex = writes.indexOf(deleteKittyImage(42));
		const drawIndex = writes.indexOf(newImage);
		assert.ok(deleteIndex >= 0, "changed old image should be deleted");
		assert.ok(drawIndex >= 0, "new image should be drawn");
		assert.ok(deleteIndex < drawIndex, "old image must be deleted before the new placement is drawn");

		tui.stop();
	});

	it("redraws image lines when an earlier reserved image row changes", async () => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui: TUI = new TuiMainScreen(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		const image = encodeKitty("AAAA", { columns: 2, rows: 2, imageId: 88, moveCursor: false });
		component.lines = ["", image];
		tui.start();
		await terminal.waitForRender();
		terminal.clearWrites();

		component.lines = ["covered", image];
		tui.requestRender();
		await terminal.waitForRender();

		const writes = terminal.getWrites();
		const deleteIndex = writes.indexOf(deleteKittyImage(88));
		const drawIndex = writes.indexOf(image);
		assert.ok(deleteIndex >= 0, "image should be deleted when a reserved row changes");
		assert.ok(drawIndex >= 0, "unchanged image line should be redrawn after deleting the placement");
		assert.ok(deleteIndex < drawIndex, "old placement must be deleted before the image line is redrawn");
		assert.ok(!writes.includes("\x1b[2J"), "reserved row changes should not force a full redraw");

		tui.stop();
	});

	it("deletes previously rendered image ids during full redraws", async () => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui: TUI = new TuiMainScreen(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = [encodeKitty("AAAA", { columns: 2, rows: 2, imageId: 77, moveCursor: false })];
		tui.start();
		await terminal.waitForRender();
		terminal.clearWrites();

		component.lines = ["plain text"];
		tui.requestRender(true);
		await terminal.waitForRender();

		const writes = terminal.getWrites();
		const deleteIndex = writes.indexOf(deleteKittyImage(77));
		const clearIndex = writes.indexOf("\x1b[2J");
		assert.ok(deleteIndex >= 0, "previous image should be deleted during full redraw");
		assert.ok(clearIndex >= 0, "full redraw should clear the screen");
		assert.ok(deleteIndex < clearIndex, "old image should be deleted before the screen is cleared");

		tui.stop();
	});
});

describe("TUI resize handling", () => {
	it("triggers full re-render when terminal height changes", async () => {
		await withEnv({ TERMUX_VERSION: undefined }, async () => {
			const terminal = new VirtualTerminal(40, 10);
			const tui: TUI = new TuiMainScreen(terminal);
			const component = new TestComponent();
			tui.addChild(component);

			component.lines = ["Line 0", "Line 1", "Line 2"];
			tui.start();
			await terminal.waitForRender();

			const initialRedraws = tui.fullRedraws;

			// Resize height
			terminal.resize(40, 15);
			await terminal.waitForRender();

			// Should have triggered a full redraw
			assert.ok(tui.fullRedraws > initialRedraws, "Height change should trigger full redraw");

			const viewport = terminal.getViewport();
			assert.ok(viewport[0]?.includes("Line 0"), "Content preserved after height change");

			tui.stop();
		});
	});

	it("skips full re-render on height changes in Termux", async () => {
		await withEnv({ TERMUX_VERSION: "1" }, async () => {
			const terminal = new LoggingVirtualTerminal(40, 10);
			const tui: TUI = new TuiMainScreen(terminal);
			const component = new TestComponent();
			tui.addChild(component);

			component.lines = Array.from({ length: 20 }, (_, i) => `Line ${i}`);
			tui.start();
			await terminal.waitForRender();
			terminal.clearWrites();

			const initialRedraws = tui.fullRedraws;
			for (const height of [15, 8, 14, 11]) {
				terminal.resize(40, height);
				await terminal.waitForRender();
			}

			assert.strictEqual(tui.fullRedraws, initialRedraws, "Height change should not trigger full redraw");
			assert.ok(!terminal.getWrites().includes("\x1b[2J"), "Height change should not clear the screen");
			assert.ok(!terminal.getWrites().includes("\x1b[3J"), "Height change should not clear scrollback");

			const viewport = terminal.getViewport();
			assert.ok(viewport.join("\n").includes("Line 19"), "Latest content remains visible after resize");

			tui.stop();
		});
	});

	it("triggers full re-render when terminal width changes", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui: TUI = new TuiMainScreen(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = ["Line 0", "Line 1", "Line 2"];
		tui.start();
		await terminal.waitForRender();

		const initialRedraws = tui.fullRedraws;

		// Resize width
		terminal.resize(60, 10);
		await terminal.waitForRender();

		// Should have triggered a full redraw
		assert.ok(tui.fullRedraws > initialRedraws, "Width change should trigger full redraw");

		tui.stop();
	});
});

describe("TUI content shrinkage", () => {
	it("clears empty rows when content shrinks significantly", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui: TUI = new TuiMainScreen(terminal);
		tui.setClearOnShrink(true); // Explicitly enable (may be disabled via env var)
		const component = new TestComponent();
		tui.addChild(component);

		// Start with many lines
		component.lines = ["Line 0", "Line 1", "Line 2", "Line 3", "Line 4", "Line 5"];
		tui.start();
		await terminal.waitForRender();

		const initialRedraws = tui.fullRedraws;

		// Shrink to fewer lines
		component.lines = ["Line 0", "Line 1"];
		tui.requestRender();
		await terminal.waitForRender();

		// Should have triggered a full redraw to clear empty rows
		assert.ok(tui.fullRedraws > initialRedraws, "Content shrinkage should trigger full redraw");

		const viewport = terminal.getViewport();
		assert.ok(viewport[0]?.includes("Line 0"), "First line preserved");
		assert.ok(viewport[1]?.includes("Line 1"), "Second line preserved");
		// Lines below should be empty (cleared)
		assert.strictEqual(viewport[2]?.trim(), "", "Line 2 should be cleared");
		assert.strictEqual(viewport[3]?.trim(), "", "Line 3 should be cleared");

		tui.stop();
	});

	it("handles shrink to single line", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui: TUI = new TuiMainScreen(terminal);
		tui.setClearOnShrink(true); // Explicitly enable (may be disabled via env var)
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = ["Line 0", "Line 1", "Line 2", "Line 3"];
		tui.start();
		await terminal.waitForRender();

		// Shrink to single line
		component.lines = ["Only line"];
		tui.requestRender();
		await terminal.waitForRender();

		const viewport = terminal.getViewport();
		assert.ok(viewport[0]?.includes("Only line"), "Single line rendered");
		assert.strictEqual(viewport[1]?.trim(), "", "Line 1 should be cleared");

		tui.stop();
	});

	it("handles shrink to empty", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui: TUI = new TuiMainScreen(terminal);
		tui.setClearOnShrink(true); // Explicitly enable (may be disabled via env var)
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = ["Line 0", "Line 1", "Line 2"];
		tui.start();
		await terminal.waitForRender();

		// Shrink to empty
		component.lines = [];
		tui.requestRender();
		await terminal.waitForRender();

		const viewport = terminal.getViewport();
		// All lines should be empty
		assert.strictEqual(viewport[0]?.trim(), "", "Line 0 should be cleared");
		assert.strictEqual(viewport[1]?.trim(), "", "Line 1 should be cleared");

		tui.stop();
	});
});

describe("TUI differential rendering", () => {
	it("tracks cursor correctly when content shrinks with unchanged remaining lines", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui: TUI = new TuiMainScreen(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		// Initial render: 5 identical lines
		component.lines = ["Line 0", "Line 1", "Line 2", "Line 3", "Line 4"];
		tui.start();
		await terminal.waitForRender();

		// Shrink to 3 lines, all identical to before (no content changes in remaining lines)
		component.lines = ["Line 0", "Line 1", "Line 2"];
		tui.requestRender();
		await terminal.waitForRender();

		// cursorRow should be 2 (last line of new content)
		// Verify by doing another render with a change on line 1
		component.lines = ["Line 0", "CHANGED", "Line 2"];
		tui.requestRender();
		await terminal.waitForRender();

		const viewport = terminal.getViewport();
		// Line 1 should show "CHANGED", proving cursor tracking was correct
		assert.ok(viewport[1]?.includes("CHANGED"), `Expected "CHANGED" on line 1, got: ${viewport[1]}`);

		tui.stop();
	});

	it("renders correctly when only a middle line changes (spinner case)", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui: TUI = new TuiMainScreen(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		// Initial render
		component.lines = ["Header", "Working...", "Footer"];
		tui.start();
		await terminal.waitForRender();

		// Simulate spinner animation - only middle line changes
		const spinnerFrames = ["|", "/", "-", "\\"];
		for (const frame of spinnerFrames) {
			component.lines = ["Header", `Working ${frame}`, "Footer"];
			tui.requestRender();
			await terminal.waitForRender();

			const viewport = terminal.getViewport();
			assert.ok(viewport[0]?.includes("Header"), `Header preserved: ${viewport[0]}`);
			assert.ok(viewport[1]?.includes(`Working ${frame}`), `Spinner updated: ${viewport[1]}`);
			assert.ok(viewport[2]?.includes("Footer"), `Footer preserved: ${viewport[2]}`);
		}

		tui.stop();
	});

	it("resets styles after each rendered line", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const tui: TUI = new TuiMainScreen(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = ["\x1b[3mItalic", "Plain"];
		tui.start();
		await terminal.waitForRender();

		assert.strictEqual(getCellItalic(terminal, 1, 0), 0);
		tui.stop();
	});

	it("renders correctly when first line changes but rest stays same", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui: TUI = new TuiMainScreen(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = ["Line 0", "Line 1", "Line 2", "Line 3"];
		tui.start();
		await terminal.waitForRender();

		// Change only first line
		component.lines = ["CHANGED", "Line 1", "Line 2", "Line 3"];
		tui.requestRender();
		await terminal.waitForRender();

		const viewport = terminal.getViewport();
		assert.ok(viewport[0]?.includes("CHANGED"), `First line changed: ${viewport[0]}`);
		assert.ok(viewport[1]?.includes("Line 1"), `Line 1 preserved: ${viewport[1]}`);
		assert.ok(viewport[2]?.includes("Line 2"), `Line 2 preserved: ${viewport[2]}`);
		assert.ok(viewport[3]?.includes("Line 3"), `Line 3 preserved: ${viewport[3]}`);

		tui.stop();
	});

	it("renders correctly when last line changes but rest stays same", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui: TUI = new TuiMainScreen(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = ["Line 0", "Line 1", "Line 2", "Line 3"];
		tui.start();
		await terminal.waitForRender();

		// Change only last line
		component.lines = ["Line 0", "Line 1", "Line 2", "CHANGED"];
		tui.requestRender();
		await terminal.waitForRender();

		const viewport = terminal.getViewport();
		assert.ok(viewport[0]?.includes("Line 0"), `Line 0 preserved: ${viewport[0]}`);
		assert.ok(viewport[1]?.includes("Line 1"), `Line 1 preserved: ${viewport[1]}`);
		assert.ok(viewport[2]?.includes("Line 2"), `Line 2 preserved: ${viewport[2]}`);
		assert.ok(viewport[3]?.includes("CHANGED"), `Last line changed: ${viewport[3]}`);

		tui.stop();
	});

	it("renders correctly when multiple non-adjacent lines change", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui: TUI = new TuiMainScreen(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = ["Line 0", "Line 1", "Line 2", "Line 3", "Line 4"];
		tui.start();
		await terminal.waitForRender();

		// Change lines 1 and 3, keep 0, 2, 4 the same
		component.lines = ["Line 0", "CHANGED 1", "Line 2", "CHANGED 3", "Line 4"];
		tui.requestRender();
		await terminal.waitForRender();

		const viewport = terminal.getViewport();
		assert.ok(viewport[0]?.includes("Line 0"), `Line 0 preserved: ${viewport[0]}`);
		assert.ok(viewport[1]?.includes("CHANGED 1"), `Line 1 changed: ${viewport[1]}`);
		assert.ok(viewport[2]?.includes("Line 2"), `Line 2 preserved: ${viewport[2]}`);
		assert.ok(viewport[3]?.includes("CHANGED 3"), `Line 3 changed: ${viewport[3]}`);
		assert.ok(viewport[4]?.includes("Line 4"), `Line 4 preserved: ${viewport[4]}`);

		tui.stop();
	});

	it("handles transition from content to empty and back to content", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui: TUI = new TuiMainScreen(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		// Start with content
		component.lines = ["Line 0", "Line 1", "Line 2"];
		tui.start();
		await terminal.waitForRender();

		let viewport = terminal.getViewport();
		assert.ok(viewport[0]?.includes("Line 0"), "Initial content rendered");

		// Clear to empty
		component.lines = [];
		tui.requestRender();
		await terminal.waitForRender();

		// Add content back - this should work correctly even after empty state
		component.lines = ["New Line 0", "New Line 1"];
		tui.requestRender();
		await terminal.waitForRender();

		viewport = terminal.getViewport();
		assert.ok(viewport[0]?.includes("New Line 0"), `New content rendered: ${viewport[0]}`);
		assert.ok(viewport[1]?.includes("New Line 1"), `New content line 1: ${viewport[1]}`);

		tui.stop();
	});

	it("full re-renders when deleted lines move the viewport upward", async () => {
		const terminal = new VirtualTerminal(20, 5);
		const tui: TUI = new TuiMainScreen(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = Array.from({ length: 12 }, (_, i) => `Line ${i}`);
		tui.start();
		await terminal.waitForRender();

		const initialRedraws = tui.fullRedraws;

		component.lines = Array.from({ length: 7 }, (_, i) => `Line ${i}`);
		tui.requestRender();
		await terminal.waitForRender();

		assert.ok(tui.fullRedraws > initialRedraws, "Shrink should trigger a full redraw");
		assert.deepStrictEqual(terminal.getViewport(), ["Line 2", "Line 3", "Line 4", "Line 5", "Line 6"]);

		tui.stop();
	});

	it("appends after a shrink without another full redraw once the viewport is reset", async () => {
		const terminal = new VirtualTerminal(20, 5);
		const tui: TUI = new TuiMainScreen(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = Array.from({ length: 8 }, (_, i) => `Line ${i}`);
		tui.start();
		await terminal.waitForRender();

		const initialRedraws = tui.fullRedraws;

		component.lines = ["Line 0", "Line 1"];
		tui.requestRender();
		await terminal.waitForRender();

		assert.ok(tui.fullRedraws > initialRedraws, "Shrink should reset the viewport with a full redraw");
		const redrawsAfterShrink = tui.fullRedraws;

		component.lines = ["Line 0", "Line 1", "Line 2"];
		tui.requestRender();
		await terminal.waitForRender();

		assert.strictEqual(tui.fullRedraws, redrawsAfterShrink, "Append should stay on the differential path");
		assert.deepStrictEqual(terminal.getViewport(), ["Line 0", "Line 1", "Line 2", "", ""]);

		tui.stop();
	});

	it("clears stale content when maxLinesRendered was inflated by a transient component", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui: TUI = new TuiMainScreen(terminal);
		const chat = new TestComponent();
		const editor = new TestComponent();
		tui.addChild(chat);
		tui.addChild(editor);

		const longChat = Array.from({ length: 15 }, (_, i) => `Chat ${i}`);
		const shortChat = Array.from({ length: 12 }, (_, i) => `Chat ${i}`);
		const editorLines = ["Editor 0", "Editor 1", "Editor 2"];
		const selectorLines = Array.from({ length: 8 }, (_, i) => `Selector ${i}`);

		chat.lines = longChat;
		editor.lines = editorLines;
		tui.start();
		await terminal.waitForRender();

		editor.lines = selectorLines;
		tui.requestRender();
		await terminal.waitForRender();

		editor.lines = editorLines;
		tui.requestRender();
		await terminal.waitForRender();

		const redrawsBeforeSwitch = tui.fullRedraws;
		chat.lines = shortChat;
		tui.requestRender();
		await terminal.waitForRender();

		// Upstream behavior: a change above the viewport triggers a
		// destructive full redraw, which repaints the tail of the new
		// content and leaves no stale rows on screen.
		assert.ok(
			tui.fullRedraws > redrawsBeforeSwitch,
			"Branch switch above the viewport should trigger a full redraw",
		);

		const viewport = terminal.getViewport();
		for (let i = 0; i < 10; i++) {
			const line = viewport[i] ?? "";
			assert.ok(!line.includes("Chat 12"), `Stale "Chat 12" at viewport row ${i}`);
			assert.ok(!line.includes("Chat 13"), `Stale "Chat 13" at viewport row ${i}`);
			assert.ok(!line.includes("Chat 14"), `Stale "Chat 14" at viewport row ${i}`);
		}

		// The full redraw shows the tail of the new content with the editor
		// at the bottom.
		assert.deepStrictEqual(viewport, [
			"Chat 5",
			"Chat 6",
			"Chat 7",
			"Chat 8",
			"Chat 9",
			"Chat 10",
			"Chat 11",
			"Editor 0",
			"Editor 1",
			"Editor 2",
		]);

		tui.stop();
	});
});

describe("TUI soft-wrap metadata", () => {
	it("does not write selection metadata to the main-screen terminal", async () => {
		const terminal = new LoggingVirtualTerminal(10, 4);
		const tui = new TuiMainScreen(terminal);
		tui.addChild(new Text("1234567890ABCDEFGHIJ", 0, 0));
		tui.start();
		try {
			await terminal.waitForRender();
			assert.ok(!terminal.getWrites().includes("\x1b[999;"));
		} finally {
			tui.stop();
		}
	});
});

describe("Container width clamping", () => {
	it("clamps non-positive widths to 1 before rendering children", () => {
		const container = new Container();
		const received: number[] = [];
		container.addChild({
			render(width: number): string[] {
				received.push(width);
				return [];
			},
			invalidate(): void {},
		});
		container.render(0);
		container.render(-3);
		container.render(5);
		assert.deepStrictEqual(received, [1, 1, 5]);
	});

	it("appends large dense child output without spreading arguments", () => {
		const childLines = Array.from({ length: 150_000 }, (_, index) => `line-${index}`);
		const container = new Container();
		container.addChild({ render: () => childLines, invalidate: () => {} });

		const rendered = container.render(80);

		assert.strictEqual(rendered.length, childLines.length);
		assert.strictEqual(rendered[0], "line-0");
		assert.strictEqual(rendered.at(-1), "line-149999");
	});
});

describe("TUI overwide line handling", () => {
	it("truncates lines wider than the terminal instead of throwing", async () => {
		const terminal = new VirtualTerminal(4, 10);
		const tui = new TuiMainScreen(terminal);
		const component = new TestComponent();
		component.lines = ["ok"];
		tui.addChild(component);
		tui.start();
		await terminal.waitForRender();

		// Switch to overwide lines and re-render through the differential
		// path (this threw before the fix).
		component.lines = ["xxxxxxxxxx", "\x1b[31myyyyyyyyyy\x1b[0m", "你好世界"];
		tui.requestRender();
		await terminal.waitForRender();

		const viewport = terminal.getViewport();
		// With truncation each logical line occupies exactly one viewport
		// row; without it, xterm auto-wraps the overwide lines and shifts
		// the following rows, failing the exact assertions below.
		assert.strictEqual(viewport[0], "xxxx");
		assert.strictEqual(viewport[1], "yyyy");
		assert.strictEqual(viewport[2], "你好");
		assert.strictEqual(viewport[3], "");

		tui.stop();
	});
});

describe("Text negative width safety", () => {
	it("does not throw at zero or negative widths", () => {
		const text = new Text("你好", 1, 1);
		assert.doesNotThrow(() => text.render(0));
		assert.doesNotThrow(() => text.render(-1));
	});
});

describe("Text selection exclusions", () => {
	it("tracks the responsive padding actually rendered at each width", () => {
		for (const [width, padding] of [[1, 0], [2, 0], [3, 1], [4, 1], [5, 2], [20, 2]] as const) {
			const lines = renderComponentLines(new Text("abcd", 2, 0), width);
			assert.ok(lines.length > 0);
			for (const line of lines) {
				assert.deepStrictEqual(
					line.selectionExclusions,
					padding === 0 ? undefined : [{ start: 0, end: padding }],
				);
			}
		}
	});
});

describe("Text selection exclusion cache", () => {
	it("refreshes exclusions across width changes and reuses unchanged snapshots", () => {
		const component = new Text("abcd", 2, 0);
		const narrow = renderComponentLines(component, 4);
		assert.deepStrictEqual(narrow[0]?.selectionExclusions, [{ start: 0, end: 1 }]);
		const wide = renderComponentLines(component, 20);
		assert.deepStrictEqual(wide[0]?.selectionExclusions, [{ start: 0, end: 2 }]);
		const narrowAgain = renderComponentLines(component, 4);
		assert.deepStrictEqual(narrowAgain[0]?.selectionExclusions, [{ start: 0, end: 1 }]);
		assert.strictEqual(renderComponentLines(component, 4), narrowAgain);
		assert.deepStrictEqual(component.render(4), renderLineTexts(narrowAgain));
	});
});

describe("TUI steady-frame processed-line reuse", () => {
	it("writes only the changed line when one component updates in a long transcript", async () => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TuiMainScreen(terminal);
		const staticComponent = new TestComponent();
		staticComponent.lines = Array.from({ length: 30 }, (_, i) => `static-${String(i).padStart(2, "0")}`);
		const spinner = new TestComponent();
		spinner.lines = ["frame-a"];
		tui.addChild(staticComponent);
		tui.addChild(spinner);
		tui.start();
		await terminal.waitForRender();
		terminal.clearWrites();

		spinner.lines = ["frame-b"];
		tui.requestRender();
		await terminal.waitForRender();

		const writes = terminal.getWrites();
		assert.ok(writes.includes("frame-b"), "changed line should be written");
		assert.ok(!writes.includes("static-"), "unchanged transcript lines must not be rewritten");
		assert.ok(!writes.includes("\x1b[2J"), "no full clear for an in-viewport change");

		tui.stop();
	});

	it("writes nothing but the cursor hide for an identical frame", async () => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TuiMainScreen(terminal);
		const component = new TestComponent();
		component.lines = ["alpha", "beta", "gamma"];
		tui.addChild(component);
		tui.start();
		await terminal.waitForRender();
		terminal.clearWrites();

		tui.requestRender();
		await terminal.waitForRender();

		const writes = terminal.getWrites();
		assert.strictEqual(writes.replaceAll("\x1b[?25l", ""), "");
		tui.stop();
	});

	it("does not serve stale processed lines when a line toggles between two values", async () => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TuiMainScreen(terminal);
		const component = new TestComponent();
		component.lines = ["head", "value-a", "tail"];
		tui.addChild(component);
		tui.start();
		await terminal.waitForRender();

		component.lines = ["head", "value-b", "tail"];
		tui.requestRender();
		await terminal.waitForRender();
		component.lines = ["head", "value-a", "tail"];
		tui.requestRender();
		await terminal.waitForRender();

		const viewport = await terminal.flushAndGetViewport();
		assert.strictEqual(viewport[0], "head");
		assert.strictEqual(viewport[1], "value-a");
		assert.strictEqual(viewport[2], "tail");
		tui.stop();
	});

	it("fully redraws when the terminal width changes", async () => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TuiMainScreen(terminal);
		const component = new TestComponent();
		component.lines = ["one", "two", "three"];
		tui.addChild(component);
		tui.start();
		await terminal.waitForRender();
		terminal.clearWrites();

		terminal.resize(30, 10);
		await terminal.waitForRender();

		const writes = terminal.getWrites();
		assert.ok(writes.includes("\x1b[2J"), "width change should clear and redraw");
		assert.ok(writes.includes("one") && writes.includes("two") && writes.includes("three"));
		tui.stop();
	});

	it("redraws a kitty image block when a line above it changes", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		try {
			const terminal = new LoggingVirtualTerminal(40, 10);
			const tui = new TuiMainScreen(terminal);
			const component = new TestComponent();
			tui.addChild(component);
			const image = new Image(
				"AAAA",
				"image/png",
				{ fallbackColor: (value) => value },
				{ maxWidthCells: 2 },
				{ widthPx: 20, heightPx: 20 },
			);
			const imageLines = image.render(40);
			const imageSequence = imageLines[0]!;
			component.lines = ["header", ...imageLines, "footer"];
			tui.start();
			await terminal.waitForRender();
			terminal.clearWrites();

			component.lines = ["header2", ...imageLines, "footer"];
			tui.requestRender();
			await terminal.waitForRender();

			const writes = terminal.getWrites();
			assert.ok(writes.includes("header2"), "changed line should be written");
			assert.ok(
				writes.includes(imageSequence),
				"image block should be redrawn when a line above it changes",
			);
			tui.stop();
		} finally {
			resetCapabilitiesCache();
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	it("does not rewrite a kitty image on an identical frame", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		try {
			const terminal = new LoggingVirtualTerminal(40, 10);
			const tui = new TuiMainScreen(terminal);
			const component = new TestComponent();
			tui.addChild(component);
			const image = new Image(
				"AAAA",
				"image/png",
				{ fallbackColor: (value) => value },
				{ maxWidthCells: 2 },
				{ widthPx: 20, heightPx: 20 },
			);
			const imageLines = image.render(40);
			const imageSequence = imageLines[0]!;
			component.lines = ["header", ...imageLines, "footer"];
			tui.start();
			await terminal.waitForRender();
			terminal.clearWrites();

			tui.requestRender();
			await terminal.waitForRender();

			const writes = terminal.getWrites();
			assert.ok(!writes.includes(imageSequence), "identical frame must not rewrite the image");
			assert.strictEqual(writes.replaceAll("\x1b[?25l", ""), "");
			tui.stop();
		} finally {
			resetCapabilitiesCache();
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});
});

describe("Box structured render cache", () => {
	function createComponent(getLines: () => TuiRenderLine[]): Component {
		return {
			render: () => renderLineTexts(getLines()),
			[RENDER_LINES]: () => getLines(),
			invalidate: () => {},
		};
	}

	it("refreshes soft-wrap metadata when text is unchanged", () => {
		let lines: TuiRenderLine[] = [
			{ text: "content", softWrap: [{ logicalLineId: 1, start: 0, end: 7 }] },
		];
		const box = new Box({ padding: { left: 1 } });
		box.addChild(createComponent(() => lines));
		const first = box[RENDER_LINES](80);
		const origin = first[0]?.softWrap?.[0]?.origin;
		assert.equal(typeof origin, "symbol");
		assert.deepStrictEqual(first[0]?.softWrap, [{ logicalLineId: 1, start: 0, end: 8, origin }]);

		lines = [{ text: "content", softWrap: [{ logicalLineId: 2, start: 0, end: 5 }] }];
		const second = box[RENDER_LINES](80);
		assert.notStrictEqual(second, first);
		assert.deepStrictEqual(first[0]?.softWrap, [{ logicalLineId: 1, start: 0, end: 8, origin }]);
		assert.deepStrictEqual(second[0]?.softWrap, [{ logicalLineId: 2, start: 1, end: 6, origin }]);
	});

	it("excludes its own padding while preserving copied child metadata", () => {
		const origin = Symbol("child");
		const lines: TuiRenderLine[] = [
			{
				text: "content",
				softWrap: [{ logicalLineId: 1, start: 0, end: 7, origin }],
				selectionExclusions: [{ start: 1, end: 2 }],
			},
		];
		const box = new Box({ padding: { left: 2 } });
		box.addChild(createComponent(() => lines));

		const rendered = box[RENDER_LINES](80);

		assert.deepStrictEqual(rendered[0]?.softWrap, [{ logicalLineId: 1, start: 0, end: 9, origin }]);
		assert.deepStrictEqual(rendered[0]?.selectionExclusions, [
			{ start: 0, end: 2 },
			{ start: 3, end: 4 },
		]);
	});

	it("refreshes and removes selection exclusions when text is unchanged", () => {
		let lines: TuiRenderLine[] = [{ text: "content", selectionExclusions: [{ start: 1, end: 2 }] }];
		const box = new Box({ padding: { left: 1 } });
		box.addChild(createComponent(() => lines));
		const first = box[RENDER_LINES](80);
		assert.deepStrictEqual(first[0]?.selectionExclusions, [
			{ start: 0, end: 1 },
			{ start: 2, end: 3 },
		]);

		lines = [{ text: "content", selectionExclusions: [{ start: 0, end: 3 }] }];
		const second = box[RENDER_LINES](80);
		assert.notStrictEqual(second, first);
		assert.deepStrictEqual(first[0]?.selectionExclusions, [
			{ start: 0, end: 1 },
			{ start: 2, end: 3 },
		]);
		assert.deepStrictEqual(second[0]?.selectionExclusions, [{ start: 0, end: 4 }]);

		lines = [{ text: "content" }];
		const third = box[RENDER_LINES](80);
		assert.notStrictEqual(third, second);
		assert.deepStrictEqual(third[0]?.selectionExclusions, [{ start: 0, end: 1 }]);
	});

	it("refreshes row count when existing text is unchanged", () => {
		let lines: TuiRenderLine[] = [{ text: "content" }];
		const box = new Box({ padding: { left: 1 } });
		box.addChild(createComponent(() => lines));
		const first = box[RENDER_LINES](80);

		lines = [{ text: "content" }, { text: "content" }];
		const second = box[RENDER_LINES](80);
		assert.notStrictEqual(second, first);
		assert.strictEqual(second.length, 2);
	});

	it("reuses cached output when child rows are unchanged", () => {
		const line: TuiRenderLine = {
			text: "content",
			softWrap: [{ logicalLineId: 1, start: 0, end: 7 }],
			selectionExclusions: [{ start: 1, end: 2 }],
		};
		let lines = [line];
		const box = new Box({ padding: { left: 1 } });
		box.addChild(createComponent(() => lines));
		const first = box[RENDER_LINES](80);

		lines = [line];
		assert.strictEqual(box[RENDER_LINES](80), first);
	});
});

describe("Immutable render results", () => {
	it("reflects in-place legacy string updates without changing prior snapshots", () => {
		const lines = ["before"];
		const component: Component = {
			render: () => lines,
			invalidate: () => {},
		};
		const firstStructured = renderComponentLines(component, 80);
		const firstTexts = renderLineTexts(firstStructured);
		assert.strictEqual(renderLineTexts(firstStructured), firstTexts);

		lines[0] = "after";
		lines.push("third");
		const secondStructured = renderComponentLines(component, 80);
		assert.notStrictEqual(secondStructured, firstStructured);
		assert.deepStrictEqual(firstStructured.map((line) => line.text), ["before"]);
		assert.deepStrictEqual(firstTexts, ["before"]);
		assert.deepStrictEqual(secondStructured.map((line) => line.text), ["after", "third"]);
		assert.deepStrictEqual(renderLineTexts(secondStructured), ["after", "third"]);
	});

	it("preserves large sparse legacy array lengths and holes", () => {
		const lines: string[] = [];
		lines.length = 1_000_000_000;
		lines[0] = "first";
		lines[lines.length - 1] = "last";
		const component: Component = { render: () => lines, invalidate: () => {} };

		const structured = renderComponentLines(component, 80);

		assert.strictEqual(structured.length, lines.length);
		assert.strictEqual(structured[0]?.text, "first");
		assert.strictEqual(structured[structured.length - 1]?.text, "last");
		assert.strictEqual(1 in structured, false);
		assert.strictEqual(structured.length - 2 in structured, false);
	});

	it("preserves prior selection metadata when an update uses new structured lines", () => {
		let lines: TuiRenderLine[] = [
			{
				text: "content",
				softWrap: [{ logicalLineId: 1, start: 0, end: 7 }],
				selectionExclusions: [{ start: 1, end: 2 }],
			},
		];
		const component: Component = {
			render: () => renderLineTexts(lines),
			[RENDER_LINES]: () => lines,
			selectionExclusions: () => [{ start: 3, end: 4 }],
			invalidate: () => {},
		};
		const first = renderComponentLines(component, 80);
		const origin = first[0]?.softWrap?.[0]?.origin;
		assert.equal(typeof origin, "symbol");
		assert.strictEqual(renderComponentLines(component, 80), first);

		lines = [
			{
				text: "content",
				softWrap: [{ logicalLineId: 1, start: 0, end: 5 }],
				selectionExclusions: [{ start: 2, end: 3 }],
			},
		];
		const second = renderComponentLines(component, 80);
		assert.notStrictEqual(second, first);
		assert.deepStrictEqual(first[0]?.softWrap, [{ logicalLineId: 1, start: 0, end: 7, origin }]);
		assert.deepStrictEqual(first[0]?.selectionExclusions, [
			{ start: 1, end: 2 },
			{ start: 3, end: 4 },
		]);
		assert.deepStrictEqual(second[0]?.softWrap, [{ logicalLineId: 1, start: 0, end: 5, origin }]);
		assert.deepStrictEqual(second[0]?.selectionExclusions, [{ start: 2, end: 4 }]);
		assert.strictEqual(renderComponentLines(component, 80), second);
	});

	it("keeps child soft-wrap origins stable through nested containers", () => {
		const inheritedOrigin = Symbol("inherited");
		const lines: TuiRenderLine[] = [
			{
				text: "content",
				softWrap: [
					{ logicalLineId: 1, start: 0, end: 3, origin: inheritedOrigin },
					{ logicalLineId: 2, start: 3, end: 7 },
				],
			},
		];
		const child: Component = {
			render: () => renderLineTexts(lines),
			[RENDER_LINES]: () => lines,
			invalidate: () => {},
		};
		const container = new Container();
		container.addChild(child);

		const childLines = renderComponentLines(child, 80);
		const containerLines = renderComponentLines(container, 80);
		const childOrigin = childLines[0]?.softWrap?.[1]?.origin;

		assert.equal(typeof childOrigin, "symbol");
		assert.strictEqual(childLines[0]?.softWrap?.[0]?.origin, inheritedOrigin);
		assert.strictEqual(containerLines[0]?.softWrap?.[0]?.origin, inheritedOrigin);
		assert.strictEqual(containerLines[0]?.softWrap?.[1]?.origin, childOrigin);
		assert.strictEqual(renderComponentLines(child, 80), childLines);
		assert.strictEqual(renderComponentLines(container, 80)[0]?.softWrap?.[1]?.origin, childOrigin);
	});

	it("propagates selection regions through line composition and transforms", () => {
		const content: TuiRenderLine = {
			text: "body",
			softWrap: [{ logicalLineId: 1, start: 0, end: 4 }],
		};
		const line = withRenderLineSelectionRegion(
			{ text: "● body", softWrap: [{ logicalLineId: 2, start: 2, end: 6 }] },
			content,
			2,
			4,
		);
		assert.strictEqual(line.selectionRegion?.content, content);

		const prefixed = prefixRenderLine(line, "  ");
		assert.deepStrictEqual(prefixed.selectionRegion, { content, column: 4, width: 4 });
		const composited = compositeTuiRenderLine({ text: "" }, prefixed, 3, 8, 20);
		assert.deepStrictEqual(composited.selectionRegion, { content, column: 7, width: 4 });
		const offset = offsetRenderLine(composited, 2);
		assert.deepStrictEqual(offset.selectionRegion, { content, column: 9, width: 4 });
		const truncated = truncateRenderLine(offset, 10);
		assert.deepStrictEqual(truncated.selectionRegion, { content, column: 9, width: 1 });
		assert.strictEqual(truncated.selectionRegion?.content.softWrap, content.softWrap);
	});
});

describe("TUI fake cursor", () => {
	it("draws the focused fake cursor in reverse video and omits it when the hardware cursor is shown", async () => {
		const terminal = new LoggingVirtualTerminal(20, 5);
		const tui: TUI = new TuiMainScreen(terminal);
		const input = new Input();
		input.setValue("abc");
		tui.addChild(input);
		tui.setFocus(input);
		tui.start();
		await terminal.waitForRender();
		assert.ok(terminal.getWrites().includes("> \x1b[7ma\x1b[27mbc"));

		terminal.clearWrites();
		tui.setShowHardwareCursor(true);
		await terminal.waitForRender();
		assert.ok(!terminal.getWrites().includes("\x1b[7m"));
		assert.ok(!terminal.getWrites().includes("\x1b_pi:"));

		tui.stop();
	});

	it("keeps the fake cursor of an unfocused input when the hardware cursor is shown", async () => {
		const terminal = new LoggingVirtualTerminal(20, 5);
		const tui: TUI = new TuiMainScreen(terminal, true);
		const input = new Input();
		input.setValue("abc");
		tui.addChild(input);
		tui.start();
		await terminal.waitForRender();
		assert.ok(terminal.getWrites().includes("> \x1b[7ma\x1b[27mbc"));
		tui.stop();
	});

	it("omits the focused fake cursor when truncation dropped its end marker", async () => {
		const terminal = new LoggingVirtualTerminal(20, 5);
		const tui: TUI = new TuiMainScreen(terminal, true);
		const base = new TestComponent();
		base.lines = [sliceByColumn(`ab${CURSOR_MARKER}${renderFakeCursor("c")}def`, 0, 3, true)];
		tui.addChild(base);
		tui.start();
		await terminal.waitForRender();
		assert.ok(!terminal.getWrites().includes("\x1b[7m"));
		assert.ok(terminal.getWrites().endsWith("\x1b[3G"));
		tui.stop();
	});

	it("keeps the cursor when an overlay ends directly left of it", async () => {
		for (const showHardwareCursor of [false, true]) {
			const terminal = new LoggingVirtualTerminal(20, 5);
			const tui: TUI = new TuiMainScreen(terminal, showHardwareCursor);
			const base = new TestComponent();
			base.lines = [`abc${CURSOR_MARKER}${renderFakeCursor("d")}ef`];
			tui.addChild(base);
			const overlay = new TestComponent();
			overlay.lines = ["XXX"];
			tui.showOverlay(overlay, { row: 0, col: 0, width: 3 });
			tui.start();
			await terminal.waitForRender();

			const writes = terminal.getWrites();
			assert.ok(writes.includes("XXX"));
			assert.strictEqual(writes.includes("\x1b[7md"), !showHardwareCursor);
			// The hardware cursor is positioned at column 4 in both modes
			assert.ok(writes.endsWith("\x1b[4G"));
			tui.stop();
		}
	});
});
