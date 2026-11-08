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
/** Frames what can be seen must stay the same, after it changed or a field was entered or left, before it is taken as settled. */
const STEADY = 20;
/** And frames it is looked at, at most: a keyboard takes about a third of a second to come up. */
const LONGEST = 120;

/** Whether what can be seen, `height` CSS px of a touch screen, is what its keyboard leaves. */
export function keyboardUp(height: number, screenWidth: number, screenHeight: number, landscape: boolean): boolean {
  const tall = landscape ? Math.min(screenWidth, screenHeight) : Math.max(screenWidth, screenHeight);
  return tall > 0 && height < KEYBOARD * tall;
}

/** Text fields a touch screen's keyboard comes up for; not a terminal's screen, which takes no keyboard there (inputmode none). */
const TEXT = 'textarea, input:not([type]), input[type=text], input[type=search], input[type=email], input[type=url], input[type=tel], input[type=password], input[type=number]';

/** Whether a field that brings up a touch screen's keyboard has the keys. */
export function typingIn(el: Element | null): boolean {
  if (!(el instanceof HTMLElement) || el.inputMode === 'none' || el.getAttribute('inputmode') === 'none') return false;
  return el.isContentEditable || el.getAttribute('contenteditable') === 'true' || (el.matches(TEXT) && !(el as HTMLInputElement).readOnly);
}

/**
 * What can be seen of the page, in its CSS px: how far below the top of the layout viewport it
 * starts, and how tall it is. Pinch-zoomed in, the page is laid out as it is, all of it. Otherwise it
 * is the visual viewport, which a browser that lays its keyboard over the page makes shorter, and may
 * move down to show the field typed in. It never reaches below the layout viewport: Edge on Android,
 * its toolbar at the bottom, moves it down for its keyboard while it goes on saying the height it
 * had before, and then what can be seen is what is left below where it moved to. With no field
 * typed in there is no keyboard to make room for, and nothing has moved.
 */
export function visibleArea(
  vv: { height: number; offsetTop: number; scale: number },
  layoutHeight: number,
  typing: boolean,
): { top: number; height: number } {
  if (vv.scale > 1.01) return { top: 0, height: layoutHeight };
  const top = typing ? Math.max(0, vv.offsetTop) : 0;
  return { top, height: top > 0 && layoutHeight > top ? Math.min(vv.height, layoutHeight - top) : vv.height };
}

/**
 * Keeps the app over what can be seen: as tall as it is in --app-h, and as far down as it starts in
 * --app-top. iOS Safari lays its keyboard over the page rather than resizing it (it does not follow
 * interactive-widget=resizes-content), and then scrolls the whole document to keep the focused field
 * in view, taking the header with it and leaving the newest message under the keyboard. Edge on
 * Android does not follow it either: it moves what can be seen down to the field instead, its
 * header, or the terminal's first rows, above the top of the screen and blank page under the field.
 * Sized to what can be seen and moved with it, the composer, or the terminal's line, sits right
 * above the keyboard and the header stays at the top. Where the browser resizes the page, as
 * Chrome does, the two are the same, and nothing moves.
 */
export function fitToVisibleViewport(): () => void {
  const vv = window.visualViewport;
  if (!vv) return () => {};
  const root = document.documentElement;
  const media = (query: string) => typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
  // Written only when it changes, as it is looked at every frame for a while.
  const style = (name: string, value: string | undefined) => {
    if (root.style.getPropertyValue(name) === (value ?? '')) return;
    if (value === undefined) root.style.removeProperty(name);
    else root.style.setProperty(name, value);
  };
  const mark = (name: string, value: string | undefined) => {
    if (root.getAttribute(name) === (value ?? null)) return;
    if (value === undefined) root.removeAttribute(name);
    else root.setAttribute(name, value);
  };
  const fit = () => {
    const { top, height } = visibleArea(vv, window.innerHeight, typingIn(document.activeElement));
    style('--app-h', `${Math.round(height)}px`);
    style('--app-top', top > 0 ? `${Math.round(top)}px` : undefined);
    // A phone's keyboard is up, or the phone lies on its side: a view being typed in keeps its
    // room for what is typed (data-short, styles.css). Read from here, as iOS Safari lays its
    // keyboard over the page, so the page's own height says nothing of it.
    mark('data-short', height < SHORT ? (height < TINY ? 'tiny' : '') : undefined);
    // On a phone on its side what can be seen is short whether its keyboard is up or not: the
    // terminal's line, typed in, keeps the room the keyboard leaves (data-keyboard, styles.css).
    mark('data-keyboard', media('(pointer: coarse)') && keyboardUp(height, screen.width, screen.height, media('(orientation: landscape)')) ? '' : undefined);
    if (vv.scale <= 1.01 && (window.scrollY !== 0 || window.scrollX !== 0)) window.scrollTo(0, 0);
    return `${top} ${height} ${vv.height} ${vv.offsetTop} ${window.innerHeight}`;
  };
  // A browser may say what can be seen late, or not at all, once its keyboard is up (Edge on
  // Android): after it changes, and after a field is entered or left, it is looked at every frame
  // until it stays the same a moment.
  let frame = 0;
  let last = '';
  let steady = 0;
  let looked = 0;
  const look = () => {
    const now = fit();
    steady = now === last ? steady + 1 : 0;
    last = now;
    looked += 1;
    frame = steady < STEADY && looked < LONGEST ? requestAnimationFrame(look) : 0;
  };
  const watch = () => {
    steady = 0;
    looked = 0;
    if (!frame) frame = requestAnimationFrame(look);
  };
  // Said by the browser: fitted now, then watched.
  const changed = () => {
    last = fit();
    watch();
  };
  changed();
  vv.addEventListener('resize', changed);
  vv.addEventListener('scroll', changed);
  window.addEventListener('resize', changed);
  window.addEventListener('scroll', changed);
  // A field entered or left: looked at from the next frame, once focus has settled where it goes
  // (the field left has lost it before the next has it).
  document.addEventListener('focusin', watch);
  document.addEventListener('focusout', watch);
  return () => {
    vv.removeEventListener('resize', changed);
    vv.removeEventListener('scroll', changed);
    window.removeEventListener('resize', changed);
    window.removeEventListener('scroll', changed);
    document.removeEventListener('focusin', watch);
    document.removeEventListener('focusout', watch);
    cancelAnimationFrame(frame);
    frame = 0;
    root.style.removeProperty('--app-h');
    root.style.removeProperty('--app-top');
    root.removeAttribute('data-short');
    root.removeAttribute('data-keyboard');
  };
}
