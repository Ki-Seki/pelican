import { useAnnouncement } from '../lib/announce';

/** The app's one polite live region; see lib/announce. */
export function Announcer() {
  const text = useAnnouncement();
  return <div aria-live="polite" aria-atomic="true" className="sr-only">{text}</div>;
}
