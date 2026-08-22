/**
 * Flow F1: the line navigator's data — every named line and tag actually
 * present in a repertoire, with per-line badges (due / cards / to-build /
 * recent misses).
 *
 * The entries are built FROM the queue builder's own candidates
 * (`collectDrillCandidates`), so an entry's `dueCount` is by construction the
 * length of the 'due' queue its Start button launches. Re-deriving the counts
 * here would let them drift from the session — a navigator that promises "11
 * due" and starts a 9-card session teaches the user to distrust every badge.
 *
 * Exclusions mirror the queue builders and the walker: dropped moves and
 * Phase 9d refutation shadow edges contribute nothing.
 */
import {
  ALL_LINES,
  fullOpeningName,
  matchesLineScope,
  mergeDrillRules,
  rankMistakes,
  type DrillAttemptDto,
  type LineScope,
  type LineScopeContext,
  type SrsCardDto,
} from '@chess-prep/shared';
import type { RepertoireFull } from '../../api/client.ts';
import { collectDrillCandidates } from '../drill/queue.ts';
import { buildDeepestOpeningIndex, type OpeningLookup } from '../openings/pathNames.ts';
import type { WalkerIndices } from '../walker/walker.ts';

export interface LineNavEntry {
  /** The scope a Start button on this row launches the session with. */
  scope: LineScope;
  /** Display label: the name segment below its parent ("Advance Variation"). */
  label: string;
  /** Nesting depth in the navigator hierarchy; 0 for top-level rows. */
  depth: number;
  /** Cards due right now under this line — the 'due' queue length. */
  dueCount: number;
  /** All cards under this line (due or not). */
  cardCount: number;
  /** Build-attention nodes (walker TODO) inside this line. */
  toBuild: number;
  /** Moves in this line with recent-mistake ranking (Phase 9d window). */
  recentMisses: number;
}

export interface BuildLineIndexArgs {
  repertoire: RepertoireFull;
  indices: WalkerIndices;
  openingLookup: OpeningLookup;
  cards: SrsCardDto[];
  attempts?: readonly DrillAttemptDto[];
  now?: Date;
}

/**
 * Aggregate the repertoire into navigator rows: "All" first, then opening-name
 * entries in hierarchical order, then tag entries.
 */
export function buildLineIndex(args: BuildLineIndexArgs): LineNavEntry[] {
  const { repertoire, indices, openingLookup, cards, attempts = [], now = new Date() } = args;

  // The stored rules' depth/branching filters apply to any session started from
  // here, so they apply to the counts too — but the stored SCOPE does not: the
  // navigator exists to replace it with a per-session choice.
  const rules = { ...mergeDrillRules(repertoire.drillRules), scope: ALL_LINES };
  const candidates = collectDrillCandidates({
    repertoire,
    cards,
    rules,
    openingLookup,
    withOpeningNames: true,
  });

  const ranked = new Set(rankMistakes(attempts, { now }).map((m) => m.moveId));
  const nowMs = now.getTime();
  const attention = collectAttentionNodes(repertoire, indices, openingLookup);

  function countsFor(scope: LineScope) {
    let dueCount = 0;
    let cardCount = 0;
    let recentMisses = 0;
    for (const c of candidates) {
      if (!matchesLineScope(scope, c.scopeCtx)) continue;
      cardCount++;
      if (new Date(c.card.due).getTime() <= nowMs) dueCount++;
      if (ranked.has(c.move.id)) recentMisses++;
    }
    let toBuild = 0;
    for (const a of attention) {
      // Mirror `findNextBuildNode`: under a non-'all' scope, a node with no
      // in-edge (the root) is never offered, whatever its name.
      if (scope.kind !== 'all' && !a.hasInEdge) continue;
      if (matchesLineScope(scope, a.ctx)) toBuild++;
    }
    return { dueCount, cardCount, toBuild, recentMisses };
  }

  const entries: LineNavEntry[] = [];

  // "All" — the un-scoped session. Attention counting differs from the scoped
  // rows: under 'all' the walker CAN offer the root and other edge-less spots
  // (no in-edge needed), so count every attention node.
  entries.push({
    scope: ALL_LINES,
    label: 'All lines',
    depth: 0,
    ...countsFor(ALL_LINES),
  });

  // Opening-name entries: names actually present (deepest name at any live
  // position), expanded with their boundary prefixes so the hierarchy always
  // has its parents, then sorted — string order puts a prefix directly above
  // the names it contains.
  const names = new Set<string>();
  for (const c of candidates) {
    const full = fullOpeningName(c.scopeCtx.deepestOpening);
    if (full) for (const p of namePrefixes(full)) names.add(p);
  }
  for (const a of attention) {
    if (!a.hasInEdge) continue;
    const full = fullOpeningName(a.ctx.deepestOpening);
    if (full) for (const p of namePrefixes(full)) names.add(p);
  }
  const sortedNames = [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const name of sortedNames) {
    const prefixes = namePrefixes(name);
    const parent = prefixes.length > 1 ? prefixes[prefixes.length - 2]! : null;
    entries.push({
      scope: { kind: 'openingName', value: name },
      label: parent ? segmentAfter(name, parent) : name,
      depth: prefixes.length - 1,
      ...countsFor({ kind: 'openingName', value: name }),
    });
  }

  // Tag entries: one per distinct tag on live prep edges, case-insensitive,
  // first-seen casing wins for display.
  const tags = new Map<string, string>();
  for (const moves of indices.movesByParent.values()) {
    for (const m of moves) {
      if (m.isDropped) continue;
      for (const t of m.lineTags ?? []) {
        const key = t.trim().toLowerCase();
        if (key && !tags.has(key)) tags.set(key, t.trim());
      }
    }
  }
  for (const [, tag] of [...tags.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    entries.push({
      scope: { kind: 'tag', value: tag },
      label: tag,
      depth: 0,
      ...countsFor({ kind: 'tag', value: tag }),
    });
  }

  return entries;
}

/**
 * Attention nodes (positions the build walker would stop at) with the scope
 * context of the edge that reaches them — mirroring `findNextBuildNode`: a
 * node is in a scoped line when its IN-edge is, and under a non-'all' scope
 * the root (which has no in-edge) is never offered.
 */
function collectAttentionNodes(
  rep: RepertoireFull,
  indices: WalkerIndices,
  openingLookup: OpeningLookup,
): Array<{ ctx: LineScopeContext; hasInEdge: boolean }> {
  const deepest = buildDeepestOpeningIndex(rep, openingLookup);
  const out: Array<{ ctx: LineScopeContext; hasInEdge: boolean }> = [];
  const root = indices.positionByKey.get(rep.rootFenKey);
  if (!root) return out;
  type Step = { posId: string; inEdgeTags: readonly string[] | null };
  const queue: Step[] = [{ posId: root.id, inEdgeTags: null }];
  const visited = new Set<string>([root.id]);
  while (queue.length > 0) {
    const { posId, inEdgeTags } = queue.shift()!;
    const liveOut = (indices.movesByParent.get(posId) ?? []).filter((m) => !m.isDropped);
    if (liveOut.length === 0) {
      out.push({
        ctx: {
          deepestOpening: deepest.get(posId) ?? null,
          lineTags: inEdgeTags ?? [],
        },
        hasInEdge: inEdgeTags !== null,
      });
      continue;
    }
    for (const m of liveOut) {
      if (visited.has(m.childPositionId)) continue;
      visited.add(m.childPositionId);
      queue.push({ posId: m.childPositionId, inEdgeTags: m.lineTags ?? [] });
    }
  }
  return out;
}

/**
 * Boundary prefixes of a full book name, shortest first, self included:
 * "A: B, C" → ["A", "A: B", "A: B, C"]. Boundaries are the `:` and `,`
 * separators `matchesOpeningName` recognizes, so every prefix is a scope value
 * that catches the full name.
 */
export function namePrefixes(full: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < full.length; i++) {
    const ch = full.charAt(i);
    if (ch === ':' || ch === ',') {
      const prefix = full.slice(0, i);
      if (prefix.trim()) out.push(prefix);
    }
  }
  out.push(full);
  return out;
}

/** The display segment of `name` below `parent`: strip the parent + separator. */
function segmentAfter(name: string, parent: string): string {
  return name.slice(parent.length).replace(/^[:,]\s*/, '');
}
