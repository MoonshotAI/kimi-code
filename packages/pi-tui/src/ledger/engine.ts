import type { Component } from "../tui.ts";
import type { Terminal } from "../terminal.ts";
import { isImageLine } from "../terminal-image.ts";
import { sliceByColumn, truncateToWidth, visibleWidth } from "../utils.ts";
import { findCommittedPrefixResync } from "./audit.ts";
import { getNativeScrollbackCommitSafeEnd, getNativeScrollbackLiveRegionStart, getNativeScrollbackSnapshotSafeEnd, getRenderStablePrefixRows, setNativeScrollbackCommittedRows } from "./seam.ts";
import { coalesceAdjacentSgr } from "./sgr-coalesce.ts";
import { isMultiplexerSession, resizeRepaintsInPlace, shouldEnableSyncOutput, TERMINAL_STUB } from "./terminal-caps-stub.ts";
import {
	type CursorControlResult,
	DISABLE_AUTOWRAP,
	ENABLE_AUTOWRAP,
	ERASE_LINE,
	ERASE_TO_END_OF_LINE,
	type FrameSegment,
	HIDE_CURSOR,
	type HardwareCursorState,
	type HardwareCursorUpdate,
	LINE_TERMINATOR,
	type PreparedLine,
	type RenderIntent,
	SEGMENT_RESET,
	SYNC_OUTPUT_BEGIN,
	SYNC_OUTPUT_END,
} from "./types.ts";

export class LedgerTuiEngine {
	// ---- ledger state (OMP: 990-1028) ----
	#committedRows = 0;
	#committedPrefix: string[] = [];
	#committedPrefixAuditRows = 0;
	#committedPrefixDurableRows = 0;
	#windowTopRow = 0;
	#previousWindow: string[] = [];
	#previousFrameLength = 0;
	#previousWidth = 0;
	#previousHeight = 0;
	#hardwareCursorRow = 0;
	#showHardwareCursor = process.env["PI_HARDWARE_CURSOR"] !== "0";

	// ---- seam (per-frame, set by compose) ----
	#nativeScrollbackLiveRegionStart: number | undefined;
	#nativeScrollbackCommitSafeEnd: number | undefined;
	#nativeScrollbackSnapshotSafeEnd: number | undefined;

	// ---- gesture flags (OMP: 1029-1070) ----
	#fullRedrawCount = 0;
	#clearScrollbackOnNextRender = false;
	#forceViewportRepaintOnNextRender = false;
	#hasEverRendered = false;
	#resizeEventPending = false;

	// ---- composed + prepared caches (OMP: 1087-1125) ----
	#composedFrame: string[] = [];
	#frameSegments: FrameSegment[] = [];
	#composeWidth = -1;
	#frameCursorMarkers: { row: number; col: number }[] = [];
	#renderStablePrefixRows = 0;
	#preparedFrame: string[] = [];
	#preparedMeta: PreparedLine[] = [];
	#preparedValidRows = 0;

	// ---- paint framing ----
	readonly #syncEnabled: boolean;
	readonly #paintBeginSequence: string;
	readonly #paintEndSequence: string;

	// children injected by the host TUI (it owns the Container children list)
	constructor(
		private readonly terminal: Terminal,
		private readonly getChildren: () => Component[],
	) {
		this.#syncEnabled = shouldEnableSyncOutput();
		this.#paintBeginSequence = this.#syncEnabled
			? `${HIDE_CURSOR}${SYNC_OUTPUT_BEGIN}${DISABLE_AUTOWRAP}`
			: `${HIDE_CURSOR}${DISABLE_AUTOWRAP}`;
		this.#paintEndSequence = this.#syncEnabled ? `${ENABLE_AUTOWRAP}${SYNC_OUTPUT_END}` : ENABLE_AUTOWRAP;
	}

	get fullRedraws(): number {
		return this.#fullRedrawCount;
	}

	// ---- cursor control (OMP: 3647-3671, 3120-3130) ----
	#targetHardwareCursorState(cursorPos: { row: number; col: number } | null, totalLines: number): HardwareCursorState | null {
		if (!cursorPos || totalLines <= 0) return null;
		return {
			row: Math.max(0, Math.min(cursorPos.row, totalLines - 1)),
			col: Math.max(0, cursorPos.col),
			visible: this.#showHardwareCursor,
		};
	}

	#cursorControlSequence(
		cursorPos: { row: number; col: number } | null,
		totalLines: number,
		fromRow: number,
	): CursorControlResult {
		const target = this.#targetHardwareCursorState(cursorPos, totalLines);
		if (!target) {
			return { seq: "\x1b[?25l", toRow: fromRow, toCol: 0, visible: false, state: null };
		}
		const rowDelta = target.row - fromRow;
		let seq = "";
		if (rowDelta > 0) seq += `\x1b[${rowDelta}B`;
		else if (rowDelta < 0) seq += `\x1b[${-rowDelta}A`;
		seq += `\x1b[${target.col + 1}G`;
		seq += target.visible ? "\x1b[?25h" : "\x1b[?25l";
		return { seq, toRow: target.row, toCol: target.col, visible: target.visible, state: target };
	}

	#recordHardwareCursorUpdate(update: HardwareCursorUpdate): void {
		this.#hardwareCursorRow = update.toRow;
		if (update.state) this.#showHardwareCursor = update.state.visible;
	}

	#ingestFrameRow(line: string): void {
		const CURSOR_MARKER = "\x1b_pi:c\x07";
		let markerIndex = line.indexOf(CURSOR_MARKER);
		if (markerIndex === -1) {
			this.#composedFrame.push(line);
			return;
		}
		this.#frameCursorMarkers.push({ row: this.#composedFrame.length, col: visibleWidth(line.slice(0, markerIndex)) });
		let stripped = line;
		while (markerIndex !== -1) {
			stripped = stripped.slice(0, markerIndex) + stripped.slice(markerIndex + CURSOR_MARKER.length);
			markerIndex = stripped.indexOf(CURSOR_MARKER, markerIndex);
		}
		this.#composedFrame.push(stripped);
	}

	#pruneFrameCursorMarkers(fromRow: number): void {
		this.#frameCursorMarkers = this.#frameCursorMarkers.filter((m) => m.row < fromRow);
	}

	#composeFrame(width: number): readonly string[] {
		width = Math.max(1, width);
		this.#nativeScrollbackLiveRegionStart = undefined;
		this.#nativeScrollbackCommitSafeEnd = undefined;
		this.#nativeScrollbackSnapshotSafeEnd = undefined;
		const children = this.getChildren();
		const previousSegments = this.#frameSegments;
		const segments: FrameSegment[] = new Array(children.length);
		let chainStable = this.#composeWidth === width;
		this.#composeWidth = width;
		let offset = 0;
		let stableRows = 0;

		for (let index = 0; index < children.length; index++) {
			const child = children[index]!;
			const previous = previousSegments[index];
			// Phase A: no component-scoped reuse yet (partial roots = null)
			let childLines: readonly string[];
			let liveLocalStart: number | undefined;
			let commitLocalEnd: number | undefined;
			let snapshotLocalEnd: number | undefined;
			let reported: number | undefined;

			setNativeScrollbackCommittedRows(child, Math.max(0, this.#committedRows - offset));
			childLines = child.render(width);
			const liveRegionStart = getNativeScrollbackLiveRegionStart(child);
			if (liveRegionStart !== undefined) {
				liveLocalStart = Number.isFinite(liveRegionStart)
					? Math.max(0, Math.min(childLines.length, Math.trunc(liveRegionStart)))
					: childLines.length;
				const commitSafeEnd = getNativeScrollbackCommitSafeEnd(child);
				if (commitSafeEnd !== undefined) {
					commitLocalEnd = Number.isFinite(commitSafeEnd)
						? Math.max(liveLocalStart, Math.min(childLines.length, Math.trunc(commitSafeEnd)))
						: childLines.length;
				}
				const snapshotSafeEnd = getNativeScrollbackSnapshotSafeEnd(child);
				if (snapshotSafeEnd !== undefined) {
					const snapshotFloor = commitLocalEnd ?? liveLocalStart;
					snapshotLocalEnd = Number.isFinite(snapshotSafeEnd)
						? Math.max(snapshotFloor, Math.min(childLines.length, Math.trunc(snapshotSafeEnd)))
						: childLines.length;
				}
			}
			reported = getRenderStablePrefixRows(child);

			// topmost seam wins
			if (liveLocalStart !== undefined && this.#nativeScrollbackLiveRegionStart === undefined) {
				this.#nativeScrollbackLiveRegionStart = offset + liveLocalStart;
				if (commitLocalEnd !== undefined) this.#nativeScrollbackCommitSafeEnd = offset + commitLocalEnd;
				if (snapshotLocalEnd !== undefined) this.#nativeScrollbackSnapshotSafeEnd = offset + snapshotLocalEnd;
			}

			if (chainStable) {
				if (previous !== undefined && previous.component === child && previous.start === offset) {
					let stableCount = 0;
					if (reported !== undefined) {
						stableCount = Number.isFinite(reported)
							? Math.max(0, Math.min(childLines.length, previous.rowCount, Math.trunc(reported)))
							: 0;
					} else if (previous.lines === childLines) {
						stableCount = childLines.length;
					}
					stableRows += stableCount;
					if (stableCount < childLines.length || previous.rowCount !== childLines.length) chainStable = false;
				} else {
					chainStable = false;
				}
			}
			segments[index] = { component: child, lines: childLines, start: offset, rowCount: childLines.length, liveLocalStart, commitLocalEnd, snapshotLocalEnd };
			offset += childLines.length;
		}
		this.#frameSegments = segments;

		const frame = this.#composedFrame;
		if (stableRows > frame.length) stableRows = frame.length;
		if (stableRows !== offset || frame.length !== offset) {
			frame.length = stableRows;
			this.#pruneFrameCursorMarkers(stableRows);
			for (const segment of segments) {
				const lines = segment.lines;
				const from = segment.start >= stableRows ? 0 : stableRows - segment.start;
				for (let i = from; i < lines.length; i++) this.#ingestFrameRow(lines[i]!);
			}
		}
		this.#renderStablePrefixRows = stableRows;
		this.#preparedValidRows = Math.min(this.#preparedValidRows, stableRows);
		return frame;
	}

	#prepareFrame(frame: readonly string[], width: number): string[] {
		const prepared = this.#preparedFrame;
		const meta = this.#preparedMeta;
		if (prepared.length > frame.length) {
			prepared.length = frame.length;
			meta.length = frame.length;
		}
		for (let i = Math.min(this.#preparedValidRows, prepared.length); i < frame.length; i++) {
			const raw = frame[i]!;
			const cached = meta[i];
			if (cached !== undefined && cached.raw === raw && cached.width === width) {
				prepared[i] = cached.line;
				continue;
			}
			const entry = this.#prepareLine(raw, width);
			meta[i] = entry;
			prepared[i] = entry.line;
		}
		this.#preparedValidRows = frame.length;
		return prepared;
	}

	#prepareLine(raw: string, width: number): PreparedLine {
		if (isImageLine(raw)) return { raw, width, line: raw };
		const normalized = raw; // Phase A: 假定组件已规范化；如需 normalizeTerminalOutput 在此补
		if (visibleWidth(normalized) <= width) return { raw, width, line: normalized };
		return { raw, width, line: truncateToWidth(normalized, width) };
	}

	#terminalLine(line: string): string {
		if (isImageLine(line)) return line;
		const coalesced = coalesceAdjacentSgr(line);
		return coalesced + (line.includes("\x1b]8;") ? LINE_TERMINATOR : SEGMENT_RESET);
	}

	#lineRewriteSequence(line: string, width: number): string {
		if (isImageLine(line)) return ERASE_LINE + line;
		const terminalLine = this.#terminalLine(line);
		const w = visibleWidth(line);
		if (w >= width) return terminalLine;
		return SEGMENT_RESET + ERASE_TO_END_OF_LINE + terminalLine;
	}

	// OMP: 2831-2851
	#auditCommittedPrefix(rawFrame: readonly string[], permanentEnd: number): void {
		const prefix = this.#committedPrefix;
		if (prefix.length === 0) return;
		const resyncTo = findCommittedPrefixResync(
			rawFrame,
			prefix,
			prefix.length,
			this.#committedPrefixAuditRows,
			this.#committedPrefixDurableRows,
			permanentEnd,
		);
		if (resyncTo < 0) return;
		this.#committedRows = resyncTo;
		this.#committedPrefixAuditRows = Math.min(this.#committedPrefixAuditRows, resyncTo);
		this.#committedPrefixDurableRows = Math.min(this.#committedPrefixDurableRows, resyncTo);
		prefix.length = resyncTo;
		if (process.env["PI_DEBUG_REDRAW"] === "1") {
			process.stderr.write(`[pi-tui] commit resync at row ${resyncTo}; recommitting\n`);
		}
	}

	// OMP: 2866-2891
	#updateCommittedAuditRows(
		resliced: boolean,
		preCommittedRows: number,
		preAuditRows: number,
		preDurableRows: number,
		byteStableBoundary: number,
		durableBoundary: number,
		hardAudited: boolean,
	): void {
		const committed = this.#committedRows;
		const auditRows =
			resliced || preAuditRows >= preCommittedRows
				? Math.min(committed, byteStableBoundary)
				: Math.min(preAuditRows, committed);
		const durableRows =
			resliced || preDurableRows >= preCommittedRows || hardAudited
				? Math.min(committed, durableBoundary)
				: Math.min(preDurableRows, committed);
		this.#committedPrefixAuditRows = auditRows;
		this.#committedPrefixDurableRows = Math.max(auditRows, durableRows);
	}

	// OMP: 3105-3118 — 只记录"屏幕上有什么"，不推进 ledger
	#commit(
		lines: readonly string[],
		window: string[],
		width: number,
		height: number,
		hardwareCursor: HardwareCursorUpdate,
	): void {
		this.#previousFrameLength = lines.length;
		this.#previousWindow = window;
		this.#forceViewportRepaintOnNextRender = false;
		this.#previousWidth = width;
		this.#previousHeight = height;
		this.#recordHardwareCursorUpdate(hardwareCursor);
	}
}
