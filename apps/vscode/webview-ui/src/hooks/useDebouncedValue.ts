import { useEffect, useRef, useState } from "react";

export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  const mountedRef = useRef(false);

  useEffect(() => {
    if (!mountedRef.current) {
      return;
    }
    const timer = setTimeout(() => { setDebounced(value); }, delayMs);
    return () => { clearTimeout(timer); };
  }, [value, delayMs]);

  useEffect(() => {
    mountedRef.current = true;
  }, []);

  return debounced;
}
