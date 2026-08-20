import { create } from 'zustand';
import {
  api,
  ApiError,
  type RepertoireFull,
  type RepertoireSummary,
} from '../api/client.ts';
import type { Color, DrillMode, DrillRules } from '@chess-prep/shared';
import { putRepertoireLocal } from '../lib/idb/schema.ts';

export type View =
  | { kind: 'list' }
  | { kind: 'browse' }
  | { kind: 'editor'; repertoireId: string }
  | { kind: 'drill-setup'; repertoireId: string }
  | { kind: 'drill-session'; repertoireId: string; mode: DrillMode }
  // Phase 7: unified Build/Drill walker. `seed` decides which queue the walker
  // pulls from; the per-node UX is identical.
  | { kind: 'walker-session'; repertoireId: string; seed: 'build' | 'drill' }
  // Phase 8a: daily diet — mixed session across all repertoires for a side.
  | { kind: 'daily' }
  | { kind: 'health-check'; repertoireId: string };

interface AppStore {
  view: View;
  repertoires: RepertoireSummary[];
  active: RepertoireFull | null;
  loading: boolean;
  error: string | null;

  go(view: View): void;
  loadList(): Promise<void>;
  createRepertoire(input: {
    name: string;
    color: Color;
    tags?: string[];
    seedSans?: string[];
  }): Promise<string>;
  importPgn(input: {
    name: string;
    color: Color;
    pgn: string;
    tags?: string[];
  }): Promise<string>;
  renameRepertoire(id: string, name: string): Promise<void>;
  deleteRepertoire(id: string): Promise<void>;
  /** Load a repertoire into `active` WITHOUT changing the view (router/deep links). */
  loadRepertoire(id: string): Promise<void>;
  openRepertoire(id: string): Promise<void>;
  reloadActive(): Promise<void>;

  addMove(parentFenKey: string, san: string, isMainLine?: boolean): Promise<void>;
  setComment(moveId: string, comment: string | null): Promise<void>;
  setAnnotation(moveId: string, annotation: string | null): Promise<void>;
  setMainLine(moveId: string, isMainLine: boolean): Promise<void>;
  setPriority(moveId: string, priority: number): Promise<void>;
  deleteMove(moveId: string): Promise<void>;

  exportPgn(id: string): Promise<string>;
  patchDrillRules(id: string, rules: DrillRules): Promise<void>;
  clearError(): void;
}

function asError(e: unknown): string {
  if (e instanceof ApiError) return `${e.status}: ${e.message}`;
  if (e instanceof Error) return e.message;
  return 'Unknown error';
}

export const useAppStore = create<AppStore>((set, get) => ({
  view: { kind: 'list' },
  repertoires: [],
  active: null,
  loading: false,
  error: null,

  go(view) {
    set({ view });
    if (view.kind === 'list') {
      set({ active: null });
    }
  },

  async loadList() {
    set({ loading: true, error: null });
    try {
      const repertoires = await api.listRepertoires();
      set({ repertoires });
    } catch (e) {
      set({ error: asError(e) });
    } finally {
      set({ loading: false });
    }
  },

  async createRepertoire(input) {
    const created = await api.createRepertoire(input);
    await get().loadList();
    return created.id;
  },

  async importPgn(input) {
    const created = await api.importPgn(input);
    await get().loadList();
    return created.id;
  },

  async renameRepertoire(id, name) {
    await api.patchRepertoire(id, { name });
    await get().loadList();
    if (get().active?.id === id) await get().reloadActive();
  },

  async deleteRepertoire(id) {
    await api.deleteRepertoire(id);
    if (get().active?.id === id) {
      set({ active: null, view: { kind: 'list' } });
    }
    await get().loadList();
  },

  async loadRepertoire(id) {
    set({ loading: true, error: null });
    try {
      const full = await api.getRepertoire(id);
      set({ active: full });
      // Cache for offline use.
      void putRepertoireLocal(full);
    } catch (e) {
      set({ error: asError(e) });
      throw e;
    } finally {
      set({ loading: false });
    }
  },

  async openRepertoire(id) {
    try {
      await get().loadRepertoire(id);
      set({ view: { kind: 'editor', repertoireId: id } });
    } catch {
      /* error already surfaced by loadRepertoire */
    }
  },

  async reloadActive() {
    const id = get().active?.id;
    if (!id) return;
    const full = await api.getRepertoire(id);
    set({ active: full });
    void putRepertoireLocal(full);
  },

  async addMove(parentFenKey, san, isMainLine) {
    const active = get().active;
    if (!active) return;
    try {
      // Auto-mainline if no existing main-line child at this parent.
      let effectiveIsMainLine = isMainLine ?? false;
      if (isMainLine === undefined) {
        const parent = active.positions.find((p) => p.fenKey === parentFenKey);
        if (parent) {
          const hasMainLine = active.moves.some(
            (m) => m.parentPositionId === parent.id && m.isMainLine,
          );
          effectiveIsMainLine = !hasMainLine;
        }
      }
      await api.addMove(active.id, { parentFenKey, san, isMainLine: effectiveIsMainLine });
      await get().reloadActive();
    } catch (e) {
      set({ error: asError(e) });
    }
  },

  async setComment(moveId, comment) {
    const active = get().active;
    if (!active) return;
    await api.patchMove(active.id, moveId, { comment });
    await get().reloadActive();
  },

  async setAnnotation(moveId, annotation) {
    const active = get().active;
    if (!active) return;
    await api.patchMove(active.id, moveId, { annotation });
    await get().reloadActive();
  },

  async setMainLine(moveId, isMainLine) {
    const active = get().active;
    if (!active) return;
    await api.patchMove(active.id, moveId, { isMainLine });
    await get().reloadActive();
  },

  async setPriority(moveId, priority) {
    const active = get().active;
    if (!active) return;
    await api.patchMove(active.id, moveId, { priority });
    await get().reloadActive();
  },

  async deleteMove(moveId) {
    const active = get().active;
    if (!active) return;
    await api.deleteMove(active.id, moveId);
    await get().reloadActive();
  },

  async exportPgn(id) {
    return api.exportPgn(id);
  },

  async patchDrillRules(id, rules) {
    await api.patchDrillRules(id, rules);
    await get().loadList();
    if (get().active?.id === id) await get().reloadActive();
  },

  clearError() {
    set({ error: null });
  },
}));
