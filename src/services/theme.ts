/**
 * Service de thème : dark (défaut) | system | light.
 * Le sombre Ionic s'active par classe `ion-palette-dark` (dark.class.css).
 * Même pattern que download-manager-ionic, mais défaut = 'dark'.
 */
export type ThemeMode = 'dark' | 'system' | 'light';

const STORAGE_KEY = 'courses_theme_mode';
const DARK_META = '#0f1120';
const LIGHT_META = '#f2f5f3';

function systemDark(): boolean {
  try {
    return !!window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return false;
  }
}

export function getThemeMode(): ThemeMode {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch {
    /* stockage indisponible */
  }
  return 'dark';
}

/** Applique le mode (classe + theme-color) et retourne si le sombre est actif. */
export function applyTheme(mode: ThemeMode = getThemeMode()): boolean {
  const dark = mode === 'dark' || (mode === 'system' && systemDark());
  try {
    document.documentElement.classList.toggle('ion-palette-dark', dark);
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
    let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.name = 'theme-color';
      document.head.appendChild(meta);
    }
    meta.content = dark ? DARK_META : LIGHT_META;
  } catch {
    /* ignore */
  }
  return dark;
}

export function setThemeMode(mode: ThemeMode): boolean {
  try {
    window.localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    /* ignore */
  }
  return applyTheme(mode);
}

/** Re-applique quand le système change (mode system uniquement). */
export function watchSystemTheme(onChange?: (dark: boolean) => void): () => void {
  try {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const fn = () => {
      if (getThemeMode() === 'system') onChange?.(applyTheme('system'));
    };
    mq.addEventListener('change', fn);
    return () => mq.removeEventListener('change', fn);
  } catch {
    return () => {};
  }
}
