import { useState, useEffect, useCallback } from "react";
import { bridge } from "@/services";

interface UseInputHistoryOptions {
  text: string;
  setText: (text: string) => void;
  onHeightChange?: () => void;
}

export function useInputHistory({ text, setText, onHeightChange }: UseInputHistoryOptions) {
  const [history, setHistory] = useState<string[]>([]);
  const [index, setIndex] = useState(-1);

  useEffect(() => {
    void bridge.getInputHistory().then(setHistory);
  }, []);

  const add = useCallback((input: string) => {
    const trimmed = input.trim();
    if (!trimmed) {
      return;
    }

    void bridge.addInputHistory(trimmed);
    setHistory((prev) => (prev[prev.length - 1] === trimmed ? prev : [...prev, trimmed]));
    setIndex(-1);
  }, []);

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
