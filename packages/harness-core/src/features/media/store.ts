import type { RefStore, StoredContent } from '@moonshot-ai/agent-core';

export interface MediaStore extends RefStore {
  put(content: StoredContent): Promise<string>;
}
