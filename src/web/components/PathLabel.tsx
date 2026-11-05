/** A path as its file name, with the folder after it in a fainter, smaller type. */
export function PathLabel({ path }: { path: string }) {
  const cut = path.lastIndexOf('/');
  return (
    <span className="flex min-w-0 items-baseline gap-1.5 overflow-hidden">
      <span className="shrink-0 font-mono text-[13px]">{cut >= 0 ? path.slice(cut + 1) : path}</span>
      {cut > 0 && <span className="min-w-0 truncate font-mono text-[11px] text-faint" dir="rtl">{`‎${path.slice(0, cut)}‎`}</span>}
    </span>
  );
}

