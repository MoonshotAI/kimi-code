import { useEffect, RefObject } from "react";

export function useClickOutside(refs: RefObject<HTMLElement | null>[], isActive: boolean, onClickOutside: () => void): void {
  useEffect(() => {
    if (!isActive) {
      return;
    }

    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node;
      const isOutside = refs.every((ref) => ref.current && !ref.current.contains(target));
      if (isOutside) {
        onClickOutside();
      }
    };

    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [refs, isActive, onClickOutside]);
}
