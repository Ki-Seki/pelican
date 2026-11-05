import { useEffect, useRef } from 'react';

/**
 * A tap or a click on a line, to comment on it, told from the start of reading it closely: with a
 * mouse, the first click of a double click (to select a word) waits for the second, and a line
 * whose text is being selected is not picked. Keys pick at once (`now`).
 */
export function useLinePick<T>(onPick: (line: T) => void): (line: T, now?: boolean) => void {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pick = useRef(onPick);
  pick.current = onPick;
  useEffect(() => () => clearTimeout(timer.current), []);
  return (line, now = false) => {
    clearTimeout(timer.current);
    if (window.getSelection()?.toString()) return;
    const fine = typeof matchMedia === 'function' && matchMedia('(pointer: fine)').matches;
    if (now || !fine) {
      pick.current(line);
      return;
    }
    timer.current = setTimeout(() => {
      if (!window.getSelection()?.toString()) pick.current(line);
    }, 250);
  };
}
