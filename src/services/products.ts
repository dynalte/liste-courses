/**
 * Recherche produit par code-barres (EAN-13/UPC) sur bases publiques gratuites.
 *
 * - Alimentaire : Open Food Facts — https://world.openfoodfacts.org/api/v2/product/{code}.json
 *   gratuit, sans clé, CORS OK (appel direct depuis l'app).
 * - Non-alimentaire : Open Products Facts (même API).
 * - Beauté : Open Beauty Facts (même API).
 *
 * Si usage intensif, Open Food Facts demande un User-Agent avec contact
 * (impossible à fixer depuis un fetch navigateur — passer par le PHP si besoin).
 */
import { BarcodeScanner } from '@capacitor-mlkit/barcode-scanning';
import { Capacitor } from '@capacitor/core';

export interface ProductInfo {
  barcode: string;
  /** Nom affiché : "Petits pois bio" (+ marque si connue). */
  name: string;
  brand: string;
  quantity: string;
  imageUrl: string;
  /** Base source : 'food' | 'products' | 'beauty'. */
  source: string;
}

export class BarcodeError extends Error {}

/** Scan navigateur (PWA) : caméra + détection JS.
 * Vrai sur tout navigateur avec getUserMedia (Chrome/Edge via BarcodeDetector,
 * Safari iOS via ZXing fallback dans WebScanOverlay). */
export function isWebScanSupported(): boolean {
  try {
    return (
      !Capacitor.isNativePlatform() &&
      typeof navigator !== 'undefined' &&
      !!navigator.mediaDevices?.getUserMedia &&
      typeof window !== 'undefined' &&
      // Contexte sécurisé requis pour la caméra (HTTPS ou localhost).
      window.isSecureContext !== false
    );
  } catch {
    return false;
  }
}

/** Vrai scan caméra native (iOS/Android). Sur web : erreur → utiliser la saisie manuelle. */
export async function scanBarcode(): Promise<string> {
  if (!Capacitor.isNativePlatform()) {
    throw new BarcodeError('Scan natif indisponible sur web : saisis le code-barres à la main.');
  }
  try {
    const supported = await BarcodeScanner.isSupported().catch(() => ({ supported: true }));
    if (supported && 'supported' in supported && supported.supported === false) {
      throw new BarcodeError('Scan non supporté sur cet appareil.');
    }
  } catch (e) {
    if (e instanceof BarcodeError) throw e;
  }
  const perm = await BarcodeScanner.requestPermissions().catch(() => null);
  const granted =
    perm === null ||
    (perm as { camera?: string }).camera === 'granted' ||
    (perm as { camera?: string }).camera === 'limited';
  if (perm !== null && !granted) {
    throw new BarcodeError('Accès caméra refusé (Réglages iOS > Liste Courses > Caméra).');
  }
  const { barcodes } = await BarcodeScanner.scan();
  const code = (barcodes?.[0]?.displayValue || barcodes?.[0]?.rawValue || '').trim();
  if (!code) throw new BarcodeError('Aucun code-barres détecté.');
  return code.replace(/\s+/g, '');
}

const BASES = [
  { host: 'world.openfoodfacts.org', source: 'food' },
  { host: 'world.openproductsfacts.org', source: 'products' },
  { host: 'world.openbeautyfacts.org', source: 'beauty' },
];

/** Interroge les bases publiques, dans l'ordre food → products → beauty. Null si inconnu. */
export async function lookupBarcode(rawCode: string): Promise<ProductInfo | null> {
  const code = rawCode.replace(/\D/g, '');
  if (code.length < 8) throw new BarcodeError('Code-barres invalide (8 chiffres min).');
  for (const { host, source } of BASES) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetch(
        `https://${host}/api/v2/product/${encodeURIComponent(code)}.json?fields=product_name,product_name_fr,brands,quantity,image_front_small_url`,
        { signal: ctrl.signal },
      );
      if (!res.ok) continue;
      const data = (await res.json()) as {
        status?: number;
        product?: {
          product_name_fr?: string;
          product_name?: string;
          brands?: string;
          quantity?: string;
          image_front_small_url?: string;
        };
      };
      if (data?.status === 1 && data.product) {
        const p = data.product;
        const name = (p.product_name_fr || p.product_name || '').trim();
        if (!name) continue;
        const brand = (p.brands || '').split(',')[0]?.trim() ?? '';
        return {
          barcode: code,
          name: brand ? `${name} (${brand})` : name,
          brand,
          quantity: (p.quantity || '').trim(),
          imageUrl: p.image_front_small_url || '',
          source,
        };
      }
    } catch {
      /* timeout / réseau : base suivante */
    } finally {
      clearTimeout(t);
    }
  }
  return null;
}
