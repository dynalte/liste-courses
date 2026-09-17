import React, { useEffect, useState } from 'react';
import {
  IonPage, IonHeader, IonToolbar, IonTitle, IonContent, IonList, IonItem,
  IonInput, IonButton, IonText, IonLabel, IonSegment, IonSegmentButton,
} from '@ionic/react';
import { settings, setSetting, Keys, clearSession } from '../services/settings';
import { familyApi, type Family } from '../services/serverApi';
import { getThemeMode, setThemeMode, type ThemeMode } from '../services/theme';
import { App as CapApp } from '@capacitor/app';

const SettingsPage: React.FC<{ onLogout: () => void }> = ({ onLogout }) => {
  const [apiURL, setApiURL] = useState(settings.apiURL);
  const [geminiKey, setGeminiKey] = useState(settings.geminiApiKey);
  const [geminiModel, setGeminiModel] = useState(settings.geminiModel);
  const [theme, setTheme] = useState<ThemeMode>(() => getThemeMode());
  const [appInfo, setAppInfo] = useState('');
  const [family, setFamily] = useState<Family | null>(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    familyApi.me().then((r) => setFamily(r.family)).catch(() => {});
    CapApp.getInfo()
      .then((i) => setAppInfo(`${i.name} ${i.version} (build ${i.build})`))
      .catch(() => setAppInfo(''));
  }, []);

  function save() {
    setSetting(Keys.apiURL, apiURL.trim());
    setSetting(Keys.geminiApiKey, geminiKey.trim());
    setSetting(Keys.geminiModel, geminiModel.trim());
    setMsg('Réglages enregistrés.');
    setTimeout(() => setMsg(''), 2500);
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
        <IonButton expand="block" onClick={save}>Enregistrer</IonButton>
        {msg && <IonText color="success"><p>{msg}</p></IonText>}

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
