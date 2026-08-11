// app-client contracts — small surfaces the consumer application implements to
// plug product-specific behavior into the shared composables.

/**
 * Product analytics sink. The desktop app bridges this to its main-process
 * telemetry (P6); the web app keeps the no-op (it does not emit these events
 * today). Composables receive it by injection — they never import a concrete
 * tracker.
 */
export interface ProductTracker {
  track(event: string, payload?: Record<string, unknown>): void;
}

export const noopProductTracker: ProductTracker = {
  track: () => {},
};
