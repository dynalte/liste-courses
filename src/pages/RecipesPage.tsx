import React, { useEffect, useState } from 'react';
import {
  IonPage, IonHeader, IonToolbar, IonTitle, IonContent, IonList, IonItem,
  IonLabel, IonCheckbox, IonInput, IonButton, IonText, IonChip, IonToast,
  IonThumbnail, IonSearchbar, IonModal, IonButtons, IonFooter,
} from '@ionic/react';
import { listsApi, type ShoppingList } from '../services/serverApi';
import { fetchMcRecipe, openMcLogin, searchMcRecipes, type McRecipe, type McSearchResult } from '../services/mcRecipes';
import { settings } from '../services/settings';
import { suggestRayon } from '../services/rayons';

/**
 * PROTOTYPE — Recettes Monsieur Cuisine → liste de courses.
 * 1) Coller l'URL d'une recette (ou son ID).
 * 2) Cocher les ingrédients voulus.
 * 3) Les ajouter à la liste active.
 * Requiert le cookie MC (Réglages) : session Lidl Plus, jamais stockée serveur.
 */
const RecipesPage: React.FC = () => {
  const [url, setUrl] = useState('');
  const [recipe, setRecipe] = useState<McRecipe | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  /** Catalogue public : recherche + parcours (sans cookie). */
  const [searchQ, setSearchQ] = useState('');
  const [results, setResults] = useState<McSearchResult[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPage, setTotalPage] = useState(1);
  const [searching, setSearching] = useState(false);
  const [lists, setLists] = useState<ShoppingList[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [err, setErr] = useState('');
  const [toastMsg, setToastMsg] = useState('');

  const hasCookie = settings.mcCookie !== '';
  const actives = lists.filter((l) => !l.archived && !l.isTemplate);
  const active = actives.find((l) => l.id === activeId) ?? actives[0] ?? null;

  useEffect(() => {
    listsApi.get()
      .then((r) => {
        setLists(r.lists);
        const first = r.lists.find((l) => !l.archived && !l.isTemplate);
        if (first) setActiveId(first.id);
      })
      .catch(() => {});
    // Catalogue : nouveautés par défaut.
    void runSearch('', 1, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function key(g: number, i: number) {
    return `${g}:${i}`;
  }

  /** Recherche catalogue (q vide = nouveautés). */
  async function runSearch(q: string, p: number, replace: boolean) {
    setSearching(true);
    try {
      const r = await searchMcRecipes(q, p);
      setResults((prev) => (replace ? r.recipes : [...prev, ...r.recipes]));
      setTotal(r.total);
      setPage(r.currentPage);
      setTotalPage(r.totalPage);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSearching(false);
    }
  }

  async function loadRecipe(input: string) {
    setErr(''); setRecipe(null);
    if (!input.trim()) { setErr('Colle l’URL d’une recette monsieur-cuisine.com (ou son ID).'); return; }
    setLoading(true);
    try {
      const r = await fetchMcRecipe(input.trim());
      setRecipe(r);
      // Par défaut : tout coché sauf les optionnels.
      const next = new Set<string>();
      r.groups.forEach((gr, gi) => gr.items.forEach((it, ii) => {
        if (!it.optional) next.add(key(gi, ii));
      }));
      setChecked(next);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  function toggleAll(on: boolean) {
    if (!recipe) return;
    if (!on) { setChecked(new Set()); return; }
    const next = new Set<string>();
    recipe.groups.forEach((gr, gi) => gr.items.forEach((_it, ii) => next.add(key(gi, ii))));
    setChecked(next);
  }

  async function addToList() {
    setErr('');
    if (!recipe) return;
    if (!active) { setErr('Crée d’abord une liste (onglet Courses).'); return; }
    const picked: Array<{ name: string; qty: string; rayon: string }> = [];
    recipe.groups.forEach((gr, gi) => gr.items.forEach((it, ii) => {
      if (checked.has(key(gi, ii))) picked.push({ name: it.name, qty: it.qty, rayon: suggestRayon(it.name) });
    }));
    if (picked.length === 0) { setErr('Coche au moins un ingrédient.'); return; }
    // Chaque ingrédient porte sa recette : « Farine (Pizza napolitaine) ».
    const tag = recipe.title.length > 30 ? recipe.title.slice(0, 27).trimEnd() + '…' : recipe.title;
    const tagged = picked.map((p) => ({ ...p, name: `${p.name} (${tag})` }));
    setAdding(true);
    try {
      const r = await listsApi.addMany(active.id, tagged);
      setToastMsg(`${r.added} ingrédient(s) « ${tag} » ajouté(s) à ${active.name} ✓`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setAdding(false);
    }
  }

  return (
    <IonPage>
      <IonHeader><IonToolbar><IonTitle>Recettes MC <span style={{ fontSize: 12, opacity: 0.6 }}>bêta</span></IonTitle></IonToolbar></IonHeader>
      <IonContent className="ion-padding">
        {!hasCookie && (
          <p className="status-bar">
            ℹ️ Sans cookie, les recettes du catalogue passent quand même.
            Le cookie (Réglages &gt; Monsieur Cuisine) ne sert que pour tes brouillons privés.
          </p>
        )}
        {!hasCookie && (
          <IonButton expand="block" fill="outline" onClick={() => void openMcLogin()}>
            Se connecter à Monsieur Cuisine
          </IonButton>
        )}
        <IonSearchbar
          placeholder="Rechercher une recette (ex : risotto)"
          value={searchQ}
          onIonInput={(e) => setSearchQ(e.detail.value ?? '')}
          onIonChange={(e) => { void runSearch(e.detail.value ?? '', 1, true); }}
          debounce={600}
        />
        {results.length > 0 && (
          <>
            <p className="cal-heading">📖 {total} recette(s)</p>
            <IonList>
              {results.map((r) => (
                <IonItem key={r.id} button onClick={() => { setUrl(r.id); void loadRecipe(r.id); }}>
                  {r.image ? <IonThumbnail slot="start"><img src={r.image} alt="" loading="lazy" /></IonThumbnail> : null}
                  <IonLabel>
                    <h2>{r.name}</h2>
                    <p>
                      {[r.complexity, r.duration > 0 ? `${r.duration} min` : '', r.ratings > 0 ? `★ ${r.rating} (${r.ratings})` : '']
                        .filter(Boolean).join(' • ')}
                    </p>
                    {r.categories.length > 0 ? <p>{r.categories.join(' • ')}</p> : null}
                  </IonLabel>
                </IonItem>
              ))}
            </IonList>
            {page < totalPage && (
              <IonButton expand="block" fill="outline" onClick={() => void runSearch(searchQ, page + 1, false)} disabled={searching}>
                {searching ? '…' : `Plus de résultats (${page}/${totalPage})`}
              </IonButton>
            )}
          </>
        )}
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <IonInput
            placeholder="…ou URL recette / ID (ex : …?recipe-id=…)"
            value={url}
            onIonInput={(e) => setUrl(e.detail.value ?? '')}
            onKeyDown={(e) => { if (e.key === 'Enter' && !loading) void loadRecipe(url); }}
          />
          <IonButton onClick={() => void loadRecipe(url)} disabled={loading}>{loading ? '…' : 'Charger'}</IonButton>
        </div>
        {err && !recipe && <IonText color="danger"><p>{err}</p></IonText>}

        {/* Détail recette en popin par-dessus la recherche. */}
        <IonModal isOpen={recipe !== null} onDidDismiss={() => { setRecipe(null); setErr(''); }}>
          <IonHeader>
            <IonToolbar>
              <IonTitle>{recipe?.title ?? 'Recette'}</IonTitle>
              <IonButtons slot="end">
                <IonButton onClick={() => { setRecipe(null); setErr(''); }}>Fermer</IonButton>
              </IonButtons>
            </IonToolbar>
          </IonHeader>
          <IonContent className="ion-padding">
            {recipe && (
              <>
                {recipe.servings ? <IonText color="medium"><p style={{ marginTop: 0 }}>{recipe.servings} • {recipe.groups.flatMap((g) => g.items).length} ingrédient(s)</p></IonText> : null}
                {err && <IonText color="danger"><p>{err}</p></IonText>}
                <div style={{ display: 'flex', gap: 8, margin: '8px 0' }}>
                  <IonButton size="small" fill="outline" onClick={() => toggleAll(true)}>Tout</IonButton>
                  <IonButton size="small" fill="outline" onClick={() => toggleAll(false)}>Rien</IonButton>
                </div>
                {recipe.groups.map((gr, gi) => (
                  <div key={gi}>
                    {gr.name ? <p className="cal-heading">🧂 {gr.name}</p> : null}
                    <IonList>
                      {gr.items.map((it, ii) => (
                        <IonItem key={ii}>
                          <IonCheckbox
                            slot="start"
                            checked={checked.has(key(gi, ii))}
                            onIonChange={(e) => {
                              setChecked((prev) => {
                                const next = new Set(prev);
                                if (e.detail.checked) next.add(key(gi, ii));
                                else next.delete(key(gi, ii));
                                return next;
                              });
                            }}
                          />
                          <IonLabel>
                            <h2>{it.name}{it.optional ? ' (optionnel)' : ''}</h2>
                            {it.qty ? <p>{it.qty}</p> : null}
                          </IonLabel>
                        </IonItem>
                      ))}
                    </IonList>
                  </div>
                ))}
                {actives.length > 0 && (
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '8px 0' }}>
                    {actives.map((l) => (
                      <IonChip
                        key={l.id}
                        color={l.id === active?.id ? 'primary' : undefined}
                        onClick={() => setActiveId(l.id)}
                      >
                        {l.name}
                      </IonChip>
                    ))}
                  </div>
                )}
              </>
            )}
          </IonContent>
          <IonFooter>
            <IonToolbar>
              <IonButton expand="block" onClick={addToList} disabled={adding || !active || !recipe}>
                + Ajouter la sélection à {active ? `« ${active.name} »` : 'la liste'}
              </IonButton>
            </IonToolbar>
          </IonFooter>
        </IonModal>
        <IonToast
          isOpen={toastMsg !== ''}
          message={toastMsg}
          duration={4000}
          position="top"
          onDidDismiss={() => setToastMsg('')}
        />
      </IonContent>
    </IonPage>
  );
};

export default RecipesPage;
