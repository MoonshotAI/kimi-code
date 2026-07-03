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

	it("re-anchors the input box to the screen bottom when content collapses past the viewport top", async () => {
		// Regression: previousViewportTop only ever grows; when content
		// collapses to or above the viewport top (compaction, clears) the
		// viewport must rewind so the tail of the new content is shown.
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const content = new Lines([]);
		tui.addChild(content);

		content.setLines([...Array.from({ length: 59 }, (_, i) => `old-${i}`), "[INPUT-BOX]"]);
		tui.start();
		await terminal.waitForRender();
		assert.ok(terminal.getViewport()[9]!.includes("[INPUT-BOX]"));

		// Collapse 60 -> 30 lines (30 <= viewportTop 50); content is still
		// taller than the screen, so the tail must land at the screen bottom.
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

	it("does not duplicate scrollback rows on a shrink/grow cycle with above-viewport changes", async () => {
		// Regression: a shrink re-anchor rewinds viewportTop; if the next
		// grow with an above-viewport change painted from the rewound top
		// through the end, rows already in scrollback were pushed out again,
		// stacking a duplicate copy there on every oscillation.
		const terminal = new VirtualTerminal(60, 10);
		const tui = new TUI(terminal);
		const content = new Lines([]);
		tui.addChild(content);

		const base = (status: string, tail: string[]): string[] => [
			...Array.from({ length: 5 }, (_, i) => `L${i}`),
			status,
			...Array.from({ length: 48 }, (_, i) => `M${i}`),
			...tail,
			"[INPUT]",
		];

		content.setLines(base("status-A", ["** marker message **"]));
		tui.start();
		await terminal.waitForRender();

		// Shrink by a few rows (activity pane collapsing) -> re-anchor.
		content.setLines(base("status-A", ["** marker message **"]).slice(0, -4).concat(["[INPUT]"]));
		tui.requestRender();
		await terminal.waitForRender();

		// Grow back with an above-viewport change (reflow/status update).
		content.setLines(base("status-B", ["** marker message **"]));
		tui.requestRender();
		await terminal.waitForRender();

		const buffer = terminal.getScrollBuffer();
		for (const marker of ["M37", "M39", "** marker message **"]) {
			const count = buffer.filter((line) => line.includes(marker)).length;
			assert.strictEqual(count, 1, `"${marker}" should appear exactly once, got ${count}`);
		}
		const viewport = terminal.getViewport();
		assert.ok(viewport[9]!.includes("[INPUT]"), "input box should sit on the bottom screen row");
		assert.ok(viewport.some((line) => line.includes("** marker message **")));

		tui.stop();
	});

	it("keeps the viewport pinned on partial shrinks and lets growth refill the gap", async () => {
		// Rewinding the anchor would repaint rows scrollback already holds
		// and duplicate them on the next scroll, so a partial shrink stays
		// pinned: the input box hovers above a bounded blank gap that the
		// next growth naturally fills. No rewind, no duplication.
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const content = new Lines([]);
		tui.addChild(content);

		content.setLines([...Array.from({ length: 59 }, (_, i) => `old-${i}`), "[INPUT-BOX]"]);
		tui.start();
		await terminal.waitForRender();
		assert.ok(terminal.getViewport()[9]!.includes("[INPUT-BOX]"));

		// Shrink by 4 rows; content still spans the pinned viewport (56 > 50).
		content.setLines([...Array.from({ length: 55 }, (_, i) => `old-${i}`), "[INPUT-BOX]"]);
		tui.requestRender();
		await terminal.waitForRender();

		// The viewport stays pinned: the input box hovers above blank rows.
		const pinned = terminal.getViewport();
		assert.ok(pinned[5]!.includes("[INPUT-BOX]"), `expected pinned gap, got: ${JSON.stringify(pinned)}`);
		assert.strictEqual(pinned[9], "", "rows below the content should be blank while pinned");

		// Growth fills the gap; the input box returns to the bottom row and
		// nothing was duplicated in the buffer along the way.
		content.setLines([...Array.from({ length: 59 }, (_, i) => `old-${i}`), "[INPUT-BOX]"]);
		tui.requestRender();
		await terminal.waitForRender();
		const grown = terminal.getViewport();
		assert.ok(grown[9]!.includes("[INPUT-BOX]"), `input box should be back at the bottom, got: ${JSON.stringify(grown)}`);
		const buffer = terminal.getScrollBuffer();
		for (const marker of ["old-40", "old-54", "[INPUT-BOX]"]) {
			const count = buffer.filter((line) => line.includes(marker)).length;
			assert.strictEqual(count, 1, `"${marker}" should appear exactly once, got ${count}`);
		}

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
