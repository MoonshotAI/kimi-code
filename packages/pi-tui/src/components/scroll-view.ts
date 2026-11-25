import { LAYOUT_NODE, type ScrollLayoutNode } from "../layout-node.ts";
import { type Component, Container } from "../tui.ts";

export type ScrollViewScrollbar = "hidden" | "auto" | "always";

export interface ScrollViewOptions {
	axis?: "vertical";
	follow?: "none" | "end";
	initialPosition?: "start" | "end";
	primary?: boolean;
	overscroll?: "chain" | "contain";
	scrollbar?: ScrollViewScrollbar;
	scrollbarTrackStyle?: (text: string) => string;
	scrollbarThumbStyle?: (text: string) => string;
	scrollbarHideDelayMs?: number;
}

export interface ScrollViewScrollToOptions {
	/** Keep follow-end disabled even when the target is the current content end. */
	disableFollow?: boolean;
}

export interface ScrollViewScrollIntoViewOptions {
	silent?: boolean;
}

type PendingScrollOp =
	| { kind: "to"; top: number; disableFollow?: boolean; silent: boolean }
	| { kind: "by"; delta: number; silent: boolean }
	| { kind: "page"; direction: -1 | 1; overlap: number; silent: boolean }
	| { kind: "start"; silent: boolean }
	| { kind: "end"; silent: boolean }
	| { kind: "intoView"; startRow: number; endRow: number; silent: boolean };

export class ScrollView extends Container {
	private readonly child: Component;
	readonly followEnd: boolean;
	private readonly initialPosition: "start" | "end";
	readonly primary: boolean;
	readonly overscroll: "chain" | "contain";
	readonly scrollbarTrackStyle: (text: string) => string;
	readonly scrollbarThumbStyle: (text: string) => string;
	private currentScrollbar: ScrollViewScrollbar;
	private readonly scrollbarHideDelayMs: number;
	private currentScrollTop = 0;
	private currentContentHeight = 0;
	private currentViewportHeight = 0;
	private hasLayout = false;
	private pendingOps: PendingScrollOp[] = [];
	private followingEnd: boolean;
	private followSuppressedAtEnd = false;
	private requestRenderCallback: (() => void) | undefined;
	private transientScrollbarVisible = false;
	private scrollbarActive = false;
	private scrollbarHideTimer: NodeJS.Timeout | undefined;

	constructor(component: Component, options: ScrollViewOptions = {}) {
		super();
		if (options.axis !== undefined && options.axis !== "vertical") {
			throw new Error(`Unsupported ScrollView axis: ${options.axis}`);
		}
		this.child = component;
		this.children.push(component);
		this.followEnd = (options.follow ?? "none") === "end";
		this.initialPosition = options.initialPosition ?? (this.followEnd ? "end" : "start");
		this.followingEnd = this.followEnd && this.initialPosition === "end";
		this.primary = options.primary ?? false;
		this.overscroll = options.overscroll ?? "chain";
		this.currentScrollbar = options.scrollbar ?? "hidden";
		this.scrollbarTrackStyle = options.scrollbarTrackStyle ?? ((text) => `\x1b[90m${text}\x1b[39m`);
		this.scrollbarThumbStyle = options.scrollbarThumbStyle ?? ((text) => `\x1b[37m${text}\x1b[39m`);
		this.scrollbarHideDelayMs = Math.max(0, Math.floor(options.scrollbarHideDelayMs ?? 1000));
	}

	get scrollTop(): number {
		return this.currentScrollTop;
	}

	/** Whether the content currently exceeds the viewport (scrolling is possible). */
	get canScroll(): boolean {
		return this.currentContentHeight > this.currentViewportHeight;
	}

	get isFollowingEnd(): boolean {
		return this.followingEnd;
	}

	get contentHeight(): number {
		return this.currentContentHeight;
	}

	get viewportHeight(): number {
		return this.currentViewportHeight;
	}

	get scrollbar(): ScrollViewScrollbar {
		return this.currentScrollbar;
	}

	get isScrollbarVisible(): boolean {
		if (this.scrollbar === "always") return this.currentViewportHeight > 0;
		return (
			this.scrollbar === "auto" &&
			this.currentContentHeight > this.currentViewportHeight &&
			this.transientScrollbarVisible
		);
	}

	get isScrollbarActive(): boolean {
		return this.scrollbarActive;
	}

	setScrollbar(scrollbar: ScrollViewScrollbar): void {
		if (scrollbar === this.currentScrollbar) return;
		this.currentScrollbar = scrollbar;
		if (scrollbar !== "auto") this.hideTransientScrollbar();
		else if (this.scrollbarActive) this.markScrollbarActivity();
		this.requestRenderCallback?.();
	}

	getContentWidth(width: number): number {
		return this.scrollbar === "always" && width > 1 ? width - 1 : width;
	}

	private maxScrollTop(): number {
		return Math.max(0, this.currentContentHeight - this.currentViewportHeight);
	}

	private markScrollbarActivity(): void {
		if (this.scrollbar !== "auto" || this.currentContentHeight <= this.currentViewportHeight) return;
		this.transientScrollbarVisible = true;
		if (this.scrollbarHideTimer) {
			clearTimeout(this.scrollbarHideTimer);
			this.scrollbarHideTimer = undefined;
		}
		if (this.scrollbarActive) return;
		this.scrollbarHideTimer = setTimeout(() => {
			this.scrollbarHideTimer = undefined;
			this.transientScrollbarVisible = false;
			this.requestRenderCallback?.();
		}, this.scrollbarHideDelayMs);
		this.scrollbarHideTimer.unref();
	}

	private hideTransientScrollbar(): void {
		this.transientScrollbarVisible = false;
		if (!this.scrollbarHideTimer) return;
		clearTimeout(this.scrollbarHideTimer);
		this.scrollbarHideTimer = undefined;
	}

	setScrollbarActive(active: boolean): void {
		if (active === this.scrollbarActive) return;
		this.scrollbarActive = active;
		this.markScrollbarActivity();
		this.requestRenderCallback?.();
	}

	private applyScrollTo(scrollTop: number, disableFollow: boolean, silent: boolean, notifyRender: boolean): void {
		const requested = Number.isFinite(scrollTop) ? Math.trunc(scrollTop) : this.currentScrollTop;
		const maxScrollTop = this.maxScrollTop();
		const next = Math.max(0, Math.min(maxScrollTop, requested));
		const nextFollowSuppressedAtEnd = disableFollow && next === maxScrollTop;
		const nextFollowingEnd = !nextFollowSuppressedAtEnd && this.followEnd && next === maxScrollTop;
		if (
			next === this.currentScrollTop &&
			nextFollowingEnd === this.followingEnd &&
			nextFollowSuppressedAtEnd === this.followSuppressedAtEnd
		) {
			return;
		}
		const moved = next !== this.currentScrollTop;
		this.currentScrollTop = next;
		this.followingEnd = nextFollowingEnd;
		this.followSuppressedAtEnd = nextFollowSuppressedAtEnd;
		if (moved && !silent) this.markScrollbarActivity();
		if (notifyRender && !silent) this.requestRenderCallback?.();
	}

	private applyScrollBy(requested: number, silent: boolean, notifyRender: boolean): number {
		const maxScrollTop = this.maxScrollTop();
		const start = this.followingEnd ? maxScrollTop : this.currentScrollTop;
		const next = Math.max(0, Math.min(maxScrollTop, start + requested));
		const moved = next - start;
		const wasFollowingEnd = this.followingEnd;
		this.currentScrollTop = next;
		this.followingEnd = this.followEnd && next === maxScrollTop;
		this.followSuppressedAtEnd = false;
		if (moved !== 0 && !silent) this.markScrollbarActivity();
		if (notifyRender && !silent && (moved !== 0 || this.followingEnd !== wasFollowingEnd)) {
			this.requestRenderCallback?.();
		}
		return requested - moved;
	}

	private applyScrollToStart(silent: boolean, notifyRender: boolean): void {
		const nextFollowingEnd = this.followEnd && this.currentContentHeight <= this.currentViewportHeight;
		const changed =
			this.currentScrollTop !== 0 || this.followingEnd !== nextFollowingEnd || this.followSuppressedAtEnd;
		this.currentScrollTop = 0;
		this.followingEnd = nextFollowingEnd;
		this.followSuppressedAtEnd = false;
		if (changed) {
			if (!silent) this.markScrollbarActivity();
			if (notifyRender && !silent) this.requestRenderCallback?.();
		}
	}

	private applyScrollToEnd(silent: boolean, notifyRender: boolean): void {
		const next = this.maxScrollTop();
		const changed =
			this.currentScrollTop !== next || this.followingEnd !== this.followEnd || this.followSuppressedAtEnd;
		this.currentScrollTop = next;
		this.followingEnd = this.followEnd;
		this.followSuppressedAtEnd = false;
		if (changed) {
			if (!silent) this.markScrollbarActivity();
			if (notifyRender && !silent) this.requestRenderCallback?.();
		}
	}

	private applyScrollIntoView(startRow: number, endRow: number, silent: boolean, notifyRender: boolean): void {
		if (!Number.isFinite(startRow) || !Number.isFinite(endRow) || this.currentViewportHeight <= 0) return;
		const maxScrollTop = this.maxScrollTop();
		const current = this.followingEnd ? maxScrollTop : this.currentScrollTop;
		const start = Math.max(0, Math.floor(startRow));
		const end = Math.max(start + 1, Math.floor(endRow));
		let target = current;
		if (start < current) {
			target = start;
		} else if (end > current + this.currentViewportHeight) {
			target = Math.min(start, end - this.currentViewportHeight);
		}
		if (target === current) return;
		this.applyScrollTo(target, false, silent, notifyRender);
	}

	private applyPendingOp(op: PendingScrollOp): void {
		switch (op.kind) {
			case "to":
				this.applyScrollTo(op.top, op.disableFollow === true, op.silent, false);
				return;
			case "by":
				this.applyScrollBy(op.delta, op.silent, false);
				return;
			case "page": {
				const safeOverlap = Number.isFinite(op.overlap) ? Math.max(0, Math.floor(op.overlap)) : 1;
				const step = Math.max(1, this.currentViewportHeight - safeOverlap);
				this.applyScrollBy(op.direction * step, op.silent, false);
				return;
			}
			case "start":
				this.applyScrollToStart(op.silent, false);
				return;
			case "end":
				this.applyScrollToEnd(op.silent, false);
				return;
			case "intoView":
				this.applyScrollIntoView(op.startRow, op.endRow, op.silent, false);
				return;
			default: {
				const _exhaustive: never = op;
				return _exhaustive;
			}
		}
	}

	private flushPendingOps(): void {
		if (this.pendingOps.length === 0) return;
		const ops = this.pendingOps.splice(0);
		for (const op of ops) {
			this.applyPendingOp(op);
		}
	}

	scrollTo(scrollTop: number, options: ScrollViewScrollToOptions = {}): void {
		if (!this.hasLayout) {
			this.pendingOps.push({
				kind: "to",
				top: scrollTop,
				...(options.disableFollow === undefined ? {} : { disableFollow: options.disableFollow }),
				silent: true,
			});
			return;
		}
		this.pendingOps.length = 0;
		this.applyScrollTo(scrollTop, options.disableFollow === true, false, true);
	}

	scrollBy(lines: number): number {
		const requested = Number.isFinite(lines) ? Math.trunc(lines) : 0;
		if (requested === 0) return 0;
		if (!this.hasLayout) {
			this.pendingOps.push({ kind: "by", delta: requested, silent: true });
			return 0;
		}
		this.flushPendingOps();
		return this.applyScrollBy(requested, false, true);
	}

	scrollPage(direction: -1 | 1, overlap = 1): number {
		if (!this.hasLayout) {
			this.pendingOps.push({ kind: "page", direction, overlap, silent: true });
			return 0;
		}
		this.flushPendingOps();
		const safeOverlap = Number.isFinite(overlap) ? Math.max(0, Math.floor(overlap)) : 1;
		const step = Math.max(1, this.currentViewportHeight - safeOverlap);
		return this.applyScrollBy(direction * step, false, true);
	}

	scrollIntoView(startRow: number, endRow: number, options?: ScrollViewScrollIntoViewOptions): void {
		const silent = options?.silent ?? false;
		if (!this.hasLayout || silent) {
			this.pendingOps.push({ kind: "intoView", startRow, endRow, silent: true });
			return;
		}
		this.pendingOps.length = 0;
		this.applyScrollIntoView(startRow, endRow, false, true);
	}

	scrollToStart(): void {
		if (!this.hasLayout) {
			this.pendingOps.push({ kind: "start", silent: true });
			return;
		}
		this.pendingOps.length = 0;
		this.applyScrollToStart(false, true);
	}

	scrollToEnd(): void {
		if (!this.hasLayout) {
			this.pendingOps.push({ kind: "end", silent: true });
			return;
		}
		this.pendingOps.length = 0;
		this.applyScrollToEnd(false, true);
	}

	updateLayout(contentHeight: number, viewportHeight: number, requestRender: () => void): void {
		this.currentContentHeight = Math.max(0, Math.floor(contentHeight));
		this.currentViewportHeight = Math.max(0, Math.floor(viewportHeight));
		this.requestRenderCallback = requestRender;
		const maxScrollTop = this.maxScrollTop();
		if (!this.hasLayout) {
			if (this.initialPosition === "end") {
				this.currentScrollTop = maxScrollTop;
				this.followingEnd = this.followEnd;
			} else {
				this.currentScrollTop = 0;
				this.followingEnd = false;
			}
			this.followSuppressedAtEnd = false;
			this.hasLayout = true;
		} else if (this.followingEnd) {
			this.currentScrollTop = maxScrollTop;
		} else {
			this.currentScrollTop = Math.max(0, Math.min(this.currentScrollTop, maxScrollTop));
		}
		if (this.pendingOps.length > 0) {
			const ops = this.pendingOps.splice(0);
			for (const op of ops) {
				this.applyPendingOp(op);
			}
		}
		this.currentScrollTop = Math.max(0, Math.min(this.currentScrollTop, maxScrollTop));
		if (this.currentScrollTop < maxScrollTop) this.followSuppressedAtEnd = false;
		if (this.followEnd && this.currentScrollTop === maxScrollTop && !this.followSuppressedAtEnd) {
			this.followingEnd = true;
		}
		if (this.currentContentHeight <= this.currentViewportHeight) this.hideTransientScrollbar();
	}

	override addChild(_component: Component): void {
		throw new Error("ScrollView has exactly one child");
	}

	override removeChild(_component: Component): void {
		throw new Error("ScrollView child cannot be removed");
	}

	override clear(): void {
		throw new Error("ScrollView child cannot be cleared");
	}

	override render(width: number): readonly string[] {
		const contentWidth = this.getContentWidth(width);
		const lines = this.child.render(contentWidth);
		return contentWidth === width ? lines : lines.map((line) => `${line} `);
	}

	[LAYOUT_NODE](): ScrollLayoutNode {
		return { type: "scroll", component: this.child, state: this };
	}
}
