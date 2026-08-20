/**
 * Phase 9a line scopes — "drill only this line" as a *predicate*, not a stored
 * object.
 *
 * A line is never copied out of the tree: a copy would drift from the tree it
 * was cut from, and the drift is silent (the copy keeps drilling moves the user
 * has since changed). Instead a scope is evaluated at queue-build time against
 * two facts about each candidate move:
 *
 *  - **derived** — the deepest ECO name along the move's path (zero authoring
 *    cost; the book already names "Caro-Kann Defense: Advance Variation").
 *  - **explicit** — `moves.line_tags`, inherited from the parent edge on insert,
 *    for what the book cannot express (`vs-danny`, `blitz-only`).
 *
 * Pure logic, shared by client and server: the queue builders filter with it and
 * the API validates scopes with `parseLineScope`.
 */
import type { OpeningId } from './openings.js';

export type LineScopeKind = 'all' | 'openingName' | 'tag';

export interface LineScope {
  kind: LineScopeKind;
  /** Required for 'openingName' and 'tag'; ignored for 'all'. */
  value?: string;
}

export const ALL_LINES: LineScope = { kind: 'all' };

/**
 * Render an `OpeningId` back into the book's full name form
 * ("Caro-Kann Defense: Advance Variation"), which is what scopes match on.
 */
export function fullOpeningName(id: OpeningId | null | undefined): string | null {
  if (!id) return null;
  return id.variation ? `${id.name}: ${id.variation}` : id.name;
}

/**
 * Prefix match on the book's full name, at a **name boundary**.
 *
 * Boundary-aware so the scope "Caro-Kann Defense" catches every one of its
 * variations without also catching an unrelated opening that merely starts with
 * the same words. Only `:` and `,` count as boundaries — the two separators
 * lichess uses — because a bare space would make "Sicilian Defense" match
 * "Sicilian Defense Deferred"-style siblings the user did not ask for.
 */
export function matchesOpeningName(
  deepest: OpeningId | null | undefined,
  value: string,
): boolean {
  const full = fullOpeningName(deepest);
  if (!full) return false;
  const needle = value.trim().toLowerCase();
  if (!needle) return false;
  const hay = full.toLowerCase();
  if (hay === needle) return true;
  if (!hay.startsWith(needle)) return false;
  const next = hay.charAt(needle.length);
  return next === ':' || next === ',';
}

/** Tags are compared case-insensitively and whitespace-trimmed. */
export function normalizeLineTag(tag: string): string {
  return tag.trim().toLowerCase();
}

export interface LineScopeContext {
  /** Deepest book match along this move's path from the repertoire root. */
  deepestOpening: OpeningId | null;
  /** The move's own `lineTags` (already inherited at insert time). */
  lineTags: readonly string[];
}

/**
 * Does a move belong to the scoped line?
 *
 * An unknown `kind`, or a kind that needs a value and has none, matches
 * everything — a malformed scope must not silently empty a session.
 */
export function matchesLineScope(
  scope: LineScope | null | undefined,
  ctx: LineScopeContext,
): boolean {
  if (!scope || scope.kind === 'all') return true;
  const value = scope.value?.trim();
  if (!value) return true;
  switch (scope.kind) {
    case 'openingName':
      return matchesOpeningName(ctx.deepestOpening, value);
    case 'tag': {
      const needle = normalizeLineTag(value);
      return ctx.lineTags.some((t) => normalizeLineTag(t) === needle);
    }
    default:
      return true;
  }
}

/**
 * Tag inheritance on insert.
 *
 * A new move copies the parent edge's tags unless the caller supplies its own,
 * in which case the supplied set **replaces** the inherited one and re-roots
 * inheritance for the subtree below it.
 *
 * The failure mode inheritance prevents is silent: without it, moves added
 * below a tagged branch point are born untagged, so a tag-scoped session
 * quietly omits exactly the moves that were just added — a session that looks
 * complete and is not.
 */
export function inheritLineTags(
  parentTags: readonly string[] | null | undefined,
  explicit?: readonly string[] | null,
): string[] {
  const source = explicit ?? parentTags ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of source) {
    if (typeof raw !== 'string') continue;
    const tag = raw.trim();
    if (!tag) continue;
    const key = normalizeLineTag(tag);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

/**
 * Validate an untrusted scope (API body / stored jsonb). Returns `undefined`
 * for absent input; throws `Error` with a message the API turns into a 400.
 */
export function parseLineScope(raw: unknown): LineScope | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object') throw new Error('scope must be an object');
  const { kind, value } = raw as { kind?: unknown; value?: unknown };
  if (kind !== 'all' && kind !== 'openingName' && kind !== 'tag') {
    throw new Error("scope.kind must be 'all' | 'openingName' | 'tag'");
  }
  if (kind === 'all') return { kind: 'all' };
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`scope.value is required for kind '${kind}'`);
  }
  return { kind, value: value.trim() };
}
