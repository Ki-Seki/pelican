import { type MouseEvent, type ReactNode, useContext, useState } from 'react';

import { entries, PATH_ACTIONS, type PathTarget } from '../lib/actions';
import { apiUrl } from '../lib/api';
import { announce } from '../lib/announce';
import { addWaiting } from '../lib/drafts';
import { baseName } from '../lib/format';
import { hasKeyboard } from '../lib/keyboard';
import { inFolder, usePathLinks } from '../lib/path-links';
import { type Press, useLongPress } from '../lib/press';
import { fileItem } from '../lib/quote';
import { ActionMenu, type MenuAnchor } from './ActionMenu';
import { QuoteTargetContext } from './Quotes';

/** Saves a file of the session's folder, as Files' Download does. */
export function downloadFile(cwd: string, path: string): void {
  const link = document.createElement('a');
  link.href = apiUrl(`file/raw?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}`);
  link.download = baseName(path);
  document.body.append(link);
  link.click();
  link.remove();
}

/**
 * A path's list (lib/actions PATH_ACTIONS) wherever it shows in the conversation, as Desktop's path
 * menu: Attach as context · Copy ▸ · Open in Changes (a file with changes) · Open in Files ·
 * Download file, a folder's Open in terminal. `path` is from the session's folder.
 */
export function usePathTarget(path: string | undefined, folder = false): PathTarget | undefined {
  const links = usePathLinks();
  const quote = useContext(QuoteTargetContext);
  if (!links || !path) return undefined;
  const relative = inFolder(path, links.cwd);
  if (relative === undefined) return undefined;
  const changed = !folder && (Boolean(links.changed?.has(relative)) || Boolean(links.turns?.some((turn) => turn.files.some((f) => f.path === relative))));
  return {
    path: relative,
    cwd: links.cwd,
    ...(folder ? { folder } : {}),
    ...(changed ? { changed } : {}),
    ...(quote ? {
      attach: () => {
        if (addWaiting(quote.chat, fileItem(relative, folder))) announce(`${baseName(relative)} goes with your message`);
      },
    } : {}),
    ...(links.openChanges ? { openInChanges: () => links.openChanges?.(relative) } : {}),
    openInFiles: () => links.openFile(folder ? `${relative.replace(/\/$/, '')}/` : relative),
    ...(folder && links.openTerminal ? { openInTerminal: () => links.openTerminal?.(relative) } : {}),
    ...(!folder ? { download: () => downloadFile(links.cwd, relative) } : {}),
  };
}

/** Where a path's menu opens: under a finger, raised over the dim; at the pointer; or under the path from the keyboard. */
type At = { at: MenuAnchor; lift?: Element; keys?: boolean };

/**
 * A long press under a finger, and a right-click with a pointer, on a path: its menu. Spread
 * `bind` on the link; its own menu is kept from what holds it (a reply, a step), which have theirs.
 */
export function usePathMenu(target: PathTarget | undefined): { bind: ReturnType<typeof useLongPress<HTMLAnchorElement>> & { 'data-path-link': true }; menu: ReactNode } {
  const [at, setAt] = useState<At>();
  const press = useLongPress<HTMLAnchorElement>((p: Press) => {
    if (!target) return;
    setAt(p.pointerType === 'touch' || p.pointerType === 'pen' ? { at: p.element, lift: p.element } : p.pointerType === 'keyboard' ? { at: p.element, keys: true } : { at: { x: p.x, y: p.y } });
  }, { enabled: Boolean(target) });
  const bind = {
    ...press,
    onContextMenu: (e: MouseEvent<HTMLAnchorElement>) => {
      press.onContextMenu(e);
      if (target) e.stopPropagation();
    },
    'data-path-link': true as const,
  };
  const list = at && target ? entries(PATH_ACTIONS, target, 'menu', hasKeyboard() ? 'pointer' : 'touch') : [];
  const menu = target ? (
    <ActionMenu
      open={Boolean(at)}
      onClose={() => setAt(undefined)}
      label={target.path}
      title={<span className="font-mono">{baseName(target.path)}</span>}
      entries={list}
      at={at?.at ?? null}
      focusFirst={Boolean(at?.keys)}
      {...(at?.lift ? { lift: at.lift } : {})}
    />
  ) : null;
  return { bind, menu };
}
