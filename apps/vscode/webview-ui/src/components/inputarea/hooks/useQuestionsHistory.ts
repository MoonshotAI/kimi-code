import { useCallback, useMemo, useState } from "react";
import type { ChatMessage } from "@/stores";
import { Content } from "@/lib/content";

export interface QuestionItem {
  id: string;
  text: string;
}

export function collapseWhitespace(text: string): string {
  return text.replaceAll(/\s+/g, " ").trim();
}

export function steerAnchorId(messageId: string, stepN: number, itemIdx: number): string {
  return `${messageId}-steer-${stepN}-${itemIdx}`;
}

// User turns plus mid-turn steer inputs, in conversation order. Steer anchors
// must match the ids SteerBubble renders (see ChatMessage.tsx).
export function collectQuestionItems(messages: ChatMessage[]): QuestionItem[] {
  const result: QuestionItem[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      const text = collapseWhitespace(Content.getText(message.content));
      if (text) {
        result.push({ id: message.id, text });
      }
      continue;
    }
    for (const step of message.steps ?? []) {
      step.items.forEach((item, idx) => {
        if (item.type !== "steer") {
          return;
        }
        const text = collapseWhitespace(Content.getText(item.content));
        if (text) {
          result.push({ id: steerAnchorId(message.id, step.n, idx), text });
        }
      });
    }
  }
  return result;
}

export function filterQuestions(items: QuestionItem[], query: string, hiddenIds: Set<string>): QuestionItem[] {
  const kw = query.toLowerCase();
  return items.filter((it) => !hiddenIds.has(it.id) && (!kw || it.text.toLowerCase().includes(kw)));
}

// The "current" question is the last one whose bubble sits above the viewport
// midline; with nothing above the midline, fall back to the latest question.
export function findCurrentQuestionIndex(items: QuestionItem[]): number {
  if (items.length === 0) {
    return -1;
  }
  const mid = window.innerHeight / 2;
  let idx = -1;
  for (let i = 0; i < items.length; i++) {
    const el = document.querySelector(`[data-message-id="${items[i].id}"]`);
    if (!el) {
      continue;
    }
    if (el.getBoundingClientRect().top <= mid) {
      idx = i;
    } else {
      break;
    }
  }
  return idx === -1 ? items.length - 1 : idx;
}

interface UseQuestionsHistoryResult {
  query: string;
  setQuery: (query: string) => void;
  activeIndex: number;
  setActiveIndex: (index: number) => void;
  visibleItems: QuestionItem[];
  moveActive: (delta: number) => void;
  hide: (id: string) => void;
  resetForOpen: () => void;
}

export function useQuestionsHistory(items: QuestionItem[]): UseQuestionsHistoryResult {
  const [query, setQueryState] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set());

  const visibleItems = useMemo(() => filterQuestions(items, query, hiddenIds), [items, query, hiddenIds]);

  const setQuery = useCallback((next: string) => {
    setQueryState(next);
    setActiveIndex(-1);
  }, []);

  const moveActive = useCallback(
    (delta: number) => {
      setActiveIndex((i) => {
        if (visibleItems.length === 0) {
          return -1;
        }
        const next = i + delta;
        if (next < 0) {
          return visibleItems.length - 1;
        }
        if (next >= visibleItems.length) {
          return 0;
        }
        return next;
      });
    },
    [visibleItems.length],
  );

  const hide = useCallback((id: string) => {
    setHiddenIds((prev) => new Set(prev).add(id));
    setActiveIndex(-1);
  }, []);

  const resetForOpen = useCallback(() => {
    setQueryState("");
    const currentIdx = findCurrentQuestionIndex(items);
    const currentItem = currentIdx >= 0 ? items[currentIdx] : undefined;
    setActiveIndex(currentItem ? filterQuestions(items, "", hiddenIds).indexOf(currentItem) : -1);
  }, [items, hiddenIds]);

  return { query, setQuery, activeIndex, setActiveIndex, visibleItems, moveActive, hide, resetForOpen };
}
