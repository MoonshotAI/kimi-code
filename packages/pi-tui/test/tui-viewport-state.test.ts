import assert from "node:assert";
import { describe, it } from "node:test";
import { type Component, TUI } from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class SimpleContent implements Component {
	private lines: string[];

	constructor(lines: string[]) {
		this.lines = lines;
	}

	render(): string[] {
		return this.lines;
	}
	invalidate() {}
}

function makeLines(count: number): string[] {
	return Array.from({ length: count }, (_, i) => `Line ${i + 1}`);
}

describe("TUI viewport state accessors", () => {
	it("reports zero scroll when content fits the screen", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		tui.addChild(new SimpleContent(makeLines(3)));

		tui.start();
		await terminal.waitForRender();

		assert.strictEqual(tui.getContentHeight(), 3);
		assert.strictEqual(tui.getViewportTop(), 0);

		tui.stop();
	});

	it("reports scroll position once content overflows the screen", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		tui.addChild(new SimpleContent(makeLines(100)));

		tui.start();
		await terminal.waitForRender();

		assert.strictEqual(tui.getContentHeight(), 100);
		assert.strictEqual(tui.getViewportTop(), 100 - 24);

		tui.stop();
	});

	it("tracks viewport growth as lines are appended", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		const content = new SimpleContent(makeLines(30));
		tui.addChild(content);

		tui.start();
		await terminal.waitForRender();
		const topBefore = tui.getViewportTop();

		// Simulate transcript growth: 10 more lines appear at the bottom.
		(content as { lines: string[] }).lines = makeLines(40);
		tui.requestRender();
		await terminal.waitForRender();

		assert.strictEqual(tui.getContentHeight(), 40);
		assert.ok(
			tui.getViewportTop() > topBefore,
			`viewportTop should grow after append (${tui.getViewportTop()} > ${topBefore})`,
		);

		tui.stop();
	});
});
