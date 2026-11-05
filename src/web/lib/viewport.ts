/**
 * Keeps the app as tall as what can be seen, in --app-h. iOS Safari lays its keyboard over the
 * page rather than resizing it (it does not follow interactive-widget=resizes-content), and then
 * scrolls the whole document to keep the focused field in view, taking the header with it and
 * leaving the newest message under the keyboard. Sized to the visual viewport, the composer sits
 * right above the keyboard and the header stays put. Elsewhere the two heights are the same.
 */
export function fitToVisibleViewport(): () => void {
  const vv = window.visualViewport;
  if (!vv) return () => {};
  const root = document.documentElement;
  const fit = () => {
    // Pinch-zoomed in, the visible part is smaller than the page and the layout stays as it is.
    const height = vv.scale > 1.01 ? window.innerHeight : vv.height;
    root.style.setProperty('--app-h', `${Math.round(height)}px`);
    if (vv.scale <= 1.01 && (window.scrollY !== 0 || window.scrollX !== 0)) window.scrollTo(0, 0);
  };
  fit();
  vv.addEventListener('resize', fit);
  vv.addEventListener('scroll', fit);
  return () => {
    vv.removeEventListener('resize', fit);
    vv.removeEventListener('scroll', fit);
    root.style.removeProperty('--app-h');
  };
}
