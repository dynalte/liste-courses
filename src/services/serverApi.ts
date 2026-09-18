/**
 * Client API pour api-liste-courses.php.
 * Auth : token de session (header X-Session-Token) obtenu via register/login.
 * Même esprit que download-manager-ionic/src/services/serverApi.ts.
 */
import { Keys, setSetting, settings } from './settings';

export interface FamilyMember {
  id: number;
  email: string;
  name: string;
  role: 'owner' | 'member';
  createdAt: number;
}

export interface Family {
  id: number;
  name: string;
  inviteCode: string;
  members: FamilyMember[];
  /** Clé Gemini partagée (poussée aux apps à la connexion). */
  geminiKey: string;
  geminiModel: string;
}

export interface ShoppingItem {
  id: number;
  listId: number;
  name: string;
  qty: string;
  /** Rayon supermarché (auto-suggéré, modifiable). */
  rayon: string;
  checked: boolean;
  addedBy: number;
  addedByName: string;
  createdAt: number;
  updatedAt: number;
}

export interface ShoppingList {
  id: number;
  familyId: number;
  name: string;
  /** Modèle réutilisable (jamais clôturé). */
  isTemplate: boolean;
  /** Semaine clôturée (lecture seule). */
  archived: boolean;
  archivedAt: number;
  items: ShoppingItem[];
}

/** Événement du fil d'activité familiale (qui a fait quoi). */
export interface ActivityEvent {
  id: number;
  userId: number;
  actor: string;
  /** list_create | add | add_many | check | uncheck | edit | delete | clear */
  action: string;
  /** nom article, ou nombre pour add_many/clear */
  item: string;
  list: string;
  at: number;
}

function baseURL(): string {
  const b = settings.apiURL;
  if (!b) throw new Error('URL API manquante (Réglages).');
  return b;
}

export async function api<T = any>(action: string, body?: unknown, method?: string): Promise<T> {
  const res = await fetch(`${baseURL()}?action=${encodeURIComponent(action)}`, {
    method: method ?? (body ? 'POST' : 'GET'),
    headers: {
      'Content-Type': 'application/json',
      'X-Session-Token': settings.sessionToken,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`API : HTTP ${res.status}. ${txt.slice(0, 200)}`);
  }
  const data = (await res.json()) as { ok?: boolean; error?: string } & T;
  if (!data || data.ok !== true) throw new Error(`API : ${data?.error || 'réponse invalide'}.`);
  return data as T;
}

/** Appels publics (sans session) : register / login / join. */
export async function apiPublic<T = any>(action: string, body: unknown): Promise<T> {
  const res = await fetch(`${baseURL()}?action=${encodeURIComponent(action)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`API : HTTP ${res.status}.`);
  const data = (await res.json()) as { ok?: boolean; error?: string } & T;
  if (!data || data.ok !== true) throw new Error(`API : ${data?.error || 'réponse invalide'}.`);
  return data as T;
}

export const authApi = {
  register: (email: string, password: string, name: string, familyName: string) =>
    apiPublic<{ token: string; userId: number; family: Family }>('register', { email, password, name, familyName }),
  login: (email: string, password: string) =>
    apiPublic<{ token: string; userId: number; name: string }>('login', { email, password }),
  join: (email: string, password: string, name: string, inviteCode: string) =>
    apiPublic<{ token: string; userId: number; family: Family }>('join', { email, password, name, inviteCode }),
};

export const familyApi = {
  me: () => api<{ user: FamilyMember; family: Family }>('me'),
  rotateInvite: () => api<{ inviteCode: string }>('invite_rotate', {}),
  /** Clé IA partagée (owner). */
  setGemini: (key: string, model: string) => api<{ ok: boolean }>('family_set_gemini', { key, model }),
};

/**
 * Synchronise la clé Gemini familiale (appelée à la connexion + Réglages).
 * Le serveur gagne toujours (clé partagée) ; s'il est vide et que l'app
 * a une clé + rôle owner, on l'y pousse (amorçage initial).
 * Silencieux hors-ligne (garde la clé locale).
 */
export async function syncFamilyGemini(): Promise<boolean> {
  try {
    const { user, family } = await familyApi.me();
    const serverKey = (family.geminiKey || '').trim();
    const serverModel = (family.geminiModel || '').trim();
    if (serverKey !== '') {
      let changed = false;
      if (serverKey !== settings.geminiApiKey) {
        setSetting(Keys.geminiApiKey, serverKey);
        changed = true;
      }
      if (serverModel !== '' && serverModel !== settings.geminiModel) {
        setSetting(Keys.geminiModel, serverModel);
        changed = true;
      }
      return changed;
    }
    const localKey = settings.geminiApiKey;
    if (localKey !== '' && user.role === 'owner') {
      await familyApi.setGemini(localKey, settings.geminiModel);
      return false;
    }
    return false;
  } catch {
    return false;
  }
}

export interface NewItem {
  name: string;
  qty?: string;
  rayon?: string;
}

export const listsApi = {
  get: () => api<{ lists: ShoppingList[]; activity: ActivityEvent[]; you: number; youRole: string }>('lists_get'),
  create: (name: string) => api<{ list: ShoppingList }>('lists_create', { name }),
  /** Nouvelle semaine depuis un modèle/une archive (tous), ou modèle (owner). */
  duplicate: (listId: number, name?: string, asTemplate?: boolean) =>
    api<{ list: { id: number; isTemplate: boolean; copied: number } }>('lists_duplicate', { listId, name, asTemplate }),
  /** Clôturer / rouvrir (tous). */
  setArchived: (listId: number, archived: boolean) =>
    api<{ ok: boolean }>('lists_set_archived', { listId, archived }),
  /** Supprimer définitivement (owner). */
  deleteList: (listId: number) => api<{ ok: boolean }>('lists_delete', { listId }),
  addItem: (listId: number, name: string, qty: string, extra?: { rayon?: string }) =>
    api<{ item: ShoppingItem }>('items_add', { listId, name, qty, ...extra }),
  toggleItem: (itemId: number, checked: boolean) =>
    api<{ ok: boolean }>('items_toggle', { itemId, checked }),
  updateItem: (itemId: number, patch: { name?: string; qty?: string; rayon?: string }) =>
    api<{ ok: boolean }>('items_update', { itemId, ...patch }),
  deleteItem: (itemId: number) => api<{ ok: boolean }>('items_delete', { itemId }),
  /** Ajout en masse (ex : depuis l'analyse frigo IA). Retourne le nb ajouté. */
  addMany: (listId: number, names: Array<string | NewItem>) =>
    api<{ added: number }>('items_add_many', { listId, names }),
  clearChecked: (listId: number) => api<{ deleted: number }>('items_clear_checked', { listId }),
};
