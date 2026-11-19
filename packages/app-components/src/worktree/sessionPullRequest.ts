import { inject } from 'vue';
import { OpenSidebarBrowserUrlKey } from '@moonshot-ai/app-core/contracts';

export function useOpenPullRequest(): (url: string | null | undefined) => void {
  const resolveSidebarBrowser = inject(OpenSidebarBrowserUrlKey, undefined);
  return (url) => {
    if (!url) return;
    const openInApp = resolveSidebarBrowser?.();
    if (openInApp !== undefined) {
      openInApp(url);
      return;
    }
    window.open(url, '_blank', 'noopener');
  };
}
