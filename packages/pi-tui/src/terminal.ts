import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { setKittyProtocolActive } from "./keys.ts";
import { isNativeModifierPressed } from "./native-modifiers.ts";
import { StdinBuffer } from "./stdin-buffer.ts";
import { ProcessTerminalCapabilities, type TerminalCapabilities } from "./terminal-capabilities.ts";
import { type ProbeIO, type ProbeResult, probeCapabilities } from "./terminal-probe.ts";

const cjsRequire = createRequire(import.meta.url);

const TERMINAL_PROGRESS_KEEPALIVE_MS = 1000;
const TERMINAL_PROGRESS_ACTIVE_SEQUENCE = "\x1b]9;4;3\x07";
const TERMINAL_PROGRESS_CLEAR_SEQUENCE = "\x1b]9;4;0;\x07";
const APPLE_TERMINAL_SHIFT_ENTER_SEQUENCE = "\x1b[13;2u";
const DESIRED_KITTY_KEYBOARD_PROTOCOL_FLAGS = 7;
const KEYBOARD_PROTOCOL_RESPONSE_FRAGMENT_TIMEOUT_MS = 150;
const KITTY_KEYBOARD_PROTOCOL_QUERY = `\x1b[>${DESIRED_KITTY_KEYBOARD_PROTOCOL_FLAGS}u\x1b[?u\x1b[c`;
// Push-only form of the kitty query: arms the desired flag level so a following
// `CSI ? u` (emitted by the capability probe) reports non-zero flags and the
// negotiation handler enables kitty. Split out so the probe can own the single
// `CSI ? u` + DA1 sentinel on the wire (a duplicate kitty query would desync the
// probe's DA1 FIFO).
const KITTY_KEYBOARD_PROTOCOL_PUSH = `\x1b[>${DESIRED_KITTY_KEYBOARD_PROTOCOL_FLAGS}u`;

export type KeyboardProtocolNegotiationSequence =
	| { type: "kitty-flags"; flags: number }
	| { type: "device-attributes" };

export function parseKeyboardProtocolNegotiationSequence(
	sequence: string,
): KeyboardProtocolNegotiationSequence | undefined {
	const kittyFlags = sequence.match(/^\x1b\[\?(\d+)u$/);
	if (kittyFlags) {
		return { type: "kitty-flags", flags: Number.parseInt(kittyFlags[1]!, 10) };
	}
	if (/^\x1b\[\?[\d;]*c$/.test(sequence)) {
		return { type: "device-attributes" };
	}
	return undefined;
}

function isKeyboardProtocolNegotiationSequencePrefix(sequence: string): boolean {
	return sequence === "\x1b[" || /^\x1b\[\?[\d;]*$/.test(sequence);
}

export function isAppleTerminalSession(): boolean {
	return process.platform === "darwin" && process.env['TERM_PROGRAM'] === "Apple_Terminal";
}

export function normalizeAppleTerminalInput(data: string, isAppleTerminal: boolean, isShiftPressed: boolean): string {
	if (isAppleTerminal && data === "\r" && isShiftPressed) return APPLE_TERMINAL_SHIFT_ENTER_SEQUENCE;
	return data;
}

/**
 * Minimal terminal interface for TUI
 */
export interface Terminal {
	// Start the terminal with input and resize handlers
	start(onInput: (data: string) => void, onResize: () => void): void;

	// Stop the terminal and restore state
	stop(): void;

	/**
	 * Drain stdin before exiting to prevent Kitty key release events from
	 * leaking to the parent shell over slow SSH connections.
	 * @param maxMs - Maximum time to drain (default: 1000ms)
	 * @param idleMs - Exit early if no input arrives within this time (default: 50ms)
	 */
	drainInput(maxMs?: number, idleMs?: number): Promise<void>;

	// Write output to terminal
	write(data: string): void;

	// Get terminal dimensions
	get columns(): number;
	get rows(): number;

	// Whether Kitty keyboard protocol is active
	get kittyProtocolActive(): boolean;

	/** Resolves with the startup probe result; undefined when probing is skipped (non-TTY). */
	probeReady?: Promise<ProbeResult>;

	/** Mutable, probe-backed terminal capabilities shared with the ledger engine. */
	readonly terminalCapabilities?: TerminalCapabilities;

	// Cursor positioning (relative to current position)
	moveBy(lines: number): void; // Move cursor up (negative) or down (positive) by N lines

	// Cursor visibility
	hideCursor(): void; // Hide the cursor
	showCursor(): void; // Show the cursor

	// Clear operations
	clearLine(): void; // Clear current line
	clearFromCursor(): void; // Clear from cursor to end of screen
	clearScreen(): void; // Clear entire screen and move cursor to (0,0)

	// Title operations
	setTitle(title: string): void; // Set terminal window title

	// Progress indicator (OSC 9;4)
	setProgress(active: boolean): void;
}

/**
 * Real terminal using process.stdin/stdout
 */
export class ProcessTerminal implements Terminal {
	private wasRaw = false;
	private inputHandler?: (data: string) => void;
	private resizeHandler?: () => void;
	private _kittyProtocolActive = false;
	private _modifyOtherKeysActive = false;
	private keyboardProtocolPushed = false;
	private keyboardProtocolNegotiationBuffer = "";
	private keyboardProtocolBufferFlushTimer?: ReturnType<typeof setTimeout>;
	private stdinBuffer?: StdinBuffer;
	private stdinDataHandler?: (data: string) => void;
	private progressInterval?: ReturnType<typeof setInterval>;
	private writeLogPath = (() => {
		const env = process.env['PI_TUI_WRITE_LOG'] || "";
		if (!env) return "";
		try {
			if (fs.statSync(env).isDirectory()) {
				const now = new Date();
				const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}-${String(now.getMinutes()).padStart(2, "0")}-${String(now.getSeconds()).padStart(2, "0")}`;
				return path.join(env, `tui-${ts}-${process.pid}.log`);
			}
		} catch {
			// Not an existing directory - use as-is (file path)
		}
		return env;
	})();

	readonly #capabilities = new ProcessTerminalCapabilities();
	/** Resolves with the startup probe result; undefined when probing is skipped (non-TTY). */
	probeReady: Promise<ProbeResult> | undefined;

	/** Mutable, probe-backed terminal capabilities shared with the ledger engine. */
	get terminalCapabilities(): ProcessTerminalCapabilities {
		return this.#capabilities;
	}

	get kittyProtocolActive(): boolean {
		return this._kittyProtocolActive;
	}

	get modifyOtherKeysActive(): boolean {
		return this._modifyOtherKeysActive;
	}

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.inputHandler = onInput;
		this.resizeHandler = onResize;

		// Save previous state and enable raw mode
		this.wasRaw = process.stdin.isRaw || false;
		if (process.stdin.setRawMode) {
			process.stdin.setRawMode(true);
		}
		process.stdin.setEncoding("utf8");
		process.stdin.resume();

		// Enable bracketed paste mode - terminal will wrap pastes in \x1b[200~ ... \x1b[201~
		process.stdout.write("\x1b[?2004h");

		// Set up resize handler immediately
		process.stdout.on("resize", this.resizeHandler);

		// Refresh terminal dimensions - they may be stale after suspend/resume
		// (SIGWINCH is lost while process is stopped). Unix only.
		if (process.platform !== "win32") {
			process.kill(process.pid, "SIGWINCH");
		}

		// On Windows, enable ENABLE_VIRTUAL_TERMINAL_INPUT so the console sends
		// VT escape sequences (e.g. \x1b[Z for Shift+Tab) instead of raw console
		// events that lose modifier information. Must run AFTER setRawMode(true)
		// since that resets console mode flags.
		this.enableWindowsVTInput();

		// Bring the stdin pipeline (StdinBuffer) live first, then arm kitty flags and
		// run the capability probe. The probe taps stdin observe-only and emits the
		// single kitty `CSI ? u` + DA1 sentinel; arming the flag level beforehand makes
		// that probe report non-zero flags so the negotiation handler enables kitty.
		// In non-TTY (headless) mode there is no terminal to probe, so fall back to the
		// legacy full kitty query. See: https://sw.kovidgoyal.net/kitty/keyboard-protocol/
		this.setupKeyboardProtocolPipeline();
		if (process.stdout.isTTY) {
			process.stdout.write(KITTY_KEYBOARD_PROTOCOL_PUSH);
			this.runCapabilityProbe();
		} else {
			process.stdout.write(KITTY_KEYBOARD_PROTOCOL_QUERY);
		}
	}

	/**
	 * Set up StdinBuffer to split batched input into individual sequences.
	 * This ensures components receive single events, making matchesKey/isKeyRelease work correctly.
	 *
	 * Also watches for Kitty protocol response and enables it when detected.
	 * This is done here (after stdinBuffer parsing) rather than on raw stdin
	 * to handle the case where the response arrives split across multiple events.
	 */
	private setupStdinBuffer(): void {
		this.stdinBuffer = new StdinBuffer({ timeout: 10 });

		// Forward individual sequences to the input handler
		this.stdinBuffer.on("data", (sequence) => {
			const negotiationSequence = this.readKeyboardProtocolNegotiationSequence(sequence);
			if (negotiationSequence === "pending") {
				this.scheduleKeyboardProtocolNegotiationBufferFlush();
				return; // Wait briefly for the rest of a split Kitty response.
			}
			if (this.handleKeyboardProtocolNegotiationSequence(negotiationSequence)) {
				return;
			}

			this.forwardInputSequence(sequence);
		});

		// Re-wrap paste content with bracketed paste markers for existing editor handling
		this.stdinBuffer.on("paste", (content) => {
			if (this.inputHandler) {
				this.inputHandler(`\x1b[200~${content}\x1b[201~`);
			}
		});

		// Handler that pipes stdin data through the buffer
		this.stdinDataHandler = (data: string) => {
			this.stdinBuffer!.process(data);
		};
	}

	/**
	 * Bring the stdin pipeline (StdinBuffer + data handler) live and arm the
	 * keyboard-protocol negotiation buffer, without writing the kitty query. In
	 * TTY mode the kitty query is emitted by the capability probe (its first probe
	 * is `CSI ? u` + DA1), so this must not write a second one — a duplicate would
	 * desync the probe's DA1 FIFO. Kept separate so start() can order the flag push,
	 * the probe, and the headless fallback.
	 */
	private setupKeyboardProtocolPipeline(): void {
		this.setupStdinBuffer();
		process.stdin.on("data", this.stdinDataHandler!);
		this.keyboardProtocolPushed = true;
		this.clearKeyboardProtocolNegotiationBuffer();
	}

	/**
	 * Run the startup capability probe (kitty / OSC 11 / DECRQM ?2026 ?2048 ?2031).
	 *
	 * The probe's first write (`CSI ? u` + DA1) doubles as the kitty keyboard query;
	 * the caller arms the desired flag level first so the reply reports non-zero
	 * flags and the negotiation handler enables kitty. Skipped when stdout is not a
	 * TTY — headless environments leave {@link probeReady} undefined and keep the
	 * static capability defaults. When it runs, the probe taps the stdin `data`
	 * stream observe-only (Node delivers each chunk to every `data` listener, so the
	 * StdinBuffer is undisturbed) and writes to stdout. On resolution the probed
	 * values are applied to the shared {@link ProcessTerminalCapabilities} in place.
	 */
	private runCapabilityProbe(): void {
		if (!process.stdout.isTTY) return;
		const io: ProbeIO = {
			write: (data: string) => {
				process.stdout.write(data);
			},
			onReply: (cb: (data: string) => void) => {
				const handler = (data: string) => {
					cb(data);
				};
				process.stdin.on("data", handler);
				return () => {
					process.stdin.removeListener("data", handler);
				};
			},
		};
		this.probeReady = probeCapabilities(io).then((result) => {
			this.#capabilities.applyProbe(result);
			return result;
		});
	}

	private handleKeyboardProtocolNegotiationSequence(
		negotiationSequence: KeyboardProtocolNegotiationSequence | undefined,
	): boolean {
		if (!negotiationSequence) return false;
		this.clearKeyboardProtocolNegotiationBuffer();
		if (negotiationSequence.type === "kitty-flags") {
			if (negotiationSequence.flags !== 0) {
				this.disableModifyOtherKeys();
				if (!this._kittyProtocolActive) {
					this._kittyProtocolActive = true;
					setKittyProtocolActive(true);
				}
			} else {
				this.enableModifyOtherKeys();
			}
			return true;
		}

		if (!this._kittyProtocolActive) {
			this.enableModifyOtherKeys();
		}
		return true;
	}

	private readKeyboardProtocolNegotiationSequence(
		sequence: string,
	): KeyboardProtocolNegotiationSequence | "pending" | undefined {
		if (this.keyboardProtocolNegotiationBuffer) {
			const bufferedSequence = this.keyboardProtocolNegotiationBuffer + sequence;
			const negotiationSequence = parseKeyboardProtocolNegotiationSequence(bufferedSequence);
			if (negotiationSequence) {
				this.clearKeyboardProtocolNegotiationBuffer();
				return negotiationSequence;
			}
			if (isKeyboardProtocolNegotiationSequencePrefix(bufferedSequence)) {
				this.setKeyboardProtocolNegotiationBuffer(bufferedSequence);
				return "pending";
			}
			this.flushKeyboardProtocolNegotiationBufferAsInput();
		}

		const negotiationSequence = parseKeyboardProtocolNegotiationSequence(sequence);
		if (negotiationSequence) return negotiationSequence;
		if (isKeyboardProtocolNegotiationSequencePrefix(sequence)) {
			this.setKeyboardProtocolNegotiationBuffer(sequence);
			return "pending";
		}
		return undefined;
	}

	private setKeyboardProtocolNegotiationBuffer(sequence: string): void {
		this.clearKeyboardProtocolNegotiationBufferFlushTimer();
		this.keyboardProtocolNegotiationBuffer = sequence;
	}

	private clearKeyboardProtocolNegotiationBuffer(): void {
		this.clearKeyboardProtocolNegotiationBufferFlushTimer();
		this.keyboardProtocolNegotiationBuffer = "";
	}

	private flushKeyboardProtocolNegotiationBufferAsInput(): void {
		if (!this.keyboardProtocolNegotiationBuffer) return;
		const sequence = this.keyboardProtocolNegotiationBuffer;
		this.clearKeyboardProtocolNegotiationBuffer();
		this.forwardInputSequence(sequence);
	}

	private scheduleKeyboardProtocolNegotiationBufferFlush(): void {
		if (!this.keyboardProtocolNegotiationBuffer || this.keyboardProtocolBufferFlushTimer) return;
		this.keyboardProtocolBufferFlushTimer = setTimeout(() => {
			this.keyboardProtocolBufferFlushTimer = undefined;
			this.flushKeyboardProtocolNegotiationBufferAsInput();
		}, KEYBOARD_PROTOCOL_RESPONSE_FRAGMENT_TIMEOUT_MS);
	}

	private clearKeyboardProtocolNegotiationBufferFlushTimer(): void {
		if (!this.keyboardProtocolBufferFlushTimer) return;
		clearTimeout(this.keyboardProtocolBufferFlushTimer);
		this.keyboardProtocolBufferFlushTimer = undefined;
	}

	private forwardInputSequence(sequence: string): void {
		if (!this.inputHandler) return;
		const isAppleTerminal = sequence === "\r" && isAppleTerminalSession();
		const input = normalizeAppleTerminalInput(
			sequence,
			isAppleTerminal,
			isAppleTerminal && isNativeModifierPressed("shift"),
		);
		this.inputHandler(input);
	}

	private enableModifyOtherKeys(): void {
		if (this._kittyProtocolActive || this._modifyOtherKeysActive) return;
		process.stdout.write("\x1b[>4;2m");
		this._modifyOtherKeysActive = true;
	}

	private disableModifyOtherKeys(): void {
		if (!this._modifyOtherKeysActive) return;
		process.stdout.write("\x1b[>4;0m");
		this._modifyOtherKeysActive = false;
	}

	/**
	 * On Windows, add ENABLE_VIRTUAL_TERMINAL_INPUT (0x0200) to the stdin
	 * console handle so the terminal sends VT sequences for modified keys
	 * (e.g. \x1b[Z for Shift+Tab). Without this, libuv's ReadConsoleInputW
	 * discards modifier state and Shift+Tab arrives as plain \t.
	 */
	private enableWindowsVTInput(): void {
		if (process.platform !== "win32") return;
		try {
			const arch = process.arch;
			if (arch !== "x64" && arch !== "arm64") return;

			// Dynamic require so non-Windows and bundled/browser paths never load the
			// native helper. In the npm package native/ is next to dist/; in compiled
			// binary archives native/ is copied next to the executable.
			const moduleDir = path.dirname(fileURLToPath(import.meta.url));
			const nativePath = path.join("native", "win32", "prebuilds", `win32-${arch}`, "win32-console-mode.node");
			const candidates = [
				path.join(moduleDir, "..", nativePath),
				path.join(moduleDir, nativePath),
				path.join(path.dirname(process.execPath), nativePath),
			];
			for (const modulePath of candidates) {
				try {
					const helper = cjsRequire(modulePath) as { enableVirtualTerminalInput?: () => boolean };
					helper.enableVirtualTerminalInput?.();
					return;
				} catch {
					// Try the next possible packaging location.
				}
			}
		} catch {
			// Native helper not available — Shift+Tab won't be distinguishable from Tab.
		}
	}

	async drainInput(maxMs = 1000, idleMs = 50): Promise<void> {
		const shouldDisableKittyProtocol = this.keyboardProtocolPushed || this._kittyProtocolActive;
		this.clearKeyboardProtocolNegotiationBuffer();
		if (shouldDisableKittyProtocol) {
			// Disable Kitty keyboard protocol first so any late key releases
			// do not generate new Kitty escape sequences.
			process.stdout.write("\x1b[<u");
			this.keyboardProtocolPushed = false;
			this._kittyProtocolActive = false;
			setKittyProtocolActive(false);
		}
		this.disableModifyOtherKeys();

		const previousHandler = this.inputHandler;
		this.inputHandler = undefined;

		let lastDataTime = Date.now();
		const onData = () => {
			lastDataTime = Date.now();
		};

		process.stdin.on("data", onData);
		const endTime = Date.now() + maxMs;

		try {
			while (true) {
				const now = Date.now();
				const timeLeft = endTime - now;
				if (timeLeft <= 0) break;
				if (now - lastDataTime >= idleMs) break;
				await new Promise((resolve) => setTimeout(resolve, Math.min(idleMs, timeLeft)));
			}
		} finally {
			process.stdin.removeListener("data", onData);
			this.inputHandler = previousHandler;
		}
	}

	stop(): void {
		if (this.clearProgressInterval()) {
			process.stdout.write(TERMINAL_PROGRESS_CLEAR_SEQUENCE);
		}

		// Disable bracketed paste mode
		process.stdout.write("\x1b[?2004l");

		const shouldDisableKittyProtocol = this.keyboardProtocolPushed || this._kittyProtocolActive;
		this.clearKeyboardProtocolNegotiationBuffer();

		// Disable Kitty keyboard protocol if not already done by drainInput()
		if (shouldDisableKittyProtocol) {
			process.stdout.write("\x1b[<u");
			this.keyboardProtocolPushed = false;
			this._kittyProtocolActive = false;
			setKittyProtocolActive(false);
		}
		this.disableModifyOtherKeys();

		// Clean up StdinBuffer
		if (this.stdinBuffer) {
			this.stdinBuffer.destroy();
			this.stdinBuffer = undefined;
		}

		// Remove event handlers
		if (this.stdinDataHandler) {
			process.stdin.removeListener("data", this.stdinDataHandler);
			this.stdinDataHandler = undefined;
		}
		this.inputHandler = undefined;
		if (this.resizeHandler) {
			process.stdout.removeListener("resize", this.resizeHandler);
			this.resizeHandler = undefined;
		}

		// Pause stdin to prevent any buffered input (e.g., Ctrl+D) from being
		// re-interpreted after raw mode is disabled. This fixes a race condition
		// where Ctrl+D could close the parent shell over SSH.
		process.stdin.pause();

		// Restore raw mode state
		if (process.stdin.setRawMode) {
			process.stdin.setRawMode(this.wasRaw);
		}
	}

	write(data: string): void {
		process.stdout.write(data);
		if (this.writeLogPath) {
			try {
				fs.appendFileSync(this.writeLogPath, data, { encoding: "utf8" });
			} catch {
				// Ignore logging errors
			}
		}
	}

	get columns(): number {
		return process.stdout.columns || Number(process.env['COLUMNS']) || 80;
	}

	get rows(): number {
		return process.stdout.rows || Number(process.env['LINES']) || 24;
	}

	moveBy(lines: number): void {
		if (lines > 0) {
			// Move down
			process.stdout.write(`\x1b[${lines}B`);
		} else if (lines < 0) {
			// Move up
			process.stdout.write(`\x1b[${-lines}A`);
		}
		// lines === 0: no movement
	}

	hideCursor(): void {
		process.stdout.write("\x1b[?25l");
	}

	showCursor(): void {
		process.stdout.write("\x1b[?25h");
	}

	clearLine(): void {
		process.stdout.write("\x1b[K");
	}

	clearFromCursor(): void {
		process.stdout.write("\x1b[J");
	}

	clearScreen(): void {
		process.stdout.write("\x1b[2J\x1b[H"); // Clear screen and move to home (1,1)
	}

	setTitle(title: string): void {
		// OSC 0;title BEL - set terminal window title
		process.stdout.write(`\x1b]0;${title}\x07`);
	}

	setProgress(active: boolean): void {
		if (active) {
			// OSC 9;4;3 - indeterminate progress
			process.stdout.write(TERMINAL_PROGRESS_ACTIVE_SEQUENCE);
			if (!this.progressInterval) {
				this.progressInterval = setInterval(() => {
					process.stdout.write(TERMINAL_PROGRESS_ACTIVE_SEQUENCE);
				}, TERMINAL_PROGRESS_KEEPALIVE_MS);
			}
		} else {
			this.clearProgressInterval();
			// OSC 9;4;0 - clear progress
			process.stdout.write(TERMINAL_PROGRESS_CLEAR_SEQUENCE);
		}
	}

	private clearProgressInterval(): boolean {
		if (!this.progressInterval) return false;
		clearInterval(this.progressInterval);
		this.progressInterval = undefined;
		return true;
	}
}
