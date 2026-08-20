/**
 * Read-only SAN move list for the current line — the orientation aid for
 * walker / drill sessions. Shows numbered moves ("1.e4 e6 2.d4 …") with the
 * last move highlighted, so the user always knows which branch they're in
 * even when the session jumps between positions.
 */
export function MoveLine({
  sans,
  className = '',
}: {
  sans: string[];
  className?: string;
}) {
  if (sans.length === 0) {
    return (
      <p className={`text-xs text-slate-500 ${className}`}>Starting position</p>
    );
  }
  return (
    <ol className={`flex flex-wrap gap-x-2 gap-y-1 text-xs font-mono ${className}`}>
      {sans.map((san, i) => (
        <li
          key={`${i}-${san}`}
          className={i === sans.length - 1 ? 'text-emerald-300 font-semibold' : 'text-slate-300'}
        >
          {i % 2 === 0 ? `${Math.floor(i / 2) + 1}.` : ''}
          {san}
        </li>
      ))}
    </ol>
  );
}
