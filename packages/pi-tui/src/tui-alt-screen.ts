import {
	AltScreenSearchComponent,
	AltScreenSearchIndex,
	type AltScreenSearchMatch,
	getAltScreenSearchMatchKey,
} from "./alt-screen-search.ts";
import { AltScreenFlashContainer } from "./components/alt-screen-flash.ts";
import { Editor } from "./components/editor.ts";
import { ScrollView } from "./components/scroll-view.ts";
import type { EditorSelectionPoint, SelectionEditComponent } from "./editor-component.ts";
import { getKeybindings } from "./keybindings.ts";
import { decodeTextInput, isKeyRelease } from "./keys.ts";
import {
	getLayoutBoxesAt,
	getScrollbarGeometry,
	getScrollViewBox,
	getScrollViewsAt,
	type LayoutBox,
	type LayoutFrame,
	type LayoutRect,
	renderLayoutFrame,
	type ScrollbarGeometry,
} from "./layout.ts";
import { getLayoutNode } from "./layout-node.ts";
import {
	RENDER_LINES,
	renderComponentText,
	type SoftWrapFragment,
	type TuiColumnRange,
	type TuiRenderLine,
} from "./render-line.ts";
import type { Terminal } from "./terminal.ts";
import {
	deleteAllKittyImages,
	deleteAllKittyPlacements,
	deleteKittyImage,
	getCapabilities,
	getKittyImagePlacement,
	getKittyImagePlacementRows,
	type ImageProtocol,
	isImageLine,
	setCapabilities,
	type TerminalCapabilities,
} from "./terminal-image.ts";
import {
	type Component,
	Container,
	CURSOR_MARKER,
	compositeTuiLine,
	dispatchMouseEvent,
	type LayoutEffect,
	type OverlayBounds,
	type OverlayHandle,
	retargetMouseEvent,
	TuiBase,
	type TuiMouseButton,
	type TuiMouseDispatchResult,
	type TuiMouseDispatchTarget,
	type TuiMouseEvent,
	type TuiStopOptions,
	VIEWPORT_TUI,
	type ViewportTUI,
} from "./tui.ts";
import {
	extractAnsiCode,
	getGraphemeCellRange,
	getOsc8LinkAtColumn,
	getWordSegmenter,
	sliceByColumn,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
} from "./utils.ts";
import { WheelScrollAccelerator, type WheelScrollLines } from "./wheel-scroll.ts";

const ENTER_ALT_SCREEN = "\x1b[?1049h";
const EXIT_ALT_SCREEN = "\x1b[?1049l";
const DISABLE_AUTOWRAP = "\x1b[?7l";
const ENABLE_AUTOWRAP = "\x1b[?7h";
const ENABLE_BUTTON_MOTION_MOUSE = "\x1b[?1000h\x1b[?1002h\x1b[?1004h\x1b[?1006h";
const ENABLE_ALL_MOTION_MOUSE = "\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1004h\x1b[?1006h";
const DISABLE_MOUSE = "\x1b[?1006l\x1b[?1004l\x1b[?1003l\x1b[?1002l\x1b[?1000l";
const FOCUS_IN = "\x1b[I";
const FOCUS_OUT = "\x1b[O";
const BEGIN_SYNCHRONIZED_OUTPUT = "\x1b[?2026h";
const END_SYNCHRONIZED_OUTPUT = "\x1b[?2026l";
const OSC133_ZONE_PREFIX = /^(?:\x1b\]133;[ABC](?:\x07|\x1b\\))+/;
const OSC133_PROMPT_START = /^\x1b\]133;A(?:\x07|\x1b\\)/;
const PAGE_SCROLL_OVERLAP = 4;
const ALT_WHEEL_SCROLL_MULTIPLIER = 5;
const MAX_CACHED_OFFSCREEN_KITTY_IMAGES = 16;
const MAX_CACHED_OFFSCREEN_KITTY_TRANSMISSION_BYTES = 32 * 1024 * 1024;
const MAX_CACHED_OFFSCREEN_KITTY_DECODED_BYTES = 64 * 1024 * 1024;
const DOUBLE_CLICK_INTERVAL_MS = 500;
const MAX_LAYOUT_EFFECT_PASSES = 10;
const COPY_ERROR_FLASH_DURATION_MS = 5000;
// Regular mode delegates double-click selection to the terminal emulator. Fullscreen owns mouse selection,
// so it uses iTerm2's default "characters considered part of a word" set:
// https://github.com/gnachman/iTerm2/blob/7f4ff739721f95d0b93003d8701c4523a7edf261/sources/Settings/iTermPreferences.m#L743
const TERMINAL_WORD_SELECTION_JOINERS = new Set(["/", "-", "+", "\\", "~", "_", "."]);
const wordSegmenter = getWordSegmenter();

interface CachedKittyImage {
	transmissionGeneration: number;
	transmissionBytes: number;
	estimatedDecodedBytes: number;
}

type SelectionEditableComponent = Component & SelectionEditComponent;

interface VisualSelectionPoint {
	mode: "visual";
	row: number;
	col: number;
	scrollView?: ScrollView;
	boundary?: boolean;
	fromRegionGutter?: boolean;
}

interface LogicalSelectionPoint extends EditorSelectionPoint {
	mode: "logical";
	component: SelectionEditableComponent;
	rowOffset: number;
	colOffset: number;
	clip?: LayoutRect;
	endOffset: number;
	displayBoundary?: boolean;
}

type SelectionPoint = VisualSelectionPoint | LogicalSelectionPoint;

interface SelectionOverlayTarget {
	key: object;
	component: Component;
	bounds: OverlayBounds;
	lines: TuiRenderLine[];
	contentVersion?: number;
}

interface OverlayRenderSnapshot {
	bounds: OverlayBounds;
	lines: TuiRenderLine[];
	version: number;
}

interface VisualSelectionRange {
	mode: "visual";
	start: VisualSelectionPoint;
	end: VisualSelectionPoint;
}

interface LogicalSelectionRange {
	mode: "logical";
	start: LogicalSelectionPoint;
	end: LogicalSelectionPoint;
}

type SelectionRange = VisualSelectionRange | LogicalSelectionRange;

function isSelectionEditComponent(component: Component): component is SelectionEditableComponent {
	const candidate = component as Partial<SelectionEditComponent>;
	return typeof candidate.getText === "function" &&
		typeof candidate.getClosestSelectionPoint === "function" &&
		typeof candidate.getSelectionContentStart === "function" &&
		typeof candidate.getSelectionContentEnd === "function" &&
		typeof candidate.getSelectionText === "function" &&
		typeof candidate.deleteSelection === "function" &&
		typeof candidate.moveCursorToOffset === "function";
}

function createLogicalSelectionTarget(component: SelectionEditableComponent): LogicalSelectionPoint {
	return { mode: "logical", component, row: 0, col: 0, rowOffset: 0, colOffset: 0, offset: 0, endOffset: 0 };
}

function logicalEndpointOffset(point: LogicalSelectionPoint, end: boolean): number {
	return end && point.boundary !== true ? point.endOffset : point.offset;
}

function sameVisualSelectionPoint(left: SelectionPoint, right: SelectionPoint): boolean {
	return left.row === right.row && left.col === right.col && left.boundary === right.boundary;
}

function getSelectionScrollView(point: SelectionPoint | undefined): ScrollView | undefined {
	return point?.mode === "visual" ? point.scrollView : undefined;
}

function getSelectionEditOffsets(
	selection: LogicalSelectionRange,
): { component: SelectionEditableComponent; start: number; end: number } {
	return {
		component: selection.start.component,
		start: selection.start.offset,
		end: logicalEndpointOffset(selection.end, true),
	};
}

type SelectionGranularity = "character" | "word" | "line";

interface ClickTarget {
	timestamp: number;
	count: number;
	row: number;
	col: number;
	scrollView?: ScrollView;
	overlay?: object;
	wordStart: number;
	wordEnd: number;
}

interface SgrMouseEvent {
	button: number;
	x: number;
	y: number;
	release: boolean;
}

interface WheelEvent {
	direction: -1 | 1;
	x: number;
	y: number;
	button: number;
}

interface ScrollbarDrag {
	scrollView: ScrollView;
	grabOffset: number;
}

interface ScrollbarTarget {
	scrollView: ScrollView;
	geometry: ScrollbarGeometry;
}

interface ScrollToEndIndicatorRect {
	row: number;
	column: number;
	width: number;
}

type SearchSelectionMode = "query" | "retain" | "next" | "previous";

interface ActiveSearch {
	component: AltScreenSearchComponent;
	index: AltScreenSearchIndex;
	overlay?: OverlayHandle;
	query: string;
	matches: AltScreenSearchMatch[];
	selectedIndex: number;
	selectedKey?: string;
	anchorRow: number;
	selectionMode: SearchSelectionMode;
}

interface SearchHighlightRange {
	startCol: number;
	endCol: number;
	current: boolean;
}

interface SelectionColumns {
	start: number;
	end: number;
}

interface ScrollSelectionSource {
	hasRegions: boolean;
	lines: readonly TuiRenderLine[];
}

const emptySelectionRegionLine: TuiRenderLine = { text: "" };
const scrollSelectionSourceCache = new WeakMap<readonly TuiRenderLine[], ScrollSelectionSource>();

function getScrollSelectionSource(lines: readonly TuiRenderLine[]): ScrollSelectionSource {
	const cached = scrollSelectionSourceCache.get(lines);
	if (cached) return cached;
	const hasRegions = lines.some((line) => line.selectionRegion !== undefined);
	if (!hasRegions) {
		const source = { hasRegions, lines };
		scrollSelectionSourceCache.set(lines, source);
		return source;
	}
	const contentLines = new Array<TuiRenderLine>(lines.length);
	for (const key of Object.keys(lines)) {
		const index = Number(key);
		if (String(index) !== key || index < 0 || index >= lines.length) continue;
		contentLines[index] = lines[index]!.selectionRegion?.content ?? emptySelectionRegionLine;
	}
	const source = { hasRegions, lines: contentLines };
	scrollSelectionSourceCache.set(lines, source);
	return source;
}

function includedSelectionRanges(
	columns: SelectionColumns,
	exclusions: readonly TuiColumnRange[] | undefined,
): SelectionColumns[] {
	let included = [columns];
	for (const excluded of exclusions ?? []) {
		included = included.flatMap((range) => {
			if (excluded.start >= range.end || excluded.end <= range.start) return [range];
			const ranges: SelectionColumns[] = [];
			if (range.start < excluded.start) {
				ranges.push({ start: range.start, end: Math.min(range.end, excluded.start) });
			}
			if (range.end > excluded.end) {
				ranges.push({ start: Math.max(range.start, excluded.end), end: range.end });
			}
			return ranges;
		});
	}
	return included
		.filter((range) => range.end > range.start)
		.sort((left, right) => left.start - right.start || left.end - right.end);
}

function sameOverlayRenderLines(left: readonly TuiRenderLine[], right: readonly TuiRenderLine[]): boolean {
	return left.length === right.length && left.every((line, row) => {
		const candidate = right[row]!;
		if (line.text !== candidate.text) return false;
		const exclusions = line.selectionExclusions ?? [];
		const candidateExclusions = candidate.selectionExclusions ?? [];
		return exclusions.length === candidateExclusions.length && exclusions.every((range, index) => {
			const candidateRange = candidateExclusions[index]!;
			return range.start === candidateRange.start && range.end === candidateRange.end;
		});
	});
}

function renderedLineContentEnd(line: TuiRenderLine): number {
	if (!line.softWrap?.length) return visibleWidth(stripTerminalSequences(line.text).trimEnd());
	return Math.max(
		...line.softWrap.map((fragment) => fragment.end),
		visibleWidth(stripTerminalSequences(line.text).trimEnd()),
	);
}

function selectionLineText(line: TuiRenderLine, columns: SelectionColumns): string {
	return includedSelectionRanges(columns, line.selectionExclusions)
		.map((range) =>
			stripTerminalSequences(sliceByColumn(line.text, range.start, range.end - range.start, true))
		)
		.join("");
}

function hasForeignSelectedContent(
	line: TuiRenderLine,
	columns: SelectionColumns,
	fragment: SoftWrapFragment,
): boolean {
	const beforeEnd = Math.max(columns.start, Math.min(fragment.start, columns.end));
	const afterStart = Math.max(columns.start, Math.min(fragment.end, columns.end));
	const before = selectionLineText(line, { start: columns.start, end: beforeEnd });
	const after = selectionLineText(line, { start: afterStart, end: columns.end });
	return before.trim().length > 0 || after.trim().length > 0;
}

function isWholeRowSoftWrapFragment(line: TuiRenderLine, fragment: SoftWrapFragment): boolean {
	if (fragment.selectionJoinBarrier) return false;
	const before = selectionLineText(line, { start: 0, end: fragment.start }).trim();
	const after = selectionLineText(line, { start: fragment.end, end: visibleWidth(line.text) }).trim();
	return before.length === 0 && after.length === 0;
}

function findMatchingSoftWrapFragment(
	line: TuiRenderLine | undefined,
	fragment: SoftWrapFragment,
): SoftWrapFragment | undefined {
	return line?.softWrap?.find(
		(candidate) =>
			candidate.origin === fragment.origin &&
			candidate.logicalLineId === fragment.logicalLineId &&
			candidate.start === fragment.start &&
			isWholeRowSoftWrapFragment(line, candidate),
	);
}

function findSoftWrapContinuation(
	previousLine: TuiRenderLine,
	currentLine: TuiRenderLine,
	previousColumns: SelectionColumns,
	currentColumns: SelectionColumns,
): SoftWrapFragment | undefined {
	for (const current of currentLine.softWrap ?? []) {
		if (!current.continuation) continue;
		const contentStart = current.start + current.continuation.generatedIndent;
		if (currentColumns.start > contentStart || currentColumns.end <= contentStart) continue;
		const previous = previousLine.softWrap?.find(
			(fragment) =>
				fragment.origin === current.origin &&
				fragment.logicalLineId === current.logicalLineId &&
				fragment.start === current.start,
		);
		if (!previous) continue;
		const coversPrevious = previous.start === previous.end
			? isWholeRowSoftWrapFragment(previousLine, previous) &&
				previousColumns.start <= previous.start && previousColumns.end >= previous.end
			: previousColumns.start < previous.end && previousColumns.end >= previous.end;
		if (!coversPrevious) continue;
		if (previous.selectionJoinBarrier || current.selectionJoinBarrier) continue;
		if (hasForeignSelectedContent(previousLine, previousColumns, previous)) continue;
		if (hasForeignSelectedContent(currentLine, currentColumns, current)) continue;
		return current;
	}
	return undefined;
}

export interface TuiSelectionCopyResult {
	copied: boolean;
	message?: string;
}

export interface TuiRightClickPasteRequest {
	isCurrent(): boolean;
}

function sanitizeSearchQuery(query: string): string {
	return query.replace(/\r\n|[\r\n\t]/g, " ");
}

export interface TuiAltScreenOptions {
	/**
	 * Logical lines moved for each mouse-wheel event (default: 1). `"auto"` accelerates fast wheel
	 * spins on terminals that send one event per notch. Alt+wheel moves five times as far.
	 */
	wheelScrollLines?: WheelScrollLines;
	/** Multiply wheel scroll distance by five while Alt is held (default: true). */
	altWheelAcceleration?: boolean;
	/** Capture mouse events for viewport scrolling and application-owned text selection. */
	mouse?: boolean;
	/** Ignore mouse-button gestures for this long after terminal focus is reported as regained. */
	refocusMouseGuardMs?: number;
	/** Style a non-current transcript search match. */
	searchMatchStyle?: (text: string) => string;
	/** Style the current transcript search match. */
	searchCurrentMatchStyle?: (text: string) => string;
	/** Style a transcript search navigation button. */
	searchNavigationButtonStyle?: (text: string, hovered: boolean) => string;
	searchSelectAll?: boolean;
	editorSelection?: boolean;
	/**
	 * Render a clickable jump-to-end label. It is centered on the last row of a follow-end
	 * primary scroll view while that view is scrolled away from its end.
	 */
	scrollToEndIndicator?: () => string;
	/** Open an OSC 8 hyperlink activated with a primary-button click. */
	openUrl?: (url: string) => void;
	/** Handle an unmodified secondary-button press for clipboard paste. Defaults to Windows; right-click copy mode enables it on every platform. */
	onRightClickPaste?: (request: TuiRightClickPasteRequest) => void;
	/** Automatically copy selected text to the clipboard on mouse release (default: true). */
	copyOnSelect?: boolean;
	/**
	 * Copy the active selection on secondary-button press; success clears only that selection. A second
	 * press during its pending copy pastes after success instead of copying again (default: false).
	 */
	copyOnRightClick?: boolean;
	/**
	 * Copy selected text to the system clipboard. Return `true` on success, an error message to
	 * display on failure, or `false` for a generic error. A result object can independently report
	 * delivery and a notice, including an unverified OSC 52 copy. When omitted, the selection is
	 * copied via an OSC 52 write.
	 */
	copySelection?: (text: string) => Promise<boolean | string | TuiSelectionCopyResult>;
}

// Terminals that forward the right-click to mouse-tracking apps and also paste
// the clipboard themselves. pi's synthetic paste would duplicate their paste.
const RIGHT_CLICK_PASTING_TERMINALS = new Set(["vscode", "tabby"]);

function terminalPastesOnRightClick(): boolean {
	const termProgram = process.env['TERM_PROGRAM']?.toLowerCase();
	return termProgram !== undefined && RIGHT_CLICK_PASTING_TERMINALS.has(termProgram);
}

/** Alternate-screen TUI with a scrollable, application-owned viewport. */
export class TuiAltScreen extends TuiBase implements ViewportTUI {
	readonly mode = "fullscreen" as const;
	readonly [VIEWPORT_TUI] = true as const;
	private previousScreen: string[] = [];
	private lastDocument: string[] = [];
	private previousScreenWidth = 0;
	private previousScreenHeight = 0;
	private readonly overlaySnapshots = new WeakMap<object, OverlayRenderSnapshot>();
	private nextOverlayContentVersion = 0;
	private layoutRoot: Component | undefined;
	private currentLayout: LayoutFrame | undefined;
	private readonly layoutEffects = new Set<LayoutEffect>();
	private runningLayoutEffects = false;
	private layoutEffectRenderRequested = false;
	private layoutEffectContentChanged = false;
	private layoutEffectForceRequested = false;
	private readonly implicitDocument: Component;
	private readonly implicitScrollView: ScrollView;
	private readonly flashes: AltScreenFlashContainer;
	private altScreenActive = false;
	private imageProtocol: ImageProtocol = null;
	private savedCapabilities?: TerminalCapabilities;
	private readonly uploadedKittyImages = new Map<number, CachedKittyImage>();
	private selectionAnchor?: SelectionPoint;
	private selectionFocus?: SelectionPoint;
	private selectionGeneration = 0;
	private selectionGranularity: SelectionGranularity = "character";
	private selectionInitialRange?: SelectionRange;
	private lastClick?: ClickTarget;
	private selectionDragPointer?: { x: number; y: number };
	private selectionAutoScrollDirection: -1 | 0 | 1 = 0;
	private selectionAutoScrollTimer?: NodeJS.Timeout;
	private selectionPressActive = false;
	private selectionPressBlocked = false;
	private selectionOverlay?: SelectionOverlayTarget;
	private scrollbarDrag?: ScrollbarDrag;
	private scrollbarHover?: ScrollView;
	private scrollToEndIndicatorRect?: ScrollToEndIndicatorRect;
	private activeSearch?: ActiveSearch;
	private pressedUrl?: string;
	private selectionDragged = false;
	private mouseCapture?: TuiMouseDispatchTarget;
	private mousePressTarget?: TuiMouseDispatchTarget;
	private mousePressPoint?: { x: number; y: number };
	private mousePressMoved = false;
	private lastComponentClick?: {
		timestamp: number;
		count: number;
		component: Component;
		x: number;
		y: number;
	};
	private refocusMouseGuardUntil?: number;
	private readonly wheelScroll: WheelScrollAccelerator;
	private altWheelAcceleration: boolean;
	private readonly mouseEnabled: boolean;
	private readonly refocusMouseGuardMs: number;
	private readonly searchMatchStyle: (text: string) => string;
	private readonly searchCurrentMatchStyle: (text: string) => string;
	private readonly searchNavigationButtonStyle: (text: string, hovered: boolean) => string;
	private readonly searchSelectAll: boolean;
	private readonly editorSelection: boolean;
	private readonly scrollToEndIndicator?: () => string;
	private readonly openUrl?: (url: string) => void;
	private readonly onRightClickPaste?: (request: TuiRightClickPasteRequest) => void;
	private copyOnSelect: boolean;
	private copyOnRightClick: boolean;
	private pendingRightClickCopy?: {
		selectionGeneration: number;
		copy: Promise<boolean>;
		pasteRequested: boolean;
	};
	private nextRightClickPasteRequestId = 0;
	private currentRightClickPasteRequest?: { id: number; selectionGeneration: number };
	private clipboardWriteTail?: Promise<void>;
	private readonly copySelection?: (text: string) => Promise<boolean | string | TuiSelectionCopyResult>;

	constructor(
		terminal: Terminal,
		showHardwareCursor?: boolean,
		logDirectory?: string,
		options: TuiAltScreenOptions = {},
	) {
		super(terminal, showHardwareCursor, logDirectory);
		this.implicitDocument = {
			render: renderComponentText,
			[RENDER_LINES]: (width) => super[RENDER_LINES](width),
			handleMouse: (event) => super.handleMouse(event),
			invalidate: () => {
				for (const child of this.children) child.invalidate();
			},
		};
		this.implicitScrollView = new ScrollView(this.implicitDocument, { follow: "end", primary: true });
		this.flashes = new AltScreenFlashContainer(() => this.requestRender());
		this.wheelScroll = new WheelScrollAccelerator(options.wheelScrollLines ?? 1);
		this.altWheelAcceleration = options.altWheelAcceleration ?? true;
		this.mouseEnabled = options.mouse ?? true;
		this.refocusMouseGuardMs = Math.max(0, options.refocusMouseGuardMs ?? 0);
		this.searchMatchStyle = options.searchMatchStyle ?? ((text) => `\x1b[4m${text}\x1b[24m`);
		this.searchCurrentMatchStyle = options.searchCurrentMatchStyle ?? ((text) => `\x1b[1;7m${text}\x1b[22;27m`);
		this.searchNavigationButtonStyle = options.searchNavigationButtonStyle ?? ((text) => text);
		this.searchSelectAll = options.searchSelectAll ?? false;
		this.editorSelection = options.editorSelection ?? false;
		this.scrollToEndIndicator = options.scrollToEndIndicator;
		this.openUrl = options.openUrl;
		this.onRightClickPaste = options.onRightClickPaste;
		this.copyOnSelect = options.copyOnSelect ?? true;
		this.copyOnRightClick = options.copyOnRightClick ?? false;
		this.copySelection = options.copySelection;
		this.addInputListener((data) => this.handleViewportInput(data));
	}

	get viewportTop(): number {
		return this.getPrimaryScrollView().scrollTop;
	}

	get isFollowingOutput(): boolean {
		return this.getPrimaryScrollView().isFollowingEnd;
	}

	setWheelScrollLines(lines: WheelScrollLines): void {
		this.wheelScroll.setLines(lines);
	}

	setAltWheelAcceleration(enabled: boolean): void {
		this.altWheelAcceleration = enabled;
	}

	getCopyOnSelect(): boolean {
		return this.copyOnSelect;
	}

	setCopyOnSelect(enabled: boolean): void {
		this.copyOnSelect = enabled;
	}

	getCopyOnRightClick(): boolean {
		return this.copyOnRightClick;
	}

	setCopyOnRightClick(enabled: boolean): void {
		this.copyOnRightClick = enabled;
	}

	/** Whether the fullscreen viewport has a non-empty active text selection. */
	hasActiveSelection(): boolean {
		return this.getActiveSelectionText() !== undefined;
	}

	/** Copy the active fullscreen text selection, if any, using the configured selection clipboard path. */
	async copyActiveSelectionToClipboard(): Promise<boolean> {
		const text = this.getActiveSelectionText();
		if (!text) return false;
		return this.copyTextToClipboard(text);
	}

	/** Drop the text selection and multi-click history, e.g. before the host replaces the transcript. */
	resetTextSelection(): void {
		this.clearTextSelection();
		this.lastClick = undefined;
	}

	/** The lines of the last rendered frame, one per terminal row, as written to the terminal. */
	getScreenLines(): string[] {
		return [...this.previousScreen];
	}

	setLayoutRoot(component: Component | undefined): void {
		if (this.layoutRoot === component) return;
		this.layoutRoot = component;
		this.currentLayout = undefined;
		this.requestRender();
	}

	getLayoutRoot(): Component | undefined {
		return this.layoutRoot;
	}

	addLayoutEffect(effect: LayoutEffect): () => void {
		this.layoutEffects.add(effect);
		return () => {
			this.layoutEffects.delete(effect);
		};
	}

	override requestRender(force = false): void {
		if (this.runningLayoutEffects) {
			if (force) this.layoutEffectForceRequested = true;
			this.layoutEffectContentChanged = true;
			this.layoutEffectRenderRequested = true;
			return;
		}
		super.requestRender(force);
	}

	protected override requestViewRender(): void {
		if (this.runningLayoutEffects) {
			this.layoutEffectRenderRequested = true;
			return;
		}
		super.requestViewRender();
	}

	override render(width: number): readonly string[] {
		return this.layoutRoot?.render(width) ?? super.render(width);
	}

	protected override getMountedRoots(): readonly Component[] {
		return this.layoutRoot ? [this.layoutRoot] : this.children;
	}

	private getPrimaryScrollView(): ScrollView {
		return this.currentLayout?.primaryScrollView ?? this.implicitScrollView;
	}

	private hasSearchableScrollView(): boolean {
		return this.layoutRoot === undefined || this.currentLayout?.primaryScrollView !== undefined;
	}

	protected override beforeTerminalStart(): void {
		this.stopSelectionAutoScroll();
		this.selectionPressActive = false;
		this.selectionPressBlocked = false;
		this.stopScrollbarHover();
		this.stopScrollbarDrag();
		this.flashes.dispose();
		this.altScreenActive = true;
		const capabilities = getCapabilities();
		this.imageProtocol = capabilities.images;
		this.uploadedKittyImages.clear();
		if (capabilities.images === "iterm2") {
			this.savedCapabilities = capabilities;
			setCapabilities({ ...capabilities, images: null });
			this.invalidate();
		}
		this.lastDocument = [];
		this.selectionGeneration += 1;
		this.selectionAnchor = undefined;
		this.selectionFocus = undefined;
		this.selectionGranularity = "character";
		this.selectionInitialRange = undefined;
		this.lastClick = undefined;
		this.pressedUrl = undefined;
		this.selectionDragged = false;
		this.clearComponentMouseGesture();
		this.lastComponentClick = undefined;
		this.resetRenderState();
		const term = process.env['TERM']?.toLowerCase() ?? "";
		// Multiplexers can lag when every pointer movement is forwarded. Button-motion
		// tracking preserves clicks, wheel events, selections, and scrollbar dragging.
		const mouseSequence =
			process.env['TMUX'] !== undefined ||
			process.env['ZELLIJ'] !== undefined ||
			process.env['STY'] !== undefined ||
			term.startsWith("tmux") ||
			term.startsWith("screen")
				? ENABLE_BUTTON_MOTION_MOUSE
				: ENABLE_ALL_MOTION_MOUSE;
		this.terminal.write(
			`${ENTER_ALT_SCREEN}${DISABLE_AUTOWRAP}${this.mouseEnabled ? mouseSequence : ""}\x1b[2J\x1b[H\x1b[?25l`,
		);
	}

	protected override beforeTerminalStop(_options: TuiStopOptions): void {
		this.closeSearch();
		this.stopSelectionAutoScroll();
		this.selectionPressActive = false;
		this.selectionPressBlocked = false;
		this.stopScrollbarHover();
		this.stopScrollbarDrag();
		this.clearComponentMouseGesture();
		this.flashes.dispose();
		if (!this.altScreenActive) return;
		this.terminal.write(
			`${BEGIN_SYNCHRONIZED_OUTPUT}${this.deleteKittyImages()}${this.mouseEnabled ? DISABLE_MOUSE : ""}${ENABLE_AUTOWRAP}${END_SYNCHRONIZED_OUTPUT}`,
		);
		this.uploadedKittyImages.clear();
	}

	protected override afterTerminalStop(options: TuiStopOptions): void {
		if (!this.altScreenActive) return;
		this.altScreenActive = false;
		if (options.preserveScreen) {
			this.terminal.write(`${BEGIN_SYNCHRONIZED_OUTPUT}${EXIT_ALT_SCREEN}\x1b[?25h${END_SYNCHRONIZED_OUTPUT}`);
		} else {
			const width = Math.max(1, this.terminal.columns);
			const documentLines = this.resolveFakeCursors(this.render(width)).map((line) =>
				line.replace(OSC133_ZONE_PREFIX, ""),
			);
			this.lastDocument = this.applyLineResets(documentLines.map((line) => line.replaceAll(CURSOR_MARKER, ""))).map(
				(line) => (isImageLine(line) || visibleWidth(line) <= width ? line : sliceByColumn(line, 0, width, true)),
			);
			let buffer = `${BEGIN_SYNCHRONIZED_OUTPUT}${EXIT_ALT_SCREEN}${DISABLE_AUTOWRAP}`;
			for (let row = 0; row < this.lastDocument.length; row++) {
				if (row > 0) buffer += "\r\n";
				buffer += `\r\x1b[2K${this.lastDocument[row] ?? ""}`;
			}
			buffer += `\x1b[0m${ENABLE_AUTOWRAP}\r\n\x1b[?25h${END_SYNCHRONIZED_OUTPUT}`;
			this.terminal.write(buffer);
		}
		if (this.savedCapabilities) {
			setCapabilities(this.savedCapabilities);
			this.savedCapabilities = undefined;
		}
	}

	protected override getExitRestorePrefix(): string {
		const prefix = super.getExitRestorePrefix();
		if (!this.altScreenActive) return prefix;
		return `${END_SYNCHRONIZED_OUTPUT}${this.mouseEnabled ? DISABLE_MOUSE : ""}${ENABLE_AUTOWRAP}${prefix}`;
	}

	protected override getExitRestoreSuffix(): string {
		// Kitty keyboard flags are per screen, so the terminal pops them before the alternate screen is left.
		return `${super.getExitRestoreSuffix()}${this.altScreenActive ? `${EXIT_ALT_SCREEN}\x1b[?25h` : ""}`;
	}

	private deleteKittyImages(): string {
		return this.imageProtocol === "kitty" ? deleteAllKittyImages() : "";
	}

	private prepareKittyScreen(screen: string[]): { lines: string[]; evictedImageDeletion: string } {
		const visibleImageIds = new Set<number>();
		const lines = screen.map((line) => {
			const placement = getKittyImagePlacement(line);
			if (!placement) return line;
			visibleImageIds.add(placement.imageId);

			const cachedImage = this.uploadedKittyImages.get(placement.imageId);
			const nextCachedImage = {
				transmissionGeneration: placement.transmissionGeneration,
				transmissionBytes: placement.transmissionBytes,
				estimatedDecodedBytes: placement.estimatedDecodedBytes,
			};
			if (cachedImage) this.uploadedKittyImages.delete(placement.imageId);
			this.uploadedKittyImages.set(placement.imageId, nextCachedImage);

			return cachedImage?.transmissionGeneration === placement.transmissionGeneration
				? placement.replacementLine
				: line;
		});

		let cachedOffscreenImageCount = 0;
		let cachedOffscreenTransmissionBytes = 0;
		let cachedOffscreenDecodedBytes = 0;
		for (const [imageId, cachedImage] of this.uploadedKittyImages) {
			if (visibleImageIds.has(imageId)) continue;
			cachedOffscreenImageCount += 1;
			cachedOffscreenTransmissionBytes += cachedImage.transmissionBytes;
			cachedOffscreenDecodedBytes += cachedImage.estimatedDecodedBytes;
		}

		let evictedImageDeletion = "";
		for (const [imageId, cachedImage] of this.uploadedKittyImages) {
			if (
				cachedOffscreenImageCount <= MAX_CACHED_OFFSCREEN_KITTY_IMAGES &&
				cachedOffscreenTransmissionBytes <= MAX_CACHED_OFFSCREEN_KITTY_TRANSMISSION_BYTES &&
				cachedOffscreenDecodedBytes <= MAX_CACHED_OFFSCREEN_KITTY_DECODED_BYTES
			) {
				break;
			}
			if (visibleImageIds.has(imageId)) continue;
			evictedImageDeletion += deleteKittyImage(imageId);
			this.uploadedKittyImages.delete(imageId);
			cachedOffscreenImageCount -= 1;
			cachedOffscreenTransmissionBytes -= cachedImage.transmissionBytes;
			cachedOffscreenDecodedBytes -= cachedImage.estimatedDecodedBytes;
		}
		return { lines, evictedImageDeletion };
	}

	protected override resetRenderState(): void {
		this.previousScreen = [];
		this.previousScreenWidth = 0;
		this.previousScreenHeight = 0;
		this.currentLayout = undefined;
	}

	scrollBy(lines: number): void {
		this.getPrimaryScrollView().scrollBy(lines);
		this.requestViewRender();
	}

	scrollToTop(): void {
		this.getPrimaryScrollView().scrollToStart();
		this.requestViewRender();
	}

	scrollToBottom(): void {
		this.getPrimaryScrollView().scrollToEnd();
		this.requestViewRender();
	}

	private scrollToPrompt(direction: -1 | 1): void {
		if (!this.currentLayout) return;
		const scrollView = this.getPrimaryScrollView();
		const lines = getScrollViewBox(this.currentLayout, scrollView)?.scrollContentLines;
		if (!lines) return;

		for (let row = scrollView.scrollTop + direction; row >= 0 && row < lines.length; row += direction) {
			if (!OSC133_PROMPT_START.test(lines[row]?.text ?? "")) continue;
			scrollView.scrollTo(row);
			this.requestViewRender();
			return;
		}
	}

	/** Open and focus transcript search, optionally pre-filling a single-line query. */
	openSearch(query?: string): void {
		const sanitized = query === undefined ? undefined : sanitizeSearchQuery(query);
		const existing = this.activeSearch;
		if (existing) {
			existing.overlay?.focus();
			if (sanitized !== undefined) {
				existing.component.setQuery(sanitized);
				if (sanitized !== existing.query) {
					existing.query = sanitized;
					existing.component.setResult(-1, 0);
				}
				existing.anchorRow = this.getPrimaryScrollView().scrollTop;
				existing.selectionMode = "query";
			}
			this.requestRender();
			return;
		}
		if (!this.hasSearchableScrollView()) return;

		const component = new AltScreenSearchComponent(
			(nextQuery) => this.updateSearchQuery(nextQuery),
			this.searchNavigationButtonStyle,
		);
		if (sanitized !== undefined) {
			component.setQuery(sanitized);
		}
		const search: ActiveSearch = {
			component,
			index: new AltScreenSearchIndex(),
			query: sanitized ?? "",
			matches: [],
			selectedIndex: -1,
			anchorRow: this.getPrimaryScrollView().scrollTop,
			selectionMode: "query",
		};
		this.activeSearch = search;
		search.overlay = this.showOverlay(component, {
			anchor: "top-right",
			width: "40%",
			minWidth: 32,
			margin: 1,
		});
		this.requestRender();
	}

	private toggleSearch(): void {
		if (this.activeSearch) {
			this.closeSearch();
			return;
		}
		this.openSearch();
	}

	private closeSearch(): void {
		const search = this.activeSearch;
		if (!search) return;
		this.activeSearch = undefined;
		search.overlay?.hide();
		this.requestRender();
	}

	private updateSearchQuery(query: string): void {
		const search = this.activeSearch;
		if (!search || query === search.query) return;
		const selected = search.matches[search.selectedIndex];
		search.anchorRow = selected?.segments[0]?.row ?? this.getPrimaryScrollView().scrollTop;
		search.query = query;
		search.selectionMode = "query";
		search.component.setResult(-1, 0);
		this.requestRender();
	}

	private navigateSearch(direction: -1 | 1): void {
		const search = this.activeSearch;
		if (!search?.query) return;
		search.selectionMode = direction < 0 ? "previous" : "next";
		this.requestRender();
	}

	private getSearchNavigationDirectionAt(x: number, y: number): -1 | 1 | undefined {
		const search = this.activeSearch;
		const bounds = search?.overlay?.getBounds();
		if (!search || !bounds) return undefined;
		if (x < bounds.col || x >= bounds.col + bounds.width || y < bounds.row || y >= bounds.row + bounds.height) {
			return undefined;
		}
		return search.component.getNavigationDirectionAt(y - bounds.row, x - bounds.col);
	}

	private handleSearchMouseEvent(event: SgrMouseEvent): boolean {
		const search = this.activeSearch;
		if (!search) return false;
		const direction = this.getSearchNavigationDirectionAt(event.x, event.y);
		if (search.component.setHoveredNavigationDirection(direction)) this.requestRender();
		if (direction === undefined || event.release || (event.button & 32) !== 0 || (event.button & 3) !== 0) {
			return false;
		}
		this.navigateSearch(direction);
		return true;
	}

	private refreshSearch(
		layout: LayoutFrame,
		options: { retainIndex?: boolean; revealSelection?: boolean } = {},
	): boolean {
		const search = this.activeSearch;
		if (!search) return false;
		const scrollView = layout.primaryScrollView ?? this.implicitScrollView;
		const box = getScrollViewBox(layout, scrollView);
		const lines = box?.scrollContentLines;
		if (!lines || !search.query.trim()) {
			search.matches = [];
			search.selectedIndex = -1;
			search.selectedKey = undefined;
			search.selectionMode = "retain";
			search.component.setResult(-1, 0);
			return false;
		}

		const shouldRevealSelection = options.revealSelection || search.selectionMode !== "retain";
		const result = search.index.search(lines.map((line) => line.text), search.query);
		const matches = result.matches;
		search.matches = matches;
		if (!result.changed && search.selectionMode === "retain" && !shouldRevealSelection) return false;

		// A layout effect can shift rows without changing the selected occurrence.
		const exactIndex =
			result.changed && !options.retainIndex
				? search.selectedKey
					? matches.findIndex((match) => getAltScreenSearchMatchKey(match) === search.selectedKey)
					: -1
				: Math.min(search.selectedIndex, matches.length - 1);
		let selectedIndex = -1;
		if (matches.length > 0) {
			if (search.selectionMode === "query") {
				let low = 0;
				let high = matches.length;
				while (low < high) {
					const middle = low + Math.floor((high - low) / 2);
					if ((matches[middle]!.segments[0]?.row ?? 0) < search.anchorRow) low = middle + 1;
					else high = middle;
				}
				selectedIndex = low < matches.length ? low : 0;
			} else if (search.selectionMode === "next") {
				const baseIndex = exactIndex >= 0 ? exactIndex : Math.min(search.selectedIndex, matches.length - 1);
				selectedIndex = baseIndex < 0 ? 0 : (baseIndex + 1) % matches.length;
			} else if (search.selectionMode === "previous") {
				const baseIndex = exactIndex >= 0 ? exactIndex : Math.min(search.selectedIndex, matches.length - 1);
				selectedIndex = baseIndex < 0 ? matches.length - 1 : (baseIndex - 1 + matches.length) % matches.length;
			} else {
				selectedIndex =
					exactIndex >= 0 ? exactIndex : Math.min(Math.max(0, search.selectedIndex), matches.length - 1);
			}
		}

		search.selectedIndex = selectedIndex;
		search.selectedKey = selectedIndex >= 0 ? getAltScreenSearchMatchKey(matches[selectedIndex]!) : undefined;
		search.selectionMode = "retain";
		search.component.setResult(selectedIndex, matches.length);
		if (!shouldRevealSelection) return false;

		const selected = matches[selectedIndex];
		const firstSegment = selected?.segments[0];
		const lastSegment = selected?.segments[selected.segments.length - 1];
		if (!box || !firstSegment || !lastSegment || scrollView.viewportHeight <= 0) return false;
		const before = scrollView.scrollTop;
		const visibleBottom = before + scrollView.viewportHeight - 1;
		let target = before;
		if (firstSegment.row < before || lastSegment.row > visibleBottom) {
			target = firstSegment.row - Math.floor(scrollView.viewportHeight / 3);
		}
		scrollView.scrollTo(target, { disableFollow: true });
		return scrollView.scrollTop !== before;
	}

	/** Show a transient message in the alternate-screen flash stack. */
	flash(message: string, durationMs?: number): void {
		this.flashes.flash(message, durationMs);
	}

	/** Focused overlays and components that capture viewport input receive viewport keys instead of the transcript. */
	private shouldDeferViewportInput(): boolean {
		if (this.getFocusedComponent()?.capturesViewportInput) return true;
		return this.isOverlayFocused() && this.activeSearch?.overlay?.isFocused() !== true;
	}

	private clearComponentMouseGesture(): void {
		this.mouseCapture = undefined;
		this.mousePressTarget = undefined;
		this.mousePressPoint = undefined;
		this.mousePressMoved = false;
	}

	private handleViewportInput(data: string): { consume?: boolean } | undefined {
		if (data === FOCUS_OUT) {
			const hadActiveSelection = this.selectionPressActive;
			const hadNonEmptyActiveSelection = hadActiveSelection && this.getSelectionBounds() !== undefined;
			this.selectionPressActive = false;
			this.selectionPressBlocked = false;
			this.stopSelectionAutoScroll();
			this.stopScrollbarHover();
			if (this.activeSearch?.component.setHoveredNavigationDirection(undefined)) this.requestRender();
			this.stopScrollbarDrag();
			this.pressedUrl = undefined;
			this.selectionDragged = false;
			this.clearComponentMouseGesture();
			this.lastComponentClick = undefined;
			if (hadActiveSelection) {
				this.selectionGeneration += 1;
				this.selectionAnchor = undefined;
				this.selectionFocus = undefined;
				this.selectionGranularity = "character";
				this.selectionInitialRange = undefined;
				if (hadNonEmptyActiveSelection) this.requestRender();
			}
			this.lastClick = undefined;
			// Do not consume focus reports: app-level input listeners (terminal
			// focus tracking for notifications, clipboard-image hints) rely on
			// them too, and the main-screen renderer lets them through.
			return undefined;
		}
		if (data === FOCUS_IN) {
			if (this.refocusMouseGuardMs > 0) this.refocusMouseGuardUntil = Date.now() + this.refocusMouseGuardMs;
			return undefined;
		}

		const wheelEvent = this.parseWheelEvent(data);
		if (wheelEvent) {
			const lines = this.wheelScroll.next(wheelEvent.direction, performance.now());
			// SGR mouse button codes use bit 3 (value 8) for the Alt modifier.
			const wheelDelta =
				wheelEvent.direction *
				(this.altWheelAcceleration && (wheelEvent.button & 8) !== 0
					? lines * ALT_WHEEL_SCROLL_MULTIPLIER
					: lines);
			const event = this.createMouseEvent("wheel", wheelEvent.button, wheelEvent.x, wheelEvent.y, { wheelDelta });
			const overlay = this.dispatchMouseToOverlay(event);
			const result = overlay.result ?? (overlay.hit ? undefined : this.dispatchMouseToLayout(event));
			if (result) {
				if (this.applyMouseDispatchResult(event, result)) this.requestRender();
				return { consume: true };
			}
			this.routeWheel(wheelEvent, wheelDelta);
			return { consume: true };
		}
		const mouseEvent = this.parseSgrMouseEvent(data);
		if (mouseEvent) {
			if (this.refocusMouseGuardUntil !== undefined && Date.now() < this.refocusMouseGuardUntil) {
				return { consume: true };
			}
			this.handleMouseEvent(mouseEvent);
			return { consume: true };
		}
		if (this.isMouseSequence(data)) return { consume: true };

		const keybindings = getKeybindings();
		const isRelease = isKeyRelease(data);
		// When the primary scroll view has nothing to scroll (short content, or a
		// full-screen component mounted as the layout root), let navigation keys
		// fall through to the focused component instead of consuming them.
		const primaryScrollable = this.getPrimaryScrollView().canScroll;
		if (keybindings.matches(data, "tui.altScreen.search") && (this.activeSearch || this.hasSearchableScrollView())) {
			if (!isRelease) this.toggleSearch();
			return { consume: true };
		}
		const search = this.activeSearch;
		if (search?.overlay?.isFocused()) {
			if (
				!isRelease &&
				(keybindings.matches(data, "tui.altScreen.searchNext") ||
					keybindings.matches(data, "tui.altScreen.searchPrevious"))
			) {
				const selection = this.getSelectionBounds();
				const editable = selection?.mode === "logical" ? getSelectionEditOffsets(selection) : undefined;
				if (editable?.component === search.component) this.clearTextSelection();
			}
			if (keybindings.matches(data, "tui.altScreen.searchNext")) {
				if (!isRelease) this.navigateSearch(1);
				return { consume: true };
			}
			if (keybindings.matches(data, "tui.altScreen.searchPrevious")) {
				if (!isRelease) this.navigateSearch(-1);
				return { consume: true };
			}
			if (keybindings.matches(data, "tui.altScreen.searchClose")) {
				if (!isRelease) this.closeSearch();
				return { consume: true };
			}
			if (this.searchSelectAll && keybindings.matches(data, "tui.altScreen.searchSelectAll")) {
				if (!isRelease) {
					const range = search.component.getSelectAllSelection?.();
					const target = this.getOverlayTargetForComponent(search.component);
					this.clearTextSelection();
					this.lastClick = undefined;
					if (range && target) {
						const logicalTarget = createLogicalSelectionTarget(search.component);
						const start = this.toSelectionPoint(logicalTarget, range.start);
						const end = this.toSelectionPoint(logicalTarget, range.end);
						this.selectionOverlay = target;
						this.selectionGranularity = "line";
						this.selectionInitialRange = { mode: "logical", start, end };
						this.selectionAnchor = start;
						this.selectionFocus = end;
					}
					this.requestRender();
				}
				return { consume: true };
			}
		}
		const focused = this.getFocusedComponent();
		const focusedSelection = focused && isSelectionEditComponent(focused) ? focused : undefined;
		if (
			this.editorSelection && focusedSelection?.getSelectAllSelection &&
			keybindings.matches(data, "tui.altScreen.searchSelectAll")
		) {
			if (!isRelease) {
				const target = this.getEditorLayoutTarget(focusedSelection);
				const range = focusedSelection.getSelectAllSelection();
				this.clearTextSelection();
				this.lastClick = undefined;
				if (target && range) {
					const start = this.toSelectionPoint(target, range.start);
					const end = this.toSelectionPoint(target, range.end);
					this.selectionGranularity = "line";
					this.selectionInitialRange = { mode: "logical", start, end };
					this.selectionAnchor = start;
					this.selectionFocus = end;
				}
				this.requestRender();
			}
			return { consume: true };
		}
		const selection = this.getSelectionBounds();
		const editableSelection = selection?.mode === "logical" ? getSelectionEditOffsets(selection) : undefined;
		const ownsEditableSelection = editableSelection && focused === editableSelection.component;
		if (
			ownsEditableSelection &&
			(keybindings.matches(data, "tui.editor.cursorLeft") ||
				keybindings.matches(data, "tui.editor.cursorRight") ||
				keybindings.matches(data, "tui.editor.cursorWordLeft") ||
				keybindings.matches(data, "tui.editor.cursorWordRight") ||
				keybindings.matches(data, "tui.editor.cursorLineStart") ||
				keybindings.matches(data, "tui.editor.cursorLineEnd") ||
				keybindings.matches(data, "tui.editor.cursorUp") ||
				keybindings.matches(data, "tui.editor.cursorDown"))
		) {
			if (!isRelease) this.clearTextSelection();
		}
		const selectionInput = ownsEditableSelection ? editableSelection.component.handleSelectionInput : undefined;
		if (ownsEditableSelection && selectionInput && !isRelease) {
			const result = selectionInput.call(editableSelection.component, data, {
				start: editableSelection.start,
				end: editableSelection.end,
				generation: this.selectionGeneration,
			});
			if (result.handled) {
				if (result.clearSelection) this.clearTextSelection();
				this.requestRender();
				return { consume: true };
			}
		}
		const useLegacySelectionInput = ownsEditableSelection && !selectionInput;
		if (
			useLegacySelectionInput &&
			(keybindings.matches(data, "tui.editor.deleteCharBackward") ||
				keybindings.matches(data, "tui.editor.deleteCharForward"))
		) {
			if (!isRelease && editableSelection.component.deleteSelection(editableSelection.start, editableSelection.end)) {
				this.clearTextSelection();
				this.requestRender();
			}
			return { consume: true };
		}
		const isReplacementInput = data.includes("\x1b[200~") || decodeTextInput(data) !== undefined;
		if (useLegacySelectionInput && !isRelease && isReplacementInput) {
			editableSelection.component.deleteSelection(editableSelection.start, editableSelection.end);
			this.clearTextSelection();
		}
		if (this.shouldDeferViewportInput()) return undefined;
		if (primaryScrollable && keybindings.matches(data, "tui.altScreen.pageUp")) {
			if (!isRelease) {
				this.scrollBy(-Math.max(1, this.getPrimaryScrollView().viewportHeight - PAGE_SCROLL_OVERLAP));
			}
			return { consume: true };
		}
		if (primaryScrollable && keybindings.matches(data, "tui.altScreen.pageDown")) {
			if (!isRelease) {
				this.scrollBy(Math.max(1, this.getPrimaryScrollView().viewportHeight - PAGE_SCROLL_OVERLAP));
			}
			return { consume: true };
		}
		if (primaryScrollable && keybindings.matches(data, "tui.altScreen.halfPageUp")) {
			if (!isRelease) this.scrollBy(-Math.max(1, Math.floor(this.getPrimaryScrollView().viewportHeight / 2)));
			return { consume: true };
		}
		if (primaryScrollable && keybindings.matches(data, "tui.altScreen.halfPageDown")) {
			if (!isRelease) this.scrollBy(Math.max(1, Math.floor(this.getPrimaryScrollView().viewportHeight / 2)));
			return { consume: true };
		}
		if (primaryScrollable && keybindings.matches(data, "tui.altScreen.lineUp")) {
			if (!isRelease) this.scrollBy(-1);
			return { consume: true };
		}
		if (primaryScrollable && keybindings.matches(data, "tui.altScreen.lineDown")) {
			if (!isRelease) this.scrollBy(1);
			return { consume: true };
		}
		if (primaryScrollable && keybindings.matches(data, "tui.altScreen.previousPrompt")) {
			if (!isRelease) this.scrollToPrompt(-1);
			return { consume: true };
		}
		if (primaryScrollable && keybindings.matches(data, "tui.altScreen.nextPrompt")) {
			if (!isRelease) this.scrollToPrompt(1);
			return { consume: true };
		}
		if (primaryScrollable && keybindings.matches(data, "tui.altScreen.top")) {
			if (!isRelease) this.scrollToTop();
			return { consume: true };
		}
		if (primaryScrollable && keybindings.matches(data, "tui.altScreen.bottom")) {
			if (!isRelease) this.scrollToBottom();
			return { consume: true };
		}
		return undefined;
	}

	private decodeMouseButton(button: number): TuiMouseButton {
		switch (button & 3) {
			case 0:
				return "left";
			case 1:
				return "middle";
			case 2:
				return "right";
			default:
				return "none";
		}
	}

	private createMouseEvent(
		type: TuiMouseEvent["type"],
		button: number,
		x: number,
		y: number,
		extra: Partial<Pick<TuiMouseEvent, "wheelDelta" | "clickCount">> = {},
	): TuiMouseEvent {
		return {
			type,
			button: type === "wheel" ? "none" : this.decodeMouseButton(button),
			x,
			y,
			screenX: x,
			screenY: y,
			width: Math.max(1, this.terminal.columns),
			height: Math.max(1, this.terminal.rows),
			shift: (button & 4) !== 0,
			alt: (button & 8) !== 0,
			ctrl: (button & 16) !== 0,
			...(extra.wheelDelta === undefined ? {} : { wheelDelta: extra.wheelDelta }),
			...(extra.clickCount === undefined ? {} : { clickCount: extra.clickCount }),
		};
	}

	private dispatchMouseToLayout(event: TuiMouseEvent): TuiMouseDispatchResult | undefined {
		if (!this.currentLayout) return undefined;
		const visited = new Set<Component>();
		const boxes = getLayoutBoxesAt(this.currentLayout, event.screenX, event.screenY);
		for (const box of boxes) {
			if (visited.has(box.component)) continue;
			const layoutNode = getLayoutNode(box.component);
			if (
				layoutNode &&
				(box.component.handleMouse === Container.prototype.handleMouse ||
					(layoutNode.type === "box" && layoutNode.skipLayoutMouseDispatch))
			) {
				continue;
			}
			visited.add(box.component);
			// lineOffset crops the top of an over-tall component so its cursor row
			// stays visible; local coordinates must use the uncropped frame.
			const result = dispatchMouseEvent(box.component, {
				...event,
				x: event.screenX - box.rect.x,
				y: event.screenY - box.rect.y + (box.lineOffset ?? 0),
				width: box.rect.width,
				height: box.lines?.length ?? box.rect.height,
			});
			if (result) return result;
		}
		return undefined;
	}

	private applyMouseDispatchResult(event: TuiMouseEvent, result: TuiMouseDispatchResult): boolean {
		const focusTarget = this.resolveMouseFocusTarget(result.focusTarget ?? result.target.component);
		const shouldFocus = result.focus === true && !(this.activeSearch && event.type === "wheel");
		const focusChanged = shouldFocus && this.getFocusedComponent() !== focusTarget;
		if (shouldFocus) {
			if (this.activeSearch && focusTarget !== this.activeSearch.component) {
				this.closeSearch();
			}
			this.setFocus(focusTarget);
		}
		if (result.capture) this.mouseCapture = result.target;
		return (
			result.render ??
			(focusChanged ||
				event.type === "press" ||
				event.type === "click" ||
				event.type === "drag" ||
				event.type === "wheel")
		);
	}

	private dispatchMouseToTarget(
		event: TuiMouseEvent,
		target: TuiMouseDispatchTarget,
	): TuiMouseDispatchResult | undefined {
		return dispatchMouseEvent(target.component, retargetMouseEvent(event, target));
	}

	private getComponentClickCount(target: TuiMouseDispatchTarget, x: number, y: number): number {
		const now = Date.now();
		const previous = this.lastComponentClick;
		const count =
			previous &&
			now - previous.timestamp <= DOUBLE_CLICK_INTERVAL_MS &&
			previous.component === target.component &&
			Math.abs(previous.x - x) <= 1 &&
			previous.y === y
				? (previous.count % 3) + 1
				: 1;
		this.lastComponentClick = { timestamp: now, count, component: target.component, x, y };
		return count;
	}

	private clearTextSelection(): void {
		this.selectionGeneration += 1;
		this.stopSelectionAutoScroll();
		this.selectionPressActive = false;
		this.selectionPressBlocked = false;
		this.selectionAnchor = undefined;
		this.selectionFocus = undefined;
		this.selectionGranularity = "character";
		this.selectionInitialRange = undefined;
		this.selectionOverlay = undefined;
		this.pressedUrl = undefined;
		this.selectionDragged = false;
	}

	private handleMouseEvent(raw: SgrMouseEvent): void {
		const isMotion = (raw.button & 32) !== 0;
		const type: TuiMouseEvent["type"] = raw.release
			? "release"
			: isMotion
				? this.decodeMouseButton(raw.button) === "none"
					? "move"
					: "drag"
				: "press";
		const event = this.createMouseEvent(type, raw.button, raw.x, raw.y);

		if (this.mouseCapture || this.mousePressTarget) {
			const target = this.mouseCapture ?? this.mousePressTarget!;
			if (
				this.mousePressPoint &&
				(raw.y !== this.mousePressPoint.y || Math.abs(raw.x - this.mousePressPoint.x) > 1)
			) {
				this.mousePressMoved = true;
				this.lastComponentClick = undefined;
			}
			let render = false;
			const targetResult = this.dispatchMouseToTarget(event, target);
			if (targetResult) render = this.applyMouseDispatchResult(event, targetResult);
			if (raw.release) {
				if (
					!this.mousePressMoved &&
					this.mousePressPoint !== undefined &&
					raw.y === this.mousePressPoint.y &&
					Math.abs(raw.x - this.mousePressPoint.x) <= 1
				) {
					const clickX = this.mousePressPoint.x;
					const clickY = this.mousePressPoint.y;
					const clickEvent = this.createMouseEvent("click", raw.button, clickX, clickY, {
						clickCount: this.getComponentClickCount(target, clickX, clickY),
					});
					const clickResult = this.dispatchMouseToTarget(clickEvent, target);
					if (clickResult) render = this.applyMouseDispatchResult(clickEvent, clickResult) || render;
				}
				this.clearComponentMouseGesture();
			}
			if (render) this.requestRender();
			return;
		}

		const selectionButton = (raw.button & 3) === 0 || (raw.release && (raw.button & 3) === 3);
		if (this.selectionPressActive && (selectionButton || this.selectionPressBlocked) && (raw.release || isMotion)) {
			this.handleSelectionMouseEvent(raw);
			return;
		}

		if (this.scrollbarDrag && this.handleScrollbarMouseEvent(raw)) return;
		if (this.handleSearchMouseEvent(raw)) return;

		const overlay = this.dispatchMouseToOverlay(event);
		if (!overlay.hit) {
			if (this.handleScrollToEndIndicatorMouseEvent(raw)) return;
			const scrollbarHandled = this.handleScrollbarMouseEvent(raw);
			if (!this.scrollbarDrag) this.updateScrollbarHover(raw.x, raw.y);
			if (scrollbarHandled) return;
		} else {
			this.stopScrollbarHover();
		}

		const editorTarget = this.activeSearch !== undefined && this.isEditorMouseTarget(raw.x, raw.y);
		const result = overlay.result ?? (overlay.hit || editorTarget ? undefined : this.dispatchMouseToLayout(event));
		if (result) {
			const render = this.applyMouseDispatchResult(event, result);
			if (type === "press") {
				this.clearTextSelection();
				this.mousePressTarget = result.target;
				this.mousePressPoint = { x: raw.x, y: raw.y };
				this.mousePressMoved = false;
			}
			if (render) this.requestRender();
			return;
		}

		if (this.handleRightClick(raw)) return;
		this.handleSelectionMouseEvent(raw, overlay.hit);
	}

	private parseWheelEvent(data: string): WheelEvent | undefined {
		const sgr = /^\x1b\[<(\d+);(\d+);(\d+)[Mm]$/.exec(data);
		if (sgr) {
			const button = Number.parseInt(sgr[1]!, 10);
			if ((button & 64) === 0) return undefined;
			const direction = button & 3;
			if (direction !== 0 && direction !== 1) return undefined;
			return {
				direction: direction === 0 ? -1 : 1,
				x: Number.parseInt(sgr[2]!, 10) - 1,
				y: Number.parseInt(sgr[3]!, 10) - 1,
				button,
			};
		}
		if (data.length === 6 && data.startsWith("\x1b[M")) {
			const button = data.charCodeAt(3) - 32;
			if ((button & 64) === 0) return undefined;
			const direction = button & 3;
			if (direction !== 0 && direction !== 1) return undefined;
			return {
				direction: direction === 0 ? -1 : 1,
				x: data.charCodeAt(4) - 33,
				y: data.charCodeAt(5) - 33,
				button,
			};
		}
		return undefined;
	}

	private routeWheel(event: WheelEvent, delta: number): void {
		let remaining = delta;
		const seen = new Set<ScrollView>();
		for (const scrollView of this.currentLayout ? getScrollViewsAt(this.currentLayout, event.x, event.y) : []) {
			seen.add(scrollView);
			remaining = scrollView.scrollBy(remaining);
			if (remaining === 0) break;
			if (scrollView.overscroll === "contain") {
				remaining = 0;
				break;
			}
		}
		const primary = this.getPrimaryScrollView();
		if (remaining !== 0 && !seen.has(primary)) primary.scrollBy(remaining);
		this.updateScrollbarHover(event.x, event.y);
		// Scrolling moves the viewport only. Reusing the previous component output keeps a wheel
		// frame O(viewport); re-rendering a long transcript on every wheel event saturated a core.
		this.requestViewRender();
	}

	private parseSgrMouseEvent(data: string): SgrMouseEvent | undefined {
		const match = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(data);
		if (!match) return undefined;
		return {
			button: Number.parseInt(match[1]!, 10),
			x: Number.parseInt(match[2]!, 10) - 1,
			y: Number.parseInt(match[3]!, 10) - 1,
			release: match[4] === "m",
		};
	}

	private handleRightClick(event: SgrMouseEvent): boolean {
		if (event.release || event.button !== 2) return false;
		if (this.copyOnRightClick) {
			const hasActiveSelection = this.hasActiveSelection();
			const selectionGeneration = this.selectionGeneration;
			const pending = this.pendingRightClickCopy;
			if (pending && (!hasActiveSelection || pending.selectionGeneration === selectionGeneration)) {
				pending.pasteRequested = true;
				return true;
			}
			if (hasActiveSelection) {
				const operation = {
					selectionGeneration,
					copy: this.copySelectionToClipboard(),
					pasteRequested: false,
				};
				this.pendingRightClickCopy = operation;
				void operation.copy.then(
					(copied) => {
						const isCurrentOperation = this.pendingRightClickCopy === operation;
						if (isCurrentOperation) this.pendingRightClickCopy = undefined;
						if (!copied || !isCurrentOperation) return;
						const selectionIsCurrent = this.selectionGeneration === operation.selectionGeneration;
						if (selectionIsCurrent) {
							this.clearTextSelection();
							this.requestRender();
						}
						if (operation.pasteRequested && (selectionIsCurrent || !this.hasActiveSelection())) {
							this.pasteOnRightClick();
						}
					},
					() => {
						if (this.pendingRightClickCopy === operation) this.pendingRightClickCopy = undefined;
					},
				);
				return true;
			}
		}
		if (
			!this.onRightClickPaste ||
			(!this.copyOnRightClick && (process.platform !== "win32" || terminalPastesOnRightClick()))
		) {
			return false;
		}
		this.pasteOnRightClick();
		return true;
	}

	private pasteOnRightClick(): void {
		const currentRequest = {
			id: ++this.nextRightClickPasteRequestId,
			selectionGeneration: this.selectionGeneration,
		};
		this.currentRightClickPasteRequest = currentRequest;
		const request: TuiRightClickPasteRequest = {
			isCurrent: () =>
				this.currentRightClickPasteRequest?.id === currentRequest.id &&
				this.selectionGeneration === currentRequest.selectionGeneration,
		};
		try {
			this.onRightClickPaste?.(request);
		} catch {}
	}

	private handleScrollToEndIndicatorMouseEvent(event: SgrMouseEvent): boolean {
		const rect = this.scrollToEndIndicatorRect;
		if (!rect || event.release || (event.button & 32) !== 0 || (event.button & 3) !== 0) return false;
		if (event.y !== rect.row || event.x < rect.column || event.x >= rect.column + rect.width) return false;
		this.scrollToBottom();
		return true;
	}

	private getScrollbarTargetAt(x: number, y: number, includeHiddenAuto = false): ScrollbarTarget | undefined {
		const focusedSearch = this.activeSearch?.overlay?.isFocused() === true ? this.activeSearch.component : undefined;
		if (!this.currentLayout || this.hasVisibleOverlay(focusedSearch)) return undefined;
		for (const scrollView of getScrollViewsAt(this.currentLayout, x, y)) {
			const box = getScrollViewBox(this.currentLayout, scrollView);
			const geometry = box ? getScrollbarGeometry(box, includeHiddenAuto) : undefined;
			if (
				geometry &&
				x === geometry.column &&
				y >= geometry.trackTop &&
				y < geometry.trackTop + geometry.trackHeight
			) {
				return { scrollView, geometry };
			}
		}
		return undefined;
	}

	private setScrollbarHover(scrollView: ScrollView | undefined): void {
		if (scrollView === this.scrollbarHover) return;
		this.scrollbarHover?.setScrollbarActive(false);
		this.scrollbarHover = scrollView;
		this.scrollbarHover?.setScrollbarActive(true);
	}

	private updateScrollbarHover(x: number, y: number): void {
		this.setScrollbarHover(this.getScrollbarTargetAt(x, y, true)?.scrollView);
	}

	private stopScrollbarHover(): void {
		this.setScrollbarHover(undefined);
	}

	private scrollScrollbarToPointer(
		scrollView: ScrollView,
		geometry: ScrollbarGeometry,
		pointerY: number,
		grabOffset: number,
	): void {
		const maxThumbOffset = geometry.trackHeight - geometry.thumbHeight;
		const thumbOffset = Math.max(0, Math.min(maxThumbOffset, pointerY - geometry.trackTop - grabOffset));
		const scrollTop = maxThumbOffset === 0 ? 0 : Math.round((thumbOffset / maxThumbOffset) * geometry.maxScrollTop);
		scrollView.scrollTo(scrollTop);
	}

	private handleScrollbarMouseEvent(event: SgrMouseEvent): boolean {
		if (this.scrollbarDrag) {
			if (event.release) {
				this.stopScrollbarDrag();
				return true;
			}
			const box = this.currentLayout
				? getScrollViewBox(this.currentLayout, this.scrollbarDrag.scrollView)
				: undefined;
			const geometry = box ? getScrollbarGeometry(box) : undefined;
			if (geometry) {
				this.scrollScrollbarToPointer(
					this.scrollbarDrag.scrollView,
					geometry,
					event.y,
					this.scrollbarDrag.grabOffset,
				);
			}
			return true;
		}

		if (event.release || (event.button & 32) !== 0 || (event.button & 3) !== 0) return false;
		const target = this.getScrollbarTargetAt(event.x, event.y);
		if (!target) return false;
		this.stopSelectionAutoScroll();
		this.selectionGeneration += 1;
		this.selectionPressActive = false;
		this.selectionPressBlocked = false;
		this.selectionAnchor = undefined;
		this.selectionFocus = undefined;
		this.selectionGranularity = "character";
		this.selectionInitialRange = undefined;
		this.lastClick = undefined;
		this.pressedUrl = undefined;
		this.selectionDragged = false;
		this.setScrollbarHover(target.scrollView);
		const onThumb =
			event.y >= target.geometry.thumbTop && event.y < target.geometry.thumbTop + target.geometry.thumbHeight;
		const grabOffset = onThumb ? event.y - target.geometry.thumbTop : Math.floor(target.geometry.thumbHeight / 2);
		if (!onThumb) this.scrollScrollbarToPointer(target.scrollView, target.geometry, event.y, grabOffset);
		this.scrollbarDrag = {
			scrollView: target.scrollView,
			grabOffset,
		};
		return true;
	}

	private stopScrollbarDrag(): void {
		this.scrollbarDrag = undefined;
	}

	private getReservedDedicatedScrollbarColumn(box: LayoutBox): number | undefined {
		const scrollView = box.scrollView;
		if (
			scrollView?.scrollbarLayout !== "dedicated" ||
			scrollView.getContentWidth(box.rect.width) >= box.rect.width
		) {
			return undefined;
		}
		return box.rect.x + box.rect.width - 1;
	}

	private getScrollSelectionPoint(
		scrollView: ScrollView,
		x: number,
		y: number,
		continuing = false,
	): SelectionPoint | undefined {
		if (!this.currentLayout) return undefined;
		const box = getScrollViewBox(this.currentLayout, scrollView);
		if (!box || box.rect.height <= 0 || box.clip.height <= 0) return undefined;
		const visibleTop = Math.max(0, box.rect.y, box.clip.y);
		const visibleBottom = Math.min(
			this.terminal.rows - 1,
			box.rect.y + box.rect.height - 1,
			box.clip.y + box.clip.height - 1,
		);
		if (visibleBottom < visibleTop) return undefined;
		const pointerRow = Math.max(visibleTop, Math.min(visibleBottom, y));
		const contentRow = scrollView.scrollTop + pointerRow - box.rect.y;
		const maxContentRow = Math.max(0, (box.scrollContentLines?.length ?? 1) - 1);
		const row = Math.max(0, Math.min(maxContentRow, contentRow));
		let col = Math.max(0, Math.min(box.rect.width - 1, x - box.rect.x));
		const dedicatedColumn = this.getReservedDedicatedScrollbarColumn(box);
		if (dedicatedColumn !== undefined) {
			if (!continuing && x === dedicatedColumn) return undefined;
			if (continuing) col = Math.max(0, Math.min(col, dedicatedColumn - box.rect.x - 1));
		}
		const lines = box.scrollContentLines;
		if (lines && getScrollSelectionSource(lines).hasRegions) {
			const region = lines[continuing ? row : contentRow]?.selectionRegion;
			if (!region) return continuing ? { mode: "visual", row, col: 0, scrollView } : undefined;
			const regionColumn = col - region.column;
			if (!continuing && regionColumn < 0) {
				return { mode: "visual", row, col: 0, scrollView, fromRegionGutter: true };
			}
			if (!continuing && regionColumn >= region.width) return undefined;
			col = Math.max(0, Math.min(region.width, regionColumn));
		}
		return { mode: "visual", row, col, scrollView };
	}

	private isEditorMouseTarget(x: number, y: number): boolean {
		if (!this.currentLayout) return false;
		for (const box of getLayoutBoxesAt(this.currentLayout, x, y)) {
			if (box.component instanceof Editor || (this.editorSelection && isSelectionEditComponent(box.component))) {
				return true;
			}
			const row = y - box.rect.y + (box.lineOffset ?? 0);
			const col = x - box.rect.x;
			const target = box.component.selectionTargetAt?.(row, col)?.component;
			if (target && (target instanceof Editor || (this.editorSelection && isSelectionEditComponent(target)))) {
				return true;
			}
		}
		return false;
	}

	private getEditorSelectionTarget(x: number, y: number): LogicalSelectionPoint | undefined {
		if (!this.editorSelection || !this.currentLayout) return undefined;
		for (const box of getLayoutBoxesAt(this.currentLayout, x, y)) {
			let component = box.component;
			let row = y - box.rect.y + (box.lineOffset ?? 0);
			let col = x - box.rect.x;
			let originX = 0;
			let originY = 0;
			if (!isSelectionEditComponent(component)) {
				const target = component.selectionTargetAt?.(row, col);
				if (!target) continue;
				component = target.component;
				row = target.row;
				col = target.col;
				originX = target.originX;
				originY = target.originY;
			}
			if (!isSelectionEditComponent(component)) continue;
			const selectionPoint = component.getClosestSelectionPoint(row, col);
			return {
				mode: "logical",
				component,
				...selectionPoint,
				rowOffset: box.rect.y - (box.lineOffset ?? 0) + originY,
				colOffset: box.rect.x + originX,
				clip: box.clip,
			};
		}
		return undefined;
	}

	private getEditorLayoutTarget(component: SelectionEditableComponent, layout = this.currentLayout): LogicalSelectionPoint | undefined {
		if (!layout) return undefined;
		const visit = (box: LayoutBox, insideScrollView: boolean): LogicalSelectionPoint | undefined => {
			const nestedScrollView = insideScrollView || box.scrollView !== undefined;
			const selectionTarget = box.component === component ? undefined : box.component.selectionTargetAt?.(1, 0);
			if (box.component === component || selectionTarget?.component === component) {
				if (nestedScrollView) return undefined;
				return {
					...createLogicalSelectionTarget(component),
					row: selectionTarget?.row ?? 0,
					col: selectionTarget?.col ?? 0,
					rowOffset: box.rect.y - (box.lineOffset ?? 0) + (selectionTarget?.originY ?? 0),
					colOffset: box.rect.x + (selectionTarget?.originX ?? 0),
					clip: box.clip,
				};
			}
			for (const child of box.children) {
				const target = visit(child, nestedScrollView);
				if (target) return target;
			}
			return undefined;
		};
		return visit(layout.root, false);
	}

	private toSelectionPoint(target: LogicalSelectionPoint, point: EditorSelectionPoint): LogicalSelectionPoint {
		return {
			mode: "logical",
			component: target.component,
			rowOffset: target.rowOffset,
			colOffset: target.colOffset,
			...(target.clip ? { clip: target.clip } : {}),
			...point,
			row: target.rowOffset + point.row,
			col: target.colOffset + point.col,
			endOffset: "endOffset" in point && typeof point.endOffset === "number" ? point.endOffset : point.offset,
		};
	}

	private getSelectionPoint(event: SgrMouseEvent, scrollView?: ScrollView): SelectionPoint {
		const continuing = this.selectionPressActive && ((event.button & 32) !== 0 || event.release);
		const logicalAnchor = this.selectionAnchor?.mode === "logical" ? this.selectionAnchor : undefined;
		const overlay = this.selectionOverlay;
		if (overlay) {
			const { bounds } = overlay;
			const rawRow = event.y - bounds.row;
			const rawColumn = event.x - bounds.col;
			const point: VisualSelectionPoint = {
				mode: "visual",
				row: Math.max(0, Math.min(bounds.height - 1, rawRow)),
				col: Math.max(0, Math.min(bounds.width - 1, rawColumn)),
			};
			const editable = isSelectionEditComponent(overlay.component) &&
				(overlay.component === this.activeSearch?.component || this.editorSelection)
				? overlay.component
				: undefined;
			if (
				editable &&
				((continuing && logicalAnchor?.component === editable) ||
					(!continuing && editable.getSelectionContentStart(rawRow) !== undefined))
			) {
				const target = logicalAnchor ?? createLogicalSelectionTarget(editable);
				const closest = editable.getClosestSelectionPoint(rawRow, rawColumn);
				return this.toSelectionPoint(target, closest);
			}
			const contentEnd = editable?.getSelectionContentEnd(point.row);
			return contentEnd !== undefined && point.col > contentEnd
				? { ...point, col: contentEnd, boundary: true }
				: point;
		}
		if (continuing && logicalAnchor) {
			const closest = logicalAnchor.component.getClosestSelectionPoint(
				event.y - logicalAnchor.rowOffset,
				event.x - logicalAnchor.colOffset,
			);
			return this.toSelectionPoint(logicalAnchor, closest);
		}
		if (scrollView) {
			const point = this.getScrollSelectionPoint(scrollView, event.x, event.y, continuing);
			if (point) {
				const lineWidth = renderedLineContentEnd(this.getSelectionSourceRenderLine(point));
				return point.col > lineWidth ? { ...point, col: lineWidth, boundary: true } : point;
			}
		}
		const point: VisualSelectionPoint = {
			mode: "visual",
			row: Math.max(0, Math.min(this.terminal.rows - 1, event.y)),
			col: Math.max(0, Math.min(this.terminal.columns - 1, event.x)),
		};
		if (continuing) return point;
		const editTarget = this.getEditorSelectionTarget(event.x, event.y);
		if (!editTarget) return point;
		return this.toSelectionPoint(editTarget, editTarget);
	}

	protected override getOverlayTargetAt(x: number, y: number): SelectionOverlayTarget | undefined {
		const target = super.getOverlayTargetAt(x, y);
		if (!target) return undefined;
		const snapshot = this.updateOverlaySnapshot(target.key, target.bounds, target.lines);
		return { ...target, contentVersion: snapshot.version };
	}

	protected override getOverlayTargetForComponent(component: Component): SelectionOverlayTarget | undefined {
		const target = super.getOverlayTargetForComponent(component);
		if (!target) return undefined;
		const snapshot = this.updateOverlaySnapshot(target.key, target.bounds, target.lines);
		return { ...target, contentVersion: snapshot.version };
	}

	protected override isOverlaySelectionTargetValid(target: {
		key: object;
		component?: Component;
		bounds: OverlayBounds;
		contentVersion?: number;
	}): boolean {
		if (!super.isOverlaySelectionTargetValid(target)) return false;
		if (target.contentVersion === undefined || target.component === this.activeSearch?.component) return true;
		return this.overlaySnapshots.get(target.key)?.version === target.contentVersion;
	}

	private getSelectionSourceRenderLines(point: SelectionPoint): readonly TuiRenderLine[] | undefined {
		const overlay = this.selectionOverlay;
		if (overlay) {
			if (!this.isOverlaySelectionTargetValid(overlay)) return undefined;
			return this.overlaySnapshots.get(overlay.key)?.lines;
		}
		if (point.mode === "visual" && point.scrollView) {
			if (!this.currentLayout) return undefined;
			const lines = getScrollViewBox(this.currentLayout, point.scrollView)?.scrollContentLines;
			return lines ? getScrollSelectionSource(lines).lines : undefined;
		}
		return this.currentLayout?.lines ?? this.previousScreen.map((text) => ({ text }));
	}

	private getSelectionSourceRenderLine(point: SelectionPoint): TuiRenderLine {
		const lines = this.getSelectionSourceRenderLines(point);
		if (lines) return lines[point.row] ?? { text: "" };
		if (this.selectionOverlay) return { text: "" };
		return { text: this.previousScreen[point.row] ?? "" };
	}

	private getSelectionSourceLine(point: SelectionPoint): string {
		return this.getSelectionSourceRenderLine(point).text;
	}

	private getSelectionPointAtColumn(point: SelectionPoint, column: number, boundary: boolean): SelectionPoint {
		if (point.mode === "logical") {
			const closest = point.component.getClosestSelectionPoint(point.row - point.rowOffset, column - point.colOffset);
			return {
				...this.toSelectionPoint(point, closest),
				boundary,
			};
		}
		return { ...point, col: column, boundary };
	}

	private getWordSelection(point: SelectionPoint): SelectionRange | undefined {
		const line = stripTerminalSequences(this.getSelectionSourceLine(point));
		const segments: Array<{ start: number; end: number; selectable: boolean; joiner: boolean }> = [];
		let start = 0;
		for (const segment of wordSegmenter.segment(line)) {
			const end = start + visibleWidth(segment.segment);
			const joiner = TERMINAL_WORD_SELECTION_JOINERS.has(segment.segment);
			segments.push({ start, end, selectable: segment.isWordLike === true || joiner, joiner });
			start = end;
		}
		const clickedSegmentIndex = segments.findIndex(
			(segment) => point.col >= segment.start && point.col < segment.end,
		);
		if (clickedSegmentIndex < 0) return undefined;

		const canJoin = (
			left: { selectable: boolean; joiner: boolean },
			right: { selectable: boolean; joiner: boolean },
		): boolean => left.selectable && right.selectable && (left.joiner || right.joiner);
		let selectionStart = segments[clickedSegmentIndex]!.start;
		let selectionEnd = segments[clickedSegmentIndex]!.end;
		for (let index = clickedSegmentIndex; index > 0 && canJoin(segments[index - 1]!, segments[index]!); index--) {
			selectionStart = segments[index - 1]!.start;
		}
		for (
			let index = clickedSegmentIndex;
			index < segments.length - 1 && canJoin(segments[index]!, segments[index + 1]!);
			index++
		) {
			selectionEnd = segments[index + 1]!.end;
		}
		const rangeStart = this.getSelectionPointAtColumn(point, selectionStart, false);
		const rangeEnd = this.getSelectionPointAtColumn(point, selectionEnd, true);
		return rangeStart.mode === "logical" && rangeEnd.mode === "logical"
			? { mode: "logical", start: rangeStart, end: rangeEnd }
			: rangeStart.mode === "visual" && rangeEnd.mode === "visual"
				? { mode: "visual", start: rangeStart, end: rangeEnd }
				: undefined;
	}

	private getLineSelection(point: SelectionPoint): SelectionRange {
		if (point.mode === "logical") {
			const row = point.row - point.rowOffset;
			const range = point.component.getLineSelection?.(row);
			if (range) {
				return {
					mode: "logical",
					start: this.toSelectionPoint(point, range.start),
					end: this.toSelectionPoint(point, range.end),
				};
			}
			const contentStart = point.component.getSelectionContentStart(row);
			const contentEnd = point.component.getSelectionContentEnd(row);
			if (contentStart !== undefined && contentEnd !== undefined) {
				const start = point.component.getClosestSelectionPoint(row, contentStart);
				const end = point.component.getClosestSelectionPoint(row, contentEnd);
				return {
					mode: "logical",
					start: this.toSelectionPoint(point, { ...start, boundary: false }),
					end: this.toSelectionPoint(point, { ...end, boundary: true }),
				};
			}
			return { mode: "logical", start: point, end: point };
		}
		const line = this.getSelectionSourceRenderLine(point);
		const visualSelection: VisualSelectionRange = {
			mode: "visual",
			start: { ...point, col: 0 },
			end: { ...point, col: visibleWidth(line.text), boundary: true },
		};
		const lines = this.getSelectionSourceRenderLines(point);
		const fragment = line.softWrap?.length === 1
			? line.softWrap[0]
			: line.softWrap?.find((candidate) => point.col >= candidate.start && point.col < candidate.end);
		if (!lines || !fragment || !isWholeRowSoftWrapFragment(line, fragment)) return visualSelection;
		let startRow = point.row;
		let endRow = point.row;
		let startFragment = fragment;
		let endFragment = fragment;
		while (startFragment.continuation && startRow > 0) {
			const previous = findMatchingSoftWrapFragment(lines[startRow - 1], startFragment);
			if (!previous) break;
			startRow -= 1;
			startFragment = previous;
		}
		while (endRow + 1 < lines.length) {
			const next = findMatchingSoftWrapFragment(lines[endRow + 1], endFragment);
			if (!next?.continuation) break;
			endRow += 1;
			endFragment = next;
		}
		if (startRow === point.row && endRow === point.row) return visualSelection;
		return {
			mode: "visual",
			start: { ...point, row: startRow, col: startFragment.start },
			end: { ...point, row: endRow, col: endFragment.end, boundary: true },
		};
	}

	private updateSelectionFocus(point: SelectionPoint): void {
		this.selectionGeneration += 1;
		if (this.selectionGranularity === "character" || !this.selectionInitialRange) {
			this.selectionFocus = point;
		} else {
			const range = this.selectionGranularity === "word" ? this.getWordSelection(point) : this.getLineSelection(point);
			if (!range) return;
			const initial = this.selectionInitialRange;
			const targetBeforeInitial = range.mode === "logical" && initial.mode === "logical" &&
					range.start.component === initial.start.component
				? range.start.offset < initial.start.offset
				: range.start.row < initial.start.row ||
					(range.start.row === initial.start.row && range.start.col < initial.start.col);
			if (targetBeforeInitial) {
				this.selectionAnchor = initial.end;
				this.selectionFocus = range.start;
			} else {
				this.selectionAnchor = initial.start;
				this.selectionFocus = range.end;
			}
		}
		const focus = this.selectionFocus;
		if (this.selectionDragged && focus?.mode === "logical" && this.getFocusedComponent() === focus.component) {
			focus.component.moveCursorToOffset(focus.offset);
		}
	}

	private getClickCount(point: SelectionPoint, word: SelectionRange | undefined): number {
		const now = Date.now();
		const previous = this.lastClick;
		const count =
			word &&
			previous &&
			now - previous.timestamp <= DOUBLE_CLICK_INTERVAL_MS &&
			previous.row === point.row &&
			previous.scrollView === getSelectionScrollView(point) &&
			previous.overlay === this.selectionOverlay?.key &&
			((previous.wordStart === word.start.col && previous.wordEnd === word.end.col) || previous.col === point.col)
				? (previous.count % 3) + 1
				: 1;
		this.lastClick = word
			? {
					timestamp: now,
					count,
					row: point.row,
					col: point.col,
					scrollView: getSelectionScrollView(point),
					overlay: this.selectionOverlay?.key,
					wordStart: word.start.col,
					wordEnd: word.end.col,
				}
			: undefined;
		return count;
	}

	private updateSelectionAutoScroll(event: SgrMouseEvent): void {
		const scrollView = getSelectionScrollView(this.selectionAnchor);
		if (!scrollView || !this.currentLayout) {
			this.stopSelectionAutoScroll();
			return;
		}
		const box = getScrollViewBox(this.currentLayout, scrollView);
		if (!box || box.rect.height <= 0 || box.clip.height <= 0) {
			this.stopSelectionAutoScroll();
			return;
		}
		const visibleTop = Math.max(0, box.rect.y, box.clip.y);
		const visibleBottom = Math.min(
			this.terminal.rows - 1,
			box.rect.y + box.rect.height - 1,
			box.clip.y + box.clip.height - 1,
		);
		this.selectionDragPointer = { x: event.x, y: event.y };
		this.selectionAutoScrollDirection = event.y <= visibleTop ? -1 : event.y >= visibleBottom ? 1 : 0;
		if (this.selectionAutoScrollDirection === 0) {
			this.stopSelectionAutoScroll();
			return;
		}
		if (this.selectionAutoScrollTimer) return;
		this.selectionAutoScrollTimer = setInterval(() => this.autoScrollSelection(), 50);
		this.selectionAutoScrollTimer.unref();
	}

	private autoScrollSelection(): void {
		const scrollView = getSelectionScrollView(this.selectionAnchor);
		const pointer = this.selectionDragPointer;
		const direction = this.selectionAutoScrollDirection;
		if (!scrollView || !pointer || direction === 0) {
			this.stopSelectionAutoScroll();
			return;
		}
		const remaining = scrollView.scrollBy(direction);
		if (remaining === direction) {
			this.stopSelectionAutoScroll();
			return;
		}
		const point = this.getScrollSelectionPoint(scrollView, pointer.x, pointer.y, true);
		if (point) this.updateSelectionFocus(point);
		// Selection is painted onto the screen after layout, so it needs no new component output.
		this.requestViewRender();
	}

	private stopSelectionAutoScroll(): void {
		if (this.selectionAutoScrollTimer) {
			clearInterval(this.selectionAutoScrollTimer);
			this.selectionAutoScrollTimer = undefined;
		}
		this.selectionAutoScrollDirection = 0;
		this.selectionDragPointer = undefined;
	}

	private handleSelectionMouseEvent(event: SgrMouseEvent, overlayHit = false): void {
		const button = event.button & 3;
		const blockedMotion = this.selectionPressBlocked && (event.button & 32) !== 0;
		if (button !== 0 && !(event.release && button === 3) && !blockedMotion) return;
		const anchorScrollView = getSelectionScrollView(this.selectionAnchor);
		const point = this.getSelectionPoint(event, anchorScrollView);
		if (event.release) {
			if (!this.selectionPressActive) return;
			const blockedPress = this.selectionPressBlocked;
			this.selectionPressActive = false;
			this.selectionPressBlocked = false;
			this.stopSelectionAutoScroll();
			if (!this.selectionAnchor) return;
			if (!blockedPress) this.updateSelectionFocus(point);
			const isClick =
				!this.selectionDragged &&
				getSelectionScrollView(this.selectionAnchor) === getSelectionScrollView(point) &&
				sameVisualSelectionPoint(this.selectionAnchor, point);
			const clickedUrl = isClick ? this.pressedUrl : undefined;
			this.pressedUrl = undefined;
			if (clickedUrl && this.openUrl) {
				this.selectionGeneration += 1;
				this.selectionAnchor = undefined;
				this.selectionFocus = undefined;
				try {
					this.openUrl(clickedUrl);
				} catch {
					// URL activation is best-effort.
				}
				this.requestRender();
				return;
			}
			if (isClick) {
				const clickEvent = this.createMouseEvent("click", event.button, event.x, event.y, {
					clickCount: this.lastClick?.count ?? 1,
				});
				const overlay = this.dispatchMouseToOverlay(clickEvent);
				const result = overlay.result ?? (overlay.hit ? undefined : this.dispatchMouseToLayout(clickEvent));
				if (result) {
					const render = this.applyMouseDispatchResult(clickEvent, result);
					this.clearTextSelection();
					if (render) {
						if (
							this.isEditorMouseTarget(event.x, event.y) ||
							result.target.component === this.activeSearch?.component
						) {
							this.requestImmediateRender();
						} else {
							this.requestRender();
						}
					}
					return;
				}
			}
			if (this.copyOnSelect) void this.copySelectionToClipboard();
			this.requestRender();
			return;
		}
		if ((event.button & 32) !== 0) {
			if (!this.selectionPressActive || !this.selectionAnchor) return;
			this.selectionDragged = true;
			this.lastClick = undefined;
			this.pressedUrl = undefined;
			if (this.selectionPressBlocked) return;
			this.updateSelectionFocus(point);
			this.updateSelectionAutoScroll(event);
			this.requestRender();
			return;
		}
		this.stopSelectionAutoScroll();
		this.selectionGeneration += 1;
		this.selectionPressActive = true;
		this.selectionPressBlocked = false;
		this.selectionOverlay = undefined;
		if (overlayHit) {
			const target = this.getOverlayTargetAt(event.x, event.y);
			if (!target) {
				this.selectionPressActive = false;
				return;
			}
			this.selectionOverlay = target;
		}
		const scrollView = !overlayHit && this.currentLayout
			? getScrollViewsAt(this.currentLayout, event.x, event.y)[0]
			: undefined;
		if (scrollView && this.currentLayout && !this.getScrollSelectionPoint(scrollView, event.x, event.y)) {
			const box = getScrollViewBox(this.currentLayout, scrollView);
			const constrained = scrollView.scrollbarLayout === "dedicated" && scrollView.scrollbar !== "hidden" ||
				(box?.scrollContentLines && getScrollSelectionSource(box.scrollContentLines).hasRegions);
			if (constrained) {
				const anchor: VisualSelectionPoint = {
					mode: "visual",
					row: Math.max(0, Math.min(this.terminal.rows - 1, event.y)),
					col: Math.max(0, Math.min(this.terminal.columns - 1, event.x)),
				};
				this.selectionPressBlocked = true;
				this.selectionAnchor = anchor;
				this.selectionFocus = anchor;
				this.selectionGranularity = "character";
				this.selectionInitialRange = undefined;
				this.lastClick = undefined;
				this.pressedUrl = undefined;
				this.selectionDragged = false;
				this.requestRender();
				return;
			}
		}
		const anchor = this.getSelectionPoint(event, scrollView);
		const word = anchor.mode === "visual" && anchor.fromRegionGutter
			? undefined
			: this.getWordSelection(anchor);
		const clickCount = this.getClickCount(anchor, word);
		const range = clickCount === 2 ? word : clickCount === 3 ? this.getLineSelection(anchor) : undefined;
		this.selectionGranularity = range ? (clickCount === 2 ? "word" : "line") : "character";
		this.selectionInitialRange = range;
		this.selectionAnchor = range?.start ?? anchor;
		this.selectionFocus = range?.end ?? anchor;
		this.selectionDragged = false;
		this.pressedUrl = range
			? undefined
			: getOsc8LinkAtColumn(
					this.previousScreen[Math.max(0, Math.min(this.terminal.rows - 1, event.y))] ?? "",
					Math.max(0, Math.min(this.terminal.columns - 1, event.x)),
				);
		this.requestRender();
	}

	private getSelectionBounds(): SelectionRange | undefined {
		const anchor = this.selectionAnchor;
		const focus = this.selectionFocus;
		if (!anchor || !focus || anchor.mode !== focus.mode) return undefined;
		if (anchor.mode === "logical" && focus.mode === "logical") {
			if (anchor.component !== focus.component) return undefined;
			if (
				anchor.offset === focus.offset && anchor.endOffset === focus.endOffset &&
				anchor.displayBoundary === undefined && focus.displayBoundary === undefined &&
				sameVisualSelectionPoint(anchor, focus)
			) {
				return undefined;
			}
			const anchorBeforeFocus = anchor.offset < focus.offset ||
				(anchor.offset === focus.offset &&
					(anchor.row < focus.row || (anchor.row === focus.row && anchor.col < focus.col)));
			const selection: LogicalSelectionRange = anchorBeforeFocus
				? { mode: "logical", start: anchor, end: focus }
				: { mode: "logical", start: focus, end: anchor };
			const offsets = getSelectionEditOffsets(selection);
			return offsets.start < offsets.end ? selection : undefined;
		}
		if (anchor.mode === "visual" && focus.mode === "visual") {
			if (anchor.scrollView !== focus.scrollView || sameVisualSelectionPoint(anchor, focus)) return undefined;
			const anchorBeforeFocus = anchor.row < focus.row ||
				(anchor.row === focus.row && anchor.col < focus.col);
			return anchorBeforeFocus
				? { mode: "visual", start: anchor, end: focus }
				: { mode: "visual", start: focus, end: anchor };
		}
		return undefined;
	}

	private getSelectionColumns(
		line: string,
		row: number,
		selection: { start: VisualSelectionPoint; end: VisualSelectionPoint },
		minColumn = 0,
		maxColumn = visibleWidth(line),
	): { start: number; end: number } {
		const lineWidth = visibleWidth(line);
		let start = Math.max(0, minColumn);
		let end = Math.min(lineWidth, maxColumn);
		if (row === selection.start.row) {
			start = getGraphemeCellRange(line, selection.start.col)?.start ?? Math.min(selection.start.col, lineWidth);
		}
		if (row === selection.end.row) {
			end = selection.end.boundary
				? Math.min(selection.end.col, lineWidth)
				: (getGraphemeCellRange(line, selection.end.col)?.end ?? Math.min(selection.end.col + 1, lineWidth));
		}
		return { start: Math.max(minColumn, start), end: Math.min(maxColumn, end) };
	}

	private preserveSelectionAcrossPadding(before: LayoutFrame, after: LayoutFrame): void {
		const scrollView = getSelectionScrollView(this.selectionAnchor);
		if (!scrollView) return;
		const oldLines = getScrollViewBox(before, scrollView)?.scrollContentLines;
		const newLines = getScrollViewBox(after, scrollView)?.scrollContentLines;
		if (!oldLines || !newLines || oldLines.length === newLines.length) return;
		const delta = newLines.length - oldLines.length;
		const longer = delta > 0 ? newLines : oldLines;
		const shorter = delta > 0 ? oldLines : newLines;
		const padding = Math.abs(delta);
		if (!longer.slice(0, padding).every((line) => line.text === "")) return;
		if (!shorter.every((line, row) => line.text === longer[row + padding]?.text)) return;
		// Word/line selections can share their endpoints with the initial range.
		const points = new Set([
			this.selectionAnchor,
			this.selectionFocus,
			this.selectionInitialRange?.start,
			this.selectionInitialRange?.end,
		]);
		for (const point of points) {
			if (point?.mode === "visual" && point.scrollView === scrollView) point.row = Math.max(0, point.row + delta);
		}
		if (this.lastClick?.scrollView === scrollView) this.lastClick.row = Math.max(0, this.lastClick.row + delta);
	}

	private getActiveSelectionText(): string | undefined {
		const selection = this.getSelectionBounds();
		if (!selection) return undefined;
		if (selection.mode === "logical") {
			const editableSelection = getSelectionEditOffsets(selection);
			const text = editableSelection.component.getSelectionText(editableSelection.start, editableSelection.end);
			return text.length === 0 ? undefined : text;
		}
		const sourceLines = this.getSelectionSourceRenderLines(selection.start);
		if (!sourceLines) return undefined;
		let text = "";
		let previousLine: TuiRenderLine | undefined;
		let previousColumns: SelectionColumns | undefined;
		for (let row = selection.start.row; row <= selection.end.row; row++) {
			const line = sourceLines[row] ?? { text: "" };
			const columns = this.getSelectionColumns(line.text, row, selection);
			const value = selectionLineText(line, columns).trimEnd();
			if (row === selection.start.row) {
				text = value;
			} else {
				const wrapped = previousLine && previousColumns
					? findSoftWrapContinuation(previousLine, line, previousColumns, columns)
					: undefined;
				const continuation = wrapped?.continuation;
				if (wrapped && continuation) {
					const contentStart = wrapped.start + continuation.generatedIndent;
					const valueStart = Math.max(columns.start, contentStart);
					const continuationValue = selectionLineText(line, {
						start: valueStart,
						end: columns.end,
					}).trimEnd();
					text += continuation.omittedWhitespace + continuationValue;
				} else {
					text += `\n${value}`;
				}
			}
			previousLine = line;
			previousColumns = columns;
		}
		return text.length === 0 ? undefined : text;
	}

	private async copySelectionToClipboard(): Promise<boolean> {
		const text = this.getActiveSelectionText();
		if (!text) return false;
		return this.copyTextToClipboard(text);
	}

	private copyTextToClipboard(text: string): Promise<boolean> {
		const write = async () => {
			// Prefer an injected clipboard implementation (native clipboard + platform tools with a
			// verified success path) when the host app provides one. A bare OSC 52 write can leave the
			// system clipboard untouched (e.g. macOS Terminal.app, tmux without OSC 52 passthrough), so
			// result objects let hosts distinguish unverified delivery from failure without losing the notice.
			if (this.copySelection) {
				const result = await this.copySelection(text);
				const copied = typeof result === "object" ? result.copied : result === true;
				const message =
					typeof result === "object" ? result.message : typeof result === "string" ? result : undefined;
				this.flash(
					message ?? (copied ? "Copied!" : "Copy failed"),
					copied ? undefined : COPY_ERROR_FLASH_DURATION_MS,
				);
				return copied;
			}
			this.terminal.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
			this.flash("Copied!");
			return true;
		};
		const copy = this.clipboardWriteTail ? this.clipboardWriteTail.then(write) : write();
		const tail = copy.then(
			() => {
				if (this.clipboardWriteTail === tail) this.clipboardWriteTail = undefined;
			},
			() => {
				if (this.clipboardWriteTail === tail) this.clipboardWriteTail = undefined;
			},
		);
		this.clipboardWriteTail = tail;
		return copy;
	}

	private applySearchTextHighlight(text: string, current: boolean): string {
		const style = current ? this.searchCurrentMatchStyle : this.searchMatchStyle;
		let result = "";
		let plainStart = 0;
		let index = 0;
		while (index < text.length) {
			const ansi = extractAnsiCode(text, index);
			if (!ansi) {
				index += 1;
				continue;
			}
			if (index > plainStart) result += style(text.slice(plainStart, index));
			result += ansi.code;
			index += ansi.length;
			plainStart = index;
		}
		if (plainStart < text.length) result += style(text.slice(plainStart));
		return result;
	}

	private applySearchHighlights(screen: string[], layout: LayoutFrame): string[] {
		const search = this.activeSearch;
		if (!search || search.selectedIndex < 0 || search.matches.length === 0) return screen;
		const scrollView = layout.primaryScrollView ?? this.implicitScrollView;
		const box = getScrollViewBox(layout, scrollView);
		if (!box) return screen;

		const rangesByRow = new Map<number, SearchHighlightRange[]>();
		const scrollbarColumn = getScrollbarGeometry(box)?.column;
		const minRow = Math.max(0, box.rect.y, box.clip.y);
		const maxRow = Math.min(screen.length, box.rect.y + box.rect.height, box.clip.y + box.clip.height);
		const minColumn = Math.max(0, box.rect.x, box.clip.x);
		const maxColumn = Math.min(
			this.terminal.columns,
			box.rect.x + box.rect.width,
			box.clip.x + box.clip.width,
			scrollbarColumn ?? Number.POSITIVE_INFINITY,
		);
		const minContentRow = scrollView.scrollTop + minRow - box.rect.y;
		const maxContentRow = scrollView.scrollTop + maxRow - box.rect.y - 1;
		let low = 0;
		let high = search.matches.length;
		while (low < high) {
			const middle = low + Math.floor((high - low) / 2);
			const match = search.matches[middle]!;
			const lastRow = match.segments[match.segments.length - 1]?.row ?? -1;
			if (lastRow < minContentRow) low = middle + 1;
			else high = middle;
		}
		for (let matchIndex = low; matchIndex < search.matches.length; matchIndex++) {
			const match = search.matches[matchIndex]!;
			if ((match.segments[0]?.row ?? 0) > maxContentRow) break;
			for (const segment of match.segments) {
				const row = box.rect.y + segment.row - scrollView.scrollTop;
				if (row < minRow || row >= maxRow) continue;
				const startCol = Math.max(minColumn, box.rect.x + segment.startCol);
				const endCol = Math.min(maxColumn, box.rect.x + segment.endCol);
				if (endCol <= startCol) continue;
				const ranges = rangesByRow.get(row) ?? [];
				ranges.push({ startCol, endCol, current: matchIndex === search.selectedIndex });
				rangesByRow.set(row, ranges);
			}
		}

		const result = [...screen];
		for (const [row, ranges] of rangesByRow) {
			let line = result[row] ?? "";
			if (isImageLine(line)) continue;
			const lineWidth = visibleWidth(line);
			for (const range of ranges.sort((a, b) => b.startCol - a.startCol)) {
				const startCol = Math.min(range.startCol, lineWidth);
				const endCol = Math.min(range.endCol, lineWidth);
				if (endCol <= startCol) continue;
				const before = sliceByColumn(line, 0, startCol, true);
				const highlighted = sliceByColumn(line, startCol, endCol - startCol, true);
				const after = sliceByColumn(line, endCol, Math.max(0, lineWidth - endCol), true);
				line = `${before}${this.applySearchTextHighlight(highlighted, range.current)}${after}`;
			}
			result[row] = line;
		}
		return result;
	}

	private applySelectionHighlight(text: string, preserveFakeCursor = true): string {
		let result = "\x1b[7m";
		let index = 0;
		while (index < text.length) {
			const ansi = extractAnsiCode(text, index);
			if (!ansi) {
				result += text[index];
				index += 1;
				continue;
			}
			if (preserveFakeCursor || (ansi.code !== "\x1b[7m" && ansi.code !== "\x1b[27m")) {
				result += ansi.code;
				if (ansi.code.endsWith("m")) result += "\x1b[7m";
			}
			index += ansi.length;
		}
		return `${result}\x1b[27m`;
	}

	private sameSelectionGeometry(left: LogicalSelectionPoint, right: LogicalSelectionPoint): boolean {
		return left.rowOffset === right.rowOffset && left.colOffset === right.colOffset &&
			left.clip?.x === right.clip?.x && left.clip?.y === right.clip?.y &&
			left.clip?.width === right.clip?.width && left.clip?.height === right.clip?.height;
	}

	private projectLogicalPoint(
		point: LogicalSelectionPoint,
		target: LogicalSelectionPoint,
		end: boolean,
	): LogicalSelectionPoint | undefined {
		const projection = point.component.getSelectionPointForOffset?.(logicalEndpointOffset(point, end), end ? "backward" : "forward");
		if (!projection) {
			if (point.component.getSelectionPointForOffset) return undefined;
			return this.sameSelectionGeometry(point, target)
				? { ...point, rowOffset: target.rowOffset, colOffset: target.colOffset, clip: target.clip, displayBoundary: end }
				: undefined;
		}
		return {
			...this.toSelectionPoint(target, { ...projection, offset: point.offset, boundary: point.boundary }),
			endOffset: point.endOffset,
			displayBoundary: end,
		};
	}

	private reprojectLogicalSelection(layout: LayoutFrame): void {
		const anchor = this.selectionAnchor;
		const focus = this.selectionFocus;
		if (this.selectionOverlay || anchor?.mode !== "logical" || focus?.mode !== "logical") return;
		const selection = this.getSelectionBounds();
		if (selection?.mode !== "logical") return;
		const target = this.getEditorLayoutTarget(anchor.component, layout);
		if (!target || focus.component !== anchor.component) {
			this.clearTextSelection();
			return;
		}
		const nextAnchor = this.projectLogicalPoint(anchor, target, selection.start !== anchor);
		const nextFocus = this.projectLogicalPoint(focus, target, selection.start !== focus);
		if (!nextAnchor || !nextFocus) {
			this.clearTextSelection();
			return;
		}
		this.selectionAnchor = nextAnchor;
		this.selectionFocus = nextFocus;
		const initial = this.selectionInitialRange;
		if (initial?.mode === "logical") {
			const start = initial.start === anchor ? nextAnchor : this.projectLogicalPoint(initial.start, target, false);
			const end = initial.end === focus ? nextFocus : this.projectLogicalPoint(initial.end, target, true);
			this.selectionInitialRange = start && end ? { mode: "logical", start, end } : undefined;
		}
	}

	private projectLogicalRange(
		selection: LogicalSelectionRange,
		overlay: SelectionOverlayTarget | undefined,
	): VisualSelectionRange | undefined {
		const target = createLogicalSelectionTarget(selection.start.component);
		const origin = overlay
			? { rowOffset: overlay.bounds.row, colOffset: overlay.bounds.col }
			: { rowOffset: selection.start.rowOffset, colOffset: selection.start.colOffset };
		const projected = selection.start.component.getSelectionPointForOffset
			? {
					start: this.projectLogicalPoint(selection.start, { ...target, ...origin }, false),
					end: this.projectLogicalPoint(selection.end, { ...target, ...origin }, true),
				}
			: {
					start: {
						...selection.start,
						row: origin.rowOffset + selection.start.row - selection.start.rowOffset,
						col: origin.colOffset + selection.start.col - selection.start.colOffset,
						displayBoundary: false,
					},
					end: {
						...selection.end,
						row: origin.rowOffset + selection.end.row - selection.end.rowOffset,
						col: origin.colOffset + selection.end.col - selection.end.colOffset,
						displayBoundary: true,
					},
				};
		if (!projected.start || !projected.end) return undefined;
		return {
			mode: "visual",
			start: {
				mode: "visual",
				row: projected.start.row,
				col: projected.start.col,
				boundary: projected.start.displayBoundary ?? projected.start.boundary,
			},
			end: {
				mode: "visual",
				row: projected.end.row,
				col: projected.end.col,
				boundary: projected.end.displayBoundary ?? projected.end.boundary,
			},
		};
	}

	private applySelection(screen: string[], layout = this.currentLayout): string[] {
		const selection = this.getSelectionBounds();
		if (!selection) return screen;
		const scrollView = selection.mode === "visual" ? selection.start.scrollView : undefined;
		const overlay = this.selectionOverlay;
		if (overlay && !this.isOverlaySelectionTargetValid(overlay)) return screen;
		let selectionBox: LayoutBox | undefined;
		let screenSelection: VisualSelectionRange;
		if (selection.mode === "logical") {
			const projected = this.projectLogicalRange(selection, overlay);
			if (!projected) return screen;
			screenSelection = projected;
		} else {
			screenSelection = selection;
		}
		let minRow = 0;
		let maxRow = screen.length - 1;
		let minColumn = 0;
		let maxColumn = this.terminal.columns;
		if (overlay) {
			const { bounds } = overlay;
			minRow = bounds.row;
			maxRow = bounds.row + bounds.height - 1;
			minColumn = bounds.col;
			maxColumn = bounds.col + bounds.width;
			if (selection.mode === "visual") {
				screenSelection = {
					mode: "visual",
					start: {
						...selection.start,
						row: bounds.row + selection.start.row,
						col: bounds.col + selection.start.col,
					},
					end: {
						...selection.end,
						row: bounds.row + selection.end.row,
						col: bounds.col + selection.end.col,
					},
				};
			}
		}
		const overlaySourceLines = overlay ? this.getSelectionSourceRenderLines(selection.start) : undefined;
		if (scrollView) {
			if (!layout) return screen;
			const box = getScrollViewBox(layout, scrollView);
			if (!box) return screen;
			selectionBox = box;
			minRow = Math.max(0, box.rect.y, box.clip.y);
			maxRow = Math.min(screen.length - 1, box.rect.y + box.rect.height - 1, box.clip.y + box.clip.height - 1);
			minColumn = Math.max(0, box.rect.x, box.clip.x);
			const dedicatedColumn = this.getReservedDedicatedScrollbarColumn(box) ?? Number.POSITIVE_INFINITY;
			maxColumn = Math.min(
				this.terminal.columns,
				box.rect.x + box.rect.width,
				box.clip.x + box.clip.width,
				dedicatedColumn,
			);
			screenSelection = {
				mode: "visual",
				start: {
					...selection.start,
					mode: "visual",
					row: box.rect.y + selection.start.row - scrollView.scrollTop,
					col: box.rect.x + selection.start.col,
				},
				end: {
					...selection.end,
					mode: "visual",
					row: box.rect.y + selection.end.row - scrollView.scrollTop,
					col: box.rect.x + selection.end.col,
				},
			};
		}
		const editTarget = selection.start.mode === "logical" ? selection.start : undefined;
		const regionSelection = selection.mode === "visual" && selectionBox?.scrollContentLines
			? getScrollSelectionSource(selectionBox.scrollContentLines).hasRegions
			: false;
		const bodySourceLines = !overlay && selection.mode === "visual"
			? regionSelection && selectionBox?.scrollContentLines
				? getScrollSelectionSource(selectionBox.scrollContentLines).lines
				: selectionBox?.scrollContentLines ?? layout?.lines
			: undefined;
		const reservedScrollbarColumn = selectionBox
			? this.getReservedDedicatedScrollbarColumn(selectionBox)
			: undefined;
		const scrollbarColumn = selectionBox
			? getScrollbarGeometry(selectionBox)?.column ?? reservedScrollbarColumn
			: undefined;
		const copiesBodyNewline = (sourceRow: number): boolean => {
			if (!bodySourceLines || selection.mode !== "visual" || sourceRow < selection.start.row || sourceRow >= selection.end.row) {
				return false;
			}
			const line = bodySourceLines[sourceRow] ?? { text: "" };
			const nextLine = bodySourceLines[sourceRow + 1] ?? { text: "" };
			const columns = this.getSelectionColumns(line.text, sourceRow, selection);
			const nextColumns = this.getSelectionColumns(nextLine.text, sourceRow + 1, selection);
			return findSoftWrapContinuation(line, nextLine, columns, nextColumns) === undefined;
		};
		const editorSelection = selection.mode === "logical" ? getSelectionEditOffsets(selection) : undefined;
		const editClip = editTarget?.clip;
		if (editClip) {
			minRow = Math.max(minRow, editClip.y);
			maxRow = Math.min(maxRow, editClip.y + editClip.height - 1);
			minColumn = Math.max(minColumn, editClip.x);
			maxColumn = Math.min(maxColumn, editClip.x + editClip.width);
		}
		return screen.map((line, row) => {
			if (
				row < minRow ||
				row > maxRow ||
				row < screenSelection.start.row ||
				row > screenSelection.end.row ||
				isImageLine(line)
			) {
				return line;
			}
			let lineWidth = visibleWidth(line);
			const sourceRow = selectionBox
				? row - selectionBox.rect.y + (scrollView?.scrollTop ?? 0)
				: overlay
					? row - overlay.bounds.row
					: row;
			const sourceLine = selectionBox
				? bodySourceLines?.[sourceRow]
				: overlay
					? overlaySourceLines?.[sourceRow]
					: layout?.lines[sourceRow];
			const sourceRegion = regionSelection
				? selectionBox?.scrollContentLines?.[sourceRow]?.selectionRegion
				: undefined;
			if (regionSelection && !sourceRegion) return line;
			const offset = (selectionBox?.rect.x ?? overlay?.bounds.col ?? 0) + (sourceRegion?.column ?? 0);
			let columns: SelectionColumns;
			if (regionSelection && sourceRegion && sourceLine && selection.mode === "visual") {
				const contentColumns = this.getSelectionColumns(
					sourceLine.text,
					sourceRow,
					selection,
					0,
					Math.max(0, sourceRegion.width),
				);
				columns = {
					start: Math.max(minColumn, offset + contentColumns.start),
					end: Math.min(maxColumn, offset + contentColumns.end),
				};
			} else {
				columns = this.getSelectionColumns(line, row, screenSelection, minColumn, maxColumn);
			}
			let contentEnd = sourceLine ? offset + renderedLineContentEnd(sourceLine) : Number.POSITIVE_INFINITY;
			if (overlay && isSelectionEditComponent(overlay.component)) {
				const end = overlay.component.getSelectionContentEnd(row - overlay.bounds.row);
				if (end !== undefined) contentEnd = overlay.bounds.col + end;
			}
			if (editTarget) {
				const editorRow = row - editTarget.rowOffset;
				const end = editTarget.component.getSelectionContentEnd(editorRow);
				if (end !== undefined) contentEnd = editTarget.colOffset + end;
				if (editorSelection?.component === editTarget.component) {
					const newlineOffset = editTarget.component.getSelectionNewlineOffset?.(editorRow);
					if (
						newlineOffset !== undefined &&
						editorSelection.start <= newlineOffset &&
						editorSelection.end > newlineOffset
					) {
						contentEnd = Math.min(lineWidth, contentEnd + 1);
					}
					const previousNewlineOffset = editTarget.component.getSelectionNewlineOffset?.(editorRow - 1);
					const focus = this.selectionFocus;
					if (
						previousNewlineOffset !== undefined &&
						editorSelection.start <= previousNewlineOffset &&
						editorSelection.end > previousNewlineOffset &&
						focus?.mode === "logical" && focus.component === editTarget.component &&
						focus.row === row && focus.offset === previousNewlineOffset + 1
					) {
						const contentStart = editTarget.component.getSelectionContentStart(editorRow);
						if (contentStart !== undefined) {
							const caretStart = editTarget.colOffset + contentStart;
							const caretEnd = Math.min(lineWidth, caretStart + 1);
							columns.start = caretStart;
							columns.end = caretEnd;
							contentEnd = Math.max(contentEnd, caretEnd);
						}
					}
				}
			}
			if (bodySourceLines && sourceLine) {
				const sourceWidth = visibleWidth(sourceLine.text);
				const empty = selectionLineText(sourceLine, { start: 0, end: sourceWidth }).trim().length === 0;
				const focus = this.selectionFocus;
				const emptyEndpoint = empty &&
					copiesBodyNewline(sourceRow - 1) &&
					focus !== undefined &&
					getSelectionScrollView(focus) === scrollView &&
					focus.row === sourceRow;
				const copiedNewline = copiesBodyNewline(sourceRow);
				if (copiedNewline || emptyEndpoint) {
					let newlineColumn = offset + renderedLineContentEnd(sourceLine);
					if (sourceRegion) {
						newlineColumn = Math.min(newlineColumn, offset + Math.max(0, sourceRegion.width));
					}
					if (empty) {
						let contentStart = 0;
						const exclusions = sourceRegion ? [] : [...(sourceLine.selectionExclusions ?? [])].sort((a, b) => a.start - b.start);
						for (const excluded of exclusions) {
							if (excluded.end <= contentStart) continue;
							if (excluded.start > contentStart) break;
							contentStart = excluded.end;
						}
						newlineColumn = offset + contentStart;
					}
					const indicator = this.scrollToEndIndicatorRect;
					const occupied = newlineColumn === scrollbarColumn ||
						(indicator?.row === row &&
							newlineColumn >= indicator.column &&
							newlineColumn < indicator.column + indicator.width);
					if (!occupied && newlineColumn >= minColumn && newlineColumn < maxColumn) {
						const requiredWidth = newlineColumn + 1;
						if (requiredWidth > lineWidth) {
							line += " ".repeat(requiredWidth - lineWidth);
							lineWidth = requiredWidth;
						}
						contentEnd = empty ? requiredWidth : Math.max(contentEnd, requiredWidth);
						if (copiedNewline) {
							columns.start = Math.min(columns.start, newlineColumn);
							columns.end = Math.max(columns.end, requiredWidth);
						}
						if (emptyEndpoint) {
							columns.start = newlineColumn;
							columns.end = requiredWidth;
						}
					}
				}
			}
			const exclusions = sourceLine?.selectionExclusions?.map((range) => ({
				start: range.start + offset,
				end: range.end + offset,
			}));
			const included = includedSelectionRanges({
				start: columns.start,
				end: Math.min(columns.end, contentEnd),
			}, exclusions);
			if (included.length === 0) return line;
			let result = "";
			let position = 0;
			for (const range of included) {
				result += sliceByColumn(line, position, Math.max(0, range.start - position), true);
				result += this.applySelectionHighlight(
					sliceByColumn(line, range.start, range.end - range.start, true),
					!(overlay && overlay.component === this.activeSearch?.component),
				);
				position = range.end;
			}
			return result + sliceByColumn(line, position, Math.max(0, lineWidth - position), true);
		});
	}

	private isMouseSequence(data: string): boolean {
		return /^\x1b\[<\d+;\d+;\d+[Mm]$/.test(data) || (data.length === 6 && data.startsWith("\x1b[M"));
	}

	private compositeScrollToEndIndicator(screen: string[], layout: LayoutFrame, width: number): string[] {
		this.scrollToEndIndicatorRect = undefined;
		const scrollView = layout.primaryScrollView ?? this.implicitScrollView;
		if (!this.scrollToEndIndicator || !scrollView.followEnd || scrollView.isFollowingEnd) return screen;
		const box = getScrollViewBox(layout, scrollView);
		const clip = box?.clip;
		if (!clip || clip.width <= 0 || clip.height <= 0) return screen;
		const row = clip.y + clip.height - 1;
		if (row >= screen.length || isImageLine(screen[row] ?? "")) return screen;
		const scrollbarColumn = box ? getScrollbarGeometry(box)?.column : undefined;
		const label = truncateToWidth(this.scrollToEndIndicator(), clip.width, "");
		const labelWidth = visibleWidth(label);
		const column = clip.x + Math.floor((clip.width - labelWidth) / 2);
		const rightEdge = scrollbarColumn ?? clip.x + clip.width;
		const availableWidth = Math.max(0, rightEdge - column);
		const text = truncateToWidth(label, availableWidth, "");
		const textWidth = visibleWidth(text);
		if (textWidth === 0) return screen;
		const result = [...screen];
		result[row] = compositeTuiLine(result[row] ?? "", text, column, textWidth, width);
		this.scrollToEndIndicatorRect = { row, column, width: textWidth };
		return result;
	}

	private updateOverlaySnapshot(
		key: object,
		bounds: OverlayBounds,
		sourceLines: readonly TuiRenderLine[],
	): OverlayRenderSnapshot {
		const lines = sourceLines.map((line) => ({
			text: line.text.replaceAll(CURSOR_MARKER, ""),
			...(line.selectionExclusions ? { selectionExclusions: line.selectionExclusions } : {}),
		}));
		const previous = this.overlaySnapshots.get(key);
		const version = previous && sameOverlayRenderLines(previous.lines, lines)
			? previous.version
			: ++this.nextOverlayContentVersion;
		const snapshot = { bounds, lines, version };
		this.overlaySnapshots.set(key, snapshot);
		return snapshot;
	}

	private refreshOverlaySnapshots(): void {
		const overlay = this.selectionOverlay;
		if (!overlay) return;
		const rendered = this.getOverlayRenderSnapshot(overlay.key);
		if (!rendered) {
			this.overlaySnapshots.delete(overlay.key);
			return;
		}
		this.updateOverlaySnapshot(overlay.key, rendered.bounds, rendered.lines);
	}

	private compositeFlashes(screen: string[], width: number, height: number): string[] {
		const flashLines = this.flashes.render(width).slice(-height);
		if (flashLines.length === 0) return screen;
		const result = [...screen];
		while (result.length < height) result.push("");
		for (let row = 0; row < flashLines.length; row++) {
			const line = flashLines[row]!;
			const flashWidth = visibleWidth(line);
			if (flashWidth === 0) continue;
			result[row] = compositeTuiLine(result[row] ?? "", line, width - flashWidth, flashWidth, width);
		}
		return result;
	}

	protected override doRender(): void {
		if (this.stopped || !this.altScreenActive) return;
		const width = Math.max(1, this.terminal.columns);
		const height = Math.max(1, this.terminal.rows);
		const revealSelection = this.activeSearch !== undefined && this.activeSearch.selectionMode !== "retain";
		const requestViewRender = () => this.requestViewRender();
		let passReusableOutput = this.contentChanged ? undefined : this.currentLayout?.renderCache;
		this.contentChanged = false;
		let nextLayout: LayoutFrame;
		let previousPass: LayoutFrame | undefined;
		for (let pass = 0; ; pass++) {
			const root = this.layoutRoot ?? this.implicitScrollView;
			nextLayout = renderLayoutFrame(root, width, height, requestViewRender, passReusableOutput);
			if (this.refreshSearch(nextLayout, { retainIndex: pass > 0, revealSelection })) {
				nextLayout = renderLayoutFrame(root, width, height, requestViewRender, nextLayout.renderCache);
			}
			if (previousPass) this.preserveSelectionAcrossPadding(previousPass, nextLayout);
			if (this.layoutEffects.size === 0) break;
			this.currentLayout = nextLayout;
			this.layoutEffectRenderRequested = false;
			this.layoutEffectContentChanged = false;
			this.layoutEffectForceRequested = false;
			this.runningLayoutEffects = true;
			try {
				for (const effect of [...this.layoutEffects]) {
					if (this.layoutEffects.has(effect)) effect();
				}
			} finally {
				this.runningLayoutEffects = false;
			}
			if (!this.layoutEffectRenderRequested) break;
			previousPass = nextLayout;
			if (this.layoutEffectForceRequested) this.resetRenderState();
			passReusableOutput = this.layoutEffectContentChanged || this.contentChanged ? undefined : nextLayout.renderCache;
			this.contentChanged = false;
			if (pass + 1 >= MAX_LAYOUT_EFFECT_PASSES) {
				throw new Error(`Layout effects did not stabilize after ${MAX_LAYOUT_EFFECT_PASSES} passes`);
			}
		}
		this.reprojectLogicalSelection(nextLayout);
		// Resolve fake cursors before highlighting and compositing, which only track SGR codes
		let screen = this.resolveFakeCursors(nextLayout.lines.map((line) => line.text.replace(OSC133_ZONE_PREFIX, "")));
		screen = this.applySearchHighlights(screen, nextLayout);
		screen = this.compositeScrollToEndIndicator(screen, nextLayout, width);
		const selectionBelowOverlays = this.hasOverlay() && !this.selectionOverlay;
		if (selectionBelowOverlays) screen = this.applySelection(screen, nextLayout);
		screen = this.compositeOverlays(screen, width, height);
		this.refreshOverlaySnapshots();
		if (screen.length > height) screen = screen.slice(screen.length - height);
		if (this.selectionOverlay && !this.isOverlaySelectionTargetValid(this.selectionOverlay)) {
			this.clearTextSelection();
		}
		if (!selectionBelowOverlays) screen = this.applySelection(screen, nextLayout);
		screen = this.compositeFlashes(screen, width, height);

		const cursorPos = this.extractCursorPosition(screen, height);
		screen = this.applyLineResets(screen).map((line) => {
			if (isImageLine(line) || visibleWidth(line) <= width) return line;
			return sliceByColumn(line, 0, width, true);
		});

		const fullRedraw =
			this.previousScreen.length === 0 || this.previousScreenWidth !== width || this.previousScreenHeight !== height;
		const changedRows = screen.map((line, row) => line !== this.previousScreen[row]);
		const imageAnchorsNeedRedraw = screen.some(
			(line, row) => changedRows[row] && (isImageLine(line) || isImageLine(this.previousScreen[row] ?? "")),
		);
		const imageCellsNeedRedraw =
			!imageAnchorsNeedRedraw &&
			this.imageProtocol === "kitty" &&
			changedRows.some(Boolean) &&
			screen.some((line, row) => {
				const placementRows = getKittyImagePlacementRows(line);
				if (placementRows === undefined) return false;
				for (let coveredRow = row; coveredRow < row + placementRows; coveredRow++) {
					if (changedRows[coveredRow]) return true;
				}
				return false;
			});
		const imagesNeedRedraw = imageAnchorsNeedRedraw || imageCellsNeedRedraw;
		const redrawImages = fullRedraw || imagesNeedRedraw;
		const hadUploadedKittyImages = this.uploadedKittyImages.size > 0;
		const preparedKittyScreen =
			redrawImages && this.imageProtocol === "kitty"
				? this.prepareKittyScreen(screen)
				: { lines: screen, evictedImageDeletion: "" };

		let buffer = BEGIN_SYNCHRONIZED_OUTPUT;
		if (fullRedraw) {
			this.fullRedrawCount += 1;
			if (this.imageProtocol === "kitty" && hadUploadedKittyImages) {
				// Kitty frees image data without placements on ED 2, which would break placement-only reuse.
				// Every row is cleared with EL 2 below, so keep the uploads and skip the screen clear.
				buffer += deleteAllKittyPlacements();
			} else {
				buffer += `${this.deleteKittyImages()}\x1b[2J`;
			}
		} else if (imagesNeedRedraw) {
			if (this.imageProtocol === "iterm2") buffer += "\x1b[2J";
			else if (this.imageProtocol === "kitty") buffer += deleteAllKittyPlacements();
		}
		buffer += preparedKittyScreen.evictedImageDeletion;

		// Some terminals store Kitty images in the cells they cover (WezTerm, xterm.js's image addon in Orca),
		// so clearing or writing a covered row erases that part of the image. Draw placements after every clear
		// and text write so nothing later intersects them. Terminals that keep images on a separate layer
		// (Kitty, Ghostty) render the same result; text-only frames keep the interleaved output.
		const drawKittyImagesLast = redrawImages && this.imageProtocol === "kitty" && screen.some(isImageLine);
		if (drawKittyImagesLast) {
			for (let row = 0; row < height; row++) {
				if (!fullRedraw && !imagesNeedRedraw && screen[row] === this.previousScreen[row]) continue;
				buffer += `\x1b[${row + 1};1H\x1b[2K`;
			}
			for (let row = 0; row < height; row++) {
				if (!fullRedraw && !imagesNeedRedraw && screen[row] === this.previousScreen[row]) continue;
				if (isImageLine(preparedKittyScreen.lines[row] ?? "")) continue;
				buffer += `\x1b[${row + 1};1H${preparedKittyScreen.lines[row] ?? ""}`;
			}
			for (let row = 0; row < height; row++) {
				if (!fullRedraw && !imagesNeedRedraw && screen[row] === this.previousScreen[row]) continue;
				if (!isImageLine(preparedKittyScreen.lines[row] ?? "")) continue;
				buffer += `\x1b[${row + 1};1H${preparedKittyScreen.lines[row] ?? ""}`;
			}
		} else {
			for (let row = 0; row < height; row++) {
				if (!fullRedraw && !imagesNeedRedraw && screen[row] === this.previousScreen[row]) continue;
				buffer += `\x1b[${row + 1};1H\x1b[2K${preparedKittyScreen.lines[row] ?? ""}`;
			}
		}

		if (cursorPos) {
			buffer += `\x1b[${cursorPos.row + 1};${Math.min(width, cursorPos.col) + 1}H`;
			buffer += this.getShowHardwareCursor() ? "\x1b[?25h" : "\x1b[?25l";
		} else {
			buffer += "\x1b[?25l";
		}
		buffer += END_SYNCHRONIZED_OUTPUT;
		this.terminal.write(buffer);

		this.previousScreen = screen;
		this.previousScreenWidth = width;
		this.previousScreenHeight = height;
		this.currentLayout = nextLayout;
	}
}
