import React, { useCallback, useEffect, useState } from 'react';
import {
  IonPage, IonHeader, IonToolbar, IonTitle, IonContent, IonList, IonItem,
  IonLabel, IonCheckbox, IonInput, IonButton, IonRefresher, IonRefresherContent,
  IonText, IonItemSliding, IonItemOptions, IonItemOption, IonSelect, IonSelectOption,
  IonIcon, IonSpinner, IonChip, IonThumbnail,
} from '@ionic/react';
import { barcodeOutline, documentTextOutline, searchOutline } from 'ionicons/icons';
import { listsApi, type ShoppingList } from '../services/serverApi';
import { lookupBarcode, scanBarcode, type ProductInfo } from '../services/products';
import { Camera, CameraResultType, CameraSource } from '@capacitor/camera';
import { analyzeHandwrittenList, downscaleToBase64 } from '../services/fridgeAi';

const ListsPage: React.FC = () => {
  const [lists, setLists] = useState<ShoppingList[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [newName, setNewName] = useState('');
  const [newQty, setNewQty] = useState('');
  const [newListName, setNewListName] = useState('');
  const [barcode, setBarcode] = useState('');
  const [found, setFound] = useState<ProductInfo | null>(null);
  const [scanMsg, setScanMsg] = useState('');
  const [scanning, setScanning] = useState(false);
  const [paperItems, setPaperItems] = useState<string[]>([]);
  const [paperMsg, setPaperMsg] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setError('');
    try {
      const r = await listsApi.get();
      setLists(r.lists);
      if (r.lists.length > 0 && (activeId === null || !r.lists.some((l) => l.id === activeId))) {
        setActiveId(r.lists[0].id);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [activeId]);

  useEffect(() => { void refresh(); }, []);

  const active = lists.find((l) => l.id === activeId) ?? lists[0];

  async function addItem() {
    if (!active || !newName.trim()) return;
    setBusy(true);
    try {
      await listsApi.addItem(active.id, newName.trim(), newQty.trim());
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
        await listsApi.addItem(active.id, p.name, p.quantity);
        await refresh();
        setNewName(''); setNewQty('');
        setScanMsg(`« ${p.name} » ajouté à ${active.name} ✓`);
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
    setScanning(true);
    try {
      const code = await scanBarcode();
      setBarcode(code);
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
    setBusy(true);
    try {
      const p = await Camera.getPhoto({
        quality: 85,
        allowEditing: false,
        resultType: CameraResultType.Base64,
        source: CameraSource.Camera,
      });
      if (!p.base64String) throw new Error('Photo vide.');
      const small = await downscaleToBase64(p.base64String);
      const items = await analyzeHandwrittenList(small);
      if (items.length === 0) {
        setPaperMsg('Aucun article déchiffré — réessaie avec une photo plus nette et bien cadrée.');
        return;
      }
      const r = await listsApi.addMany(active.id, items);
      await refresh();
      setPaperItems(items.map((i) => (i.qty ? `${i.name} • ${i.qty}` : i.name)));
      setPaperMsg(`${r.added} article(s) ajouté(s) à ${active.name} ✓`);
    } catch (e) {
      setPaperMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <IonPage>
      <IonHeader><IonToolbar><IonTitle>Liste de courses</IonTitle></IonToolbar></IonHeader>
      <IonContent>
        <IonRefresher slot="fixed" onIonRefresh={async (e) => { await refresh(); e.detail.complete(); }}>
          <IonRefresherContent />
        </IonRefresher>
        {error && <p className="status-bar">{error}</p>}
        <div style={{ padding: '8px 12px 0' }}>
          <IonSelect label="Liste" value={active?.id} onIonChange={(e) => setActiveId(e.detail.value)}>
            {lists.map((l) => <IonSelectOption key={l.id} value={l.id}>{l.name}</IonSelectOption>)}
          </IonSelect>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <IonInput placeholder="Nouvelle liste (ex : Courses)" value={newListName} onIonInput={(e) => setNewListName(e.detail.value ?? '')} />
            <IonButton onClick={createList} disabled={busy}>Créer</IonButton>
          </div>
        </div>
        {active && (
          <>
            <p className="status-bar">{remaining} article(s) restant(s) — {active.items.length} au total.</p>
            <div style={{ display: 'flex', gap: 8, padding: '0 12px' }}>
              <IonInput placeholder="Article (ex : Lait)" value={newName} onIonInput={(e) => setNewName(e.detail.value ?? '')} />
              <IonInput placeholder="Qté" value={newQty} onIonInput={(e) => setNewQty(e.detail.value ?? '')} style={{ maxWidth: 90 }} />
              <IonButton onClick={addItem} disabled={busy || !newName.trim()}>+</IonButton>
            </div>
            <div style={{ display: 'flex', gap: 8, padding: '8px 12px 0', alignItems: 'center' }}>
              <IonButton fill="outline" onClick={handleScan} disabled={scanning || busy} title="Scanner un code-barres">
                <IonIcon icon={barcodeOutline} slot="start" />
                Scan
              </IonButton>
              <IonInput placeholder="Code-barres (ex : 3017620422003)" inputmode="numeric" value={barcode} onIonInput={(e) => setBarcode(e.detail.value ?? '')} />
              <IonButton fill="clear" onClick={() => resolveBarcode(barcode)} disabled={scanning || busy || !barcode.trim()} title="Rechercher le produit">
                {scanning ? <IonSpinner /> : <IonIcon icon={searchOutline} />}
              </IonButton>
            </div>
            <div style={{ display: 'flex', gap: 8, padding: '8px 12px 0', alignItems: 'center' }}>
              <IonButton fill="outline" onClick={handlePaperList} disabled={busy} title="Photographier une liste manuscrite">
                <IonIcon icon={documentTextOutline} slot="start" />
                📝 Liste papier
              </IonButton>
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
                {scanMsg && !found && <IonText color="medium"><p style={{ margin: '4px 0' }}>{scanMsg}</p></IonText>}
                {scanMsg && found && <IonText color="medium"><p style={{ margin: '4px 0' }}>{scanMsg}</p></IonText>}
              </div>
            )}
            <IonList>
              {active.items.map((it) => (
                <IonItemSliding key={it.id}>
                  <IonItem>
                    <IonCheckbox
                      slot="start"
                      checked={it.checked}
                      onIonChange={async (e) => {
                        try { await listsApi.toggleItem(it.id, e.detail.checked); await refresh(); }
                        catch (err) { setError(err instanceof Error ? err.message : String(err)); }
                      }}
                    />
                    <IonLabel style={{ textDecoration: it.checked ? 'line-through' : undefined, opacity: it.checked ? 0.55 : 1 }}>
                      <h2>{it.name}</h2>
                      <p>{[it.qty, it.addedByName ? `par ${it.addedByName}` : ''].filter(Boolean).join(' • ')}</p>
                    </IonLabel>
                  </IonItem>
                  <IonItemOptions side="end">
                    <IonItemOption color="danger" onClick={async () => { await listsApi.deleteItem(it.id); await refresh(); }}>
                      Suppr.
                    </IonItemOption>
                  </IonItemOptions>
                </IonItemSliding>
              ))}
            </IonList>
            {active.items.some((i) => i.checked) && (
              <div style={{ padding: 12 }}>
                <IonButton fill="clear" size="small" onClick={async () => { await listsApi.clearChecked(active.id); await refresh(); }}>
                  Effacer les articles cochés
                </IonButton>
              </div>
            )}
          </>
        )}
        {lists.length === 0 && !error && (
          <IonText color="medium"><p style={{ padding: 16 }}>Aucune liste — crée « Courses » ci-dessus.</p></IonText>
        )}
      </IonContent>
    </IonPage>
  );
};

export default ListsPage;
