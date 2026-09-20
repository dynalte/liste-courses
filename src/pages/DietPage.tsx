import React, { useCallback, useEffect, useState } from 'react';
import {
  IonPage, IonHeader, IonToolbar, IonTitle, IonContent, IonList, IonItem,
  IonLabel, IonInput, IonButton, IonText, IonChip, IonToast, IonSegment,
  IonSegmentButton, IonThumbnail, IonFooter, IonIcon, IonModal, IonButtons,
  IonAlert, IonTextarea,
} from '@ionic/react';
import { Camera, CameraResultType, CameraSource } from '@capacitor/camera';
import { cameraOutline, imageOutline, chevronBackOutline, chevronForwardOutline, statsChartOutline, pencilOutline } from 'ionicons/icons';
import { dietApi, type DietEntry } from '../services/serverApi';
import { analyzePlatePhoto, analyzeMealText, downscaleToBase64, type PlateAnalysis } from '../services/fridgeAi';
import MacroDonut from '../components/MacroDonut';
import DietChart from '../components/DietChart';

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

function shiftDay(day: string, delta: number): string {
  const d = new Date(`${day}T12:00:00`);
  d.setDate(d.getDate() + delta);
  return todayLocal(d);
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

function shortDay(day: string): string {
  const d = new Date(`${day}T12:00:00`);
  return d.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric' });
}

interface MealGroup {
  name: string;
  list: DietEntry[];
  kcal: number;
  avg: number;
  protein: number;
  carbs: number;
  fat: number;
}

/** Petit commentaire justifiant la note moyenne du repas (règles locales). */
function mealComment(m: MealGroup): string {
  const P = m.protein * 4;
  const F = m.fat * 9;
  const T = P + m.carbs * 4 + F || 1;
  const pP = P / T;
  const pF = F / T;
  const head =
    m.avg >= 75 ? `Bon équilibre d'ensemble (${m.avg}/100)` :
    m.avg >= 50 ? `Correct (${m.avg}/100) mais perfectible` :
    `Déséquilibré (${m.avg}/100)`;
  const obs: string[] = [];
  if (pP < 0.15) obs.push('peu protéiné');
  else if (pP > 0.35) obs.push('très protéiné');
  if (pF > 0.45) obs.push('riche en lipides');
  if (m.list.length > 1) {
    const best = [...m.list].sort((a, b) => b.score - a.score)[0];
    const worst = [...m.list].sort((a, b) => a.score - b.score)[0];
    if (best.score - worst.score >= 20) {
      obs.push(`« ${best.dish || 'une assiette'} » remonte l'ensemble, « ${worst.dish || 'une autre'} » le plombe`);
    }
  }
  return head + (obs.length > 0 ? ' : ' + obs.join(', ') + '.' : '.');
}

/**
 * Onglet Diététique : photo d'assiettes → analyse IA → journal par jour
 * (repas multi-assiettes, moyennes) + statistiques.
 */
const DietPage: React.FC = () => {
  const [analysis, setAnalysis] = useState<PlateAnalysis | null>(null);
  /** Photo réduite conservée côté serveur avec le repas. */
  const [platePhoto, setPlatePhoto] = useState('');
  const [meal, setMeal] = useState(() => defaultMeal());
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState('');
  /** Jour affiché (navigation) + date de l'analyse en cours = ce jour. */
  const [selDay, setSelDay] = useState(() => todayLocal());
  const [entries, setEntries] = useState<DietEntry[]>([]);
  const [detail, setDetail] = useState<DietEntry | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  const [statsDays, setStatsDays] = useState<7 | 30>(7);
  /** Saisie manuelle (description texte → estimation IA). */
  const [manualOpen, setManualOpen] = useState(false);
  const [manualText, setManualText] = useState('');
  const [manualErr, setManualErr] = useState('');
  const [estimating, setEstimating] = useState(false);
  const [err, setErr] = useState('');
  const [toastMsg, setToastMsg] = useState('');

  const refresh = useCallback(async () => {
    try {
      const r = await dietApi.list(500);
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
        day: selDay, meal,
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
      setToastMsg(`Assiette ajoutée au ${meal.toLowerCase()} ✓`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  /** Description texte → estimation IA (sans photo). */
  async function estimate() {
    setManualErr('');
    if (!manualText.trim()) { setManualErr('Décris ton assiette en quelques mots.'); return; }
    setEstimating(true);
    try {
      const a = await analyzeMealText(manualText.trim());
      setAnalysis(a);
      setPlatePhoto('');
      setMeal(defaultMeal());
      setManualText('');
      setManualOpen(false);
    } catch (e) {
      setManualErr(e instanceof Error ? e.message : String(e));
    } finally {
      setEstimating(false);
    }
  }

  async function remove(id: number) {    try {
      await dietApi.remove(id);
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  /** Entrées du jour affiché, groupées par repas (plusieurs assiettes/repas). */
  const dayEntries = entries.filter((e) => e.day === selDay);
  const meals = MEALS.map((m) => {
    const list = dayEntries.filter((e) => e.meal === m);
    const kcal = list.reduce((s, e) => s + e.kcal, 0);
    const avg = list.length > 0 ? Math.round(list.reduce((s, e) => s + e.score, 0) / list.length) : 0;
    return {
      name: m, list, kcal, avg,
      protein: list.reduce((s, e) => s + e.protein, 0),
      carbs: list.reduce((s, e) => s + e.carbs, 0),
      fat: list.reduce((s, e) => s + e.fat, 0),
    };
  }).filter((m) => m.list.length > 0);
  const dayKcal = dayEntries.reduce((s, e) => s + e.kcal, 0);

  /** Stats sur les N derniers jours suivis (jours avec au moins une assiette). */
  const today = todayLocal();
  const followed = [...new Set(entries.map((e) => e.day))].sort().reverse().slice(0, statsDays);
  const statEntries = entries.filter((e) => followed.includes(e.day));
  const statKcal = statEntries.reduce((s, e) => s + e.kcal, 0);
  const statAvg = statEntries.length > 0
    ? Math.round(statEntries.reduce((s, e) => s + e.score, 0) / statEntries.length)
    : 0;
  const statDays = followed.length;

  return (
    <IonPage>
      <IonHeader>
        <IonToolbar>
          <IonTitle>Diététique <span style={{ fontSize: 12, opacity: 0.6 }}>bêta</span></IonTitle>
          <IonButtons slot="end">
            <IonButton onClick={() => setStatsOpen(true)} title="Statistiques">
              <IonIcon icon={statsChartOutline} slot="icon-only" />
            </IonButton>
          </IonButtons>
        </IonToolbar>
      </IonHeader>
      <IonContent className="ion-padding">
        {err && <IonText color="danger"><p>{err}</p></IonText>}

        {/* Navigation jour (le journal n'affiche que ce jour). */}
        <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginBottom: 4 }}>
          <IonButton fill="clear" size="small" onClick={() => setSelDay(shiftDay(selDay, -1))} title="Jour précédent">
            <IonIcon icon={chevronBackOutline} slot="icon-only" />
          </IonButton>
          <IonText style={{ flex: 1, textAlign: 'center' }}><b style={{ textTransform: 'capitalize' }}>{dayLabel(selDay)}</b></IonText>
          <IonButton fill="clear" size="small" onClick={() => setSelDay(shiftDay(selDay, 1))} disabled={selDay >= today} title="Jour suivant">
            <IonIcon icon={chevronForwardOutline} slot="icon-only" />
          </IonButton>
        </div>
        {selDay !== today && (
          <div style={{ textAlign: 'center', marginBottom: 4 }}>
            <IonButton size="small" fill="outline" onClick={() => setSelDay(today)}>Aujourd’hui</IonButton>
          </div>
        )}

        {busy && step ? <IonText color="medium"><p>{step}</p></IonText> : null}

        {/* Aperçu d'analyse en popin (jamais empilé sur le journal). */}
        <IonModal className="recipe-modal" isOpen={analysis !== null} onDidDismiss={() => { if (!busy) { setAnalysis(null); setPlatePhoto(''); } }}>
          <IonHeader>
            <IonToolbar>
              <IonTitle>🍽 {analysis?.dish || 'Plat non nommé'}</IonTitle>
              <IonButtons slot="end">
                <IonButton onClick={() => { setAnalysis(null); setPlatePhoto(''); }}>Fermer</IonButton>
              </IonButtons>
            </IonToolbar>
          </IonHeader>
          <IonContent className="ion-padding">
            {analysis && (
              <>
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
                <IonText color="medium"><p style={{ margin: '4px 0' }}>Sera ajouté au {meal.toLowerCase()} du {dayLabel(selDay).toLowerCase()}.</p></IonText>
              </>
            )}
          </IonContent>
          <IonFooter>
            <IonToolbar>
              <IonButton expand="block" onClick={save} disabled={busy || !analysis}>
                Enregistrer ce repas
              </IonButton>
            </IonToolbar>
          </IonFooter>
        </IonModal>

        {/* Repas du jour : totals + note moyenne par repas. */}
        {dayEntries.length === 0 && (
          <IonText color="medium"><p>Aucune assiette ce jour — photographie ton premier plat.</p></IonText>
        )}
        {dayEntries.length > 0 && (
          <p className="cal-heading">
            📓 Total jour : {Math.round(dayKcal)} kcal • note moy. {
              Math.round(dayEntries.reduce((s, e) => s + e.score, 0) / dayEntries.length)
            }/100
          </p>
        )}
        {meals.map((m) => (
          <div key={m.name}>
            <p className="cal-heading">
              {m.name} — {m.list.length} assiette{m.list.length > 1 ? 's' : ''} • {Math.round(m.kcal)} kcal • note moy. {m.avg}/100
            </p>
            <div className="meal-summary">
              <MacroDonut protein={m.protein} carbs={m.carbs} fat={m.fat} kcal={m.kcal} size={84} />
              <IonText color="medium" className="meal-comment">
                <p>💬 {mealComment(m)}</p>
              </IonText>
            </div>
            <IonList>
              {m.list.map((e) => (
                <IonItem key={e.id} button onClick={() => setDetail(e)}>
                  {e.hasPhoto ? (
                    <IonThumbnail slot="start">
                      <img src={dietApi.photoUrl(e.id)} alt="" loading="lazy" />
                    </IonThumbnail>
                  ) : null}
                  <IonLabel>
                    <h2>{e.dish || 'Plat non nommé'}</h2>
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

        {/* Saisie manuelle : description → estimation IA. */}
        <IonModal className="recipe-modal" isOpen={manualOpen} onDidDismiss={() => { setManualOpen(false); setManualErr(''); }}>
          <IonHeader>
            <IonToolbar>
              <IonTitle>Décrire l’assiette</IonTitle>
              <IonButtons slot="end">
                <IonButton onClick={() => { setManualOpen(false); setManualErr(''); }}>Fermer</IonButton>
              </IonButtons>
            </IonToolbar>
          </IonHeader>
          <IonContent className="ion-padding">
            <IonItem>
              <IonTextarea
                label="Repas"
                placeholder="Ex : poulet rôti + riz + haricots verts"
                autoGrow
                value={manualText}
                onIonInput={(e) => setManualText(e.detail.value ?? '')}
              />
            </IonItem>
            <IonText color="medium"><p>Quantités estimées en portions standard si tu ne les précises pas.</p></IonText>
            {manualErr && <IonText color="danger"><p>{manualErr}</p></IonText>}
          </IonContent>
          <IonFooter>
            <IonToolbar>
              <IonButton expand="block" onClick={estimate} disabled={estimating || !manualText.trim()}>
                {estimating ? 'Estimation…' : 'Estimer avec l’IA'}
              </IonButton>
            </IonToolbar>
          </IonFooter>
        </IonModal>

        {/* Statistiques. */}
        <IonModal className="recipe-modal" isOpen={statsOpen} onDidDismiss={() => setStatsOpen(false)}>
          <IonHeader>
            <IonToolbar>
              <IonTitle>Statistiques</IonTitle>
              <IonButtons slot="end">
                <IonButton onClick={() => setStatsOpen(false)}>Fermer</IonButton>
              </IonButtons>
            </IonToolbar>
          </IonHeader>
          <IonContent className="ion-padding">
            <IonSegment
              value={String(statsDays)}
              onIonChange={(e) => setStatsDays(e.detail.value === '30' ? 30 : 7)}
            >
              <IonSegmentButton value="7"><IonLabel>7 jours</IonLabel></IonSegmentButton>
              <IonSegmentButton value="30"><IonLabel>30 jours</IonLabel></IonSegmentButton>
            </IonSegment>
            {statDays === 0 && (
              <IonText color="medium"><p>Aucune assiette suivie — reviens après tes premiers repas.</p></IonText>
            )}
            {statDays > 0 && (
              <>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '10px 0' }}>
                  <IonChip>{statDays} jour{statDays > 1 ? 's' : ''} suivi{statDays > 1 ? 's' : ''}</IonChip>
                  <IonChip>{statEntries.length} assiettes</IonChip>
                  <IonChip>{Math.round(statKcal / statDays)} kcal/jour</IonChip>
                  <IonChip color={scoreColor(statAvg)}>Note moy. : {statAvg}/100</IonChip>
                </div>
                <MacroDonut
                  protein={statEntries.reduce((s, e) => s + e.protein, 0) / statDays}
                  carbs={statEntries.reduce((s, e) => s + e.carbs, 0) / statDays}
                  fat={statEntries.reduce((s, e) => s + e.fat, 0) / statDays}
                  kcal={statKcal / statDays}
                />
                <p className="cal-heading">🔥 Kcal (barres) + note moy. (courbe)</p>
                <DietChart
                  points={followed.slice().reverse().map((d) => {
                    const list = statEntries.filter((e) => e.day === d);
                    return {
                      day: d,
                      label: shortDay(d),
                      kcal: list.reduce((s, e) => s + e.kcal, 0),
                      avg: list.length > 0 ? Math.round(list.reduce((s, e) => s + e.score, 0) / list.length) : 0,
                    };
                  })}
                  selDay={selDay}
                  onSelect={(d) => { setSelDay(d); setStatsOpen(false); }}
                />
              </>
            )}
          </IonContent>
        </IonModal>
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
            <IonButton fill="outline" onClick={() => { setManualErr(''); setManualOpen(true); }} disabled={busy} title="Décrire l'assiette en texte">
              <IonIcon icon={pencilOutline} slot="start" />
              Manuel
            </IonButton>
          </div>
        </IonToolbar>
      </IonFooter>
    </IonPage>
  );
};

export default DietPage;
