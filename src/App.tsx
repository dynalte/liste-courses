import React, { useEffect, useState } from 'react';
import { IonApp, IonRouterOutlet, IonTabs, IonTabBar, IonTabButton, IonIcon, IonLabel } from '@ionic/react';
// Routage en hash (#/listes) : l'app tourne dans un sous-dossier web
// (/courses/) sans rewrite serveur, et à l'identique sous Capacitor.
import { IonReactHashRouter } from '@ionic/react-router';
import { Redirect, Route } from 'react-router-dom';
import { cartOutline, cameraOutline, restaurantOutline, nutritionOutline, settingsOutline } from 'ionicons/icons';

import AuthPage from './pages/AuthPage';
import ListsPage from './pages/ListsPage';
import FridgePage from './pages/FridgePage';
import RecipesPage from './pages/RecipesPage';
import DietPage from './pages/DietPage';
import SettingsPage from './pages/SettingsPage';
import { settings } from './services/settings';
import { syncFamilyGemini } from './services/serverApi';

const App: React.FC = () => {
  const [authed, setAuthed] = useState(() => settings.sessionToken !== '');

  // Clé Gemini familiale poussée automatiquement à la connexion.
  useEffect(() => {
    if (authed) void syncFamilyGemini();
  }, [authed]);

  if (!authed) {
    return (
      <IonApp>
        <AuthPage onAuth={() => setAuthed(true)} />
      </IonApp>
    );
  }

  return (
    <IonApp>
      <IonReactHashRouter>
        <IonTabs>
          <IonRouterOutlet>
            <Route exact path="/listes"><ListsPage /></Route>
            <Route exact path="/frigo"><FridgePage /></Route>
            <Route exact path="/recettes"><RecipesPage /></Route>
            <Route exact path="/diet"><DietPage /></Route>
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
            <IonTabButton tab="recettes" href="/recettes">
              <IonIcon icon={restaurantOutline} />
              <IonLabel>Recettes</IonLabel>
            </IonTabButton>
            <IonTabButton tab="diet" href="/diet">
              <IonIcon icon={nutritionOutline} />
              <IonLabel>Diététique</IonLabel>
            </IonTabButton>
            <IonTabButton tab="reglages" href="/reglages">
              <IonIcon icon={settingsOutline} />
              <IonLabel>Réglages</IonLabel>
            </IonTabButton>
          </IonTabBar>
        </IonTabs>
      </IonReactHashRouter>
    </IonApp>
  );
};

export default App;
