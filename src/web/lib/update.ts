import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { version as built } from '../../../package.json';
import { api } from './api';
import { socket } from './socket';
import { STATIC_DEMO } from './static-demo';

/** The version of Pelican this page's app was built as. */
export const APP_VERSION = built;

/** Where a page notes the version it loaded the app again for: once for each, never round and round. */
const RELOADED = 'pelican-reloaded-for';

/** Where a page notes the version it said it was updated to: once, in the page that loaded it. */
const SAID = 'pelican-updated-said';

/** Loading the page again; tests see it here. */
export const page = { reload: () => location.reload() };

/**
 * The version this page loaded the app again for (Pelican started again as it, after an update),
 * to say so once: none once said, or where the page was loaded any other way.
 */
export function updatedTo(): string | undefined {
  try {
    if (sessionStorage.getItem(RELOADED) !== APP_VERSION || sessionStorage.getItem(SAID) === APP_VERSION) return undefined;
    sessionStorage.setItem(SAID, APP_VERSION);
    return APP_VERSION;
  } catch {
    return undefined;
  }
}

/**
 * Once the page connects again after losing Pelican (it started again, after an update here or one
 * by hand), it asks which version runs now; another than this page's app, the page loads the new
 * app, once for that version. A Pelican still running while its install is already another
 * version's serves the new app with the old version's word: that is not asked twice.
 */
export function useNewVersion(): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (STATIC_DEMO) return undefined;
    let lost = false;
    return socket.onConnection((connected) => {
      if (!connected) {
        lost = true;
        return;
      }
      if (!lost) return;
      lost = false;
      void api.info().then((info) => {
        queryClient.setQueryData(['info'], info);
        void queryClient.invalidateQueries({ queryKey: ['update'] });
        if (info.version === APP_VERSION) return;
        let reloaded: string | null = null;
        try {
          reloaded = sessionStorage.getItem(RELOADED);
          sessionStorage.setItem(RELOADED, info.version);
        } catch {
          // No storage: the page may load the new app again later; never more than once at a time.
        }
        if (reloaded !== info.version) page.reload();
      }, () => undefined);
    });
  }, [queryClient]);
}
