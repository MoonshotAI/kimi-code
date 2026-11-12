/** By default, every animation frame lands on a multiple of this many milliseconds of the clock. */
export const ANIMATION_FRAME_INTERVAL_MS = 120;
export const MAX_ANIMATION_FRAME_RATE = 60;

/** Time source and timers behind animation frames. Tests pass a manual clock. */
export interface AnimationClock {
	now(): number;
	setTimeout(callback: () => void, delayMs: number): unknown;
	clearTimeout(handle: unknown): void;
}

function systemClock(): AnimationClock {
	// Each scheduler keeps the timers and time source that existed when it was created. Looking
	// them up on every frame would move a running frame chain onto fake timers a later test installs.
	const now = performance.now.bind(performance);
	const { setTimeout, clearTimeout } = globalThis;
	return {
		now,
		setTimeout: (callback, delayMs) => setTimeout(callback, delayMs).unref(),
		clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
	};
}

/**
 * Runs `requestAnimationFrame` callbacks the way a browser does, on one timer shared by every
 * request. See `TUI.requestAnimationFrame` for the contract.
 */
export class AnimationFrameScheduler {
	private readonly requests = new Map<number, (time: number) => void>();
	private nextHandle = 1;
	private timer: { readonly handle: unknown } | undefined;
	private lastFrameTime = Number.NEGATIVE_INFINITY;
	private paused = false;
	private intervalMs = ANIMATION_FRAME_INTERVAL_MS;
	private readonly clock: AnimationClock;

	constructor(clock: AnimationClock = systemClock()) {
		this.clock = clock;
	}

	requestAnimationFrame(callback: (time: number) => void): number {
		const handle = this.nextHandle++;
		this.requests.set(handle, callback);
		this.schedule();
		return handle;
	}

	cancelAnimationFrame(handle: number): void {
		this.requests.delete(handle);
		this.schedule();
	}

	/** Stops the timer and keeps every request until {@link resume}. */
	pause(): void {
		this.paused = true;
		this.schedule();
	}

	/** Continues on the next frame; frames missed while paused are not replayed. */
	resume(): void {
		this.paused = false;
		this.schedule();
	}

	setFrameRate(fps: number): void {
		if (!Number.isInteger(fps) || fps < 1 || fps > MAX_ANIMATION_FRAME_RATE) {
			throw new RangeError(`An animation frame rate must be a whole number from 1 to ${MAX_ANIMATION_FRAME_RATE}, got ${fps}`);
		}
		this.intervalMs = 1000 / fps;
		if (this.timer !== undefined) this.clock.clearTimeout(this.timer.handle);
		this.timer = undefined;
		this.schedule();
	}

	private schedule(): void {
		if (this.paused || this.requests.size === 0) {
			if (this.timer !== undefined) this.clock.clearTimeout(this.timer.handle);
			this.timer = undefined;
			return;
		}
		if (this.timer !== undefined) return;
		const now = this.clock.now();
		const time = Math.max(this.lastFrameTime, latestFrameTime(now, this.intervalMs)) + this.intervalMs;
		this.timer = { handle: this.clock.setTimeout(() => this.runFrame(time), time - now) };
	}

	private runFrame(scheduledTime: number): void {
		this.timer = undefined;
		// A timer can fire a little before its due time or long after it. The frame keeps a grid
		// time either way, and frames missed while the event loop was busy are skipped.
		const time = Math.max(scheduledTime, latestFrameTime(this.clock.now(), this.intervalMs));
		this.lastFrameTime = time;
		let failure: { readonly error: unknown } | undefined;
		for (const handle of [...this.requests.keys()]) {
			const callback = this.requests.get(handle);
			if (callback === undefined) continue;
			this.requests.delete(handle);
			try {
				callback(time);
			} catch (error) {
				failure ??= { error };
			}
		}
		this.schedule();
		if (failure !== undefined) {
			const { error } = failure;
			queueMicrotask(() => {
				throw error;
			});
		}
	}
}

function latestFrameTime(now: number, intervalMs: number): number {
	return Math.floor(now / intervalMs) * intervalMs;
}
