/**
 * Capture vidéo du frigo SANS piste audio (contournement du TCC micro).
 *
 * Le sélecteur système (`<input capture>`) ouvre un UIImagePickerController
 * vidéo qui exige NSMicrophoneUsageDescription et plantait l'app malgré la clé
 * présente. Ici on filme via @capgo/camera-preview avec `disableAudio: true` :
 * le plugin n'ajoute aucune entrée audio à la session AVFoundation, donc iOS
 * ne touche jamais au micro — aucun prompt, aucun crash possible.
 *
 * La vidéo enregistrée (fichier local) est ensuite découpée en images-clés
 * par extractVideoFrames() (fridgeAi.ts) via une URL convertie.
 */
import { Capacitor } from '@capacitor/core';
import { CameraPreview } from '@capgo/camera-preview';

export class VideoCaptureError extends Error {}

const TRANSPARENT_CLASS = 'camera-preview-active';

function setTransparent(on: boolean) {
  try {
    document.documentElement.classList.toggle(TRANSPARENT_CLASS, on);
    // Masquage direct (ne dépend pas du CSS) : la prévisualisation est
    // plein écran, seule la barre de capture reste visible.
    document.querySelectorAll('ion-tab-bar, ion-header, ion-footer').forEach((el) => {
      (el as HTMLElement).style.display = on ? 'none' : '';
    });
  } catch {
    /* ignore */
  }
}

/** Ouvre la prévisualisation plein écran (caméra arrière) et démarre l'enregistrement. */
export async function startFilming(): Promise<void> {
  if (!Capacitor.isNativePlatform()) {
    throw new VideoCaptureError('Filming natif indisponible sur web.');
  }
  // Preview native PAR-DESSUS la WebView (toBack: false) : aucun besoin de
  // transparence. Plein écran, seule la barre de capture reste visible.
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
    setTransparent(true); // masque header/onglets via CSS (pas de transparence requise)
  } catch (e) {
    setTransparent(false);
    throw new VideoCaptureError(
      e instanceof Error ? `Caméra indisponible : ${e.message}` : 'Caméra indisponible.',
    );
  }
  try {
    await CameraPreview.startRecordVideo({});
  } catch (e) {
    await stopPreview();
    throw new VideoCaptureError(
      e instanceof Error ? `Enregistrement impossible : ${e.message}` : 'Enregistrement impossible.',
    );
  }
}

async function stopPreview(): Promise<void> {
  setTransparent(false);
  try {
    await CameraPreview.stop();
  } catch {
    /* déjà arrêté */
  }
}

/**
 * Stoppe l'enregistrement + ferme la prévisualisation.
 * Retourne une URL lisible par un <video> (convertFileSrc) pour l'extraction.
 */
export async function stopFilming(): Promise<string> {
  try {
    const { videoFilePath } = await CameraPreview.stopRecordVideo();
    if (!videoFilePath) throw new VideoCaptureError('Aucune vidéo enregistrée.');
    return videoFilePath.startsWith('file://') || videoFilePath.startsWith('http')
      ? videoFilePath.startsWith('http')
        ? videoFilePath
        : Capacitor.convertFileSrc(videoFilePath)
      : Capacitor.convertFileSrc(videoFilePath);
  } catch (e) {
    if (e instanceof VideoCaptureError) throw e;
    throw new VideoCaptureError(
      e instanceof Error ? `Arrêt impossible : ${e.message}` : 'Arrêt impossible.',
    );
  } finally {
    await stopPreview();
  }
}

/** Annule : stoppe tout sans retourner de vidéo (ex : fermeture pendant le rec). */
export async function cancelFilming(): Promise<void> {
  try {
    await CameraPreview.stopRecordVideo().catch(() => null);
  } finally {
    await stopPreview();
  }
}
