/**
 * Client API pour api-liste-courses.php.
 * Auth : token de session (header X-Session-Token) obtenu via register/login.
 * Même esprit que download-manager-ionic/src/services/serverApi.ts.
 */
import { settings } from './settings';

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
}

export interface ShoppingItem {
  id: number;
  listId: number;
  name: string;
  qty: string;
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
  items: ShoppingItem[];
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
};

export const listsApi = {
  get: () => api<{ lists: ShoppingList[] }>('lists_get'),
  create: (name: string) => api<{ list: ShoppingList }>('lists_create', { name }),
  addItem: (listId: number, name: string, qty: string) =>
    api<{ item: ShoppingItem }>('items_add', { listId, name, qty }),
  toggleItem: (itemId: number, checked: boolean) =>
    api<{ ok: boolean }>('items_toggle', { itemId, checked }),
  deleteItem: (itemId: number) => api<{ ok: boolean }>('items_delete', { itemId }),
  /** Ajout en masse (ex : depuis l'analyse frigo IA). Retourne le nb ajouté. */
  addMany: (listId: number, names: Array<string | { name: string; qty?: string }>) =>
    api<{ added: number }>('items_add_many', { listId, names }),
  clearChecked: (listId: number) => api<{ deleted: number }>('items_clear_checked', { listId }),
};
