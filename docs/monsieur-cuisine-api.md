# API Monsieur Cuisine — note technique (pour LLM et devs)

> Pas d'API publique officielle Lidl. Tout ci-dessous est reverse-engineeré
> (site `monsieur-cuisine.com` + projet MIT `gerkensm/smart-recipe`).
> Implémentation de référence dans ce repo : `api-liste-courses.php`
> (actions `mc_search`, `mc_categories`, `mc_recipe`, `mc_session`).

## 1. Catalogue public (SANS authentification)

Base : `https://mc-api.tecpal.com` — headers requis :
`User-Agent: Mozilla/5.0`, `Accept-Language: fr-FR` (**c'est lui qui fixe la
langue**, pas un paramètre), `device-type: MC3.0`.

| Besoin | Endpoint | Notes |
|---|---|---|
| Recherche / parcours | `GET /api/v1/recipes/search/page/{n}?q=...&sortBy[0][field]=...&sortBy[0][direction]=DESC` | `q` vide = nouveautés. 20/page. Validation stricte : tout paramètre inconnu est rejeté (`"xxx" is not allowed`). |
| Filtre catégories | même endpoint + `filters[category][]={id}` répété | IDs numériques (pas les noms). |
| Tris | `sortBy[0][field]` = `lastUpdated` (nouveautés), `popularity` (populaires), `rating` (mieux notées), `title`, `duration` | Direction `DESC` (ou `ASC` pour title A→Z). |
| Catégories | `GET /api/v1/categories` | `{data: {categories: [{id, name, order}]}}` — 25 entrées FR. |
| Détail recette | `GET /api/v2/recipes/{id}` | `{code: 0, data: {recipe: {...}}}`. **Pas** la v1 (`/api/v1/recipes/{id}` = stub). |
| Référentiel ingrédients | `GET /api/v2/ingredients` | 6193 entrées, ~2,6 Mo. `{data: {ingredients: [{id, translations: [{systemIngredientId, language, name}]}]}}`. Choisir traduction `fr-FR`, repli `en-US`, sinon 1re non vide. |

Réponse recherche : `{code: 0, data: {language, total, resultNo, pageSize,
currentPage, totalPage, recipes: [{id, translationId, language, name,
complexity, preparationDuration, duration, rating, totalRating,
thumbnail: {landscape, portrait}, categories: [{id, name}], url}]}}`.

Réponse détail v2 (`data.recipe`) :
- Titre = champ **`name`** (pas `title`). Durées = `preparationDuration`,
  `duration`. Photo = `detailsImage.landscape ?? thumbnail.landscape`.
- Portions : `servingSizes[0].amount` + **`servingUnit`** (pas `unit`).
  Le PHP expose aussi `servingsNum` (nombre brut) pour la mise à l'échelle,
  et chaque ingrédient porte `amount` (float|null, `"0,48"` → 0.48) + `unit`.
- Ingrédients **à plat** : `servingSizes[0].ingredients[]` =
  `{order, amount (STRING, ex "60"), unit, systemIngredientId,
  ingredientGroupId (souvent null), name (souvent null!), ingredientCategory
  ({id, name} ou null)}`. Groupes séparés : `ingredientGroups[]` (`{id, name}`,
  souvent vide → un seul groupe sans nom).
- **`name: null` fréquent** (créations de membres) : résoudre via
  `systemIngredientId` + référentiel ci-dessus. IDs absents du référentiel
  → devinette IA avec contexte (titre + autres ingrédients + qté/catégorie).
- Étapes : `servingSizes[0].steps[]` =
  `{order|step (BASE 0 !), name, description, deviceSetting, video}`.

`deviceSetting` (modes robot) : `{mode, reverse, turbo, size, texture,
cleaningMode, settings: [{speed, temperature (°C), time (SECONDES),
weight (g)}]}`. Modes vus : `scale` (pesée), `customized` (manuel), `roast`,
`slowCook`, `steam`, `knead`, `sousVide`, `turbo`, `precleaning`,
`fermentation`, `riceCooking`, `foodProcessor`, `puree`, `smoothie`.
`reverse: true` = rotation à gauche (sens inverse), `false` = à droite.
Le site affiche la température même à 0 et toujours le sens de rotation.

## 2. Données privées (AVEC session Lidl Plus)

Tout passe par `POST https://www.monsieur-cuisine.com/proxy-api` avec :
```json
{"endpoint": "api/v3/auth/user/recipes/123", "method": "GET", "lang": "fr-FR"}
```
Headers : `Content-Type: application/json`, `User-Agent: Mozilla/5.0`,
`X-Request-ID: <uuid>` (**obligatoire**, sinon `xRequestId should not be empty`),
`x-bypass-cdn: cd844315-77c4-46ba-83fe-7702d13b12b2`,
`device-type: web`, `Accept-Language: fr-FR`,
`Referer: https://www.monsieur-cuisine.com/fr/creer-une-recette?devices=mc-smart`,
`Cookie: <session>`.

Endpoints utiles : `api/v1/users` (test session, cf. `getCurrentUser`),
`api/v3/auth/user/recipes/{id}` (brouillon/recette perso, réponse
`{data: {recipe: {title, servingSizes: [{amount, unit, ingredientGroups:
[{name, ingredients: [{amount (number|string), unit, name, isOptional}]}],
steps: [{title, description|text, mode}]}})}}`).

**Session** = cookies du domaine `www.monsieur-cuisine.com` :
`wordpress_logged_in_*` + `wordpress_sec_*` (+ `lidl_sso_id_token` quand
présent), format `nom=valeur; nom2=valeur2`. Testée via `api/v1/users`.
**Attention** : une session WordPress seule peut suffire pour `api/v1/users`
mais être rejetée (`403 Insufficient permission`) sur `api/v3/...` — dans ce
cas, repli sur la voie publique.

## 3. Login : PAS d'email/mot de passe automatisable

Le SSO Lidl (`accounts.lidl.com`, OAuth `client_id=monsieurcuisinewebcompanionclient`)
exige un **token reCAPTCHA généré dans le navigateur** à chaque envoi du mot
de passe (+ mention Cloudflare). `smart-recipe` ne s'en sort que via un vrai
Chromium (Playwright). Donc : pas de `mc_login` par mot de passe — l'utilisateur
se connecte dans son navigateur puis colle son cookie (stocké appareil uniquement,
transmis au PHP à chaque appel, jamais persisté serveur).

## 4. Pièges rencontrés

- `Accept-Language` header > tout paramètre de langue (rejetés en 400).
- `amount` string en v2 (`"60"`, voire `"0,48"` avec virgule) vs number en v3.
- `order` des steps en base 0 → afficher position+1.
- `ingredientCategory` est un objet : ce n'est PAS le nom de l'ingrédient.
- IDs du catalogue parfois absents de la route `auth/user` → toujours tenter
  public en repli (et inversement pour les brouillons privés).
- `X-Request-ID` manquant → `400 xRequestId should not be empty`.
- Référentiel ingrédients : mettre en cache (fichier 7 j), sinon 2,6 Mo/appel.
