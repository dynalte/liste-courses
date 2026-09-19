import React, { useCallback, useEffect, useState } from 'react';
import {
  IonPage, IonHeader, IonToolbar, IonTitle, IonContent, IonList, IonItem,
  IonLabel, IonInput, IonButton, IonText, IonChip, IonToast, IonSegment,
  IonSegmentButton, IonThumbnail, IonFooter, IonIcon, IonModal, IonButtons,
  IonAlert,
} from '@ionic/react';
import { cameraOutline, imageOutline, saveOutline } from 'ionicons/icons';
import MacroDonut from '../components/MacroDonut';
import { Camera, CameraResultType, CameraSource } from '@capacitor/camera';
import { dietApi, type DietEntry } from '../services/serverApi';
import { analyzePlatePhoto, downscaleToBase64, type PlateAnalysis } from '../services/fridgeAi';

const MEALS = ['Petit-déjeuner', 'Déjeuner', 'Goûter', 'Dîner'];

/** Repas suggéré selon l'heure (modifiable). */
function defaultMeal(d = new Date()): string {
  const h = d.getHours() + d.getMinutes() / 60;
  if (h < 10.5) return 'Petit-déjeuner';
  if (h < 14.5) return 'Déjeuner';
  if (h < 18) return 'Goûter';
  return 'Dîner';
}

/** AAAA-MM-JJ local (sans décalage UTC). */
function todayLocal(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function scoreColor(s: number): string {
  if (s >= 75) return 'success';
  if (s >= 50) return 'warning';
  return 'danger';
}

function dayLabel(day: string): string {
  const d = new Date(`${day}T12:00:00`);
  if (day === todayLocal()) return "Aujourd'hui";
  const y = new Date();
  y.setDate(y.getDate() - 1);
  if (day === todayLocal(y)) return 'Hier';
  return d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
}

/**
 * Onglet Diététique : photo d'une assiette → analyse IA (plat, aliments,
 * quantités, nutrition, note /100) → journal horodaté par repas.
 */
const DietPage: React.FC = () => {
  const [analysis, setAnalysis] = useState<PlateAnalysis | null>(null);
  /** Photo réduite conservée côté serveur avec le repas. */
  const [platePhoto, setPlatePhoto] = useState('');
  const [day, setDay] = useState(() => todayLocal());
  const [meal, setMeal] = useState(() => defaultMeal());
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState('');
  const [entries, setEntries] = useState<DietEntry[]>([]);
  const [detail, setDetail] = useState<DietEntry | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [err, setErr] = useState('');
  const [toastMsg, setToastMsg] = useState('');

  const refresh = useCallback(async () => {
    try {
      const r = await dietApi.list(100);
      setEntries(r.entries);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  /** Photo (appareil ou galerie) → analyse IA. */
  async function snap(source: CameraSource) {
    setErr(''); setAnalysis(null); setPlatePhoto('');
    setBusy(true);
    try {
      setStep('Photo…');
      const p = await Camera.getPhoto({
        quality: 80,
        allowEditing: false,
        resultType: CameraResultType.Base64,
        source,
      });
      if (!p.base64String) throw new Error('Photo vide.');
      setStep('Analyse de l’assiette…');
      const small = await downscaleToBase64(p.base64String);
      const a = await analyzePlatePhoto(small);
      if (!a.dish && a.foods.length === 0) {
        setErr('Pas de repas détecté sur cette photo — vise une assiette et réessaie.');
        return;
      }
      // Version réduite (~480px) archivée côté serveur avec le repas.
      try {
        setPlatePhoto(await downscaleToBase64(p.base64String, 480, 0.6));
      } catch {
        setPlatePhoto('');
      }
      setAnalysis(a);
      setDay(todayLocal());
      setMeal(defaultMeal());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setStep('');
    }
  }

  async function save() {
    if (!analysis) return;
    setBusy(true);
    try {
      await dietApi.add({
        day, meal,
        dish: analysis.dish,
        items: analysis.foods.map((f) => ({ name: f.name, qty: f.qty })),
        kcal: analysis.kcal, protein: analysis.protein,
        carbs: analysis.carbs, fat: analysis.fat,
        score: analysis.score, comment: analysis.comment,
        photo: platePhoto,
      });
      setAnalysis(null);
      setPlatePhoto('');
      await refresh();
      setToastMsg(`« ${meal} » enregistré ✓`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: number) {
    try {
      await dietApi.remove(id);
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  /** Historique groupé par jour (décroissant), totaux kcal + note moyenne. */
  const days: Array<{ day: string; entries: DietEntry[]; kcal: number; avg: number }> = [];
  for (const e of entries) {
    let g = days.find((d) => d.day === e.day);
    if (!g) {
      g = { day: e.day, entries: [], kcal: 0, avg: 0 };
      days.push(g);
    }
    g.entries.push(e);
    g.kcal += e.kcal;
  }
  for (const g of days) {
    g.avg = g.entries.length > 0 ? Math.round(g.entries.reduce((s, e) => s + e.score, 0) / g.entries.length) : 0;
  }

  return (
    <IonPage>
      <IonHeader><IonToolbar><IonTitle>Diététique <span style={{ fontSize: 12, opacity: 0.6 }}>bêta</span></IonTitle></IonToolbar></IonHeader>
      <IonContent className="ion-padding">
        {err && <IonText color="danger"><p>{err}</p></IonText>}
        {busy && step ? <IonText color="medium"><p>{step}</p></IonText> : null}

        {analysis && (
          <>
            <p className="cal-heading">🍽 {analysis.dish || 'Plat non nommé'}</p>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '6px 0', alignItems: 'center' }}>
              <IonChip color={scoreColor(analysis.score)}>Note : {analysis.score}/100</IonChip>
            </div>
            <MacroDonut protein={analysis.protein} carbs={analysis.carbs} fat={analysis.fat} kcal={analysis.kcal} />
            <IonList>
              {analysis.foods.map((f, i) => (
                <IonItem key={i}>
                  <IonLabel>
                    <h2>{f.name}</h2>
                    {f.qty ? <p>{f.qty}</p> : null}
                  </IonLabel>
                </IonItem>
              ))}
            </IonList>
            {analysis.comment ? <IonText color="medium"><p>💡 {analysis.comment}</p></IonText> : null}
            <IonInput
              label="Jour"
              type="date"
              value={day}
              onIonInput={(e) => setDay(e.detail.value ?? todayLocal())}
            />
            <IonSegment
              value={meal}
              onIonChange={(e) => {
                const m = String(e.detail.value ?? '');
                if (MEALS.includes(m)) setMeal(m);
              }}
              style={{ margin: '8px 0' }}
            >
              {MEALS.map((m) => (
                <IonSegmentButton key={m} value={m}><IonLabel style={{ fontSize: 12 }}>{m}</IonLabel></IonSegmentButton>
              ))}
            </IonSegment>
          </>
        )}

        <p className="cal-heading">📓 Journal</p>
        {days.length === 0 && (
          <IonText color="medium"><p>Aucun repas enregistré — photographie ta première assiette.</p></IonText>
        )}
        {days.map((g) => (
          <div key={g.day}>
            <p className="cal-heading">
              {dayLabel(g.day)} — {Math.round(g.kcal)} kcal
              {g.entries.length > 0 ? ` • note moy. ${g.avg}/100` : ''}
            </p>
            <div style={{ margin: '4px 0 8px 12px' }}>
              <MacroDonut
                protein={g.entries.reduce((s, e) => s + e.protein, 0)}
                carbs={g.entries.reduce((s, e) => s + e.carbs, 0)}
                fat={g.entries.reduce((s, e) => s + e.fat, 0)}
                kcal={g.kcal}
                size={84}
              />
            </div>
            <IonList>
              {g.entries.map((e) => (
                <IonItem key={e.id} button onClick={() => setDetail(e)}>
                  {e.hasPhoto ? (
                    <IonThumbnail slot="start">
                      <img src={dietApi.photoUrl(e.id)} alt="" loading="lazy" />
                    </IonThumbnail>
                  ) : null}
                  <IonLabel>
                    <h2>{e.meal}{e.dish ? ` : ${e.dish}` : ''}</h2>
                    <p>
                      {[`${Math.round(e.kcal)} kcal`, e.items.map((i) => (i.qty ? `${i.name} (${i.qty})` : i.name)).join(', ')]
                        .filter(Boolean).join(' • ')}
                    </p>
                    {e.comment ? <p>💡 {e.comment}</p> : null}
                  </IonLabel>
                  <IonChip slot="end" color={scoreColor(e.score)}>{e.score}</IonChip>
                </IonItem>
              ))}
            </IonList>
          </div>
        ))}
        <IonToast
          isOpen={toastMsg !== ''}
          message={toastMsg}
          duration={4000}
          position="top"
          onDidDismiss={() => setToastMsg('')}
        />

        {/* Détail d'une assiette enregistrée. */}
        <IonModal className="recipe-modal" isOpen={detail !== null} onDidDismiss={() => setDetail(null)}>
          <IonHeader>
            <IonToolbar>
              <IonTitle>{detail ? `${detail.meal}${detail.dish ? ` : ${detail.dish}` : ''}` : 'Repas'}</IonTitle>
              <IonButtons slot="end">
                <IonButton onClick={() => setDetail(null)}>Fermer</IonButton>
              </IonButtons>
            </IonToolbar>
          </IonHeader>
          <IonContent className="ion-padding">
            {detail && (
              <>
                {detail.hasPhoto ? (
                  <img
                    src={dietApi.photoUrl(detail.id)}
                    alt={detail.dish}
                    style={{ width: '100%', borderRadius: 12, marginBottom: 8, display: 'block' }}
                  />
                ) : null}
                <IonText color="medium"><p style={{ marginTop: 0 }}>{dayLabel(detail.day)}</p></IonText>
                <div style={{ display: 'flex', gap: 6, margin: '6px 0' }}>
                  <IonChip color={scoreColor(detail.score)}>Note : {detail.score}/100</IonChip>
                </div>
                <MacroDonut protein={detail.protein} carbs={detail.carbs} fat={detail.fat} kcal={detail.kcal} />
                <p className="cal-heading">🧂 Aliments ({detail.items.length})</p>
                <IonList>
                  {detail.items.map((it, i) => (
                    <IonItem key={i}>
                      <IonLabel>
                        <h2>{it.name}</h2>
                        {it.qty ? <p>{it.qty}</p> : null}
                      </IonLabel>
                    </IonItem>
                  ))}
                </IonList>
                {detail.comment ? <IonText color="medium"><p>💡 {detail.comment}</p></IonText> : null}
              </>
            )}
          </IonContent>
          <IonFooter>
            <IonToolbar>
              <div className="action-bar">
                <IonButton
                  fill="outline"
                  color="danger"
                  onClick={() => setConfirmDelete(true)}
                  disabled={!detail}
                >
                  Supprimer ce repas
                </IonButton>
              </div>
            </IonToolbar>
          </IonFooter>
        </IonModal>
        <IonAlert
          isOpen={confirmDelete}
          header="Supprimer ce repas ?"
          message="L’assiette et son analyse seront définitivement effacées du journal."
          buttons={[
            { text: 'Annuler', role: 'cancel' },
            {
              text: 'Supprimer',
              role: 'destructive',
              handler: () => {
                if (detail) {
                  const id = detail.id;
                  setConfirmDelete(false);
                  setDetail(null);
                  void remove(id);
                }
              },
            },
          ]}
          onDidDismiss={() => setConfirmDelete(false)}
        />
      </IonContent>
      <IonFooter>
        <IonToolbar>
          <div className="action-bar">
            <IonButton fill="outline" onClick={() => void snap(CameraSource.Camera)} disabled={busy} title="Photographier l'assiette">
              <IonIcon icon={cameraOutline} slot="start" />
              Assiette
            </IonButton>
            <IonButton fill="outline" onClick={() => void snap(CameraSource.Photos)} disabled={busy} title="Choisir depuis la galerie">
              <IonIcon icon={imageOutline} slot="start" />
              Galerie
            </IonButton>
            <IonButton onClick={save} disabled={busy || !analysis} title="Enregistrer ce repas">
              <IonIcon icon={saveOutline} slot="start" />
              Enregistrer
            </IonButton>
          </div>
        </IonToolbar>
      </IonFooter>
    </IonPage>
  );
};

export default DietPage;
