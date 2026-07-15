import { defineAsyncComponent, type Component } from 'vue';
import AsyncErrorFallback from '../components/AsyncErrorFallback.vue';

/**
 * Wrap a lazy-loaded component with a shared error fallback, delay, and
 * timeout. Use this instead of `defineAsyncComponent` directly so every
 * async component gets the same error-recovery behaviour.
 */
export function asyncComponent<T extends Component>(loader: () => Promise<{ default: T }>) {
  return defineAsyncComponent({
    loader,
    errorComponent: AsyncErrorFallback,
    delay: 200,
    timeout: 30000,
  });
}
