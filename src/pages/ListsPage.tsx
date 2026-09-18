import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  IonPage, IonHeader, IonToolbar, IonTitle, IonContent, IonList, IonItem,
  IonLabel, IonCheckbox, IonInput, IonButton, IonRefresher, IonRefresherContent,
  IonText, IonItemSliding, IonItemOptions, IonItemOption,
  IonIcon, IonChip, IonThumbnail, IonToast, IonAlert, IonFooter,
  IonAccordion, IonAccordionGroup, IonCard, IonCardContent, IonActionSheet,
  type ActionSheetButton,
} from '@ionic/react';
import {
  archiveOutline, barcodeOutline, basketOutline, cameraOutline, checkmarkDoneOutline, documentTextOutline,
  ellipsisHorizontal, funnelOutline, playOutline, saveOutline, sparklesOutline, trashOutline,
} from 'ionicons/icons';
import { LocalNotifications } from '@capacitor/local-notifications';
import { listsApi, type ShoppingItem, type ShoppingList } from '../services/serverApi';
import { lookupBarcode, scanBarcode, isWebScanSupported, type ProductInfo } from '../services/products';
import { Camera, CameraResultType, CameraSource } from '@capacitor/camera';
import { Capacitor } from '@capacitor/core';
import { analyzeHandwrittenList, analyzeProductPhoto, downscaleToBase64 } from '../services/fridgeAi';
import { closePhotoPreview, openPhotoPreview, snapPhoto } from '../services/photoCapture';
import CaptureOverlay from '../components/CaptureOverlay';
import WebScanOverlay from '../components/WebScanOverlay';
import { summarizeActivity, useRemoteSync } from '../services/sync';import { settings, setSetting, Keys } from '../services/settings';
import { RAYON_ORDER, nextRayon, suggestRayon } from '../services/rayons';

/** 2e scan du même article : "1"→"2", ""→"2", "500 g"→"2 × 500 g" (jamais "501 g"). */
function bumpQty(qty: string): string {
  const t = qty.trim();
  const multi = t.match(/^(\d+)\s*[×x]\s*(.+)$/);
  if (multi) return `${parseInt(multi[1], 10) + 1} × ${multi[2].trim()}`;
  const m = t.match(/^(\d+(?:[.,]\d+)?)\s*(.*)$/);
  if (!m) return '2';
  const num = parseFloat(m[1].replace(',', '.'));
  const suffix = (m[2] || '').trim();
  if (!suffix) {
    const next = num + 1;
    return Number.isInteger(next) ? String(next) : String(Math.round(next * 100) / 100).replace('.', ',');
  }
  // Taille de pack ("500 g", "1 L") : compteur devant, pas +1 sur le poids.
  return `2 × ${t}`;
}

/** Découpe "2" / "500 g" / "" en nombre + suffixe pour les steppers. */
function stepQty(qty: string, delta: number): string {
  const m = qty.trim().match(/^(\d+(?:[.,]\d+)?)\s*(.*)$/);
  const num = m ? parseFloat(m[1].replace(',', '.')) : null;
  const suffix = m ? m[2] : '';
  const next = Math.max(0, (num ?? (delta > 0 ? 0 : 1)) + delta);
  const whole = Number.isInteger(next);
  const str = whole ? String(next) : String(Math.round(next * 100) / 100).replace('.', ',');
  return suffix ? `${str} ${suffix}` : str;
}

const ListsPage: React.FC = () => {
  const [lists, setLists] = useState<ShoppingList[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [newName, setNewName] = useState('');
  const [newQty, setNewQty] = useState('');
  const [newListName, setNewListName] = useState('');
  const [found, setFound] = useState<ProductInfo | null>(null);
  const [scanMsg, setScanMsg] = useState('');
  const [scanning, setScanning] = useState(false);
  /** Scan web (overlay caméra navigateur) / saisie manuelle de secours. */
  const [webScanning, setWebScanning] = useState(false);
  const [manualScan, setManualScan] = useState(false);
  const [filter, setFilter] = useState<'all' | 'todo' | 'done'>('all');
  const [paperItems, setPaperItems] = useState<string[]>([]);
  const [paperMsg, setPaperMsg] = useState('');
  const [prodFound, setProdFound] = useState<{ name: string; qty: string } | null>(null);
  const [prodMsg, setProdMsg] = useState('');
  /** Capture intégrée en cours : 'paper' | 'product' | null. */
  const [capturing, setCapturing] = useState<null | 'paper' | 'product'>(null);
  const [toastMsg, setToastMsg] = useState('');
  const [myRole, setMyRole] = useState('member');
  const [rayonsOn, setRayonsOn] = useState(() => settings.rayonsOn);
  const [editItem, setEditItem] = useState<ShoppingItem | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  /** Applique une réponse lists_get (listes + sélection). */
  function applyLists(lists: ShoppingList[]) {
    setLists(lists);
    setActiveId((prev) => {
      if (lists.length === 0) return null;
      if (prev !== null && lists.some((l) => l.id === prev)) return prev;
      return lists.find((l) => !l.archived && !l.isTemplate)?.id ?? lists[0].id;
    });
  }

  // Temps réel : polling + toasts + notif locale au retour avant-plan.
  useRemoteSync({
    enabled: settings.sessionToken !== '',
    paused: () => busy || scanning,
    fetcher: () => listsApi.get(),
    onData: (data) => {
      applyLists(data.lists as ShoppingList[]);
      setMyRole(data.youRole || 'member');
    },
    onRemote: (events, fromResume) => {
      const summary = summarizeActivity(events);
      setToastMsg(summary);
      if (fromResume && settings.notifEnabled) {
        LocalNotifications.schedule({
          notifications: [{
            title: 'Liste de courses mise à jour',
            body: summary,
            id: Date.now() % 2147483647,
          }],
        }).catch(() => {});
      }
    },
  });

  const refresh = useCallback(async () => {
    setError('');
    try {
      const r = await listsApi.get();
      applyLists(r.lists);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { void refresh(); }, []);

  const active = lists.find((l) => l.id === activeId) ?? lists.find((l) => !l.archived && !l.isTemplate) ?? lists[0];
  const actives = lists.filter((l) => !l.archived && !l.isTemplate);
  const templates = lists.filter((l) => l.isTemplate);
  const archived = lists.filter((l) => l.archived);
  const isTemplate = !!active?.isTemplate;
  const isArchived = !!active?.archived;
  const lastArchived = [...archived].sort((a, b) => b.archivedAt - a.archivedAt)[0];

  const [showNewWeek, setShowNewWeek] = useState(false);
  const [newWeekName, setNewWeekName] = useState('');
  const [newWeekSource, setNewWeekSource] = useState<number | 'empty' | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const [saveTpl, setSaveTpl] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const contentRef = useRef<HTMLIonContentElement>(null);

  function scrollTop() {
    contentRef.current?.scrollToTop(300).catch(() => {});
  }

  function defaultWeekName(): string {
    const d = new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
    return `Semaine du ${d}`;
  }

  /** Nouvelle semaine depuis un modèle/une archive (tous) ou vide (owner). */
  async function createWeek() {
    setBusy(true);
    try {
      const name = newWeekName.trim() || defaultWeekName();
      if (newWeekSource === null || newWeekSource === undefined) throw new Error('Choisis une base (modèle, archive ou vide).');
      if (newWeekSource === 'empty') {
        const r = await listsApi.create(name);
        await refresh();
        setActiveId(r.list.id);
      } else {
        const r = await listsApi.duplicate(newWeekSource, name);
        await refresh();
        setActiveId(r.list.id);
      }
      setShowNewWeek(false);
      setNewWeekName('');
      setNewWeekSource(null);
      setToastMsg(`« ${name} » prête ✓`);
      scrollTop();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  /** Clôturer la semaine : archive + ouvre la préparation de la suivante. */
  async function closeWeek() {
    if (!active || isArchived || isTemplate) return;
    setBusy(true);
    try {
      await listsApi.setArchived(active.id, true);
      await refresh();
      setToastMsg(`« ${active.name} » clôturée ✓`);
      setShowNewWeek(true);
      setNewWeekSource(templates[0]?.id ?? lastArchived?.id ?? (myRole === 'owner' ? 'empty' : null));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  /** Enregistrer la liste courante comme modèle (owner). */
  async function saveAsTemplate(name: string) {
    if (!active) return;
    setBusy(true);
    try {
      await listsApi.duplicate(active.id, name.trim() || `${active.name} (modèle)`, true);
      await refresh();
      setToastMsg('Modèle enregistré ✓');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  /** Réutiliser un modèle ou une archive : prépare la duplication. */
  function reuseList(l: ShoppingList) {
    setNewWeekName(l.isTemplate ? defaultWeekName() : l.name);
    setNewWeekSource(l.id);
    setShowNewWeek(true);
    scrollTop();
  }

  async function unarchiveCurrent() {
    if (!active) return;
    setBusy(true);
    try {
      await listsApi.setArchived(active.id, false);
      await refresh();
      setToastMsg(`« ${active.name} » rouverte ✓`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  async function deleteCurrent() {
    if (!active) return;
    setBusy(true);
    try {
      await listsApi.deleteList(active.id);
      setActiveId(null);
      await refresh();
      setToastMsg('Liste supprimée.');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  async function addItem() {
    if (!active || !newName.trim()) return;
    setBusy(true);
    try {
      await listsApi.addItem(active.id, newName.trim(), newQty.trim(), {
        rayon: suggestRayon(newName),
      });
      setNewName(''); setNewQty('');
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  async function createList() {
    if (!newListName.trim()) return;
    setBusy(true);
    try {
      const r = await listsApi.create(newListName.trim());
      setNewListName('');
      await refresh();
      setActiveId(r.list.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  const remaining = active ? active.items.filter((i) => !i.checked).length : 0;
  const checkedCount = active ? active.items.filter((i) => i.checked).length : 0;

  type Filter = 'all' | 'todo' | 'done';
  const FILTER_LABEL: Record<Filter, string> = { all: 'Tous', todo: 'À acheter', done: 'Cochés' };

  /** Articles visibles selon le filtre (Tous / À acheter / Cochés). */
  function visibleItems(): ShoppingItem[] {
    if (!active) return [];
    if (filter === 'todo') return active.items.filter((i) => !i.checked);
    if (filter === 'done') return active.items.filter((i) => i.checked);
    return active.items;
  }

  function cycleFilter() {
    setFilter((f) => (f === 'all' ? 'todo' : f === 'todo' ? 'done' : 'all'));
  }

  /** Articles groupés par rayon (ordre RAYON_ORDER), rayons vides exclus. */
  function groupedItems(): Array<{ rayon: string; items: ShoppingItem[] }> {
    const items = visibleItems();
    const by = new Map<string, ShoppingItem[]>();
    for (const it of items) {
      const r = it.rayon || 'Divers';
      if (!by.has(r)) by.set(r, []);
      by.get(r)!.push(it);
    }
    const ordered: Array<{ rayon: string; items: ShoppingItem[] }> = RAYON_ORDER.filter((r) => by.has(r)).map((r) => ({
      rayon: r,
      items: by.get(r)!,
    }));
    for (const [r, items] of by) {
      if (!(RAYON_ORDER as readonly string[]).includes(r)) ordered.push({ rayon: r, items });
    }
    return ordered;
  }

  async function mutate(itemId: number, patch: { qty?: string; rayon?: string; name?: string }) {
    try {
      await listsApi.updateItem(itemId, patch);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function checkAll() {
    if (!active) return;
    const todo = active.items.filter((i) => !i.checked);
    if (todo.length === 0) return;
    setBusy(true);
    try {
      await Promise.all(todo.map((i) => listsApi.toggleItem(i.id, true)));
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  function toggleRayonsView() {
    const next = !rayonsOn;
    setRayonsOn(next);
    setSetting(Keys.rayonsOn, next ? '1' : '0');
  }

  const diversCount = active ? active.items.filter((i) => !i.rayon || i.rayon === 'Divers').length : 0;

  /** Reclasse les articles restés en Divers (ajoutés avant les rayons). */
  async function reclassify() {
    if (!active || diversCount === 0) return;
    setBusy(true);
    try {
      let fixed = 0;
      for (const it of active.items) {
        if (it.rayon && it.rayon !== 'Divers') continue;
        const r = suggestRayon(it.name);
        if (r !== 'Divers') {
          await listsApi.updateItem(it.id, { rayon: r });
          fixed++;
        }
      }
      await refresh();
      setToastMsg(fixed > 0 ? `${fixed} article(s) reclassé(s) ✓` : 'Rien à reclasser — le reste est vraiment divers.');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  function renderItem(it: ShoppingItem, showRayon: boolean) {
    const sub = [
      it.qty,
      showRayon ? it.rayon : '',
      it.addedByName ? `par ${it.addedByName}` : '',
    ].filter(Boolean).join(' • ');
    return (
      <IonItemSliding key={it.id}>
        <IonItemOptions side="start">
          <IonItemOption color="tertiary" onClick={() => mutate(it.id, { rayon: nextRayon(it.rayon || 'Divers') })}>
            🏷 {it.rayon || 'Divers'}
          </IonItemOption>
        </IonItemOptions>
        <IonItem>
          <IonCheckbox
            slot="start"
            checked={it.checked}
            onIonChange={async (e) => {
              try { await listsApi.toggleItem(it.id, e.detail.checked); await refresh(); }
              catch (err) { setError(err instanceof Error ? err.message : String(err)); }
            }}
          />
          <IonLabel
            onClick={() => setEditItem(it)}
            style={{ textDecoration: it.checked ? 'line-through' : undefined, opacity: it.checked ? 0.55 : 1 }}
          >
            <h2>{it.name}</h2>
            {sub ? <p>{sub}</p> : null}
          </IonLabel>
          <div slot="end" style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <IonButton fill="clear" size="small" onClick={() => mutate(it.id, { qty: stepQty(it.qty, -1) })}>−</IonButton>
            <IonButton fill="clear" size="small" onClick={() => mutate(it.id, { qty: stepQty(it.qty, +1) })}>+</IonButton>
          </div>
        </IonItem>
        <IonItemOptions side="end">
          <IonItemOption onClick={() => setEditItem(it)}>Éditer</IonItemOption>
          <IonItemOption color="danger" onClick={async () => { await listsApi.deleteItem(it.id); await refresh(); }}>
            Suppr.
          </IonItemOption>
        </IonItemOptions>
      </IonItemSliding>
    );
  }

  /** Ajout anti-doublon : même article non coché → quantité +1, sinon nouvelle ligne. */
  async function addOrBump(name: string, qty: string): Promise<{ bumped: boolean; qty: string }> {
    if (!active) throw new Error('Crée d’abord une liste.');
    const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
    const existing = active.items.find((i) => !i.checked && norm(i.name) === norm(name));
    if (existing) {
      const next = bumpQty(existing.qty);
      await listsApi.updateItem(existing.id, { qty: next });
      await refresh();
      return { bumped: true, qty: next };
    }
    await listsApi.addItem(active.id, name, qty, { rayon: suggestRayon(name) });
    await refresh();
    return { bumped: false, qty };
  }

  /** Recherche le produit (scan caméra ou code saisi) et l'ajoute directement. */
  async function resolveBarcode(code: string) {
    setScanMsg(''); setFound(null);
    if (!code.trim()) return;
    if (!active) { setScanMsg('Crée d’abord une liste.'); return; }
    setScanning(true);
    try {
      const p = await lookupBarcode(code.trim());
      if (p) {
        setFound(p);
        const r = await addOrBump(p.name, p.quantity);
        setNewName(''); setNewQty('');
        setScanMsg(r.bumped ? `« ${p.name} » : quantité → ${r.qty} ✓` : `« ${p.name} » ajouté à ${active.name} ✓`);
      } else {
        setScanMsg(`Code ${code.trim()} inconnu des bases publiques — complète le nom à la main puis tape +.`);
      }
    } catch (e) {
      setScanMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setScanning(false);
    }
  }

  async function handleScan() {
    setScanMsg(''); setFound(null);
    // Web (PWA) : overlay caméra navigateur si supporté, sinon saisie manuelle.
    if (!Capacitor.isNativePlatform()) {
      if (!active) { setScanMsg('Crée d’abord une liste.'); return; }
      if (isWebScanSupported()) setWebScanning(true);
      else setManualScan(true);
      return;
    }
    setScanning(true);
    try {
      const code = await scanBarcode();
      setScanning(false);
      await resolveBarcode(code);
    } catch (e) {
      setScanning(false);
      setScanMsg(e instanceof Error ? e.message : String(e));
    }
  }

  /** Photo d'une liste manuscrite → transcription IA → ajout direct. */
  async function handlePaperList() {
    setPaperMsg(''); setPaperItems([]);
    if (!active) { setPaperMsg('Crée d’abord une liste.'); return; }
    // Natif : capture intégrée (sans écran "Use Photo"). Web : sélecteur système.
    if (Capacitor.isNativePlatform()) {
      try {
        await openPhotoPreview();
        setCapturing('paper');
      } catch (e) {
        setPaperMsg(e instanceof Error ? e.message : String(e));
      }
      return;
    }
    setBusy(true);
    try {
      const p = await Camera.getPhoto({
        quality: 85,
        allowEditing: false,
        resultType: CameraResultType.Base64,
        source: CameraSource.Camera,
      });
      if (!p.base64String) throw new Error('Photo vide.');
      await processPaperPhoto(p.base64String);
    } catch (e) {
      setPaperMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  /** Transcription + ajout (busy géré par l'appelant). */
  async function processPaperPhoto(b64: string) {
    if (!active) return;
    const small = await downscaleToBase64(b64);
    const items = await analyzeHandwrittenList(small);
    if (items.length === 0) {
      setPaperMsg('Aucun article déchiffré — réessaie avec une photo plus nette et bien cadrée.');
      return;
    }
    const r = await listsApi.addMany(
      active.id,
      items.map((i) => ({ ...i, rayon: suggestRayon(i.name) })),
    );
    await refresh();
    setPaperItems(items.map((i) => (i.qty ? `${i.name} • ${i.qty}` : i.name)));
    setPaperMsg(`${r.added} article(s) ajouté(s) à ${active.name} ✓`);
  }

  /** Photo d'UN produit → reconnaissance IA → ajout direct. */
  async function handleProductPhoto() {
    setProdMsg(''); setProdFound(null);
    if (!active) { setProdMsg('Crée d’abord une liste.'); return; }
    // Natif : capture intégrée (sans écran "Use Photo"). Web : sélecteur système.
    if (Capacitor.isNativePlatform()) {
      try {
        await openPhotoPreview();
        setCapturing('product');
      } catch (e) {
        setProdMsg(e instanceof Error ? e.message : String(e));
      }
      return;
    }
    setBusy(true);
    try {
      const p = await Camera.getPhoto({
        quality: 85,
        allowEditing: false,
        resultType: CameraResultType.Base64,
        source: CameraSource.Camera,
      });
      if (!p.base64String) throw new Error('Photo vide.');
      await processProductPhoto(p.base64String);
    } catch (e) {
      setProdMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  /** Reconnaissance + ajout (busy géré par l'appelant). */
  async function processProductPhoto(b64: string) {
    if (!active) return;
    const small = await downscaleToBase64(b64);
    const prod = await analyzeProductPhoto(small);
    if (!prod.name) {
      setProdMsg('Produit non reconnu — réessaie de plus près sur l’emballage, ou complète à la main.');
      return;
    }
    const r = await addOrBump(prod.name, prod.qty);
    setProdFound({ name: prod.name, qty: r.qty });
    setProdMsg(r.bumped ? `« ${prod.name} » : quantité → ${r.qty} ✓` : `« ${prod.name} » ajouté à ${active.name} ✓`);
  }

  /** Capture depuis l'overlay intégré (papier ou produit). */
  async function handleOverlaySnap() {
    const mode = capturing;
    if (!mode) return;
    setBusy(true);
    try {
      const b64 = await snapPhoto();
      await closePhotoPreview();
      setCapturing(null);
      if (mode === 'paper') await processPaperPhoto(b64);
      else await processProductPhoto(b64);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (mode === 'paper') setPaperMsg(msg);
      else setProdMsg(msg);
    } finally {
      setBusy(false);
    }
  }

  async function handleOverlayCancel() {
    await closePhotoPreview();
    setCapturing(null);
  }

  /** Actions secondaires (menu ⋯) : explicites, hors du niveau principal. */
  const menuActions: ActionSheetButton[] = [];
  if (active && !isArchived && diversCount > 0) {
    menuActions.push({
      text: `Reclasser les articles sans rayon (${diversCount})`,
      icon: sparklesOutline,
      handler: () => { void reclassify(); },
    });
  }
  if (active && !isArchived && remaining > 0) {
    menuActions.push({
      text: 'Tout cocher',
      icon: checkmarkDoneOutline,
      handler: () => { void checkAll(); },
    });
  }
  if (active && !isArchived && checkedCount > 0) {
    menuActions.push({
      text: 'Effacer les articles cochés',
      role: 'destructive',
      icon: trashOutline,
      handler: () => {
        void (async () => {
          await listsApi.clearChecked(active.id);
          await refresh();
        })();
      },
    });
  }
  if (active && !isArchived && !isTemplate) {
    menuActions.push({
      text: 'Clôturer la semaine',
      icon: archiveOutline,
      handler: () => setConfirmClose(true),
    });
  }
  if (active && !isArchived && !isTemplate && myRole === 'owner') {
    menuActions.push({
      text: 'Enregistrer comme modèle',
      icon: saveOutline,
      handler: () => setSaveTpl(true),
    });
  }

  return (
    <IonPage className="courses-page">
      <IonHeader><IonToolbar><IonTitle>Liste de courses</IonTitle></IonToolbar></IonHeader>
      <IonContent ref={contentRef}>
        <IonRefresher slot="fixed" onIonRefresh={async (e) => { await refresh(); e.detail.complete(); }}>
          <IonRefresherContent />
        </IonRefresher>
        {error && <p className="status-bar">{error}</p>}
        <div style={{ padding: '8px 12px 0' }}>
          {actives.length > 0 && (
            <>
              <p className="cal-heading">🛒 En cours</p>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', padding: '2px 0 0' }}>
                {actives.map((l) => (
                  <IonChip key={l.id} color={l.id === active?.id ? 'primary' : undefined} onClick={() => { setActiveId(l.id); scrollTop(); }}>
                    {l.name} • {l.items.filter((i) => !i.checked).length}
                  </IonChip>
                ))}
                <IonChip outline onClick={() => setShowNewWeek((v) => !v)}>＋ Semaine</IonChip>
              </div>
            </>
          )}
          {actives.length === 0 && (
            <IonButton expand="block" style={{ marginTop: 8 }} onClick={() => setShowNewWeek(true)}>
              ＋ Préparer la semaine
            </IonButton>
          )}
          {showNewWeek && (
            <IonCard>
              <IonCardContent>
                <IonInput label="Nom" placeholder={defaultWeekName()} value={newWeekName} onIonInput={(e) => setNewWeekName(e.detail.value ?? '')} />
                <p className="cal-heading" style={{ margin: '8px 0 0' }}>Base de départ</p>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '6px 0' }}>
                  {templates.map((t) => (
                    <IonChip key={t.id} color={newWeekSource === t.id ? 'primary' : undefined} onClick={() => setNewWeekSource(t.id)}>
                      📋 {t.name}
                    </IonChip>
                  ))}
                  {lastArchived && (
                    <IonChip color={newWeekSource === lastArchived.id ? 'primary' : undefined} onClick={() => setNewWeekSource(lastArchived.id)}>
                      🗂 {lastArchived.name}
                    </IonChip>
                  )}
                  {myRole === 'owner' && (
                    <IonChip color={newWeekSource === 'empty' ? 'primary' : undefined} onClick={() => setNewWeekSource('empty')}>
                      📄 Vide
                    </IonChip>
                  )}
                </div>
                <IonButton expand="block" onClick={createWeek} disabled={busy || newWeekSource === null}>
                  Créer la semaine
                </IonButton>
              </IonCardContent>
            </IonCard>
          )}
          {myRole === 'owner' && (
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <IonInput placeholder="Nouvelle liste (ex : Noël)" value={newListName} onIonInput={(e) => setNewListName(e.detail.value ?? '')} />
              <IonButton onClick={createList} disabled={busy}>Créer</IonButton>
            </div>
          )}
        </div>
        {active && (
          <>
            {isTemplate && (
              <p className="status-bar">📋 <b>Modèle</b> — modifie son contenu : il servira de base aux prochaines semaines.</p>
            )}
            {isArchived && (
              <p className="status-bar">🗂 <b>Archive</b>
                {active.archivedAt > 0 ? ` du ${new Date(active.archivedAt * 1000).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' })}` : ''}
                {' '}— lecture seule.</p>
            )}
            {!isArchived ? (
              <>
            <p className="status-bar">
              {remaining} article(s) restant(s) — {active.items.length} au total.
            </p>
            <div style={{ display: 'flex', gap: 8, padding: '0 12px' }}>
              <IonInput placeholder="Article (ex : Lait)" enterkeyhint="done" value={newName} onIonInput={(e) => setNewName(e.detail.value ?? '')} onKeyDown={(e) => { if (e.key === 'Enter' && !busy) void addItem(); }} />
              <IonInput placeholder="Qté" enterkeyhint="done" value={newQty} onIonInput={(e) => setNewQty(e.detail.value ?? '')} style={{ maxWidth: 90 }} onKeyDown={(e) => { if (e.key === 'Enter' && !busy) void addItem(); }} />
              <IonButton onClick={addItem} disabled={busy || !newName.trim()}>+</IonButton>
            </div>
            {(paperItems.length > 0 || paperMsg) && (
              <div style={{ padding: '4px 12px 0' }}>
                {paperItems.length > 0 && (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '6px 0' }}>
                    {paperItems.map((s, i) => <IonChip key={i} color="success">{s}</IonChip>)}
                  </div>
                )}
                {paperMsg && <IonText color="medium"><p style={{ margin: '4px 0' }}>{paperMsg}</p></IonText>}
              </div>
            )}
            {(found || scanMsg) && (
              <div style={{ padding: '4px 12px 0' }}>
                {found && (
                  <IonItem lines="none">
                    {found.imageUrl ? <IonThumbnail slot="start"><img src={found.imageUrl} alt="" /></IonThumbnail> : null}
                    <IonLabel>
                      <h3>{found.name}</h3>
                      <p>{[found.quantity, `code ${found.barcode}`].filter(Boolean).join(' • ')}</p>
                    </IonLabel>
                    <IonChip color="success">✓</IonChip>
                  </IonItem>
                )}
                {scanMsg && <IonText color="medium"><p style={{ margin: '4px 0' }}>{scanMsg}</p></IonText>}
              </div>
            )}
            {(prodFound || prodMsg) && (
              <div style={{ padding: '4px 12px 0' }}>
                {prodFound && (
                  <IonItem lines="none">
                    <IonLabel>
                      <h3>📷 {prodFound.name}</h3>
                      {prodFound.qty ? <p>{prodFound.qty}</p> : null}
                    </IonLabel>
                    <IonChip color="success">✓</IonChip>
                  </IonItem>
                )}
                {prodMsg && <IonText color="medium"><p style={{ margin: '4px 0' }}>{prodMsg}</p></IonText>}
              </div>
            )}
            {rayonsOn ? (
              <>
                {groupedItems().map((g) => (
                  <div key={g.rayon}>
                    <p className="cal-heading">🧺 {g.rayon} ({g.items.filter((i) => !i.checked).length})</p>
                    <IonList>
                      {g.items.map((it) => renderItem(it, false))}
                    </IonList>
                  </div>
                ))}
              </>
            ) : (
              <IonList>
                {visibleItems().map((it) => renderItem(it, true))}
              </IonList>
            )}
            {filter !== 'all' && visibleItems().length === 0 && (
              <IonText color="medium"><p style={{ padding: 16 }}>Rien à voir avec ce filtre.</p></IonText>
            )}
            <IonAlert
              isOpen={editItem !== null}
              header="Modifier l’article"
              inputs={[
                { name: 'name', type: 'text', placeholder: 'Nom', value: editItem?.name ?? '' },
                { name: 'qty', type: 'text', placeholder: 'Quantité', value: editItem?.qty ?? '' },
              ]}
              buttons={[
                { text: 'Annuler', role: 'cancel' },
                {
                  text: 'OK',
                  handler: (data: Record<string, string>) => {
                    if (editItem) {
                      void mutate(editItem.id, {
                        name: (data.name ?? '').trim() || editItem.name,
                        qty: (data.qty ?? '').trim(),
                      });
                    }
                  },
                },
              ]}
              onDidDismiss={() => setEditItem(null)}
            />
              </>
            ) : (
              <>
                <IonList>
                  {active.items.map((it) => (
                    <IonItem key={it.id}>
                      <IonLabel style={{ opacity: it.checked ? 0.55 : 1 }}>
                        <h2>{it.checked ? '✓ ' : '○ '}{it.name}</h2>
                        {it.qty ? <p>{it.qty}</p> : null}
                      </IonLabel>
                    </IonItem>
                  ))}
                </IonList>
                {active.items.length === 0 && (
                  <IonText color="medium"><p style={{ padding: 16 }}>Archive vide.</p></IonText>
                )}
                <div style={{ display: 'flex', gap: 8, padding: '8px 12px', flexWrap: 'wrap' }}>
                  <IonButton size="small" onClick={() => reuseList(active)} disabled={busy}>↩ Réutiliser</IonButton>
                  <IonButton size="small" fill="outline" onClick={unarchiveCurrent} disabled={busy}>Rouvrir</IonButton>
                  {myRole === 'owner' && (
                    <IonButton size="small" fill="clear" color="danger" onClick={() => setConfirmDelete(true)}>
                      Supprimer
                    </IonButton>
                  )}
                </div>
              </>
            )}
            <IonAlert
              isOpen={confirmClose}
              header="Clôturer la semaine ?"
              message={`« ${active.name} » passera en archive, puis tu prépareras la suivante.`}
              buttons={[
                { text: 'Annuler', role: 'cancel' },
                { text: 'Clôturer', handler: () => { setConfirmClose(false); void closeWeek(); } },
              ]}
              onDidDismiss={() => setConfirmClose(false)}
            />
            <IonAlert
              isOpen={saveTpl}
              header="Enregistrer comme modèle"
              inputs={[{ name: 'name', type: 'text', placeholder: 'Nom du modèle', value: `${active.name} (modèle)` }]}
              buttons={[
                { text: 'Annuler', role: 'cancel' },
                {
                  text: 'Enregistrer',
                  handler: (data: Record<string, string>) => {
                    setSaveTpl(false);
                    void saveAsTemplate(data.name ?? '');
                  },
                },
              ]}
              onDidDismiss={() => setSaveTpl(false)}
            />
            <IonAlert
              isOpen={confirmDelete}
              header="Supprimer définitivement ?"
              message={`« ${active.name} » et ses articles seront effacés.`}
              buttons={[
                { text: 'Annuler', role: 'cancel' },
                { text: 'Supprimer', role: 'destructive', handler: () => { setConfirmDelete(false); void deleteCurrent(); } },
              ]}
              onDidDismiss={() => setConfirmDelete(false)}
            />
          </>
        )}
        {templates.length > 0 && (
          <>
            <p className="cal-heading">📋 Modèles</p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', padding: '2px 12px 0' }}>
              {templates.map((t) => (
                <IonChip key={t.id} color={t.id === active?.id ? 'primary' : undefined} onClick={() => { setActiveId(t.id); scrollTop(); }}>
                  {t.name} • {t.items.length}
                </IonChip>
              ))}
            </div>
          </>
        )}
        {archived.length > 0 && (
          <IonAccordionGroup style={{ padding: '8px 12px 0' }}>
            <IonAccordion value="archives">
              <IonItem slot="header">
                <IonLabel>🗂 Archives ({archived.length})</IonLabel>
              </IonItem>
              <div slot="content" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', padding: '8px 4px' }}>
                {[...archived].sort((a, b) => b.archivedAt - a.archivedAt).map((l) => (
                  <IonChip key={l.id} color={l.id === active?.id ? 'primary' : undefined} onClick={() => { setActiveId(l.id); scrollTop(); }}>
                    {l.name} • {l.items.length}
                  </IonChip>
                ))}
              </div>
            </IonAccordion>
          </IonAccordionGroup>
        )}
        {lists.length === 0 && !error && (
          <IonText color="medium"><p style={{ padding: 16 }}>Aucune liste — prépare ta semaine ci-dessus.</p></IonText>
        )}
        <IonToast
          isOpen={toastMsg !== ''}
          message={toastMsg}
          duration={4000}
          position="top"
          onDidDismiss={() => setToastMsg('')}
        />
      </IonContent>
      {active && (
        <IonFooter>
          <IonToolbar>
            <div className="action-bar">
              {!isArchived && (
                <IonButton fill="outline" onClick={handleScan} disabled={scanning || busy} title="Scanner un code-barres">
                  <IonIcon icon={barcodeOutline} slot="start" />
                  Scan
                </IonButton>
              )}
              {!isArchived && (
                <IonButton fill="outline" onClick={handlePaperList} disabled={busy} title="Photographier une liste manuscrite">
                  <IonIcon icon={documentTextOutline} slot="start" />
                  Papier
                </IonButton>
              )}
              {!isArchived && (
                <IonButton fill="outline" onClick={handleProductPhoto} disabled={busy} title="Photographier un produit (reconnaissance IA)">
                  <IonIcon icon={cameraOutline} slot="start" />
                  Produit
                </IonButton>
              )}
              <IonButton fill={rayonsOn ? 'solid' : 'outline'} onClick={toggleRayonsView} title="Grouper par rayon">
                <IonIcon icon={basketOutline} slot="start" />
                Rayons
              </IonButton>
              <IonButton fill={filter === 'all' ? 'outline' : 'solid'} onClick={cycleFilter} title="Filtrer la liste">
                <IonIcon icon={funnelOutline} slot="start" />
                {FILTER_LABEL[filter]}
              </IonButton>
              {active && isTemplate && (
                <IonButton fill="solid" onClick={() => reuseList(active)} disabled={busy} title="Créer une semaine depuis ce modèle">
                  <IonIcon icon={playOutline} slot="start" />
                  Utiliser
                </IonButton>
              )}
              {menuActions.length > 0 && (
                <IonButton fill="clear" onClick={() => setShowMenu(true)} title="Plus d'actions">
                  <IonIcon icon={ellipsisHorizontal} slot="icon-only" />
                </IonButton>
              )}
            </div>
          </IonToolbar>
        </IonFooter>
      )}
      <IonActionSheet
        isOpen={showMenu}
        onDidDismiss={() => setShowMenu(false)}
        header="Actions"
        buttons={menuActions}
      />
      {/* Overlay hors du contenu scrollable : calé à l'écran, au-dessus du menu. */}
      {capturing && (
        <CaptureOverlay
          busy={busy}
          hint={capturing === 'paper' ? 'Cadre la liste puis capture.' : 'Cadre le produit puis capture.'}
          onSnap={() => void handleOverlaySnap()}
          onCancel={() => void handleOverlayCancel()}
        />
      )}
      {webScanning && (
        <WebScanOverlay
          onCode={(code) => {
            setWebScanning(false);
            void resolveBarcode(code);
          }}
          onCancel={() => setWebScanning(false)}
          onManual={() => {
            setWebScanning(false);
            setManualScan(true);
          }}
        />
      )}
      <IonAlert
        isOpen={manualScan}
        header="Code-barres"
        message="Ton navigateur ne sait pas scanner : saisis le code à la main."
        inputs={[{ name: 'code', type: 'text', placeholder: 'Ex : 3017620422003', attributes: { inputmode: 'numeric' } }]}
        buttons={[
          { text: 'Annuler', role: 'cancel' },
          {
            text: 'Rechercher',
            handler: (data: Record<string, string>) => {
              setManualScan(false);
              if ((data.code ?? '').trim()) void resolveBarcode(data.code);
            },
          },
        ]}
        onDidDismiss={() => setManualScan(false)}
      />
    </IonPage>
  );
};

export default ListsPage;
