/**
 * In-place changes above the viewport must not trigger destructive full
 * redraws (ESC[2J / ESC[3J): those clear screen + scrollback on every tick
 * of an above-viewport spinner, producing sustained flicker and scroll-
 * position yanks (#2039). Layout shifts keep the post-#1367 full-redraw
 * baseline.
 *
 * Written with the vitest API and opted into vitest.config.ts — the rest of
 * this package's suite runs under node:test.
 */
import { describe, expect, it } from "vitest";
import { type Component, TUI } from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class TestComponent implements Component {
	lines: string[] = [];
	render(_width: number): string[] {
		return this.lines;
	}
	invalidate(): void {}
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

function makeLines(count: number): string[] {
	return Array.from({ length: count }, (_, i) => `line ${i}`);
}

describe("above-viewport in-place changes", () => {
	it("skips the destructive full redraw when a line above the viewport changes in place", async () => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);
		// 30 lines on a 10-row terminal -> viewport top sits at row 20.
		component.lines = makeLines(30);
		tui.start();
		await terminal.waitForRender();
		const initialRedraws = tui.fullRedraws;
		const viewportBefore = await terminal.flushAndGetViewport();

		// Repeated ticks mirror a spinner line that /usage pushed above the
		// viewport: same line count, one changed row per tick.
		for (let tick = 0; tick < 4; tick++) {
			const lines = makeLines(30);
			lines[3] = `spinner frame ${tick}`;
			component.lines = lines;
			terminal.clearWrites();
			tui.requestRender();
			await terminal.waitForRender();

			expect(tui.fullRedraws).toBe(initialRedraws);
			const writes = terminal.getWrites();
			expect(writes).not.toContain("\x1b[2J");
			expect(writes).not.toContain("\x1b[3J");
		}

		// The visible viewport stays untouched by the skipped repaints.
		expect(await terminal.flushAndGetViewport()).toEqual(viewportBefore);
		tui.stop();
	});

	it("repaints only the visible part when an in-place change spans the viewport boundary", async () => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);
		component.lines = makeLines(30);
		tui.start();
		await terminal.waitForRender();
		const initialRedraws = tui.fullRedraws;

		const lines = makeLines(30);
		for (let i = 18; i <= 22; i++) {
			lines[i] = `changed ${i}`;
		}
		component.lines = lines;
		terminal.clearWrites();
		tui.requestRender();
		await terminal.waitForRender();

		expect(tui.fullRedraws).toBe(initialRedraws);
		const writes = terminal.getWrites();
		expect(writes).not.toContain("\x1b[2J");
		expect(writes).not.toContain("\x1b[3J");

		// The visible rows (20-22 -> screen rows 0-2) show the new content.
		const viewport = await terminal.flushAndGetViewport();
		expect(viewport[0]).toContain("changed 20");
		expect(viewport[1]).toContain("changed 21");
		expect(viewport[2]).toContain("changed 22");
		expect(viewport[3]).toContain("line 23");
		tui.stop();
	});

	it("keeps the full redraw when the line count changes above the viewport", async () => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);
		component.lines = makeLines(30);
		tui.start();
		await terminal.waitForRender();
		const initialRedraws = tui.fullRedraws;

		// Inserting a row above the viewport shifts every following line —
		// that layout change must keep the post-#1367 destructive redraw.
		const lines = makeLines(30);
		lines.splice(3, 0, "inserted above viewport");
		component.lines = lines;
		tui.requestRender();
		await terminal.waitForRender();

		expect(tui.fullRedraws).toBeGreaterThan(initialRedraws);
		tui.stop();
	});
});
