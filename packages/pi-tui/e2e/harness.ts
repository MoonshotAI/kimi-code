import assert from "node:assert";
import { type Component, TUI } from "../src/tui.ts";
import { VirtualTerminal } from "../test/virtual-terminal.ts";

/** A component whose rendered lines are fully controlled by the test. */
export class Lines implements Component {
	private lines: string[] = [];

	setLines(lines: string[]): void {
		this.lines = lines;
	}

	render(): string[] {
		return this.lines;
	}

	invalidate(): void {}
}

/** VirtualTerminal that also records every raw write for escape-sequence assertions. */
export class WriteCapturingTerminal extends VirtualTerminal {
	writes: string[] = [];

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}
}

export interface Harness<T extends VirtualTerminal = VirtualTerminal> {
	terminal: T;
	tui: TUI;
	content: Lines;
	/** Replace the content lines and wait for the next render to settle. */
	frame(lines: string[], force?: boolean): Promise<void>;
	stop(): void;
}

/** Build a TUI driven by a single Lines component on a virtual terminal. */
export async function createHarness(
	initialLines: string[],
	options?: { columns?: number; rows?: number; capture?: boolean },
): Promise<Harness<VirtualTerminal | WriteCapturingTerminal>> {
	const columns = options?.columns ?? 60;
	const rows = options?.rows ?? 10;
	const terminal = options?.capture ? new WriteCapturingTerminal(columns, rows) : new VirtualTerminal(columns, rows);
	const tui = new TUI(terminal);
	const content = new Lines();
	tui.addChild(content);
	content.setLines(initialLines);
	tui.start();
	await terminal.waitForRender();
	return {
		terminal,
		tui,
		content,
		async frame(lines: string[], force = false): Promise<void> {
			content.setLines(lines);
			tui.requestRender(force);
			await terminal.waitForRender();
		},
		stop(): void {
			tui.stop();
		},
	};
}

/** Count buffer lines (scrollback + screen) containing the marker. */
export function countInBuffer(buffer: string[], marker: string): number {
	return buffer.filter((line) => line.includes(marker)).length;
}

/**
 * Assert each marker appears exactly once across scrollback + screen.
 * Catches both duplication (count > 1) and row loss (count === 0).
 * Only use markers whose logical line did not change between frames:
 * lines rewritten above the viewport legitimately leave a stale copy
 * in scrollback (see e2e/README.md, "stale bytes" trade-off).
 */
export function assertExactlyOnce(terminal: VirtualTerminal, markers: string[]): void {
	const buffer = terminal.getScrollBuffer();
	for (const marker of markers) {
		const count = countInBuffer(buffer, marker);
		assert.strictEqual(count, 1, `"${marker}" should appear exactly once in the buffer, got ${count}`);
	}
}
