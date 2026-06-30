import assert from "node:assert";
import { describe, it } from "node:test";
import {
	createStaticCapabilities,
	isMultiplexerSession,
	shouldEnableHyperlinks,
	shouldEnableSyncOutput,
} from "../src/terminal-capabilities.ts";
import { isImageLine as detectImageLine } from "../src/terminal-image.ts";

describe("terminal-capabilities", () => {
	it("detects mux via env and TERM fallback", () => {
		assert.strictEqual(isMultiplexerSession({ TMUX: "x" }), true);
		assert.strictEqual(isMultiplexerSession({ TERM: "screen-256color" }), true);
		assert.strictEqual(isMultiplexerSession({ TERM: "xterm-256color" }), false);
	});
	it("sync: force on overrides mux", () => {
		assert.strictEqual(shouldEnableSyncOutput({ PI_FORCE_SYNC_OUTPUT: "1", TMUX: "x" }), true);
	});
	it("sync: off in mux by default", () => {
		assert.strictEqual(shouldEnableSyncOutput({ TMUX: "x", TERM: "xterm-kitty" }), false);
	});
	it("sync: on for known direct terminal", () => {
		assert.strictEqual(shouldEnableSyncOutput({ TERM: "xterm-kitty" }), true);
	});
	it("sync: DECRQM result overrides static table", () => {
		assert.strictEqual(shouldEnableSyncOutput({ TERM: "dumb" }, true), true);
		assert.strictEqual(shouldEnableSyncOutput({ TERM: "xterm-kitty" }, false), false);
	});
	it("hyperlinks off in mux", () => {
		assert.strictEqual(shouldEnableHyperlinks({ TMUX: "x" }), false);
	});
	it("sync/hyperlinks env override ordering", () => {
		// NO beats the static table.
		assert.strictEqual(shouldEnableSyncOutput({ PI_NO_SYNC_OUTPUT: "1", TERM: "xterm-kitty" }), false);
		// FORCE beats NO when both are set.
		assert.strictEqual(shouldEnableSyncOutput({ PI_FORCE_SYNC_OUTPUT: "1", PI_NO_SYNC_OUTPUT: "1" }), true);
		// NO disables hyperlinks.
		assert.strictEqual(shouldEnableHyperlinks({ PI_NO_HYPERLINKS: "1" }), false);
	});
});

describe("createStaticCapabilities", () => {
	it("syncEnabled reflects env via the static factory", () => {
		assert.strictEqual(createStaticCapabilities({ TERM: "xterm-kitty" }).syncEnabled, true);
		assert.strictEqual(createStaticCapabilities({ TERM: "dumb" }).syncEnabled, false);
	});
	it("uses the conservative static defaults", () => {
		const caps = createStaticCapabilities({ TERM: "xterm-kitty" });
		assert.strictEqual(caps.supportsScreenToScrollback, false);
		assert.strictEqual(caps.deccara, false);
		assert.strictEqual(caps.imageProtocol, "none");
	});
	it("isImageLine delegates to the terminal-image detector", () => {
		const caps = createStaticCapabilities({ TERM: "xterm-kitty" });
		const kittyLine = "\x1b_Ga=T,f=100;AAAA\x1b\\";
		const plainLine = "just a plain line of text";
		// Real positive + negative cases against the assembled object.
		assert.strictEqual(caps.isImageLine(kittyLine), true);
		assert.strictEqual(caps.isImageLine(plainLine), false);
		// And they match the real detector it delegates to.
		assert.strictEqual(caps.isImageLine(kittyLine), detectImageLine(kittyLine));
		assert.strictEqual(caps.isImageLine(plainLine), detectImageLine(plainLine));
	});
});
