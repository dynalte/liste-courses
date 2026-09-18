/**
 * Réglages persistés (localStorage) : URL API PHP + session + clé Gemini.
 * Même pattern que download-manager-ionic/src/services/settings.ts.
 */
export const Keys = {
  apiURL: 'courses_api_url',
  sessionToken: 'courses_session_token',
  userEmail: 'courses_user_email',
  userName: 'courses_user_name',
  geminiApiKey: 'courses_gemini_api_key',
  geminiModel: 'courses_gemini_model',
  /** Email Lidl Plus (pré-remplit la page de connexion MC). */
  mcEmail: 'courses_mc_email',
  /** Cookie de session monsieur-cuisine.com (compte Lidl Plus) pour l'import
   *  recettes. Stocké uniquement sur l'appareil, envoyé au PHP à chaque
   *  appel (jamais persisté côté serveur). */
  mcCookie: 'courses_mc_cookie',
  notifEnabled: 'courses_notif_enabled',
  rayonsOn: 'courses_rayons_on',
} as const;

function getString(key: string, fallback = ''): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

export const settings = {
  get apiURL(): string {
    return getString(Keys.apiURL, 'https://photos2.dynaspirit.com/api-liste-courses.php').trim().replace(/\/+$/, '');
  },
  get sessionToken(): string {
    return getString(Keys.sessionToken, '').trim();
  },
  get userEmail(): string {
    return getString(Keys.userEmail, '').trim();
  },
  get userName(): string {
    return getString(Keys.userName, '').trim();
  },
  get geminiApiKey(): string {
    return getString(Keys.geminiApiKey, '').trim();
  },
  get geminiModel(): string {
    const m = getString(Keys.geminiModel, '').trim();
    return m === '' ? 'gemini-3.5-flash-lite' : m;
  },
  get mcCookie(): string {
    return getString(Keys.mcCookie, '').trim();
  },
  get mcEmail(): string {
    return getString(Keys.mcEmail, '').trim();
  },
  /** Notifications lors des changements d'un autre membre. Défaut : oui. */
  get notifEnabled(): boolean {
    const v = getString(Keys.notifEnabled, '');
    return v === '' || v === '1' || v === 'true';
  },
  /** Groupement des articles par rayon (mode magasin). Défaut : oui. */
  get rayonsOn(): boolean {
    const v = getString(Keys.rayonsOn, '');
    return v === '' || v === '1' || v === 'true';
  },
};

export function setSetting(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

export function clearSession() {
  try {
    localStorage.removeItem(Keys.sessionToken);
    localStorage.removeItem(Keys.userEmail);
    localStorage.removeItem(Keys.userName);
  } catch {
    /* ignore */
  }
}
