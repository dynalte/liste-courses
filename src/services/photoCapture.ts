/**
 * Capture photo intégrée SANS l'écran de confirmation iOS ("Use Photo").
 *
 * Le sélecteur système (@capacitor/camera, source appareil) impose toujours
 * l'aperçu Retake/Use Photo. Ici on affiche la prévisualisation @capgo/camera-preview
 * par-dessus la WebView et on capture d'un tap (overlay CaptureOverlay).
 * Sur web : repli sur Camera.getPhoto (pas de confirmation côté navigateur).
 */
import { Capacitor } from '@capacitor/core';
import { CameraPreview } from '@capgo/camera-preview';

export class PhotoCaptureError extends Error {}

function setChromeHidden(on: boolean) {
  try {
    document.documentElement.classList.toggle('camera-preview-active', on);
    // Masquage direct (ne dépend pas du CSS) : la prévisualisation est
    // plein écran, seule la barre de capture reste visible.
    document.querySelectorAll('ion-tab-bar, ion-header, ion-footer').forEach((el) => {
      (el as HTMLElement).style.display = on ? 'none' : '';
    });
  } catch {
    /* ignore */
  }
}

/** Ouvre la prévisualisation plein écran (caméra arrière). */
export async function openPhotoPreview(): Promise<void> {
  if (!Capacitor.isNativePlatform()) {
    throw new PhotoCaptureError('Capture intégrée indisponible sur web.');
  }
  const width = Math.round(window.innerWidth || window.screen.width);
  const height = Math.round(window.innerHeight || window.screen.height);
  try {
    await CameraPreview.start({
      position: 'rear',
      toBack: false,
      disableAudio: true,
      x: 0,
      y: 0,
      width,
      height,
    });
    setChromeHidden(true);
  } catch (e) {
    setChromeHidden(false);
    throw new PhotoCaptureError(
      e instanceof Error ? `Caméra indisponible : ${e.message}` : 'Caméra indisponible.',
    );
  }
}

/** Capture instantanée → base64 (avec ou sans préfixe data:). */
export async function snapPhoto(): Promise<string> {
  try {
    const { value } = await CameraPreview.capture({ quality: 85 });
    if (!value) throw new PhotoCaptureError('Capture vide.');
    return value;
  } catch (e) {
    if (e instanceof PhotoCaptureError) throw e;
    throw new PhotoCaptureError(e instanceof Error ? e.message : 'Capture impossible.');
  }
}

/** Ferme la prévisualisation (après capture ou annulation). */
export async function closePhotoPreview(): Promise<void> {
  setChromeHidden(false);
  try {
    await CameraPreview.stop();
  } catch {
    /* déjà arrêté */
  }
}
