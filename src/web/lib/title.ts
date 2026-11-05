/**
 * The tab's title: the open session's, after how many sessions need you, so a background tab
 * says so ("(1) Fix the login test · Pelican").
 */
let session: string | undefined;
let waiting = 0;

export function titleFor(sessionTitle: string | undefined, needYou: number): string {
  return `${needYou > 0 ? `(${needYou}) ` : ''}${sessionTitle ? `${sessionTitle} · ` : ''}Pelican`;
}

const apply = () => {
  document.title = titleFor(session, waiting);
};

export function setSessionTitle(title: string | undefined): void {
  session = title || undefined;
  apply();
}

export function setWaitingCount(count: number): void {
  waiting = count;
  apply();
}
