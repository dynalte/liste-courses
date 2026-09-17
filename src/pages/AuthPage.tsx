import React, { useState } from 'react';
import {
  IonPage, IonHeader, IonToolbar, IonTitle, IonContent,
  IonList, IonItem, IonInput, IonButton, IonText, IonSegment, IonSegmentButton, IonLabel,
} from '@ionic/react';
import { authApi } from '../services/serverApi';
import { setSetting, Keys } from '../services/settings';

const AuthPage: React.FC<{ onAuth: () => void }> = ({ onAuth }) => {
  const [mode, setMode] = useState<'login' | 'register' | 'join'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [familyName, setFamilyName] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    setError('');
    setBusy(true);
    try {
      const e = email.trim();
      const p = password;
      if (!e || !p) throw new Error('Email et mot de passe requis.');
      if (mode === 'login') {
        const r = await authApi.login(e, p);
        setSetting(Keys.sessionToken, r.token);
        setSetting(Keys.userEmail, e);
        setSetting(Keys.userName, r.name || '');
      } else if (mode === 'register') {
        if (!name.trim() || !familyName.trim()) throw new Error('Prénom et nom de famille requis.');
        const r = await authApi.register(e, p, name.trim(), familyName.trim());
        setSetting(Keys.sessionToken, r.token);
        setSetting(Keys.userEmail, e);
        setSetting(Keys.userName, name.trim());
      } else {
        if (!name.trim() || !inviteCode.trim()) throw new Error('Prénom et code d’invitation requis.');
        const r = await authApi.join(e, p, name.trim(), inviteCode.trim().toUpperCase());
        setSetting(Keys.sessionToken, r.token);
        setSetting(Keys.userEmail, e);
        setSetting(Keys.userName, name.trim());
      }
      onAuth();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <IonPage>
      <IonHeader><IonToolbar><IonTitle>Connexion famille</IonTitle></IonToolbar></IonHeader>
      <IonContent className="ion-padding">
        <IonSegment value={mode} onIonChange={(e) => setMode(e.detail.value as any)}>
          <IonSegmentButton value="login"><IonLabel>Entrer</IonLabel></IonSegmentButton>
          <IonSegmentButton value="register"><IonLabel>Créer</IonLabel></IonSegmentButton>
          <IonSegmentButton value="join"><IonLabel>Rejoindre</IonLabel></IonSegmentButton>
        </IonSegment>
        <IonList style={{ marginTop: 12 }}>
          <IonItem><IonInput label="Email" type="email" value={email} onIonInput={(e) => setEmail(e.detail.value ?? '')} /></IonItem>
          <IonItem><IonInput label="Mot de passe" type="password" value={password} onIonInput={(e) => setPassword(e.detail.value ?? '')} /></IonItem>
          {mode !== 'login' && (
            <IonItem><IonInput label="Prénom" value={name} onIonInput={(e) => setName(e.detail.value ?? '')} /></IonItem>
          )}
          {mode === 'register' && (
            <IonItem><IonInput label="Nom de la famille" placeholder="Ex : Dupont" value={familyName} onIonInput={(e) => setFamilyName(e.detail.value ?? '')} /></IonItem>
          )}
          {mode === 'join' && (
            <IonItem><IonInput label="Code d’invitation" placeholder="Ex : A8F3KQ" value={inviteCode} onIonInput={(e) => setInviteCode((e.detail.value ?? '').toUpperCase())} /></IonItem>
          )}
        </IonList>
        {error && <IonText color="danger"><p>{error}</p></IonText>}
        <IonButton expand="block" onClick={submit} disabled={busy}>
          {busy ? '…' : mode === 'login' ? 'Se connecter' : mode === 'register' ? 'Créer la famille' : 'Rejoindre'}
        </IonButton>
        <p className="status-bar">
          {mode === 'register'
            ? 'Crée une famille : tu recevras un code d’invitation à partager.'
            : mode === 'join'
              ? 'Demande le code d’invitation (Réglages > Famille chez le créateur).'
              : 'Chaque membre se connecte avec son propre compte.'}
        </p>
      </IonContent>
    </IonPage>
  );
};

export default AuthPage;
