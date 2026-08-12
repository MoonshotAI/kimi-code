// app-client contracts — small surfaces the consumer application implements to
// plug product-specific behavior into the shared composables.

/**
 * Product analytics sink. The desktop app bridges this to its main-process
 * telemetry; the web app keeps the no-op (it does not emit these events
 * today). Composables receive it by injection — they never import a concrete
 * tracker.
 */
export interface ProductTracker {
  track(event: string, payload?: Record<string, unknown>): void;
}

export const noopProductTracker: ProductTracker = {
  track: () => {},
};

let activeProductTracker: ProductTracker = noopProductTracker;

/** Install the real tracker once at app bootstrap (composition root). The
    desktop app passes its IPC bridge adapter; web leaves the no-op default. */
export function setProductTracker(tracker: ProductTracker): void {
  activeProductTracker = tracker;
}

/** Emit a product analytics event through the injected tracker. Shared modules
    call this delegate — they never import a concrete tracker. With the default
    no-op (web) this is inert. */
export function track(event: string, payload?: Record<string, unknown>): void {
  activeProductTracker.track(event, payload);
}
