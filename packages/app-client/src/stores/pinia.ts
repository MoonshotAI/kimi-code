// Shared Pinia instance for app-client's domain stores. Held at module level
// (NOT resolved via getActivePinia) so package-internal import-time code — the
// client singleton composables are constructed when their module is first
// imported, before any app exists — can touch stores safely. Both apps install
// THIS instance (`app.use(clientPinia)` in main.ts), so component-side
// `useXStore()` calls resolve to the very same store instances.
import { createPinia } from 'pinia';

export const clientPinia = createPinia();
