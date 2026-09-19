import React, { useEffect, useState } from 'react';
import {
  IonPage, IonHeader, IonToolbar, IonTitle, IonContent, IonList, IonItem,
  IonLabel, IonCheckbox, IonButton, IonText, IonChip, IonToast,
  IonThumbnail, IonSearchbar, IonModal, IonButtons, IonFooter,
  IonSegment, IonSegmentButton, IonIcon,
} from '@ionic/react';
import { heart, heartOutline } from 'ionicons/icons';
import { listsApi, favApi, type ShoppingList, type FavRecipe } from '../services/serverApi';
import { fetchMcRecipe, searchMcRecipes, fetchMcCategories, type McRecipe, type McSearchResult, type McCategory, type McSort } from '../services/mcRecipes';
import { suggestRayon } from '../services/rayons';

/**
 * Basiques déjà chez tout le monde : non pré-cochés à l'import recette
 * (forme normalisée : minuscules, sans accents ni apostrophes).
 */
const STAPLES = new Set([
  // Sels
  'sel', 'sel fin', 'gros sel', 'fleur de sel', 'sel de guerande', 'sel aux herbes',
  'sel et poivre',
  // Poivres & piments secs
  'poivre', 'poivre noir', 'poivre blanc', 'poivre gris', 'poivre moulu',
  'poivre du moulin', 'poivre en grains', 'poivre 5 baies',
  'piment', 'piment doux', 'piment de cayenne', 'piment despelette', 'piment en poudre',
  'paprika', 'paprika doux',
  // Eaux
  'eau', 'eau chaude', 'eau froide', 'eau bouillante', 'eau tiede',
  // Huiles
  'huile', 'huile dolive', 'huile neutre', 'huile de tournesol', 'huile de colza',
  'filet dhuile', 'filet dhuile dolive', 'un filet dhuile', 'un filet dhuile dolive',
  // Vinaigres
  'vinaigre', 'vinaigre blanc', 'vinaigre balsamique', 'vinaigre de cidre',
  'vinaigre de vin', 'vinaigre de vin rouge',
  // Sucres
  'sucre', 'sucre en poudre', 'sucre semoule', 'sucre glace', 'sucre vanille', 'sucre roux',
  // Farines & fécules
  'farine', 'farine de ble', 'farine t55', 'farine t65', 'farine fluide',
  'maizena', 'fecule de mais', 'fecule',
  // Levure
  'levure chimique', 'poudre a lever',
  // Moutarde
  'moutarde', 'moutarde de dijon', 'moutarde a lancienne',
  // Herbes & aromates séchés
  'thym', 'laurier', 'feuille de laurier', 'romarin', 'origan', 'herbes de provence',
  // Épices de base
  'cumin', 'cumin moulu', 'curry', 'curry en poudre', 'curcuma',
  'cannelle', 'cannelle en poudre', 'muscade', 'noix de muscade',
  'gingembre moulu', 'clou de girofle', 'quatre-epices', 'quatre epices',
]);

/**
 * PROTOTYPE — Recettes Monsieur Cuisine → liste de courses.
 * 1) Coller l'URL d'une recette (ou son ID).
 * 2) Cocher les ingrédients voulus.
 * 3) Les ajouter à la liste active.
 * Requiert le cookie MC (Réglages) : session Lidl Plus, jamais stockée serveur.
 */
const RecipesPage: React.FC = () => {
  const [recipe, setRecipe] = useState<McRecipe | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  /** Catalogue public : recherche + parcours (sans cookie). */
  const [searchQ, setSearchQ] = useState('');
  const [results, setResults] = useState<McSearchResult[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPage, setTotalPage] = useState(1);
  const [searching, setSearching] = useState(false);
  /** Tri suggestions (comme le site) + filtres catégories. */
  const [sort, setSort] = useState<McSort>('new');
  const [categories, setCategories] = useState<McCategory[]>([]);
  const [selCats, setSelCats] = useState<string[]>([]);
  const [lists, setLists] = useState<ShoppingList[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [err, setErr] = useState('');
  const [toastMsg, setToastMsg] = useState('');
  /** Onglet de la popin recette : ingrédients (ajout liste) ou pas-à-pas. */
  const [detailTab, setDetailTab] = useState<'items' | 'steps'>('items');
  /** Favoris (cœurs + vue dédiée). */
  const [favs, setFavs] = useState<FavRecipe[]>([]);
  const [favOnly, setFavOnly] = useState(false);

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
    // Catalogue : nouveautés par défaut + liste des catégories + favoris.
    void runSearch('', 1, true, 'new', []);
    fetchMcCategories().then(setCategories).catch(() => {});
    refreshFavs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const favIds = new Set(favs.map((f) => f.recipeId));

  async function refreshFavs() {
    try {
      const r = await favApi.list();
      setFavs(r.favorites);
    } catch {
      /* favoris indisponibles : le reste fonctionne */
    }
  }

  async function toggleFav(recipeId: string, title = '', image = '') {
    try {
      if (favIds.has(recipeId)) await favApi.remove(recipeId);
      else await favApi.add(recipeId, title, image);
      await refreshFavs();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  function key(g: number, i: number) {
    return `${g}:${i}`;
  }

  /** Basiques que tout le monde a déjà (non pré-cochés à l'import). */
  function isStaple(name: string): boolean {
    const norm = name.trim().toLowerCase().normalize('NFD').replace(/['’]/g, '').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ');
    return STAPLES.has(norm);
  }

  /** Recherche catalogue (q vide = suggestion selon le tri). */
  async function runSearch(q: string, p: number, replace: boolean, s: McSort = sort, cats: string[] = selCats) {
    setSearching(true);
    try {
      const r = await searchMcRecipes(q, p, s, cats);
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

  function changeSort(s: McSort) {
    setSort(s);
    void runSearch(searchQ, 1, true, s, selCats);
  }

  function toggleCat(id: string) {
    const next = selCats.includes(id) ? selCats.filter((c) => c !== id) : [...selCats, id];
    setSelCats(next);
    void runSearch(searchQ, 1, true, sort, next);
  }

  async function loadRecipe(input: string) {
    setErr(''); setRecipe(null); setDetailTab('items');
    if (!input.trim()) { setErr('Colle l’URL d’une recette monsieur-cuisine.com (ou son ID).'); return; }
    setLoading(true);
    try {
      const r = await fetchMcRecipe(input.trim());
      setRecipe(r);
      // Par défaut : tout coché sauf optionnels et basiques (sel, poivre…).
      const next = new Set<string>();
      r.groups.forEach((gr, gi) => gr.items.forEach((it, ii) => {
        if (!it.optional && !isStaple(it.name)) next.add(key(gi, ii));
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
        <IonSearchbar
          placeholder="Rechercher une recette (ex : risotto)"
          value={searchQ}
          onIonInput={(e) => setSearchQ(e.detail.value ?? '')}
          onIonChange={(e) => { void runSearch(e.detail.value ?? '', 1, true, sort, selCats); }}
          debounce={600}
        />
        <IonSegment
          value={favOnly ? 'favs' : sort}
          onIonChange={(e) => {
            const s = String(e.detail.value ?? '');
            if (s === 'favs') { setFavOnly(true); return; }
            if (s === 'new' || s === 'popular' || s === 'top') { setFavOnly(false); changeSort(s); }
          }}
        >
          <IonSegmentButton value="new"><IonLabel>Nouveautés</IonLabel></IonSegmentButton>
          <IonSegmentButton value="popular"><IonLabel>Populaires</IonLabel></IonSegmentButton>
          <IonSegmentButton value="top"><IonLabel>Mieux notées</IonLabel></IonSegmentButton>
          <IonSegmentButton value="favs"><IonLabel>❤ Favoris{favs.length > 0 ? ` (${favs.length})` : ''}</IonLabel></IonSegmentButton>
        </IonSegment>
        {categories.length > 0 && (
          <div style={{ display: 'flex', gap: 6, overflowX: 'auto', padding: '8px 2px' }}>
            {categories.map((c) => (
              <IonChip
                key={c.id}
                color={selCats.includes(c.id) ? 'primary' : undefined}
                outline={!selCats.includes(c.id)}
                onClick={() => toggleCat(c.id)}
                style={{ flexShrink: 0 }}
              >
                {c.name}
              </IonChip>
            ))}
          </div>
        )}
        {favOnly ? (
          <>
            <p className="cal-heading">❤ Favoris ({favs.length})</p>
            {favs.length === 0 && (
              <IonText color="medium"><p>Touche le cœur d’une recette pour la retrouver ici.</p></IonText>
            )}
            <IonList>
              {favs.map((f) => (
                <IonItem key={f.recipeId} button onClick={() => void loadRecipe(f.recipeId)}>
                  {f.image ? <IonThumbnail slot="start"><img src={f.image} alt="" loading="lazy" /></IonThumbnail> : null}
                  <IonLabel>
                    <h2>{f.title || `Recette ${f.recipeId}`}</h2>
                  </IonLabel>
                  <IonButton
                    slot="end"
                    fill="clear"
                    color="danger"
                    onClick={(ev) => { ev.stopPropagation(); void toggleFav(f.recipeId); }}
                  >
                    <IonIcon icon={heart} slot="icon-only" />
                  </IonButton>
                </IonItem>
              ))}
            </IonList>
          </>
        ) : (
        results.length > 0 && (
          <>
            <p className="cal-heading">📖 {total} recette(s)</p>
            <IonList>
              {results.map((r) => (
                <IonItem key={r.id} button onClick={() => void loadRecipe(r.id)}>
                  {r.image ? <IonThumbnail slot="start"><img src={r.image} alt="" loading="lazy" /></IonThumbnail> : null}
                  <IonLabel>
                    <h2>{r.name}</h2>
                    <p>
                      {[r.complexity, r.duration > 0 ? `${r.duration} min` : '', r.ratings > 0 ? `★ ${r.rating} (${r.ratings})` : '']
                        .filter(Boolean).join(' • ')}
                    </p>
                    {r.categories.length > 0 ? <p>{r.categories.join(' • ')}</p> : null}
                  </IonLabel>
                  <IonButton
                    slot="end"
                    fill="clear"
                    color={favIds.has(r.id) ? 'danger' : 'medium'}
                    onClick={(ev) => { ev.stopPropagation(); void toggleFav(r.id, r.name, r.image); }}
                  >
                    <IonIcon icon={favIds.has(r.id) ? heart : heartOutline} slot="icon-only" />
                  </IonButton>
                </IonItem>
              ))}
            </IonList>
            {page < totalPage && (
              <IonButton expand="block" fill="outline" onClick={() => void runSearch(searchQ, page + 1, false, sort, selCats)} disabled={searching}>
                {searching ? '…' : `Plus de résultats (${page}/${totalPage})`}
              </IonButton>
            )}
          </>
        )
        )}
        {err && !recipe && <IonText color="danger"><p>{err}</p></IonText>}

        {/* Détail recette en popin par-dessus la recherche. */}
        <IonModal
          className="recipe-modal"
          isOpen={recipe !== null}
          onDidDismiss={() => { setRecipe(null); setErr(''); }}
        >
          <IonHeader>
            <IonToolbar>
              <IonTitle>{recipe?.title ?? 'Recette'}</IonTitle>
              <IonButtons slot="end">
                {recipe && (
                  <IonButton
                    color={favIds.has(recipe.id) ? 'danger' : 'medium'}
                    onClick={() => void toggleFav(recipe.id, recipe.title, recipe.image)}
                  >
                    <IonIcon icon={favIds.has(recipe.id) ? heart : heartOutline} slot="icon-only" />
                  </IonButton>
                )}
                <IonButton onClick={() => { setRecipe(null); setErr(''); }}>Fermer</IonButton>
              </IonButtons>
            </IonToolbar>
          </IonHeader>
          <IonContent className="ion-padding">
            {recipe && (
              <>
                {recipe.image ? (
                  <img
                    src={recipe.image}
                    alt={recipe.title}
                    loading="lazy"
                    style={{ width: '100%', borderRadius: 12, marginBottom: 8, display: 'block' }}
                  />
                ) : null}
                {recipe.servings ? <IonText color="medium"><p style={{ marginTop: 0 }}>{recipe.servings} • {recipe.groups.flatMap((g) => g.items).length} ingrédient(s)</p></IonText> : null}
                {err && <IonText color="danger"><p>{err}</p></IonText>}
                <IonSegment
                  value={detailTab}
                  onIonChange={(e) => setDetailTab(e.detail.value === 'steps' ? 'steps' : 'items')}
                >
                  <IonSegmentButton value="items"><IonLabel>Ingrédients</IonLabel></IonSegmentButton>
                  <IonSegmentButton value="steps"><IonLabel>Recette</IonLabel></IonSegmentButton>
                </IonSegment>
                {detailTab === 'items' ? (
                <>
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
                ) : (
                <>
                {recipe.steps.length === 0 && (
                  <IonText color="medium"><p>Pas-à-pas non disponible pour cette recette.</p></IonText>
                )}
                <IonList>
                  {recipe.steps.map((st, i) => (
                    <IonItem key={i}>
                      <IonLabel>
                        <h2>{i + 1}. {st.name || `Étape ${i + 1}`}</h2>
                        {st.text ? <p style={{ whiteSpace: 'pre-wrap' }}>{st.text}</p> : null}
                        {st.cook ? <p><IonChip color="tertiary" style={{ margin: '4px 0 0' }}>{st.cook}</IonChip></p> : null}
                      </IonLabel>
                    </IonItem>
                  ))}
                </IonList>
                </>
                )}
              </>
            )}
          </IonContent>
          {detailTab === 'items' && (
          <IonFooter>
            <IonToolbar>
              <IonButton expand="block" onClick={addToList} disabled={adding || !active || !recipe}>
                + Ajouter la sélection à {active ? `« ${active.name} »` : 'la liste'}
              </IonButton>
            </IonToolbar>
          </IonFooter>
          )}
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
