import assert from "node:assert";
import { describe, it } from "node:test";
import { type Component, TUI } from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class Lines implements Component {
	private lines: string[];

	constructor(lines: string[]) {
		this.lines = lines;
	}

	setLines(lines: string[]): void {
		this.lines = lines;
	}

	render(): string[] {
		return this.lines;
	}

	invalidate(): void {}
}

class WriteCapturingTerminal extends VirtualTerminal {
	writes: string[] = [];

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}
}

describe("TUI shrinking content", () => {
	it("clears all rendered lines when content shrinks to zero", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const content = new Lines(["first", "second", "third"]);
		tui.addChild(content);
		tui.start();
		await terminal.waitForRender();

		assert.ok(terminal.getViewport().some((line) => line.includes("first")));
		assert.ok(terminal.getViewport().some((line) => line.includes("second")));
		assert.ok(terminal.getViewport().some((line) => line.includes("third")));

		tui.clear();
		tui.requestRender();
		await terminal.waitForRender();

		const viewport = terminal.getViewport();
		assert.ok(!viewport.some((line) => line.includes("first")), "first line should be cleared");
		assert.ok(!viewport.some((line) => line.includes("second")), "second line should be cleared");
		assert.ok(!viewport.some((line) => line.includes("third")), "third line should be cleared");

		tui.stop();
	});

	it("repaints the viewport when content collapses above it with an above-viewport change", async () => {
		// Regression: compaction/collapse shrinks 30 lines to 8 (below the
		// viewport top at 20) while a line above the viewport also changes.
		// The clamped differential path used to desync the cursor and leave
		// the viewport blank with the input box gone.
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const content = new Lines([]);
		tui.addChild(content);

		content.setLines([...Array.from({ length: 29 }, (_, i) => `L${i}`), "[INPUT-BOX]"]);
		tui.start();
		await terminal.waitForRender();
		assert.ok(terminal.getViewport().some((line) => line.includes("[INPUT-BOX]")));

		content.setLines(["L0", "L1", "L2", "L3", "L4", "L5-CHANGED", "L6", "[INPUT-BOX]"]);
		tui.requestRender();
		await terminal.waitForRender();

		const viewport = terminal.getViewport();
		assert.ok(
			viewport.some((line) => line.includes("[INPUT-BOX]")),
			`input box should stay visible, got: ${JSON.stringify(viewport)}`,
		);
		assert.ok(viewport.some((line) => line.includes("L5-CHANGED")));

		// Scrollback must be preserved (no ESC[3J): old history stays above.
		assert.ok(
			terminal.getScrollBuffer().some((line) => line.includes("L15")),
			"scrollback should keep the old history",
		);

		// Subsequent renders must land in the right place (self-healing).
		content.setLines(["L0", "L1", "L2", "L3", "L4", "L5-CHANGED", "L6", "[INPUT-BOX]x"]);
		tui.requestRender();
		await terminal.waitForRender();
		assert.ok(
			terminal.getViewport().some((line) => line.includes("[INPUT-BOX]x")),
			"render after the collapse should update the input box in place",
		);

		tui.stop();
	});

	it("preserves the user's scroll position when content collapses while scrolled up", async () => {
		// While the user is reading scrollback, the collapse repaint must only
		// touch the live screen area at the bottom of the buffer: no ESC[3J,
		// no viewport yank. Scrolling back down shows the fresh content.
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const content = new Lines([]);
		tui.addChild(content);

		content.setLines([...Array.from({ length: 29 }, (_, i) => `L${i}`), "[INPUT-BOX]"]);
		tui.start();
		await terminal.waitForRender();

		// User scrolls up into scrollback.
		terminal.scrollViewport(-10);
		const scrolledPosition = terminal.getScrollPosition();
		assert.ok(scrolledPosition < 20, "user should be scrolled into scrollback");
		assert.ok(terminal.getViewport().some((line) => line.includes("L10")));

		content.setLines(["L0", "L1", "L2", "L3", "L4", "L5-CHANGED", "L6", "[INPUT-BOX]"]);
		tui.requestRender();
		await terminal.waitForRender();

		// The user's scrolled view must not move, and still shows the history.
		assert.strictEqual(terminal.getScrollPosition(), scrolledPosition, "scroll position should be preserved");
		assert.ok(terminal.getViewport().some((line) => line.includes("L10")));

		// Scrolling back down reveals the repainted content with the input box.
		terminal.scrollToBottom();
		const viewport = terminal.getViewport();
		assert.ok(
			viewport.some((line) => line.includes("[INPUT-BOX]")),
			`input box should be visible at the bottom, got: ${JSON.stringify(viewport)}`,
		);
		assert.ok(viewport.some((line) => line.includes("L5-CHANGED")));

		tui.stop();
	});

	it("deletes a kitty image straddling the viewport top when content collapses", async () => {
		// A multi-row image can start above the viewport top while its
		// reserved rows are still visible. The collapse repaint must widen
		// its image-delete range to that block, or the stale overlay
		// survives and its id drops out of tracking.
		const terminal = new WriteCapturingTerminal(40, 10);
		const tui = new TUI(terminal);
		const content = new Lines([]);
		tui.addChild(content);

		// 30 lines, image line at index 18 with 4 reserved rows (18..21),
		// straddling the viewport top at 20.
		const imageLine = "\x1b_Ga=T,i=42,r=4;AAAA\x1b\\";
		const first = [
			...Array.from({ length: 18 }, (_, i) => `L${i}`),
			imageLine,
			"",
			"",
			"",
			...Array.from({ length: 7 }, (_, i) => `L${22 + i}`),
			"[INPUT-BOX]",
		];
		content.setLines(first);
		tui.start();
		await terminal.waitForRender();

		terminal.writes = [];
		content.setLines(["L0", "L1", "L2", "L3", "L4", "L5-CHANGED", "L6", "[INPUT-BOX]"]);
		tui.requestRender();
		await terminal.waitForRender();

		const written = terminal.writes.join("");
		assert.ok(
			written.includes("\x1b_Ga=d,d=I,i=42,q=2\x1b\\"),
			"the straddling image should be deleted during the collapse repaint",
		);
		assert.ok(terminal.getViewport().some((line) => line.includes("[INPUT-BOX]")));

		tui.stop();
	});

	it("re-anchors the input box to the screen bottom when content shrinks", async () => {
		// Regression: previousViewportTop only ever grows, so after a shrink
		// (e.g. collapsing expanded tool output) the content bottom hovered
		// mid-screen with dead rows below, and nothing ever re-anchored it.
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const content = new Lines([]);
		tui.addChild(content);

		content.setLines([...Array.from({ length: 59 }, (_, i) => `old-${i}`), "[INPUT-BOX]"]);
		tui.start();
		await terminal.waitForRender();
		assert.ok(terminal.getViewport()[9]!.includes("[INPUT-BOX]"));

		// Shrink 60 -> 30 lines; content is still taller than the screen, so
		// the tail must stay glued to the screen bottom.
		content.setLines([...Array.from({ length: 29 }, (_, i) => `new-${i}`), "[INPUT-BOX]"]);
		tui.requestRender();
		await terminal.waitForRender();

		const viewport = terminal.getViewport();
		assert.ok(
			viewport[9]!.includes("[INPUT-BOX]"),
			`input box should sit on the bottom screen row, got: ${JSON.stringify(viewport)}`,
		);
		assert.ok(viewport[0]!.includes("new-20"), "viewport should show the tail of the new content");

		// Subsequent renders must land in the right place (self-healing).
		content.setLines([...Array.from({ length: 29 }, (_, i) => `new-${i}`), "[INPUT-BOX]x"]);
		tui.requestRender();
		await terminal.waitForRender();
		assert.ok(terminal.getViewport()[9]!.includes("[INPUT-BOX]x"));

		tui.stop();
	});

	it("shows the tail of collapsed content when it is still taller than the screen", async () => {
		// 100 lines -> 30 lines (still > height 10) with a change above the
		// viewport: the viewport should show the tail of the new content.
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const content = new Lines([]);
		tui.addChild(content);

		content.setLines(Array.from({ length: 100 }, (_, i) => `old-${i}`));
		tui.start();
		await terminal.waitForRender();

		const newLines = Array.from({ length: 30 }, (_, i) => `new-${i}`);
		content.setLines(newLines);
		tui.requestRender();
		await terminal.waitForRender();

		const viewport = terminal.getViewport();
		for (let i = 20; i < 30; i++) {
			assert.ok(
				viewport.some((line) => line.includes(`new-${i}`)),
				`tail line new-${i} should be visible, got: ${JSON.stringify(viewport)}`,
			);
		}

		tui.stop();
	});
});
