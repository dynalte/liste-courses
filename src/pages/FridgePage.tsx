import React, { useEffect, useRef, useState } from 'react';
import {
  IonPage, IonHeader, IonToolbar, IonTitle, IonContent, IonButton, IonCard,
  IonCardContent, IonCardHeader, IonCardTitle, IonText, IonTextarea, IonItem,
  IonLabel, IonSelect, IonSelectOption, IonSpinner, IonChip, IonFooter,
  IonIcon,
} from '@ionic/react';
import { cameraOutline, videocamOutline, imageOutline, sparklesOutline } from 'ionicons/icons';
import { Camera, CameraResultType, CameraSource } from '@capacitor/camera';
import { Capacitor } from '@capacitor/core';
import { analyzeFridgePhoto, downscaleToBase64, extractVideoFrames, type FridgeAnalysis } from '../services/fridgeAi';
import { suggestRayon } from '../services/rayons';
import { cancelFilming, startFilming, stopFilming } from '../services/videoCapture';
import { closePhotoPreview, openPhotoPreview, snapPhoto } from '../services/photoCapture';
import CaptureOverlay from '../components/CaptureOverlay';
import { listsApi, type ShoppingList } from '../services/serverApi';

const VIDEO_FRAMES = 8;
const FILM_MAX_SECONDS = 45; // arrêt auto : borne la taille du fichier

const FridgePage: React.FC = () => {
  const [images, setImages] = useState<string[]>([]); // JPEG base64 sans préfixe (1 photo ou N extraits vidéo)
  const [isVideo, setIsVideo] = useState(false);
  const [filming, setFilming] = useState(false);
  const [filmSeconds, setFilmSeconds] = useState(0);
  const filmTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const videoInput = useRef<HTMLInputElement>(null);
  const [capturing, setCapturing] = useState(false);
  const [hint, setHint] = useState('');
  const [result, setResult] = useState<FridgeAnalysis | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [lists, setLists] = useState<ShoppingList[]>([]);
  const [targetListId, setTargetListId] = useState<number | null>(null);
  const [addedMsg, setAddedMsg] = useState('');

  useEffect(() => {
    listsApi.get().then((r) => {
      // Cibles = listes en cours (ni modèles ni archives).
      const open = r.lists.filter((l) => !l.archived && !l.isTemplate);
      setLists(open.length > 0 ? open : r.lists);
      const first = open.length > 0 ? open[0] : r.lists[0];
      if (first) setTargetListId(first.id);
    }).catch(() => {});
  }, []);

  async function takePhoto(source: CameraSource) {
    setError(''); setAddedMsg(''); setResult(null);
    try {
      const p = await Camera.getPhoto({
        quality: 85,
        allowEditing: false,
        resultType: CameraResultType.Base64,
        source,
      });
      if (!p.base64String) throw new Error('Photo vide.');
      const small = await downscaleToBase64(p.base64String);
      setImages([small]);
      setIsVideo(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  /** Photo frigo SANS l'écran "Use Photo" : capture intégrée (natif), système sinon. */
  async function handleFridgePhoto() {
    setError(''); setAddedMsg(''); setResult(null);
    if (!Capacitor.isNativePlatform()) {
      await takePhoto(CameraSource.Camera);
      return;
    }
    try {
      await openPhotoPreview();
      setCapturing(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleSnap() {
    setBusy(true);
    try {
      const b64 = await snapPhoto();
      await closePhotoPreview();
      setCapturing(false);
      const small = await downscaleToBase64(b64);
      setImages([small]);
      setIsVideo(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleCancelCapture() {
    await closePhotoPreview();
    setCapturing(false);
  }

  /** Vidéo (travelling dans le frigo) → N images-clés extraites côté app. */
  async function handleVideoFile(file: File | undefined) {
    // Reset l'input pour pouvoir re-filmer le même plan ensuite.
    if (videoInput.current) videoInput.current.value = '';
    if (!file) return;
    setError(''); setAddedMsg(''); setResult(null);
    setBusy(true);
    try {
      const frames = await extractVideoFrames(file, VIDEO_FRAMES);
      setImages(frames);
      setIsVideo(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function analyze() {
    if (images.length === 0) { setError('Prends d’abord une photo ou filme le frigo.'); return; }
    setBusy(true); setError(''); setAddedMsg('');
    try {
      const r = await analyzeFridgePhoto(images, hint);
      setResult(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  // ---- Filming natif sans audio (iOS/Android) : pas d'accès micro, pas de crash TCC ----
  function clearFilmTimer() {
    if (filmTimer.current) {
      clearInterval(filmTimer.current);
      filmTimer.current = null;
    }
  }

  // Sécurité : si on quitte pendant le rec, on coupe la caméra.
  useEffect(() => () => {
    clearFilmTimer();
    if (filming) void cancelFilming();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleFilm() {
    // Sur web : repli sur l'input vidéo système (pas de TCC côté navigateur).
    if (!Capacitor.isNativePlatform()) {
      videoInput.current?.click();
      return;
    }
    setError(''); setAddedMsg(''); setResult(null);
    setBusy(true);
    try {
      await startFilming();
      setFilming(true);
      setFilmSeconds(0);
      clearFilmTimer();
      filmTimer.current = setInterval(() => {
        setFilmSeconds((s) => {
          if (s + 1 >= FILM_MAX_SECONDS) {
            void handleStopFilm(); // arrêt auto
            return s;
          }
          return s + 1;
        });
      }, 1000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleStopFilm() {
    clearFilmTimer();
    setFilming(false);
    setBusy(true);
    try {
      const url = await stopFilming();
      const frames = await extractVideoFrames(url, VIDEO_FRAMES);
      setImages(frames);
      setIsVideo(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleCancelFilm() {
    clearFilmTimer();
    setFilming(false);
    await cancelFilming();
  }

  async function addToBuyToList() {
    if (!result || targetListId === null || result.toBuy.length === 0) return;
    setBusy(true);
    try {
      const r = await listsApi.addMany(
        targetListId,
        result.toBuy.map((n) => ({ name: n, rayon: suggestRayon(n) })),
      );
      setAddedMsg(`${r.added} article(s) ajouté(s) à la liste.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  return (
    <IonPage>
      <IonHeader><IonToolbar><IonTitle>Frigo → IA</IonTitle></IonToolbar></IonHeader>
      <IonContent className="ion-padding">
        <input
          ref={videoInput}
          type="file"
          accept="video/*"
          capture="environment"
          hidden
          onChange={(e) => void handleVideoFile(e.target.files?.[0])}
        />
        {images.length > 0 && (
          <>
            {isVideo ? (
              <div style={{ display: 'flex', gap: 6, overflowX: 'auto', marginTop: 12, paddingBottom: 4 }}>
                {images.map((b64, i) => (
                  <img
                    key={i}
                    src={`data:image/jpeg;base64,${b64}`}
                    alt={`Extrait ${i + 1}`}
                    style={{ height: 110, borderRadius: 10, border: '1px solid var(--app-border)', flexShrink: 0 }}
                  />
                ))}
              </div>
            ) : (
              <img className="photo-preview" style={{ marginTop: 12 }} src={`data:image/jpeg;base64,${images[0]}`} alt="Frigo" />
            )}
            {isVideo && (
              <IonText color="medium">
                <p style={{ margin: '4px 0' }}>🎬 {images.length} extraits envoyés — Gemini fusionne les angles.</p>
              </IonText>
            )}
          </>
        )}
        <IonItem style={{ marginTop: 12 }}>
          <IonTextarea label="Contexte (optionnel)" placeholder="Ex : famille de 4, pas de porc…" value={hint} onIonInput={(e) => setHint(e.detail.value ?? '')} />
        </IonItem>
        {error && <IonText color="danger"><p>{error}</p></IonText>}
        {addedMsg && <IonText color="success"><p>{addedMsg}</p></IonText>}
        {result && (
          <IonCard style={{ marginTop: 12 }}>
            <IonCardHeader><IonCardTitle>Analyse</IonCardTitle></IonCardHeader>
            <IonCardContent>
              <p>{result.summary}</p>
              <h4>Vu dans le frigo ({result.seen.length})</h4>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '6px 0' }}>
                {result.seen.map((s, i) => <IonChip key={i}>{s.name}{s.qty ? ` • ${s.qty}` : ''}</IonChip>)}
                {result.seen.length === 0 && <IonText color="medium">Rien détecté.</IonText>}
              </div>
              <h4>À racheter ({result.toBuy.length})</h4>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '6px 0' }}>
                {result.toBuy.map((s, i) => <IonChip key={i} color="primary">{s}</IonChip>)}
              </div>
              {result.toBuy.length > 0 && (
                <>
                  <IonItem>
                    <IonLabel>Ajouter à</IonLabel>
                    <IonSelect value={targetListId} onIonChange={(e) => setTargetListId(e.detail.value)}>
                      {lists.map((l) => <IonSelectOption key={l.id} value={l.id}>{l.name}</IonSelectOption>)}
                    </IonSelect>
                  </IonItem>
                  <IonButton expand="block" style={{ marginTop: 8 }} onClick={addToBuyToList} disabled={busy || targetListId === null}>
                    + Ajouter à la liste
                  </IonButton>
                </>
              )}
            </IonCardContent>
          </IonCard>
        )}
        <p className="status-bar">Photo ou vidéo sans son : tout est envoyé à Gemini avec ta clé (Réglages). Rien n’est stocké sur le serveur PHP. Astuce : filme lentement de haut en bas pour couvrir toutes les étagères.</p>
      </IonContent>
      <IonFooter>
        <IonToolbar>
          <div className="action-bar">
            <IonButton fill="outline" onClick={() => void handleFridgePhoto()} disabled={busy} title="Photographier le frigo">
              <IonIcon icon={cameraOutline} slot="start" />
              Photo
            </IonButton>
            <IonButton fill="outline" onClick={() => videoInput.current?.click()} disabled={busy} title="Filmer le frigo">
              <IonIcon icon={videocamOutline} slot="start" />
              Filmer
            </IonButton>
            <IonButton fill="outline" onClick={() => takePhoto(CameraSource.Photos)} disabled={busy} title="Choisir depuis la galerie">
              <IonIcon icon={imageOutline} slot="start" />
              Galerie
            </IonButton>
            <IonButton onClick={analyze} disabled={busy || images.length === 0} title="Analyser avec Gemini">
              <IonIcon icon={sparklesOutline} slot="start" />
              {busy ? <IonSpinner /> : 'Analyser'}
            </IonButton>
          </div>
        </IonToolbar>
      </IonFooter>
      {/* Overlays hors du contenu scrollable : calés à l'écran, au-dessus du menu. */}
      {capturing && (
        <CaptureOverlay busy={busy} hint="Cadre le frigo puis capture." onSnap={() => void handleSnap()} onCancel={() => void handleCancelCapture()} />
      )}
      {filming && (
        <div className="film-overlay">
          <div className="film-rec">⏺ REC {String(Math.floor(filmSeconds / 60)).padStart(1, '0')}:{String(filmSeconds % 60).padStart(2, '0')}</div>
          <p>Balaie lentement le frigo de haut en bas.</p>
          <div style={{ display: 'flex', gap: 8 }}>
            <IonButton color="danger" onClick={() => void handleStopFilm()}>■ Stop</IonButton>
            <IonButton fill="outline" onClick={() => void handleCancelFilm()}>Annuler</IonButton>
          </div>
        </div>
      )}
    </IonPage>
  );
};

export default FridgePage;
