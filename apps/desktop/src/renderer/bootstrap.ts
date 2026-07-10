// Task 4.4 placeholder for the desktop renderer bootstrap.
//
// Task 4.5 will own the real wiring:
//   - a credentialStore whose `getToken()` calls `window.kimiDesktop.getServerToken()`
//     (token is read in the main process from `serverTokenPath`; the renderer
//     never touches fs directly);
//   - a tracer;
//   - a lightweight desktop projector that maps daemon events onto desktop state.
//
// Desktop deliberately does NOT reuse apps/web's `createAgentProjector`; it ships
// its own small projector tailored to the desktop shell.

export function bootstrap(): void {
  // TODO(4.5): wire credentialStore.getToken(), tracer, and the lightweight
  // daemon-event → desktop-state projector, then call this from main.ts.
}
