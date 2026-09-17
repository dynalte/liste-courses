# Liste Courses Famille (Ionic React)

App familiale de liste de courses partagée, calquée sur `download-manager-ionic`.

- **Comptes** : chaque membre a son compte (email + mot de passe). Le créateur ouvre une famille et partage un **code d'invitation à 6 caractères** (Réglages > Famille).
- **Backend** : `api-liste-courses.php` (PHP + SQLite, `data/liste-courses.sqlite` créée au 1er appel). Déploiement comme l'autre projet :
  ```sh
  ssh photos2
  cp api-liste-courses.php /srv/web/photos/api-liste-courses.php
  # URL : http://photos2.dynaspirit.com:8080/api-liste-courses.php
  ```
- **Frigo → IA** : onglet Frigo, photo via `@capacitor/camera`, envoi direct à **Gemini Vision** depuis l'app (clé dans Réglages, jamais sur le serveur PHP). Bouton « + Ajouter à la liste » pour injecter les `toBuy` dans la liste active.
- **Code-barres** : bouton Scan sur l'onglet Courses (caméra native via `@capacitor-mlkit/barcode-scanning`, iOS/Android) ou saisie manuelle du code (marche aussi sur web). Nom du produit récupéré automatiquement sur les bases publiques gratuites : **Open Food Facts** (alimentaire) → **Open Products Facts** → **Open Beauty Facts**, sans clé API — et **ajouté directement** à la liste active, sans taper +. Si le code est inconnu, complète le nom à la main.

## Dev

```sh
npm install
npm run dev     # :8101
npm run build   # tsc + vite
npx cap sync    # après build pour iOS/Android
```

## Actions API

Publiques : `ping`, `register`, `login`, `join`. Authentifiées (`X-Session-Token`) : `me`, `logout`, `invite_rotate`, `lists_get`, `lists_create`, `items_add`, `items_add_many`, `items_toggle`, `items_delete`, `items_clear_checked`.
