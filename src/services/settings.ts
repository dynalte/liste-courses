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
    return getString(Keys.apiURL, 'http://photos2.dynaspirit.com:8080/api-liste-courses.php').trim().replace(/\/+$/, '');
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
