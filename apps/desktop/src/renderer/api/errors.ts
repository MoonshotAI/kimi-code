// apps/web src/api/errors.ts — re-export daemon error types + guards from
// web-core so existing `import … from '../api/errors'` sites keep working.
export {
  DaemonApiError,
  DaemonNetworkError,
  isDaemonApiError,
  isDaemonNetworkError,
} from '@moonshot-ai/web-core/api';
