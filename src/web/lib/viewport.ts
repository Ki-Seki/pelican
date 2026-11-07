/** What can be seen is short under this height: a phone's keyboard up (about 420 px left on a large one), or a phone on its side. */
const SHORT = 520;
/** And too short for the terminal's key row and line together: a phone on its side with its keyboard up (66 px left in Chrome). */
const TINY = 120;
/**
 * A touch screen's keyboard is up where what can be seen is less than this part of the screen's
 * height: no browser bar takes that much, and a keyboard takes more (on a phone on its side, its
 * height is the screen's shorter side; iOS keeps screen.width and screen.height upright).
 */
const KEYBOARD = 0.6;

/** Whether what can be seen, `height` CSS px of a touch screen, is what its keyboard leaves. */
export function keyboardUp(height: number, screenWidth: number, screenHeight: number, landscape: boolean): boolean {
  const tall = landscape ? Math.min(screenWidth, screenHeight) : Math.max(screenWidth, screenHeight);
  return tall > 0 && height < KEYBOARD * tall;
}

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
    // A phone's keyboard is up, or the phone lies on its side: a view being typed in keeps its
    // room for what is typed (data-short, styles.css). Read from here, as iOS Safari lays its
    // keyboard over the page, so the page's own height says nothing of it.
    if (height < SHORT) root.setAttribute('data-short', height < TINY ? 'tiny' : '');
    else root.removeAttribute('data-short');
    // On a phone on its side what can be seen is short whether its keyboard is up or not: the
    // terminal's line, typed in, keeps the room the keyboard leaves (data-keyboard, styles.css).
    const media = (query: string) => typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
    if (media('(pointer: coarse)') && keyboardUp(height, screen.width, screen.height, media('(orientation: landscape)'))) root.setAttribute('data-keyboard', '');
    else root.removeAttribute('data-keyboard');
    if (vv.scale <= 1.01 && (window.scrollY !== 0 || window.scrollX !== 0)) window.scrollTo(0, 0);
  };
  fit();
  vv.addEventListener('resize', fit);
  vv.addEventListener('scroll', fit);
  return () => {
    vv.removeEventListener('resize', fit);
    vv.removeEventListener('scroll', fit);
    root.style.removeProperty('--app-h');
    root.removeAttribute('data-short');
    root.removeAttribute('data-keyboard');
  };
}
