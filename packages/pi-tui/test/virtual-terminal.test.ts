import assert from "node:assert";
import { describe, it } from "node:test";
import { VirtualTerminal } from "./virtual-terminal.ts";

describe("VirtualTerminal replies", () => {
	it("answers device attribute and cursor position queries only while someone listens", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const replies: string[] = [];
		terminal.write("\x1b[c");
		await terminal.flush();
		const stop = terminal.onReply((data) => replies.push(data));
		terminal.write("\x1b[3;5H\x1b[6n\x1b[c");
		await terminal.flush();
		stop();
		terminal.write("\x1b[c");
		await terminal.flush();
		assert.deepStrictEqual(replies, ["\x1b[3;5R", "\x1b[?1;2c"]);
	});
});
