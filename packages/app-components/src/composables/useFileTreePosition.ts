import { ref, type Ref } from 'vue';
import { safeGetString, safeSetString } from '@moonshot-ai/app-core/lib';

export type FileTreePosition = 'left' | 'right';

const TREE_POSITION_KEY = 'kimi-web.file-tree-position';

const position: Ref<FileTreePosition> = ref(
  safeGetString(TREE_POSITION_KEY) === 'left' ? 'left' : 'right',
);

function setPosition(next: FileTreePosition): void {
  position.value = next;
  safeSetString(TREE_POSITION_KEY, next);
}

export function useFileTreePosition(): {
  position: Ref<FileTreePosition>;
  setPosition: (next: FileTreePosition) => void;
} {
  return { position, setPosition };
}
