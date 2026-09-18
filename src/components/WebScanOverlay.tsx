import React, { useEffect, useRef, useState } from 'react';
import { IonButton, IonText } from '@ionic/react';
import type { IScannerControls } from '@zxing/browser';

/**
 * Scan code-barres 100 % web (PWA) : caméra via getUserMedia.
 * - Détection en continu : BarcodeDetector natif (Chrome/Edge) puis ZXing.
 * - Bouton Capturer : photo pleine résolution décodée en TRY_HARDER —
 *   bien plus fiable quand la vidéo en continu ne "voit" rien
 *   (code petit, flou, manque de lumière).
 * - Torche si le device la supporte.
 * HTTPS (ou localhost) obligatoire.
 */
type BarcodeDetectorCtor = new (opts?: { formats?: string[] }) => {
  detect(i: HTMLVideoElement): Promise<Array<{ rawValue?: string }>>;
};

const SCAN_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf', 'qr_code'];
/** Au-delà, on propose la saisie manuelle (le scan continue en tâche de fond). */
const START_TIMEOUT_MS = 20000;

const WebScanOverlay: React.FC<{
  onCode: (code: string) => void;
  onCancel: () => void;
  onManual?: () => void;
}> = ({ onCode, onCancel, onManual }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(true);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoMsg, setPhotoMsg] = useState('');
  const [torchOn, setTorchOn] = useState(false);
  const [torchSupported, setTorchSupported] = useState(false);
  const done = useRef(false);
  const settled = useRef(false);
  const photoBusyRef = useRef(false);
  const onCodeRef = useRef(onCode);
  onCodeRef.current = onCode;

  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let controls: IScannerControls | null = null;
    let cancelled = false;

    function markReady() {
      if (settled.current || cancelled) return;
      settled.current = true;
      setStarting(false);
      if (timeout) clearTimeout(timeout);
    }

    function fail(msg: string) {
      if (cancelled) return;
      markReady();
      setError(msg);
    }

    function emit(code: string) {
      if (done.current || cancelled) return;
      const clean = (code || '').trim().replace(/\s+/g, '');
      if (!clean) return;
      done.current = true;
      onCodeRef.current(clean);
    }

    function toMessage(e: unknown): string {
      if (e instanceof DOMException && e.name === 'NotAllowedError')
        return 'Caméra refusée : autorise l’accès puis réessaie.';
      if (e instanceof DOMException && e.name === 'NotFoundError')
        return 'Aucune caméra trouvée sur cet appareil.';
      if (e instanceof DOMException && e.name === 'NotReadableError')
        return 'Caméra déjà utilisée par une autre app.';
      if (e instanceof DOMException && e.name === 'OverconstrainedError')
        return 'Caméra arrière introuvable, réessaie.';
      if (e instanceof Error && e.message) return e.message;
      return 'Caméra indisponible.';
    }

    /** Boucle de détection native sur la vidéo déjà en lecture. */
    async function startNativeLoop(video: HTMLVideoElement): Promise<boolean> {
      const BD = (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
      if (!BD) return false;
      try {
        let formats = SCAN_FORMATS;
        const withStatics = BD as unknown as { getSupportedFormats?: () => Promise<string[]> };
        if (typeof withStatics.getSupportedFormats === 'function') {
          try {
            const supported = await withStatics.getSupportedFormats();
            if (Array.isArray(supported) && supported.length > 0) {
              const wanted = SCAN_FORMATS.filter((f) => supported.includes(f));
              if (wanted.length > 0) formats = wanted;
            }
          } catch {
            /* ignore : on garde la liste par défaut */
          }
        }
        if (cancelled) return false;
        const detector = new BD({ formats });
        timer = setInterval(async () => {
          if (done.current || cancelled) return;
          if (video.readyState < 2 || video.videoWidth === 0) return;
          try {
            const codes = await detector.detect(video);
            const code = (codes?.[0]?.rawValue || '').trim();
            if (code) emit(code);
          } catch {
            /* frame illisible : on réessaie */
          }
        }, 300);
        return true;
      } catch {
        if (timer) clearInterval(timer);
        timer = null;
        return false;
      }
    }

    /** Fallback ZXing en continu sur le flux déjà ouvert (pas de 2e demande caméra). */
    async function startZxing(video: HTMLVideoElement, s: MediaStream): Promise<void> {
      // Import différé : ZXing (~340 Ko gzip) chargé uniquement au 1er scan,
      // pas dans le bundle initial de la PWA.
      const [{ BrowserMultiFormatReader }, { BarcodeFormat, DecodeHintType }] = await Promise.all([
        import('@zxing/browser'),
        import('@zxing/library'),
      ]);
      if (cancelled || done.current) return;
      const hints = new Map();
      hints.set(DecodeHintType.POSSIBLE_FORMATS, [
        BarcodeFormat.EAN_13,
        BarcodeFormat.EAN_8,
        BarcodeFormat.UPC_A,
        BarcodeFormat.UPC_E,
        BarcodeFormat.CODE_128,
        BarcodeFormat.CODE_39,
        BarcodeFormat.ITF,
      ]);
      // Pas de TRY_HARDER en continu (trop lent sur mobile) : réservé à la photo.
      const reader = new BrowserMultiFormatReader(hints, { delayBetweenScanAttempts: 300 });
      controls = await reader.decodeFromStream(s, video, (result, err) => {
        if (cancelled || done.current) return;
        const text = result?.getText?.()?.trim();
        if (text) {
          emit(text);
          return;
        }
        // NotFoundException entre deux frames = normal, on continue.
        if (err && err.name !== 'NotFoundException') {
          /* ChecksumException… : on continue aussi */
        }
      });
    }

    async function start() {
      // Sécurité : jamais bloqué sur "Démarrage…" — on propose la saisie.
      timeout = setTimeout(() => {
        if (cancelled || settled.current) return;
        settled.current = true;
        setStarting(false);
        setError('Démarrage trop long : vérifie l’autorisation caméra, ou saisis le code.');
      }, START_TIMEOUT_MS);

      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error('Caméra non supportée par ce navigateur.');
        }
        if (window.isSecureContext === false) {
          throw new Error('La caméra exige HTTPS (ou localhost).');
        }
        const video = videoRef.current;
        if (!video) return;

        // 1) Caméra d'abord : affichage immédiat dès que le flux joue.
        const onPlaying = () => markReady();
        video.addEventListener('playing', onPlaying);
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: 'environment' } },
            audio: false,
          });
          if (cancelled) {
            stream.getTracks().forEach((t) => t.stop());
            return;
          }
          streamRef.current = stream;
          // Torche dispo ? (bouton affiché seulement dans ce cas)
          try {
            const track = stream.getVideoTracks()[0];
            const caps = track?.getCapabilities?.() as { torch?: boolean } | undefined;
            if (caps?.torch) setTorchSupported(true);
          } catch {
            /* pas de torche */
          }
          video.srcObject = stream;
          await video.play().catch(() => {});
          markReady();
        } finally {
          video.removeEventListener('playing', onPlaying);
        }

        // 2) Détection : native si dispo, sinon ZXing sur le même flux.
        if (await startNativeLoop(video)) return;
        if (cancelled || done.current) return;
        await startZxing(video, stream);
      } catch (e) {
        fail(toMessage(e));
      }
    }

    void start();
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      if (timeout) clearTimeout(timeout);
      try {
        controls?.stop();
      } catch {
        /* ignore */
      }
      stream?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      const v = videoRef.current;
      if (v) {
        v.pause();
        v.srcObject = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Photo pleine résolution → décodage TRY_HARDER (secours quand la vidéo ne détecte rien). */
  async function capturePhoto() {
    const video = videoRef.current;
    const s = streamRef.current;
    if (!video || !s || photoBusyRef.current || done.current) return;
    photoBusyRef.current = true;
    setPhotoBusy(true);
    setPhotoMsg('Analyse de la photo…');
    try {
      const [{ BrowserMultiFormatReader }, { BarcodeFormat, DecodeHintType }] = await Promise.all([
        import('@zxing/browser'),
        import('@zxing/library'),
      ]);
      const canvas = document.createElement('canvas');
      let drew = false;
      // Photo native (autofocus + pleine résolution) si supportée.
      try {
        const IC = (window as unknown as { ImageCapture?: new (t: MediaStreamTrack) => { takePhoto(): Promise<Blob> } }).ImageCapture;
        const track = s.getVideoTracks()[0];
        if (IC && track) {
          const blob = await new IC(track).takePhoto().catch(() => null);
          if (blob && typeof createImageBitmap === 'function') {
            const bmp = await createImageBitmap(blob);
            canvas.width = bmp.width;
            canvas.height = bmp.height;
            canvas.getContext('2d')?.drawImage(bmp, 0, 0);
            if (typeof bmp.close === 'function') bmp.close();
            drew = true;
          }
        }
      } catch {
        /* repli frame vidéo ci-dessous */
      }
      if (!drew) {
        const w = video.videoWidth;
        const h = video.videoHeight;
        if (!w || !h) throw new Error('Vidéo pas prête.');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d')?.drawImage(video, 0, 0, w, h);
      }
      const hints = new Map();
      hints.set(DecodeHintType.POSSIBLE_FORMATS, [
        BarcodeFormat.EAN_13,
        BarcodeFormat.EAN_8,
        BarcodeFormat.UPC_A,
        BarcodeFormat.UPC_E,
        BarcodeFormat.CODE_128,
        BarcodeFormat.CODE_39,
        BarcodeFormat.ITF,
      ]);
      hints.set(DecodeHintType.TRY_HARDER, true);
      const reader = new BrowserMultiFormatReader(hints);
      const result = reader.decodeFromCanvas(canvas);
      const text = result?.getText?.()?.trim().replace(/\s+/g, '') ?? '';
      if (!text) throw new Error('not found');
      done.current = true;
      onCodeRef.current(text);
    } catch {
      setPhotoMsg('Non détecté — rapproche le code bien net dans le cadre, éclaire, stabilise, puis réessaie.');
    } finally {
      photoBusyRef.current = false;
      setPhotoBusy(false);
    }
  }

  async function toggleTorch() {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    try {
      await track.applyConstraints({ advanced: [{ torch: !torchOn }] } as unknown as MediaTrackConstraints);
      setTorchOn((v) => !v);
    } catch {
      /* torche refusée par le device */
    }
  }

  return (
    <div className="webscan-overlay">
      <video ref={videoRef} muted playsInline autoPlay className="webscan-video" />
      <div className="webscan-frame" />
      <p className="webscan-hint">{starting ? 'Démarrage caméra…' : 'Vise le code-barres'}</p>
      {photoMsg ? (
        <IonText color="light">
          <p style={{ margin: 0 }}>{photoMsg}</p>
        </IonText>
      ) : null}
      {error ? (
        <IonText color="danger">
          <p>Caméra inaccessible ({error})</p>
        </IonText>
      ) : null}
      {!starting && !error ? (
        <div style={{ display: 'flex', gap: 8, position: 'relative' }}>
          <IonButton onClick={() => void capturePhoto()} disabled={photoBusy}>
            {photoBusy ? 'Analyse…' : '📸 Capturer'}
          </IonButton>
          {torchSupported ? (
            <IonButton fill={torchOn ? 'solid' : 'outline'} onClick={() => void toggleTorch()}>
              🔦
            </IonButton>
          ) : null}
        </div>
      ) : null}
      <div style={{ display: 'flex', gap: 8, position: 'relative' }}>
        {error && onManual ? (
          <IonButton onClick={onManual}>Saisir le code</IonButton>
        ) : null}
        <IonButton fill={error ? 'outline' : 'solid'} onClick={onCancel}>
          Annuler
        </IonButton>
      </div>
    </div>
  );
};

export default WebScanOverlay;
