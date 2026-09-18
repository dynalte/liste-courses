/**
 * Synchronisation temps réel (polling) + résumés d'activité en français.
 *
 * iOS suspend le JS en arrière-plan : on interroge toutes les 10 s quand
 * l'app est ouverte + immédiatement au retour avant-plan (resume/visible).
 * Les événements des autres membres déclenchent un toast (1er plan) et,
 * au retour d'arrière-plan, une notification locale.
 */
import { useEffect, useRef } from 'react';
import { App as CapApp } from '@capacitor/app';
import { listsApi, type ActivityEvent } from './serverApi';

export const SYNC_INTERVAL_MS = 10000;

/** "Marie a ajouté Lait (2)" / "Paul a coché Oeufs" — max 3, puis "+N". */
export function summarizeActivity(events: ActivityEvent[]): string {
  const verbs: Record<string, (e: ActivityEvent) => string> = {
    list_create: (e) => `a créé la liste ${e.list}`,
    add: (e) => `a ajouté ${e.item}`,
    add_many: (e) => `a ajouté ${e.item} article(s)${e.list ? ` (${e.list})` : ''}`,
    check: (e) => `a coché ${e.item}`,
    uncheck: (e) => `a décoché ${e.item}`,
    edit: (e) => `a modifié ${e.item}`,
    delete: (e) => `a supprimé ${e.item}`,
    clear: (e) => `a effacé ${e.item} article(s) coché(s)`,
    duplicate: (e) => `a créé ${e.item}${e.list ? ` depuis ${e.list}` : ''}`,
    template: (e) => `a enregistré le modèle ${e.item}`,
    archive: (e) => `a clôturé ${e.item}`,
    unarchive: (e) => `a rouvert ${e.item}`,
    delete_list: (e) => `a supprimé la liste ${e.item}`,
  };
  const lines = events.slice(0, 3).map((e) => {
    const fn = verbs[e.action] ?? ((x: ActivityEvent) => `a modifié ${x.item}`);
    return `${e.actor} ${fn(e)}`;
  });
  if (events.length > 3) lines.push(`+${events.length - 3} autre(s)`);
  return lines.join(' • ');
}

interface SyncData {
  activity: ActivityEvent[];
  you: number;
  youRole: string;
}

interface SyncOptions {
  enabled: boolean;
  /** Pause le tick (ex : saisie/IA en cours). */
  paused: () => boolean;
  /** Requête réseau (lists_get suffit : listes + activity + you). */
  fetcher: () => Promise<SyncData & { lists: unknown[] }>;
  /** Appelé avec les événements des AUTRES membres (jamais au 1er chargement). */
  onRemote: (events: ActivityEvent[], fromResume: boolean) => void;
  /** Appelé à chaque réponse (pour rafraîchir les listes). */
  onData?: (data: SyncData & { lists: unknown[] }) => void;
}

/**
 * Retourne un déclencheur manuel (pull-to-refresh) partageant le même
 * curseur "vu" que le polling (pas de double toast).
 */
export function useRemoteSync(opts: SyncOptions): { checkNow: (fromResume: boolean) => Promise<void> } {
  const lastSeen = useRef(0);
  const primed = useRef(false);
  const state = useRef(opts);
  state.current = opts;

  async function tick(fromResume: boolean): Promise<void> {
    const o = state.current;
    if (!o.enabled || o.paused()) return;
    let data: SyncData & { lists: unknown[] };
    try {
      data = await o.fetcher();
    } catch {
      return; // réseau coupé : silencieux, le prochain tick réessaie
    }
    o.onData?.(data);
    const mine = data.you;
    const fresh = (data.activity ?? [])
      .filter((e) => e.id > lastSeen.current && e.userId !== mine)
      .sort((a, b) => a.id - b.id);
    lastSeen.current = Math.max(lastSeen.current, ...data.activity.map((e) => e.id), 0);
    if (!primed.current) {
      primed.current = true;
      return; // 1er chargement : amorce le curseur, pas de toast
    }
    if (fresh.length > 0) o.onRemote(fresh, fromResume);
  }

  useEffect(() => {
    if (!opts.enabled) return;
    let stopped = false;
    const id = setInterval(() => {
      if (stopped || document.hidden) return;
      void tick(false);
    }, SYNC_INTERVAL_MS);
    const onVisible = () => {
      if (!document.hidden) void tick(false);
    };
    document.addEventListener('visibilitychange', onVisible);
    let resumeSub: { remove: () => void } | null = null;
    CapApp.addListener('appStateChange', ({ isActive }) => {
      if (isActive) void tick(true);
    }).then((s) => {
      resumeSub = s;
    }).catch(() => {});
    void tick(false); // vérif immédiate à l'ouverture de l'onglet
    return () => {
      stopped = true;
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
      resumeSub?.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.enabled]);

  return { checkNow: (fromResume: boolean) => tick(fromResume) };
}
