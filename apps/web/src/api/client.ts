import type { Color, DrillRules, ExplorerEntry, OpeningId } from '@chess-prep/shared';

export interface BookContinuation {
  san: string;
  childFenKey: string;
  opening: OpeningId | null;
}

const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:8787';

export interface RepertoireSummary {
  id: string;
  name: string;
  color: Color;
  tags: string[];
  drillRules: DrillRules;
  /** Phase 9c: silently auto-expand opponent replies while building. Off by default. */
  autoExpand: boolean;
  rootFenKey: string;
  rootFullFen: string;
  createdAt: string;
  updatedAt: string;
}

export interface RepertoirePosition {
  id: string;
  fenKey: string;
  fullFen: string;
}

export interface RepertoireMove {
  id: string;
  parentPositionId: string;
  childPositionId: string;
  parentFenKey: string;
  childFenKey: string;
  san: string;
  uci: string;
  comment: string | null;
  annotation: string | null;
  isMainLine: boolean;
  priority: number;
  /** Phase 7: walker skips dropped moves and their subtrees. */
  isDropped: boolean;
  /** Phase 9a: explicit line membership, inherited from the parent edge on insert. */
  lineTags: string[];
}

export interface RepertoireFull extends RepertoireSummary {
  positions: RepertoirePosition[];
  moves: RepertoireMove[];
}

export interface AddedMove {
  id: string;
  parentPositionId: string;
  childPositionId: string;
  parentFenKey: string;
  childFenKey: string;
  san: string;
  uci: string;
  comment: string | null;
  annotation: string | null;
  isMainLine: boolean;
  priority: number;
  isDropped: boolean;
  lineTags: string[];
  childPositionCreated: boolean;
}

export interface OpeningListItem {
  id: string;
  eco: string;
  name: string;
  variation: string | null;
  fenKey: string;
  fullFen: string;
  pgnMoves: string;
}

export interface UserSettings {
  userId: string;
  newCardsPerDay: number;
  dailyDietLastResetAt: string;
  updatedAt: string;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(
  path: string,
  init?: RequestInit & { expectNoContent?: boolean },
): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = await res.json();
      if (body && typeof body.error === 'string') message = body.error;
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, message);
  }
  if (init?.expectNoContent) return undefined as T;
  if (res.status === 204) return undefined as T;
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.startsWith('application/json')) return (await res.json()) as T;
  return (await res.text()) as T;
}

export const api = {
  listRepertoires(): Promise<RepertoireSummary[]> {
    return request('/repertoires');
  },

  createRepertoire(input: {
    name: string;
    color: Color;
    tags?: string[];
    /** Phase 7: SANs auto-inserted from the root (the chosen opening's prefix). */
    seedSans?: string[];
  }): Promise<RepertoireSummary> {
    return request('/repertoires', { method: 'POST', body: JSON.stringify(input) });
  },

  getRepertoire(id: string): Promise<RepertoireFull> {
    return request(`/repertoires/${id}`);
  },

  patchRepertoire(
    id: string,
    input: { name?: string; tags?: string[]; autoExpand?: boolean },
  ): Promise<RepertoireSummary> {
    return request(`/repertoires/${id}`, { method: 'PATCH', body: JSON.stringify(input) });
  },

  deleteRepertoire(id: string): Promise<void> {
    return request(`/repertoires/${id}`, { method: 'DELETE', expectNoContent: true });
  },

  addMove(
    repertoireId: string,
    input: {
      parentFenKey: string;
      san: string;
      isMainLine?: boolean;
      /** Phase 7: how to handle a conflicting existing prep move at this user-turn position. */
      onConflict?: 'refuse' | 'swap';
    },
  ): Promise<AddedMove> {
    return request(`/repertoires/${repertoireId}/moves`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  patchMove(
    repertoireId: string,
    moveId: string,
    input: {
      comment?: string | null;
      annotation?: string | null;
      isMainLine?: boolean;
      priority?: number;
      /** Phase 7: mark/unmark a branch as "won't cover" — walker skips dropped moves. */
      isDropped?: boolean;
      /**
       * Phase 9a: retag this edge. Cascades down the subtree server-side,
       * because retagging re-roots inheritance.
       */
      lineTags?: string[];
    },
  ): Promise<void> {
    return request(`/repertoires/${repertoireId}/moves/${moveId}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
      expectNoContent: true,
    });
  },

  deleteMove(repertoireId: string, moveId: string): Promise<void> {
    return request(`/repertoires/${repertoireId}/moves/${moveId}`, {
      method: 'DELETE',
      expectNoContent: true,
    });
  },

  appendLine(
    repertoireId: string,
    input: {
      fromFenKey: string;
      sans: string[];
      /** Phase 7: how to handle a conflicting existing prep at any user-turn parent in this line. */
      onConflict?: 'refuse' | 'swap';
    },
  ): Promise<{ added: number; reused: number; finalFenKey: string }> {
    return request(`/repertoires/${repertoireId}/moves/batch`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  importPgn(input: {
    name: string;
    color: Color;
    pgn: string;
    tags?: string[];
    startFen?: string;
  }): Promise<RepertoireFull> {
    return request('/repertoires/import', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  exportPgn(repertoireId: string): Promise<string> {
    return request(`/repertoires/${repertoireId}/export`);
  },

  patchDrillRules(repertoireId: string, rules: DrillRules): Promise<RepertoireSummary> {
    return request(`/repertoires/${repertoireId}/drill-rules`, {
      method: 'PATCH',
      body: JSON.stringify(rules),
    });
  },

  /* ---------------- openings ---------------- */

  listOpenings(input: { q?: string; eco?: string; limit?: number } = {}): Promise<OpeningListItem[]> {
    const params = new URLSearchParams();
    if (input.q) params.set('q', input.q);
    if (input.eco) params.set('eco', input.eco);
    if (input.limit) params.set('limit', String(input.limit));
    const qs = params.toString();
    return request(`/openings${qs ? `?${qs}` : ''}`);
  },

  getOpeningByFenKey(fenKey: string): Promise<OpeningListItem | null> {
    return request<OpeningListItem>(`/openings/by-fen/${encodeURIComponent(fenKey)}`).catch(
      (e) => {
        if (e instanceof ApiError && e.status === 404) return null;
        throw e;
      },
    );
  },

  /**
   * Phase 9a: bulk name lookup for a whole repertoire, cached client-side so
   * opening-name scope filtering keeps working offline.
   */
  lookupOpeningsByFenKeys(fenKeys: string[]): Promise<{ openings: Record<string, OpeningId> }> {
    return request('/openings/by-fens', {
      method: 'POST',
      body: JSON.stringify({ fenKeys }),
    });
  },

  identifyDeepestOpening(fenKeys: string[]): Promise<{ opening: OpeningId | null }> {
    return request('/openings/identify-deepest', {
      method: 'POST',
      body: JSON.stringify({ fenKeys }),
    });
  },

  /**
   * Phase 7: known book moves out of a position, each labeled with the opening
   * name of the child position (when that child is itself a named entry).
   * Used by the guided builder's "What's your move?" / "Which responses?" prompts.
   */
  getBookContinuations(fenKey: string): Promise<BookContinuation[]> {
    return request(`/openings/continuations/${encodeURIComponent(fenKey)}`);
  },

  /* ---------------- opening explorer (Phase 9b) ---------------- */

  /**
   * Explorer statistics for a position, read through the server's cache.
   * `entry` is `null` when nothing is cached and lichess is unreachable — that
   * is a normal outcome, not an error: fall back to book continuations.
   */
  getExplorerEntry(
    fenKey: string,
    opts: { cachedOnly?: boolean } = {},
  ): Promise<{ entry: ExplorerEntry | null; source: string; backoffMs: number }> {
    const qs = opts.cachedOnly ? '?cachedOnly=1' : '';
    return request(`/explorer/${encodeURIComponent(fenKey)}${qs}`);
  },

  /* ---------------- user settings (Phase 8a) ---------------- */

  getUserSettings(): Promise<UserSettings> {
    return request('/settings');
  },

  patchUserSettings(input: { newCardsPerDay?: number }): Promise<UserSettings> {
    return request('/settings', {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
  },
};
