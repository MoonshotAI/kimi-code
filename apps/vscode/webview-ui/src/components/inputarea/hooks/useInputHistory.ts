import { useState, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { bridge } from "@/services";

interface UseInputHistoryOptions {
  text: string;
  setText: (text: string) => void;
  onHeightChange?: () => void;
}

const INPUT_HISTORY_KEY = ["inputHistory"] as const;
const NO_HISTORY: string[] = [];

export function useInputHistory({ text, setText, onHeightChange }: UseInputHistoryOptions) {
  const queryClient = useQueryClient();
  const { data: history = NO_HISTORY } = useQuery({
    queryKey: INPUT_HISTORY_KEY,
    queryFn: () => bridge.getInputHistory(),
  });
  const [index, setIndex] = useState(-1);

  const add = useCallback((input: string) => {
    const trimmed = input.trim();
    if (!trimmed) {
      return;
    }

    void bridge.addInputHistory(trimmed);
    queryClient.setQueryData<string[]>(INPUT_HISTORY_KEY, (prev) => (prev?.[prev.length - 1] === trimmed ? prev : [...(prev ?? []), trimmed]));
    setIndex(-1);
  }, [queryClient]);

  const handleKey = useCallback(
    (e: React.KeyboardEvent): boolean => {
      // Ignore if any modifier key is pressed
      if (e.ctrlKey || e.metaKey || e.altKey) {
        return false;
      }

      if (e.key === "ArrowUp" && history.length > 0 && (!text || index >= 0)) {
        const newIndex = Math.min(index + 1, history.length - 1);
        if (newIndex !== index) {
          e.preventDefault();
          setIndex(newIndex);
          setText(history[history.length - 1 - newIndex]);
          onHeightChange?.();
          return true;
        }
      }

      if (e.key === "ArrowDown" && index >= 0) {
        e.preventDefault();
        const newIndex = index - 1;
        setIndex(newIndex);
        setText(newIndex === -1 ? "" : history[history.length - 1 - newIndex]);
        onHeightChange?.();
        return true;
      }

      return false;
    },
    [history, index, text, setText, onHeightChange],
  );

  const reset = useCallback(() => setIndex(-1), []);

  return { handleKey, add, reset };
}
