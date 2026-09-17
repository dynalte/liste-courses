import React, { useState } from 'react';
import { IonApp, IonRouterOutlet, IonTabs, IonTabBar, IonTabButton, IonIcon, IonLabel } from '@ionic/react';
import { IonReactRouter } from '@ionic/react-router';
import { Redirect, Route } from 'react-router-dom';
import { cartOutline, cameraOutline, settingsOutline } from 'ionicons/icons';

import AuthPage from './pages/AuthPage';
import ListsPage from './pages/ListsPage';
import FridgePage from './pages/FridgePage';
import SettingsPage from './pages/SettingsPage';
import { settings } from './services/settings';

const App: React.FC = () => {
  const [authed, setAuthed] = useState(() => settings.sessionToken !== '');

  if (!authed) {
    return (
      <IonApp>
        <AuthPage onAuth={() => setAuthed(true)} />
      </IonApp>
    );
  }

  return (
    <IonApp>
      <IonReactRouter>
        <IonTabs>
          <IonRouterOutlet>
            <Route exact path="/listes"><ListsPage /></Route>
            <Route exact path="/frigo"><FridgePage /></Route>
            <Route exact path="/reglages"><SettingsPage onLogout={() => setAuthed(false)} /></Route>
            <Route exact path="/"><Redirect to="/listes" /></Route>
          </IonRouterOutlet>
          <IonTabBar slot="bottom">
            <IonTabButton tab="listes" href="/listes">
              <IonIcon icon={cartOutline} />
              <IonLabel>Courses</IonLabel>
            </IonTabButton>
            <IonTabButton tab="frigo" href="/frigo">
              <IonIcon icon={cameraOutline} />
              <IonLabel>Frigo IA</IonLabel>
            </IonTabButton>
            <IonTabButton tab="reglages" href="/reglages">
              <IonIcon icon={settingsOutline} />
              <IonLabel>Réglages</IonLabel>
            </IonTabButton>
          </IonTabBar>
        </IonTabs>
      </IonReactRouter>
    </IonApp>
  );
};

export default App;
