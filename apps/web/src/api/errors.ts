// apps/web src/api/errors.ts — re-export daemon error types + guards from
// app-core so existing `import … from '../api/errors'` sites keep working.
export {
  DaemonApiError,
  DaemonNetworkError,
  FileTooLargeError,
  isDaemonApiError,
  isDaemonNetworkError,
  isFileTooLargeError,
} from '@moonshot-ai/app-core/api';
