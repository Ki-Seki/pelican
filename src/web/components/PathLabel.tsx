/** A path as its file name, with the folder after it in a fainter, smaller type. */
export function PathLabel({ path }: { path: string }) {
  const cut = path.lastIndexOf('/');
  return (
    <span className="flex min-w-0 items-baseline gap-1.5 overflow-hidden">
      {/* The folder gives way first; a name longer than the row then ends in an ellipsis, never cut off. */}
      <span className="min-w-0 truncate font-mono text-[13px]">{cut >= 0 ? path.slice(cut + 1) : path}</span>
      {cut > 0 && <span className="min-w-0 shrink-[1000] truncate font-mono text-[11px] text-faint" dir="rtl">{`\u200e${path.slice(0, cut)}\u200e`}</span>}
    </span>
  );
}

