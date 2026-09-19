/**
 * Analyse du frigo via Gemini Vision, en direct depuis l'app
 * (même pattern que download-manager-ionic/src/services/gemini.ts :
 * clé stockée dans Réglages, fetch direct generativelanguage.googleapis.com).
 *
 * Deux modes d'entrée :
 * - photo unique (Camera / galerie) ;
 * - vidéo (input file `capture`) : on extrait N images-clés réparties sur la
 *   durée (canvas), puis on les envoie ensemble — Gemini déduplique les
 *   produits vus sous plusieurs angles.
 *
 * Modèle vision : gemini-3.5-flash-lite accepte inline_data image.
 * Les images sont réduites côté app (canvas) avant envoi pour limiter le poids.
 */
import { settings } from './settings';

export interface FridgeAnalysis {
  /** Produits vus dans le frigo, avec quantité estimée. */
  seen: Array<{ name: string; qty: string }>;
  /** Produits manquants / à racheter suggérés par l'IA. */
  toBuy: string[];
  /** Résumé en une phrase. */
  summary: string;
}

export class FridgeAiError extends Error {}

/** Réduit une image (dataURL ou base64) à max 1024px, sortie JPEG base64 sans préfixe. */
export async function downscaleToBase64(inputBase64: string, maxSize = 1024, quality = 0.8): Promise<string> {
  const src = inputBase64.startsWith('data:') ? inputBase64 : `data:image/jpeg;base64,${inputBase64}`;
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new FridgeAiError('Image illisible.'));
    el.src = src;
  });
  const ratio = Math.min(1, maxSize / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * ratio));
  const h = Math.max(1, Math.round(img.height * ratio));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d')?.drawImage(img, 0, 0, w, h);
  const out = canvas.toDataURL('image/jpeg', quality);
  const comma = out.indexOf(',');
  return comma >= 0 ? out.slice(comma + 1) : out;
}

const FALLBACKS = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.5-flash'];

const VIDEO_MAX_BYTES = 200 * 1024 * 1024; // 200 Mo : au-delà, on refuse (fichier anormal)
const VIDEO_MAX_SECONDS = 60; // on échantillonne sur les 60 premières secondes max

/**
 * Extrait `count` images-clés JPEG (base64 sans préfixe) réparties sur la durée
 * d'une vidéo (ex : travelling dans le frigo). Zéro dépendance native :
 * marche dans la WebView iOS/Android comme sur web.
 * Accepte un Blob (input file) ou une URL directe (fichier natif converti).
 *
 * Robustesse iOS : après chaque seek on attend que le décodeur ait vraiment
 * rendu l'image (requestVideoFrameCallback + délai), et on détecte les frames
 * noires (luminance ~0) avec une 2e tentative avant d'accepter l'image.
 */
export async function extractVideoFrames(input: Blob | string, count = 8, maxSize = 1024): Promise<string[]> {
  let url: string;
  let revoke = false;
  if (typeof input === 'string') {
    url = input;
  } else {
    if (input.size > VIDEO_MAX_BYTES) {
      throw new FridgeAiError('Vidéo trop lourde (> 200 Mo). Filme un plan plus court.');
    }
    url = URL.createObjectURL(input);
    revoke = true;
  }
  const waitEvent = (video: HTMLVideoElement, name: string, timeoutMs: number, err: string) =>
    new Promise<void>((resolve, reject) => {
      const to = setTimeout(() => {
        video.removeEventListener(name, onOk);
        reject(new FridgeAiError(err));
      }, timeoutMs);
      const onOk = () => {
        clearTimeout(to);
        video.removeEventListener(name, onOk);
        resolve();
      };
      video.addEventListener(name, onOk);
    });
  /** Attend que le décodeur ait affiché une image après un seek. */
  const waitPainted = (video: HTMLVideoElement) =>
    new Promise<void>((resolve) => {
      const done = () => resolve();
      const fallback = setTimeout(done, 900);
      try {
        const rvc = (video as unknown as {
          requestVideoFrameCallback?: (cb: () => void) => number;
        }).requestVideoFrameCallback;
        if (typeof rvc === 'function') {
          rvc.call(video, () => {
            clearTimeout(fallback);
            // micro-délai : laisse le compositing finir avant drawImage.
            setTimeout(done, 120);
          });
        } else {
          clearTimeout(fallback);
          setTimeout(done, 350);
        }
      } catch {
        clearTimeout(fallback);
        setTimeout(done, 350);
      }
    });
  try {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.src = url;
    await new Promise<void>((resolve, reject) => {
      const to = setTimeout(() => reject(new FridgeAiError('Vidéo illisible ou chargement trop long.')), 25000);
      video.onloadedmetadata = () => {
        clearTimeout(to);
        resolve();
      };
      video.onerror = () => {
        clearTimeout(to);
        reject(new FridgeAiError('Vidéo illisible.'));
      };
    });
    const dur = video.duration;
    if (!Number.isFinite(dur) || dur <= 0) throw new FridgeAiError('Durée de vidéo invalide.');
    const span = Math.min(dur, VIDEO_MAX_SECONDS);
    const times = Array.from({ length: count }, (_, i) => Math.min(dur - 0.05, (span * (i + 0.5)) / count));
    // S'assure qu'il y a des données décodables avant le 1er seek (sinon frame noire).
    if (video.readyState < 2) {
      await waitEvent(video, 'canplay', 15000, 'Décodage vidéo trop lent.');
    }
    const vw = video.videoWidth || maxSize;
    const vh = video.videoHeight || maxSize;
    const ratio = Math.min(1, maxSize / Math.max(vw, vh));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(vw * ratio));
    canvas.height = Math.max(1, Math.round(vh * ratio));
    const ctx = canvas.getContext('2d');
    // Sonde 32x32 pour détecter une frame noire sans lire 1M de pixels.
    const probe = document.createElement('canvas');
    probe.width = 32;
    probe.height = 32;
    const probeCtx = probe.getContext('2d', { willReadFrequently: true });
    const draw = () => {
      ctx?.drawImage(video, 0, 0, canvas.width, canvas.height);
      probeCtx?.drawImage(video, 0, 0, 32, 32);
    };
    const luminance = (): number => {
      try {
        const d = probeCtx?.getImageData(0, 0, 32, 32).data;
        if (!d) return 255;
        let sum = 0;
        const n = d.length / 4;
        for (let i = 0; i < d.length; i += 4) sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        return sum / n;
      } catch {
        return 255; // canvas illisible : ne bloque pas, accepte l'image
      }
    };
    const toDataURL = (): string => {
      const out = canvas.toDataURL('image/jpeg', 0.8);
      const comma = out.indexOf(',');
      return comma >= 0 ? out.slice(comma + 1) : out;
    };
    const frames: string[] = [];
    for (const t of times) {
      try {
        video.currentTime = t;
      } catch {
        throw new FridgeAiError('Positionnement vidéo impossible.');
      }
      await waitEvent(video, 'seeked', 12000, 'Extraction des images trop lente.').catch(() => {});
      await waitPainted(video);
      draw();
      if (luminance() < 5) {
        // Frame noire (décodeur pas prêt) : on réessaie un cran plus loin.
        await new Promise((r) => setTimeout(r, 500));
        try {
          video.currentTime = Math.min(dur - 0.05, t + 0.15);
        } catch {
          /* garde la 1re image */
        }
        await waitEvent(video, 'seeked', 12000, 'Extraction des images trop lente.').catch(() => {});
        await waitPainted(video);
        draw();
      }
      frames.push(toDataURL());
    }
    if (frames.length === 0) throw new FridgeAiError('Aucune image extraite de la vidéo.');
    return frames;
  } finally {
    if (revoke) URL.revokeObjectURL(url);
  }
}

/** Appel Vision générique : prompt + images → texte brut (1er modèle qui répond). */
async function geminiVisionJson(prompt: string, images: string[], maxTokens = 1024): Promise<string> {
  const apiKey = settings.geminiApiKey;
  if (!apiKey) throw new FridgeAiError('Clé Gemini manquante (onglet Réglages).');
  const requested = settings.geminiModel || FALLBACKS[0];
  const models = [requested, ...FALLBACKS.filter((m) => m !== requested)];
  const parts: Array<Record<string, unknown>> = [{ text: prompt }];
  for (const b64 of images.slice(0, 8)) {
    parts.push({ inline_data: { mime_type: 'image/jpeg', data: b64 } });
  }
  const bodyFor = () =>
    JSON.stringify({
      contents: [{ parts }],
      generationConfig: { temperature: 0.4, maxOutputTokens: maxTokens, responseMimeType: 'application/json' },
    });
  let lastErr = '';
  for (const model of models) {
    let res: Response;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 45000);
      try {
        res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: bodyFor(), signal: ctrl.signal },
        );
      } finally {
        clearTimeout(t);
      }
    } catch (e) {
      lastErr = e instanceof Error && e.name === 'AbortError' ? 'délai dépassé' : e instanceof Error ? e.message : String(e);
      continue;
    }
    if (res.status === 404) {
      lastErr = `"${model}" introuvable`;
      continue;
    }
    if (!res.ok) {
      const b = await res.text().catch(() => '').then((t) => t.slice(0, 200));
      if (/API key not valid|API_KEY_INVALID/i.test(b)) throw new FridgeAiError('Clé Gemini invalide (Réglages).');
      lastErr = `HTTP ${res.status}`;
      continue;
    }
    const data = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    if (!text.trim()) {
      lastErr = 'réponse vide';
      continue;
    }
    return text;
  }
  throw new FridgeAiError(`Analyse IA indisponible (${lastErr}). Relance dans un moment.`);
}

/** Extrait l'objet JSON d'une réponse (tolère du texte autour). */
function extractJsonObject<T>(text: string): T {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return JSON.parse(start >= 0 && end > start ? text.slice(start, end + 1) : text) as T;
}

export async function analyzeFridgePhoto(images: string | string[], hint = ''): Promise<FridgeAnalysis> {
  const list = (Array.isArray(images) ? images : [images]).map((s) => (s || '').trim()).filter(Boolean);
  if (list.length === 0) throw new FridgeAiError('Aucune image à analyser.');
  const multi = list.length > 1;

  const prompt =
    (multi
      ? `Ces ${list.length} images sont des extraits d'une vidéo filmée en travelling à l'intérieur d'un réfrigérateur (plusieurs angles du même frigo). ` +
        `Fusionne les observations et ne compte chaque produit qu'une seule fois. `
      : `Analyse cette photo de l'intérieur d'un réfrigérateur. `) +
    `Identifie les aliments visibles avec quantité approximative, puis suggère ce qu'il manque ` +
    `pour une famille (produits de base absents : lait, œufs, beurre, légumes...).` +
    (hint.trim() ? ` Contexte utilisateur : « ${hint.trim()} ».` : '') +
    `\nRéponds UNIQUEMENT en JSON valide, sans markdown : ` +
    `{"seen": [{"name": "...", "qty": "..."}], "toBuy": ["..."], "summary": "..."}. ` +
    `Règles : noms courts en français, max 20 vus, max 15 à acheter, summary en 1 phrase.`;

  const text = await geminiVisionJson(prompt, list);
  try {
    const parsed = extractJsonObject<Partial<FridgeAnalysis>>(text);
    const seen = Array.isArray(parsed.seen) ? parsed.seen : [];
    const toBuy = Array.isArray(parsed.toBuy) ? parsed.toBuy : [];
    return {
      seen: seen
        .map((s: any) => ({ name: String(s?.name ?? '').trim(), qty: String(s?.qty ?? '').trim() }))
        .filter((s) => s.name)
        .slice(0, 20),
      toBuy: toBuy.map((s) => String(s ?? '').trim()).filter(Boolean).slice(0, 15),
      summary: String(parsed.summary ?? '').trim() || 'Analyse terminée.',
    };
  } catch {
    throw new FridgeAiError('Réponse IA inattendue. Relance dans un moment.');
  }
}

export interface HandwrittenItem {
  name: string;
  qty: string;
}

/**
 * Transcrit une liste de courses manuscrite photographiée
 * (papier, ticket, tableau blanc...) en articles {nom, quantité}.
 */
export async function analyzeHandwrittenList(jpegBase64: string): Promise<HandwrittenItem[]> {
  const img = (jpegBase64 || '').trim();
  if (!img) throw new FridgeAiError('Aucune image à analyser.');
  const prompt =
    `Cette photo montre une liste de courses manuscrite (papier, ticket de caisse, tableau...). ` +
    `Transcris chaque article à acheter : nom court en français + quantité si lisible ` +
    `(ex : "2", "500 g", "1 L", sinon chaîne vide). ` +
    `Ignore les prix, ratures, en-têtes, totaux et gribouillis. ` +
    `Si ce n'est pas une liste de courses, réponds {"items": []}.` +
    `\nRéponds UNIQUEMENT en JSON valide, sans markdown : ` +
    `{"items": [{"name": "...", "qty": "..."}]}. Max 30 articles.`;
  const text = await geminiVisionJson(prompt, [img]);
  try {
    const parsed = extractJsonObject<{ items?: unknown }>(text);
    const items = Array.isArray(parsed.items) ? parsed.items : [];
    return items
      .map((s: any) => ({ name: String(s?.name ?? '').trim(), qty: String(s?.qty ?? '').trim() }))
      .filter((s) => s.name)
      .slice(0, 30);
  } catch {
    throw new FridgeAiError('Réponse IA inattendue. Relance dans un moment.');
  }
}

export interface PlateFood {
  name: string;
  qty: string;
}

export interface PlateAnalysis {
  /** Nom du plat ("Poulet rôti + riz + haricots verts"). Vide si pas d'assiette. */
  dish: string;
  foods: PlateFood[];
  /** Totaux estimés pour l'assiette entière. */
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  /** Note diététique /100 (équilibre, légumes, protéines, transformation, sucres). */
  score: number;
  comment: string;
}

/**
 * Analyse une assiette photographiée : nom du plat, aliments + quantités
 * approximatives, estimation nutritionnelle et note diététique /100.
 */
export async function analyzePlatePhoto(jpegBase64: string): Promise<PlateAnalysis> {
  const img = (jpegBase64 || '').trim();
  if (!img) throw new FridgeAiError('Aucune image à analyser.');
  const prompt =
    `Analyse cette photo d'une assiette (ou d'un repas). ` +
    `1) Nomme le plat en français. ` +
    `2) Liste chaque aliment visible avec sa quantité approximative en grammes ou parts ` +
    `(ex : "150 g", "1 part", "2 c.à.s", sinon chaîne vide). ` +
    `3) Estime pour l'assiette ENTIÈRE : calories (kcal), protéines, glucides, lipides (en grammes). ` +
    `4) Donne une note diététique sur 100 (équilibre assiette, légumes, protéines, aliments ultra-transformés, sucres/gras) + 1 phrase de conseil. ` +
    `Si ce n'est pas un repas, réponds {"dish": "", "foods": [], "kcal": 0, "protein": 0, "carbs": 0, "fat": 0, "score": 0, "comment": ""}.` +
    `\nRéponds UNIQUEMENT en JSON valide, sans markdown : ` +
    `{"dish": "...", "foods": [{"name": "...", "qty": "..."}], "kcal": 0, "protein": 0, "carbs": 0, "fat": 0, "score": 0, "comment": "..."}. ` +
    `Max 15 aliments. Nombres positifs, réalistes.`;
  const text = await geminiVisionJson(prompt, [img]);
  const empty: PlateAnalysis = { dish: '', foods: [], kcal: 0, protein: 0, carbs: 0, fat: 0, score: 0, comment: '' };
  try {
    const parsed = extractJsonObject<Partial<PlateAnalysis>>(text);
    const num = (v: unknown) => {
      const f = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
      return Number.isFinite(f) && f >= 0 ? Math.round(f * 10) / 10 : 0;
    };
    const foods = Array.isArray(parsed.foods) ? parsed.foods : [];
    const score = Math.round(num(parsed.score));
    return {
      dish: String(parsed.dish ?? '').trim().slice(0, 120),
      foods: foods
        .map((s: any) => ({ name: String(s?.name ?? '').trim(), qty: String(s?.qty ?? '').trim() }))
        .filter((s) => s.name)
        .slice(0, 15),
      kcal: num(parsed.kcal),
      protein: num(parsed.protein),
      carbs: num(parsed.carbs),
      fat: num(parsed.fat),
      score: Math.min(100, Math.max(0, score)),
      comment: String(parsed.comment ?? '').trim().slice(0, 300),
    };
  } catch {
    throw new FridgeAiError('Réponse IA inattendue. Relance dans un moment.');
  }
}
export interface RecognizedProduct {
  /** Nom court + marque si lisible ("Yaourt nature (Danone)"). Vide si non reconnu. */
  name: string;
  brand: string;
  qty: string;
}

/**
 * Reconnaît UN produit photographié (emballage, étiquette, fruit...) pour
 * l'ajouter à la liste. À distinguer de analyzeHandwrittenList (liste papier).
 */
export async function analyzeProductPhoto(jpegBase64: string): Promise<RecognizedProduct> {
  const img = (jpegBase64 || '').trim();
  if (!img) throw new FridgeAiError('Aucune image à analyser.');
  const prompt =
    `Identifie le produit principal sur cette photo (emballage, étiquette, fruit, légume...). ` +
    `Nom court en français + marque si lisible sur l'emballage + quantité/poids si lisible ` +
    `(ex : "500 g", "1 L", sinon chaîne vide). ` +
    `Si aucun produit n'est identifiable, réponds {"name": "", "brand": "", "qty": ""}.` +
    `\nRéponds UNIQUEMENT en JSON valide, sans markdown : ` +
    `{"name": "...", "brand": "...", "qty": "..."}.`;
  const text = await geminiVisionJson(prompt, [img]);
  try {
    const parsed = extractJsonObject<{ name?: unknown; brand?: unknown; qty?: unknown }>(text);
    const name = String(parsed.name ?? '').trim();
    const brand = String(parsed.brand ?? '').trim();
    const qty = String(parsed.qty ?? '').trim();
    if (!name) return { name: '', brand: '', qty: '' };
    return { name: brand ? `${name} (${brand})` : name, brand, qty };
  } catch {
    throw new FridgeAiError('Réponse IA inattendue. Relance dans un moment.');
  }
}
