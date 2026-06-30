import type { Component } from "../tui.ts";
import type { Terminal } from "../terminal.ts";
import { type TerminalCapabilities, isMultiplexerSession, resizeRepaintsInPlace } from "../terminal-capabilities.ts";
import { sliceByColumn, truncateToWidth, visibleWidth } from "../utils.ts";
import { findCommittedPrefixResync } from "./audit.ts";
import { getNativeScrollbackCommitSafeEnd, getNativeScrollbackLiveRegionStart, getNativeScrollbackSnapshotSafeEnd, getRenderStablePrefixRows, setNativeScrollbackCommittedRows } from "./seam.ts";
import { coalesceAdjacentSgr } from "./sgr-coalesce.ts";
import {
	type CursorControlResult,
	ALT_SCREEN_ENTER,
	ALT_SCREEN_EXIT,
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
	#stopped = false;

	// ---- resize viewport defer (Phase B Task 4) ----
	#resizeViewportActive = false;
	#resizeViewportSettleTimer: ReturnType<typeof setTimeout> | undefined;
	static readonly #RESIZE_SETTLE_MS = 120;

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
	// Recomputed by refreshSyncFraming() once the startup probe resolves, since
	// the caps object is mutated in place by ProcessTerminalCapabilities.applyProbe.
	#syncEnabled: boolean;
	#paintBeginSequence: string;
	#paintEndSequence: string;

	// children injected by the host TUI (it owns the Container children list)
	private readonly terminal: Terminal;
	private readonly getChildren: () => Component[];
	readonly #caps: TerminalCapabilities;

	constructor(terminal: Terminal, getChildren: () => Component[], caps: TerminalCapabilities) {
		this.terminal = terminal;
		this.getChildren = getChildren;
		this.#caps = caps;
		this.#syncEnabled = caps.syncEnabled;
		this.#paintBeginSequence = this.#syncEnabled
			? `${HIDE_CURSOR}${SYNC_OUTPUT_BEGIN}${DISABLE_AUTOWRAP}`
			: `${HIDE_CURSOR}${DISABLE_AUTOWRAP}`;
		this.#paintEndSequence = this.#syncEnabled ? `${ENABLE_AUTOWRAP}${SYNC_OUTPUT_END}` : ENABLE_AUTOWRAP;
	}

	/**
	 * Recompute the synchronized-output paint framing from the current caps.
	 * The host calls this after the startup probe resolves: the caps object is
	 * mutated in place by `ProcessTerminalCapabilities.applyProbe`, so re-reading
	 * `this.#caps.syncEnabled` picks up the DECRQM ?2026 result.
	 */
	public refreshSyncFraming(): void {
		this.#syncEnabled = this.#caps.syncEnabled;
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
		if (this.#caps.isImageLine(raw)) return { raw, width, line: raw };
		const normalized = raw; // Phase A: 假定组件已规范化；如需 normalizeTerminalOutput 在此补
		if (visibleWidth(normalized) <= width) return { raw, width, line: normalized };
		// Hard-clamp to width without an ellipsis (matches OMP Ellipsis.Omit):
		// the first `width` columns of the original content must remain visible.
		return { raw, width, line: truncateToWidth(normalized, width, "") };
	}

	#terminalLine(line: string): string {
		if (this.#caps.isImageLine(line)) return line;
		const coalesced = coalesceAdjacentSgr(line);
		return coalesced + (line.includes("\x1b]8;") ? LINE_TERMINATOR : SEGMENT_RESET);
	}

	#lineRewriteSequence(line: string, width: number): string {
		if (this.#caps.isImageLine(line)) return ERASE_LINE + line;
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

	// OMP: 3182-3240 — 唯一 ED3 call site
	#emitFullPaint(
		frame: readonly string[],
		window: string[],
		width: number,
		height: number,
		cursorPos: { row: number; col: number } | null,
		options: { clearScrollback: boolean; chunkTo: number; windowTop: number },
	): void {
		this.#fullRedrawCount += 1;
		const { chunkTo, windowTop } = options;
		let buffer = this.#paintBeginSequence;
		if (options.clearScrollback) {
			buffer += "\x1b[2J\x1b[H\x1b[3J";
		} else if (this.#caps.supportsScreenToScrollback) {
			buffer += "\x1b[2J\x1b[H\x1b[22J"; // kitty ED22: keep pre-existing shell screen
		} else {
			buffer += "\x1b[2J\x1b[H";
		}
		let wroteLine = false;
		for (let i = 0; i < chunkTo; i++) {
			if (wroteLine) buffer += "\r\n";
			buffer += this.#terminalLine(frame[i] ?? "");
			wroteLine = true;
		}
		for (let screenRow = 0; screenRow < height; screenRow++) {
			if (wroteLine) buffer += "\r\n";
			buffer += this.#terminalLine(window[screenRow] ?? "");
			wroteLine = true;
		}
		const contentRows = Math.max(1, Math.min(height, frame.length - windowTop));
		const parkUp = height - contentRows;
		if (parkUp > 0) buffer += `\x1b[${parkUp}A`;
		const contentBottomRow = windowTop + contentRows - 1;
		const cursorControl = this.#cursorControlSequence(cursorPos, frame.length, contentBottomRow);
		buffer += cursorControl.seq;
		buffer += this.#paintEndSequence;
		this.terminal.write(buffer);

		this.#committedRows = chunkTo;
		this.#windowTopRow = windowTop;
		this.#commit(frame, window, width, height, cursorControl);
	}

	// OMP: 3462-3624
	#emitUpdate(
		frame: readonly string[],
		window: string[],
		width: number,
		height: number,
		cursorPos: { row: number; col: number } | null,
		options: {
			chunkTo: number;
			windowTop: number;
			prevWindowTop: number;
			prevHardwareCursorRow: number;
			forceWindowRewrite: boolean;
		},
	): void {
		const { chunkTo, windowTop, prevWindowTop, prevHardwareCursorRow, forceWindowRewrite } = options;
		const chunkFrom = this.#committedRows;
		const chunkLength = chunkTo - chunkFrom;
		const scroll = windowTop - prevWindowTop;
		const previousWindow = this.#previousWindow;
		const contentRows = Math.max(1, Math.min(height, frame.length - windowTop));
		const contentBottomRow = windowTop + contentRows - 1;
		const clampedCursor = Math.min(prevHardwareCursorRow, prevWindowTop + height - 1);
		const currentScreenRow = Math.max(0, Math.min(height - 1, clampedCursor - prevWindowTop));

		// ---- shape 1: scroll-append ----
		if (!forceWindowRewrite && chunkLength > 0 && chunkLength === scroll && scroll < height && chunkFrom === prevWindowTop) {
			let prefixIntact = previousWindow.length === height;
			for (let i = 0; prefixIntact && i < chunkLength; i++) {
				if (previousWindow[i] !== frame[chunkFrom + i]) prefixIntact = false;
			}
			if (prefixIntact) {
				let buffer = this.#paintBeginSequence;
				const moveToBottom = height - 1 - currentScreenRow;
				if (moveToBottom > 0) buffer += `\x1b[${moveToBottom}B`;
				for (let r = height - scroll; r < height; r++) {
					buffer += `\r\n${this.#lineRewriteSequence(window[r] ?? "", width)}`;
				}
				let firstChanged = -1;
				let lastChanged = -1;
				for (let r = 0; r < height - scroll; r++) {
					if ((window[r] ?? "") === (previousWindow[r + scroll] ?? "")) continue;
					if (firstChanged === -1) firstChanged = r;
					lastChanged = r;
				}
				let cursorFromRow = windowTop + height - 1;
				if (firstChanged !== -1) {
					const up = height - 1 - firstChanged;
					if (up > 0) buffer += `\x1b[${up}A`;
					buffer += "\r";
					for (let r = firstChanged; r <= lastChanged; r++) {
						if (r > firstChanged) buffer += "\r\n";
						buffer += this.#lineRewriteSequence(window[r] ?? "", width);
					}
					cursorFromRow = windowTop + lastChanged;
				}
				const cursorControl = this.#cursorControlSequence(cursorPos, frame.length, cursorFromRow);
				buffer += cursorControl.seq;
				buffer += this.#paintEndSequence;
				this.terminal.write(buffer);
				this.#committedRows = chunkTo;
				this.#windowTopRow = windowTop;
				this.#commit(frame, window, width, height, cursorControl);
				return;
			}
		}

		// ---- shape 2: in-window diff ----
		if (chunkLength === 0 && scroll === 0) {
			if (forceWindowRewrite) this.#fullRedrawCount += 1;
			let firstChanged = forceWindowRewrite ? 0 : -1;
			let lastChanged = forceWindowRewrite ? height - 1 : -1;
			if (!forceWindowRewrite) {
				const comparable = previousWindow.length === height;
				for (let r = 0; r < height; r++) {
					if (comparable && (window[r] ?? "") === (previousWindow[r] ?? "")) continue;
					if (firstChanged === -1) firstChanged = r;
					lastChanged = r;
				}
			}
			if (firstChanged === -1) {
				this.#writeCursorPosition(cursorPos, frame.length);
				this.#previousWidth = width;
				this.#previousHeight = height;
				return;
			}
			let buffer = this.#paintBeginSequence;
			const rowDelta = firstChanged - currentScreenRow;
			if (rowDelta > 0) buffer += `\x1b[${rowDelta}B`;
			else if (rowDelta < 0) buffer += `\x1b[${-rowDelta}A`;
			buffer += "\r";
			for (let r = firstChanged; r <= lastChanged; r++) {
				if (r > firstChanged) buffer += "\r\n";
				buffer += this.#lineRewriteSequence(window[r] ?? "", width);
			}
			let cursorFromRow = windowTop + lastChanged;
			const contentBottomScreenRow = contentBottomRow - windowTop;
			if (lastChanged > contentBottomScreenRow) {
				buffer += `\x1b[${lastChanged - contentBottomScreenRow}A`;
				cursorFromRow = contentBottomRow;
			}
			const cursorControl = this.#cursorControlSequence(cursorPos, frame.length, cursorFromRow);
			buffer += cursorControl.seq;
			buffer += this.#paintEndSequence;
			this.terminal.write(buffer);
			this.#commit(frame, window, width, height, cursorControl);
			return;
		}

		// ---- shape 3: seam rewrite ----
		this.#fullRedrawCount += 1;
		let buffer = this.#paintBeginSequence;
		if (currentScreenRow > 0) buffer += `\x1b[${currentScreenRow}A`;
		buffer += "\r";
		let wroteLine = false;
		for (let i = chunkFrom; i < chunkTo; i++) {
			if (wroteLine) buffer += "\r\n";
			buffer += this.#lineRewriteSequence(frame[i] ?? "", width);
			wroteLine = true;
		}
		for (let screenRow = 0; screenRow < height; screenRow++) {
			if (wroteLine) buffer += "\r\n";
			buffer += this.#lineRewriteSequence(window[screenRow] ?? "", width);
			wroteLine = true;
		}
		const parkUp = height - 1 - (contentBottomRow - windowTop);
		if (parkUp > 0) buffer += `\x1b[${parkUp}A`;
		const cursorControl = this.#cursorControlSequence(cursorPos, frame.length, contentBottomRow);
		buffer += cursorControl.seq;
		buffer += this.#paintEndSequence;
		this.terminal.write(buffer);
		this.#committedRows = chunkTo;
		this.#windowTopRow = windowTop;
		this.#commit(frame, window, width, height, cursorControl);
	}

	#writeCursorPosition(cursorPos: { row: number; col: number } | null, totalLines: number): void {
		const cursorControl = this.#cursorControlSequence(cursorPos, totalLines, this.#hardwareCursorRow);
		if (cursorControl.seq.length > 0) this.terminal.write(cursorControl.seq);
		this.#recordHardwareCursorUpdate(cursorControl);
	}

	// 公共入口（由 TUI.doRender 分发调用）
	public doRender(): void {
		if (this.#stopped) return;
		const width = this.terminal.columns;
		const height = this.terminal.rows;
		if (this.#resizeViewportActive) {
			// dragging: paint viewport only; no ledger/commit/diff
			this.#renderResizeViewport(width, height);
			this.#armResizeSettle();
			return;
		}

		// 1. compose (Phase A: no partial roots, no image budget pass)
		const rawFrame = this.#composeFrame(width);
		const cursorMarkers = this.#frameCursorMarkers;

		const liveRegionStart = this.#nativeScrollbackLiveRegionStart;
		const commitSafeEnd = this.#nativeScrollbackCommitSafeEnd;
		const snapshotSafeEnd = this.#nativeScrollbackSnapshotSafeEnd;

		// 2. boundaries (OMP: 2599-2604)
		const frameLength = rawFrame.length;
		const byteStableBoundary = Math.max(0, Math.min(frameLength, commitSafeEnd ?? liveRegionStart ?? frameLength));
		const durableBoundary = Math.max(byteStableBoundary, Math.min(frameLength, snapshotSafeEnd ?? byteStableBoundary));

		// 3. transition state (OMP: 2606-2619)
		const prevWindowTop = this.#windowTopRow;
		const prevHardwareCursorRow = this.#hardwareCursorRow;
		const resizeEventOccurred = this.#resizeEventPending;
		this.#resizeEventPending = false;
		const widthChanged = this.#previousWidth > 0 && this.#previousWidth !== width;
		const heightChanged =
			(this.#previousHeight > 0 && this.#previousHeight !== height) ||
			(resizeEventOccurred && this.#previousHeight > 0);
		const geometryChanged = widthChanged || heightChanged;

		// 4. audit (OMP: 2634-2658)
		let committedRowsResynced = false;
		const auditUpper =
			this.#committedPrefixDurableRows < this.#committedRows ? this.#committedRows : this.#committedPrefixAuditRows;
		const hardAuditEnd = Math.min(this.#committedRows, durableBoundary);
		const needHardAudit = this.#committedPrefixDurableRows < hardAuditEnd;
		const auditRan =
			this.#hasEverRendered &&
			!geometryChanged &&
			!this.#clearScrollbackOnNextRender &&
			(this.#renderStablePrefixRows < auditUpper || needHardAudit);
		if (auditRan) {
			const before = this.#committedRows;
			this.#auditCommittedPrefix(rawFrame, durableBoundary);
			committedRowsResynced = this.#committedRows !== before;
		}
		const preCommitRows = this.#committedRows;
		const preCommitAuditRows = this.#committedPrefixAuditRows;
		const preCommitDurableRows = this.#committedPrefixDurableRows;

		// 5. classify + window math (OMP: 2680-2731)
		const firstPaint = !this.#hasEverRendered;
		const replaceRequested = this.#clearScrollbackOnNextRender;
		const geometryRebuild = geometryChanged && !resizeRepaintsInPlace();
		const fullPaint = firstPaint || replaceRequested || geometryRebuild;
		let windowTop: number;
		let chunkTo: number;
		let committedPrefixResliced = false;
		if (fullPaint) {
			committedPrefixResliced = true;
			windowTop = Math.max(0, frameLength - height);
			chunkTo = windowTop;
		} else if (
			frameLength <= this.#committedRows ||
			(committedRowsResynced &&
				frameLength - this.#committedRows < height &&
				cursorMarkers.some((m) => m.row >= this.#committedRows))
		) {
			windowTop = Math.max(0, frameLength - height);
			chunkTo = windowTop;
			committedPrefixResliced = true;
			this.#committedRows = chunkTo;
			this.#committedPrefix = rawFrame.slice(0, chunkTo);
		} else {
			windowTop = Math.max(this.#committedRows, frameLength - height, 0);
			// hasVisibleOverlay = false (Phase A); geometryChanged freezes commits
			chunkTo = geometryChanged ? this.#committedRows : windowTop;
			if (geometryChanged) {
				committedPrefixResliced = true;
				this.#committedPrefix = rawFrame.slice(0, this.#committedRows);
			}
		}

		// 6. cursor marker + window slice (OMP: 2736-2758)
		let cursorPos: { row: number; col: number } | null = null;
		for (let i = cursorMarkers.length - 1; i >= 0; i--) {
			const marker = cursorMarkers[i]!;
			if (marker.row >= windowTop) {
				cursorPos = marker;
				break;
			}
		}
		const frame = this.#prepareFrame(rawFrame, width);
		const window: string[] = new Array(height);
		for (let r = 0; r < height; r++) window[r] = frame[windowTop + r] ?? "";

		const intent: RenderIntent = fullPaint
			? { kind: "fullPaint", clearScrollback: replaceRequested || geometryRebuild ? !isMultiplexerSession() : false }
			: { kind: "update", chunkTo, windowTop };

		// 7. emit + ledger advance (OMP: 2779-2822)
		if (intent.kind === "fullPaint") {
			this.#emitFullPaint(frame, window, width, height, cursorPos, {
				clearScrollback: intent.clearScrollback,
				chunkTo,
				windowTop,
			});
			this.#committedPrefix = rawFrame.slice(0, chunkTo);
			this.#updateCommittedAuditRows(true, preCommitRows, preCommitAuditRows, preCommitDurableRows, byteStableBoundary, durableBoundary, false);
			this.#clearScrollbackOnNextRender = false;
			this.#hasEverRendered = true;
			return;
		}
		this.#emitUpdate(frame, window, width, height, cursorPos, {
			chunkTo,
			windowTop,
			prevWindowTop,
			prevHardwareCursorRow,
			forceWindowRewrite: this.#forceViewportRepaintOnNextRender || (geometryChanged && resizeRepaintsInPlace()),
		});
		for (let i = this.#committedPrefix.length; i < chunkTo; i++) {
			this.#committedPrefix.push(rawFrame[i] ?? "");
		}
		this.#updateCommittedAuditRows(
			committedPrefixResliced,
			preCommitRows,
			preCommitAuditRows,
			preCommitDurableRows,
			byteStableBoundary,
			durableBoundary,
			auditRan,
		);
	}

	public requestFullPaint(clearScrollback: boolean): void {
		if (clearScrollback) this.#clearScrollbackOnNextRender = true;
		else this.#forceViewportRepaintOnNextRender = true;
	}

	public notifyResize(): void {
		this.#resizeEventPending = true;
	}

	// Called by the TUI's onResize (non-mux).
	public beginResizeViewport(): void {
		if (isMultiplexerSession()) return; // mux: no alt-screen
		if (!this.#resizeViewportActive) {
			this.terminal.write(ALT_SCREEN_ENTER);
			this.#resizeViewportActive = true;
		}
		this.#armResizeSettle();
	}

	#armResizeSettle(): void {
		if (this.#resizeViewportSettleTimer) clearTimeout(this.#resizeViewportSettleTimer);
		this.#resizeViewportSettleTimer = setTimeout(() => this.#settleResizeViewport(), LedgerTuiEngine.#RESIZE_SETTLE_MS);
		this.#resizeViewportSettleTimer.unref();
	}

	#settleResizeViewport(): void {
		this.#resizeViewportSettleTimer = undefined;
		if (this.#resizeViewportActive) {
			this.#resizeViewportActive = false;
			this.terminal.write(ALT_SCREEN_EXIT);
		}
		// authoritative full repaint after settle (clear scrollback, rewrap)
		this.requestFullPaint(true);
		this.doRender();
	}

	// Viewport fast path: paint only the bottom `height` rows into the alt-screen; do NOT advance ledger/commit/diff
	#renderResizeViewport(width: number, height: number): void {
		const rawFrame = this.#composeFrame(width);
		const frame = this.#prepareFrame(rawFrame, width);
		const start = Math.max(0, frame.length - height);
		let buffer = this.#paintBeginSequence + "\x1b[H";
		for (let r = 0; r < height; r++) {
			if (r > 0) buffer += "\r\n";
			buffer += "\x1b[2K" + this.#terminalLine(frame[start + r] ?? "");
		}
		buffer += this.#paintEndSequence;
		this.terminal.write(buffer);
	}

	public stop(): void {
		this.#stopped = true;
		if (this.#resizeViewportSettleTimer) {
			clearTimeout(this.#resizeViewportSettleTimer);
			this.#resizeViewportSettleTimer = undefined;
		}
		if (this.#resizeViewportActive) {
			this.#resizeViewportActive = false;
			this.terminal.write(ALT_SCREEN_EXIT);
		}
	}

	public reset(): void {
		this.#stopped = false;
		if (this.#resizeViewportSettleTimer) {
			clearTimeout(this.#resizeViewportSettleTimer);
			this.#resizeViewportSettleTimer = undefined;
		}
		if (this.#resizeViewportActive) {
			this.#resizeViewportActive = false;
			this.terminal.write(ALT_SCREEN_EXIT);
		}
		this.#committedRows = 0;
		this.#committedPrefix = [];
		this.#committedPrefixAuditRows = 0;
		this.#committedPrefixDurableRows = 0;
		this.#windowTopRow = 0;
		this.#previousWindow = [];
		this.#previousFrameLength = 0;
		this.#previousWidth = 0;
		this.#previousHeight = 0;
		this.#hasEverRendered = false;
		this.#clearScrollbackOnNextRender = false;
		this.#forceViewportRepaintOnNextRender = false;
		this.#composedFrame = [];
		this.#frameSegments = [];
		this.#composeWidth = -1;
		this.#frameCursorMarkers = [];
		this.#renderStablePrefixRows = 0;
		this.#preparedFrame = [];
		this.#preparedMeta = [];
		this.#preparedValidRows = 0;
	}

	// Park the hardware cursor just past the last content row so the host's shell
	// prompt does not overwrite painted rows on exit. Mirrors TUI.stop()'s legacy
	// cursor-parking, but sourced from the ledger's own window/cursor state.
	public parkCursorForExit(): void {
		const window = this.#previousWindow;
		if (window.length === 0) return;
		let lastContentRow = -1;
		for (let i = window.length - 1; i >= 0; i--) {
			if ((window[i] ?? "").length > 0) {
				lastContentRow = i;
				break;
			}
		}
		const targetRow = lastContentRow + 1;
		const height = this.terminal.rows;
		const rawCursorRow = this.#hardwareCursorRow - this.#windowTopRow;
		const cursorScreenRow = Math.max(0, Math.min(height - 1, rawCursorRow));
		let seq = "";
		const lineDiff = targetRow - cursorScreenRow;
		if (lineDiff > 0) seq += `\x1b[${lineDiff}B`;
		else if (lineDiff < 0) seq += `\x1b[${-lineDiff}A`;
		seq += "\r\n";
		this.terminal.write(seq);
	}
}
