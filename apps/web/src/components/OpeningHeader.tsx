/**
 * Auto-naming header: shows the deepest known opening for a given path of
 * fenKeys, refining (e.g. "Caro-Kann Defense" → "Caro-Kann Defense, Advance
 * Variation") as the user steps deeper. When the current FEN itself isn't in
 * the book but an ancestor is, shows the ancestor's name with a "…" suffix.
 */
import { useEffect, useRef, useState } from 'react';
import { useDeepestOpeningId } from '../lib/openings/useOpeningId';
import { fenKey as makeFenKey } from '@chess-prep/shared';

interface Props {
  /** Path of FULL FENs (or fenKeys) from the root to the current position. */
  pathFens: string[];
  /** Optional className for outer container. */
  className?: string;
}

export function OpeningHeader({ pathFens, className = '' }: Props) {
  // Normalize once per render so the hook gets stable fenKeys.
  const fenKeys: string[] = [];
  for (const f of pathFens) {
    try {
      fenKeys.push(makeFenKey(f));
    } catch {
      // skip invalid
    }
  }
  const { opening, loading } = useDeepestOpeningId(fenKeys);

  // The deepest match is for some prefix of the path. If it isn't the last
  // position, the line has continued past anything the book knows — surface
  // that with a "…" suffix so the user knows they're off-book.
  const lastFenKey = fenKeys[fenKeys.length - 1];
  const matchedLastPosition = useMatchedLastPosition(opening, lastFenKey);

  if (!opening && !loading) {
    return (
      <div className={`text-xs text-slate-500 ${className}`}>Starting position</div>
    );
  }
  if (!opening) {
    return <div className={`text-xs text-slate-500 ${className}`}>Identifying…</div>;
  }

  return (
    <div className={`flex items-baseline gap-2 ${className}`}>
      <span className="text-[10px] uppercase tracking-wide text-slate-500">
        {opening.eco}
      </span>
      <span className="text-sm font-medium text-slate-100">
        {opening.name}
        {opening.variation ? `, ${opening.variation}` : ''}
        {matchedLastPosition === false ? <span className="text-slate-500"> …</span> : null}
      </span>
    </div>
  );
}

/**
 * Lookup: was the deepest hit at the last position in the path, or earlier?
 * The hook doesn't return which position matched, so we do a tiny single-key
 * lookup against the same cache to decide whether to show the "off-book"
 * ellipsis. False = matched ancestor only; true = exact match at current.
 */
function useMatchedLastPosition(
  opening: ReturnType<typeof useDeepestOpeningId>['opening'],
  lastFenKey: string | undefined,
): boolean | null {
  const [matched, setMatched] = useState<boolean | null>(null);
  const lastReqRef = useRef(0);
  useEffect(() => {
    if (!opening || !lastFenKey) {
      setMatched(null);
      return;
    }
    const myReq = ++lastReqRef.current;
    void (async () => {
      const { api } = await import('../api/client');
      try {
        const row = await api.getOpeningByFenKey(lastFenKey);
        if (myReq !== lastReqRef.current) return;
        setMatched(row !== null);
      } catch {
        if (myReq === lastReqRef.current) setMatched(null);
      }
    })();
  }, [opening, lastFenKey]);
  return matched;
}
