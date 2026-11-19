import { clearCredential, initServerAuth } from '@moonshot-ai/app-core/lib';

export function clearEmbeddedServerCredential(search: string): boolean {
  if (new URLSearchParams(search).get('kimi_embedded') !== '1') return false;
  initServerAuth();
  clearCredential();
  return true;
}
