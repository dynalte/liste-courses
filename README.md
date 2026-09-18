# Liste Courses Famille (Ionic React)

App familiale de liste de courses partagée, calquée sur `download-manager-ionic`.

- **Comptes** : chaque membre a son compte (email + mot de passe). Le créateur ouvre une famille et partage un **code d'invitation à 6 caractères** (Réglages > Famille). Création de nouvelles familles **désactivée** (`ALLOW_REGISTER=false` côté PHP).
- **Backend** : `api-liste-courses.php` (PHP + SQLite, `data/liste-courses.sqlite` créée au 1er appel).
  Servi en **HTTPS via Caddy** (labels `caddy` + réseau `caddy` sur le service php,
  `/data/compose/11/docker-compose.yml`, projet `php`) :
  `https://photos2.dynaspirit.com/api-liste-courses.php`
  (le `:8080` direct reste actif en repli).
- **Web** : https://photos2.dynaspirit.com/courses/ (`npm run deploy:web`).
- **Frigo → IA** : onglet Frigo, photo via `@capacitor/camera`, envoi direct à **Gemini Vision** depuis l'app (clé dans Réglages, jamais sur le serveur PHP). Bouton « + Ajouter à la liste » pour injecter les `toBuy` dans la liste active.
- **Code-barres** : bouton Scan sur l'onglet Courses (caméra native via `@capacitor-mlkit/barcode-scanning`, iOS/Android) ou saisie manuelle du code (marche aussi sur web). Nom du produit récupéré automatiquement sur les bases publiques gratuites : **Open Food Facts** (alimentaire) → **Open Products Facts** → **Open Beauty Facts**, sans clé API — et **ajouté directement** à la liste active, sans taper +. Si le code est inconnu, complète le nom à la main.
- **📝 Liste papier / 📷 Produit** : photo d'une liste manuscrite → transcription IA → ajout direct (avec quantités) ; photo d'un produit → reconnaissance IA (emballage/marque) → ajout direct. Même moteur Gemini Vision que le frigo.
- **Clé Gemini partagée** : stockée côté famille (`family_set_gemini`, owner), poussée aux apps à la connexion (`syncFamilyGemini`) — plus de saisie par appareil. L'IA reste appelée en direct depuis l'app.
- **Temps réel** : l'onglet Courses se réactualise toutes les 10 s + au retour avant-plan. Chaque modification est journalisée côté PHP (`activity`) : un toast affiche « Marie a ajouté Lait », et une notification locale part au retour dans l'app (désactivable dans Réglages). Limite assumée : pas de push en arrière-plan complet (nécessiterait APNs/FCM) — à faire en v2 si besoin.
- **Mode magasin** : steppers +/− sur les quantités, groupement par rayon auto-suggéré (corrigible d'un tap : balayer vers la droite), fiche d'édition au tap sur le nom, bouton « Tout cocher ». Colonne SQLite `rayon` (migration auto) + action `items_update`.
- **Cycle de vie** : modèles réutilisables → liste de semaine → clôture → archives. `lists_duplicate` (nouvelle semaine depuis modèle/archive, articles décochés prix à 0), `lists_set_archived` (tout membre), `lists_delete` + création de modèles (owner). Sections En cours (chips) / Modèles / Archives dans l'onglet Courses.

## Dev

```sh
npm install
npm run dev     # :8101
npm run build   # tsc + vite
npx cap sync    # après build pour iOS/Android
```

## Web

Version web servie en sous-dossier (routage en hash `#/…`, aucun rewrite serveur requis) :
**http://photos2.dynaspirit.com:8080/courses/**

```sh
npm run deploy:web   # build + copie dist/ → photos2:/srv/web/photos/courses/
```

Sur web : scan caméra remplacé par la saisie manuelle du code, vidéo via le sélecteur
système, notifs via le navigateur. Le reste (listes, frigo IA, temps réel) est identique.

**Installer comme app (Chrome Android/desktop)** : ouvrir la page, icône d'installation
dans la barre d'adresse (⊕) → « Installer ». PWA vérifiée : manifest + service worker
actif (scope `/courses/`), icônes 192/512 + maskable, HTTPS.

## Actions API

Publiques : `ping`, `register`, `login`, `join`. Authentifiées (`X-Session-Token`) : `me`, `logout`, `invite_rotate`, `lists_get`, `lists_create`, `items_add`, `items_add_many`, `items_toggle`, `items_delete`, `items_clear_checked`.
