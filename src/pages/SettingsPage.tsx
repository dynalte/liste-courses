import React, { useEffect, useState } from 'react';
import {
  IonPage, IonHeader, IonToolbar, IonTitle, IonContent, IonList, IonItem,
  IonInput, IonButton, IonText, IonLabel, IonSegment, IonSegmentButton, IonToggle,
} from '@ionic/react';
import { LocalNotifications } from '@capacitor/local-notifications';
import { settings, setSetting, Keys, clearSession } from '../services/settings';
import { familyApi, syncFamilyGemini, type Family } from '../services/serverApi';
import { testMcSession } from '../services/mcRecipes';
import { getThemeMode, setThemeMode, type ThemeMode } from '../services/theme';
import { App as CapApp } from '@capacitor/app';

const SettingsPage: React.FC<{ onLogout: () => void }> = ({ onLogout }) => {
  const [apiURL, setApiURL] = useState(settings.apiURL);
  const [geminiKey, setGeminiKey] = useState(settings.geminiApiKey);
  const [geminiModel, setGeminiModel] = useState(settings.geminiModel);
  const [mcCookie, setMcCookie] = useState(settings.mcCookie);
  const [mcEmail, setMcEmail] = useState(settings.mcEmail);
  const [mcMsg, setMcMsg] = useState('');
  const [mcTesting, setMcTesting] = useState(false);
  const [theme, setTheme] = useState<ThemeMode>(() => getThemeMode());
  const [notif, setNotif] = useState(() => settings.notifEnabled);
  const [role, setRole] = useState('member');
  const [appInfo, setAppInfo] = useState('');
  const [family, setFamily] = useState<Family | null>(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    familyApi.me().then((r) => {
      setFamily(r.family);
      setRole(r.user.role);
    }).catch(() => {});
    // Clé partagée : le serveur gagne, les champs suivent.
    void syncFamilyGemini().then(() => {
      setGeminiKey(settings.geminiApiKey);
      setGeminiModel(settings.geminiModel);
    });
    CapApp.getInfo()
      .then((i) => setAppInfo(`${i.name} ${i.version} (build ${i.build})`))
      // Web/PWA : pas d'info native → version injectée au build.
      .catch(() => setAppInfo(`Liste Courses v${__APP_VERSION__} (PWA)`));
  }, []);

  async function save() {
    setSetting(Keys.apiURL, apiURL.trim());
    setSetting(Keys.geminiApiKey, geminiKey.trim());
    setSetting(Keys.geminiModel, geminiModel.trim());
    // Cookie MC : local uniquement (jamais partagé, jamais stocké serveur).
    setSetting(Keys.mcCookie, mcCookie.trim());
    setSetting(Keys.mcEmail, mcEmail.trim());
    setMsg('Réglages enregistrés.');
    // Le créateur partage sa clé à la famille (poussée aux apps à la connexion).
    if (role === 'owner' && geminiKey.trim() !== '') {
      try {
        await familyApi.setGemini(geminiKey.trim(), geminiModel.trim());
        setMsg('Réglages enregistrés + clé IA partagée à la famille.');
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      }
    }
    setTimeout(() => setMsg(''), 4000);
  }

  return (
    <IonPage>
      <IonHeader><IonToolbar><IonTitle>Réglages</IonTitle></IonToolbar></IonHeader>
      <IonContent className="ion-padding">
        <IonList>
          <IonItem><IonInput label="URL API PHP" value={apiURL} onIonInput={(e) => setApiURL(e.detail.value ?? '')} /></IonItem>
          <IonItem><IonInput label="Clé Gemini" type="password" value={geminiKey} onIonInput={(e) => setGeminiKey(e.detail.value ?? '')} /></IonItem>
          <IonItem><IonInput label="Modèle Gemini" value={geminiModel} onIonInput={(e) => setGeminiModel(e.detail.value ?? '')} /></IonItem>
        </IonList>
        <IonText color="medium"><p>Clé partagée de la famille : synchronisée automatiquement à la connexion (le créateur la diffuse en l'enregistrant ici).</p></IonText>
        <h3 style={{ marginTop: 20 }}>Monsieur Cuisine <span style={{ fontSize: 12, opacity: 0.6 }}>(bêta)</span></h3>
        <IonList>
          <IonItem><IonInput label="Email Lidl Plus" type="email" value={mcEmail} onIonInput={(e) => setMcEmail(e.detail.value ?? '')} /></IonItem>
          <IonItem><IonInput label="Cookie MC" type="password" value={mcCookie} onIonInput={(e) => setMcCookie(e.detail.value ?? '')} /></IonItem>
        </IonList>
        <IonText color="medium"><p>
          1) Touche Enregistrer pour garder l’email, 2) ouvre la connexion via l’onglet
          Recettes (bouton « Se connecter ») et identifie-toi avec ton mot de passe,
          3) recopie ici le cookie (F12 → Réseau → une requête → En-têtes → <b>Cookie</b>).
          Email + cookie restent sur cet appareil (jamais stockés serveur).
          Le mot de passe n’est tapé que sur le site Lidl, jamais dans l’app.
          Si l’import échoue plus tard, le cookie a expiré : reconnecte-toi et recolle-le.
        </p></IonText>
        <IonButton
          fill="outline"
          size="small"
          disabled={mcTesting}
          onClick={() => {
            setMcMsg(''); setErr('');
            setMcTesting(true);
            // Enregistre d'abord le champ courant, puis teste la session.
            setSetting(Keys.mcCookie, mcCookie.trim());
            setSetting(Keys.mcEmail, mcEmail.trim());
            testMcSession(mcCookie.trim())
              .then((u) => setMcMsg(`Session MC valide ✓${u && u !== 'OK' ? ` (${u})` : ''}`))
              .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
              .finally(() => setMcTesting(false));
          }}
        >
          {mcTesting ? 'Test…' : 'Tester la connexion MC'}
        </IonButton>
        {mcMsg && <IonText color="success"><p>{mcMsg}</p></IonText>}
        <IonButton expand="block" onClick={save}>Enregistrer</IonButton>
        {msg && <IonText color="success"><p>{msg}</p></IonText>}

        <h3 style={{ marginTop: 20 }}>Notifications</h3>
        <IonList>
          <IonItem>
            <IonToggle
              checked={notif}
              onIonChange={async (e) => {
                const on = e.detail.checked;
                if (on) {
                  try {
                    const perm = await LocalNotifications.requestPermissions();
                    if (perm.display !== 'granted') {
                      setErr('Notifications refusées par le système (Réglages iOS > Liste Courses).');
                      return;
                    }
                  } catch {
                    /* web : pas de permission native */
                  }
                }
                setErr('');
                setNotif(on);
                setSetting(Keys.notifEnabled, on ? '1' : '0');
              }}
            >
              Me notifier quand un membre modifie la liste
            </IonToggle>
          </IonItem>
        </IonList>
        <IonText color="medium"><p>Actualisation auto toutes les 10 s + alerte au retour dans l’app.</p></IonText>

        <h3 style={{ marginTop: 20 }}>Apparence</h3>
        <IonSegment
          value={theme}
          onIonChange={(e) => {
            const m = e.detail.value as ThemeMode;
            setTheme(m);
            setThemeMode(m);
          }}
        >
          <IonSegmentButton value="dark"><IonLabel>Sombre</IonLabel></IonSegmentButton>
          <IonSegmentButton value="system"><IonLabel>Auto</IonLabel></IonSegmentButton>
          <IonSegmentButton value="light"><IonLabel>Clair</IonLabel></IonSegmentButton>
        </IonSegment>

        <h3 style={{ marginTop: 20 }}>Famille</h3>
        {family ? (
          <>
            <p className="status-bar">
              <b>{family.name}</b> — {family.members.length} membre(s)<br />
              Code d’invitation : <b style={{ fontSize: 18 }}>{family.inviteCode}</b><br />
              {family.members.map((m) => `${m.name} (${m.email})`).join(' • ')}
            </p>
            <IonButton fill="outline" size="small" onClick={async () => {
              setErr('');
              try {
                const r = await familyApi.rotateInvite();
                setFamily({ ...family, inviteCode: r.inviteCode });
              } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
            }}>
              Régénérer le code
            </IonButton>
          </>
        ) : (
          <IonText color="medium"><p>Famille non chargée (vérifie l’URL API + session).</p></IonText>
        )}
        {err && <IonText color="danger"><p>{err}</p></IonText>}

        <IonButton fill="clear" color="danger" expand="block" style={{ marginTop: 24 }}
          onClick={() => { clearSession(); onLogout(); }}>
          Se déconnecter
        </IonButton>
        <IonLabel color="medium"><p>Connecté : {settings.userName} ({settings.userEmail})</p></IonLabel>
        {appInfo && <IonLabel color="medium"><p>{appInfo}</p></IonLabel>}
      </IonContent>
    </IonPage>
  );
};

export default SettingsPage;
