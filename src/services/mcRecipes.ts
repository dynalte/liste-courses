/**
 * Import de recettes Monsieur Cuisine → ingrédients.
 * Le PHP (action mc_recipe) appelle le proxy-api MC avec le cookie Lidl Plus
 * (fourni à chaque appel, jamais stocké serveur) et renvoie les ingrédients
 * structurés. Ici : types + appel + aide à la saisie.
 */
import { api } from './serverApi';
import { settings } from './settings';
import { Browser } from '@capacitor/browser';
import { Capacitor } from '@capacitor/core';

export interface McIngredient {
  name: string;
  qty: string;
  optional: boolean;
}

export interface McIngredientGroup {
  name: string;
  items: McIngredient[];
}

/** Détail cuisson structuré (icônes façon site MC). time en secondes. */
export interface McCookDetail {
  mode: string;
  label: string;
  temperature: number | null;
  time: number | null;
  speed: number | null;
  weight: number | null;
  reverse: boolean | null;
  turbo: boolean;
}

export interface McRecipeStep {
  order: number;
  name: string;
  text: string;
  /** Ligne de cuisson MC (compat) : "Saisir · 130 °C · 4 min · Vitesse 1". */
  cook: string;
  cookDetail?: McCookDetail | null;
}

export interface McRecipe {
  id: string;
  title: string;
  servings: string;
  /** Pitch / texte de présentation de la recette (description MC). */
  pitch?: string;
  /** Difficulté ("Facile"...) + durées en minutes (0 = inconnue). */
  complexity?: string;
  prepMin?: number;
  totalMin?: number;
  groups: McIngredientGroup[];
  steps: McRecipeStep[];
  image: string;
}

export interface McSearchResult {
  id: string;
  name: string;
  image: string;
  complexity: string;
  prep: number;
  duration: number;
  rating: number;
  ratings: number;
  categories: string[];
  url: string;
}

export interface McSearchPage {
  total: number;
  totalPage: number;
  currentPage: number;
  recipes: McSearchResult[];
}

export type McSort = 'new' | 'popular' | 'top';

export interface McCategory {
  id: string;
  name: string;
}

/** Catégories du catalogue MC (cache serveur 7 j). */
export async function fetchMcCategories(): Promise<McCategory[]> {
  const r = await api<{ categories: McCategory[] }>('mc_categories', { lang: 'fr-FR' });
  if (!r || !Array.isArray(r.categories)) throw new Error('Catégories illisibles.');
  return r.categories;
}

/** Catalogue public MC : recherche (q vide = nouveautés). Sans cookie. */
export async function searchMcRecipes(q: string, page = 1, sort: McSort = 'new', categories: string[] = []): Promise<McSearchPage> {
  const r = await api<McSearchPage>('mc_search', { q: q.trim(), page, lang: 'fr-FR', sort, categories });
  if (!r || !Array.isArray(r.recipes)) throw new Error('Catalogue illisible.');
  return r;
}

/** Extrait l'ID numérique d'une URL (...?recipe-id=123) ou d'une saisie brute. */
export function extractMcId(input: string): string | null {
  const v = input.trim();
  if (/^\d{1,12}$/.test(v)) return v;
  try {
    const u = new URL(v);
    const cand = u.searchParams.get('recipe-id') ?? u.searchParams.get('recipeId') ?? '';
    if (/^\d{1,12}$/.test(cand)) return cand;
  } catch {
    /* pas une URL */
  }
  return null;
}

/** Charge une recette MC : catalogue public, + brouillons privés si cookie présent. */
export async function fetchMcRecipe(input: string): Promise<McRecipe> {
  const cookie = settings.mcCookie;
  const id = extractMcId(input);
  const r = await api<{ recipe: McRecipe }>('mc_recipe', {
    recipeId: id ?? '',
    url: id ? '' : input.trim(),
    cookie,
    lang: 'fr-FR',
    // Clé IA transmise à chaque appel (jamais stockée serveur) : sert à
    // nommer les ingrédients perso absents du référentiel MC.
    geminiKey: settings.geminiApiKey,
    geminiModel: settings.geminiModel,
  });
  if (!r.recipe || !Array.isArray(r.recipe.groups)) {
    throw new Error('Recette illisible.');
  }
  return r.recipe;
}

/** Valide la session MC seule (distingue cookie invalide / recette introuvable). */
export async function testMcSession(cookie?: string): Promise<string> {
  const c = (cookie ?? settings.mcCookie).trim();
  if (!c) throw new Error('Cookie MC manquant.');
  const r = await api<{ user: string }>('mc_session', { cookie: c, lang: 'fr-FR' });
  return r.user || 'OK';
}

/**
 * Ouvre la connexion MC (SSO Lidl) dans le navigateur : l'utilisateur s'y
 * connecte avec son email/mot de passe (vrai formulaire, captcha OK).
 * Après connexion, il recopie le cookie dans Réglages (session longue durée).
 * Note : le login_hint est transmis s'il est propagé par le SSO, sinon
 * le navigateur pré-remplit généralement l'email tout seul.
 */
export async function openMcLogin(): Promise<void> {
  const base = 'https://www.monsieur-cuisine.com/fr/sso/login';
  const redirect = 'https://www.monsieur-cuisine.com/fr/create-recipe';
  const url = `${base}?redirect_uri=${encodeURIComponent(redirect)}`;
  // login_hint ajouté côté Lidl après la 1re redirection : on le passe ici,
  // le SSO le propage (même astuce que smart-recipe).
  const email = settings.mcEmail;
  const target = email ? `${url}&login_hint=${encodeURIComponent(email)}` : url;
  if (Capacitor.isNativePlatform()) {
    await Browser.open({ url: target });
  } else {
    window.open(target, '_blank', 'noopener');
  }
}
