<?php
/*
    API « Liste Courses Famille » — backend PHP + SQLite, même esprit que api-download-manager.php.

    Déploiement :  ssh photos2
                    cp api-liste-courses.php /srv/web/photos/api-liste-courses.php
    URL :           http://photos2.dynaspirit.com:8080/api-liste-courses.php

    Prérequis serveur : php-sqlite3 (pdo_sqlite) + dossier data/ writable.
    Base créée au 1er appel : data/liste-courses.sqlite (à côté du script).

    Modèle :
      - 1 famille = 1 code d'invitation (6 lettres/chiffres, régénérable).
      - Chaque membre a son compte (email + mot de passe hashé).
      - Session = token aléatoire (header X-Session-Token), valable 1 an.
      - Listes appartenant à la famille, items partagés, ajout par nom.

    Actions publiques (sans session) :
      GET  ?action=ping
      POST ?action=register {email, password, name, familyName}
        → DÉSACTIVÉ par défaut (ALLOW_REGISTER=false) : inscriptions fermées,
          les membres rejoignent via join + code d'invitation.
      POST ?action=login    {email, password}
      POST ?action=join     {email, password, name, inviteCode}

    Actions authentifiées (header X-Session-Token ou ?session=) :
      GET  ?action=me
      POST ?action=invite_rotate                       → nouveau code (owner uniquement)
      POST ?action=family_set_gemini {key, model}       → clé IA partagée (owner)
      GET  ?action=lists_get                           → listes + items de la famille
                                                  + activity (15 derniers événements :
                                                    qui a fait quoi) + you (id courant)
      Listes (cycle de vie : modèle → semaine → archive) :
      POST ?action=lists_create {name, isTemplate?}       (owner)
      POST ?action=lists_duplicate {listId, name?, asTemplate?}
             → nouvelle semaine depuis modèle/archive (tous), ou
               enregistrement comme modèle (owner). Articles décochés, prix à 0.
      POST ?action=lists_set_archived {listId, archived}  (tous : clôturer/rouvrir)
      POST ?action=lists_delete {listId}                  (owner)
      POST ?action=items_add {listId, name, qty?}
      POST ?action=items_add_many {listId, names:[...]} → ajout en masse (frigo IA,
        liste manuscrite). names accepte "Lait" ou {name, qty}.
      POST ?action=items_toggle {itemId, checked}
      POST ?action=items_update {itemId, name?, qty?, price?, rayon?}
      POST ?action=items_delete {itemId}
      POST ?action=items_clear_checked {listId}
      POST ?action=mc_recipe {recipeId|url, cookie, lang?} → recette Monsieur
        Cuisine (via proxy-api, cookie Lidl Plus fourni à chaque appel, jamais
        stocké) : {id, title, servings, groups:[{name, items:[{name,qty,optional}]}]}
      POST ?action=mc_search {q?, page?, lang?, sort?, categories?} → catalogue
        public MC : {total, totalPage, currentPage, recipes:[...]}
        (q vide = nouveautés ; sort = new|popular|top ; categories = IDs MC)
      POST ?action=mc_categories {lang?} → catégories MC : [{id, name}]
      POST ?action=mc_session {cookie, lang?} → valide la session MC :
        {user} (distingue cookie invalide / recette introuvable)
      Journal diététique personnel :
      POST ?action=diet_add {day, meal, dish, items, kcal, protein, carbs,
        fat, score, comment} → {id} (day = AAAA-MM-JJ)
      GET  ?action=diet_list {limit?} → [{id, day, meal, dish, items, kcal,
        protein, carbs, fat, score, comment, hasPhoto}]
      GET  ?action=diet_photo {entryId} → JPEG (ses propres entrées,
        auth via header ou ?session= pour les <img>)
      Recettes favorites :
      POST ?action=fav_add {recipeId, title?, image?} → {ok}
      GET  ?action=fav_list → [{recipeId, title, image, addedAt}]
      POST ?action=fav_delete {recipeId} → {ok}
      POST ?action=diet_delete {entryId} (ses propres entrées)
      POST ?action=logout
*/
declare(strict_types=1);

// ================= CONFIG =================
const DB_FILE = __DIR__ . '/data/liste-courses.sqlite';
const SESSION_TTL = 365 * 24 * 3600; // 1 an
// Création de nouvelles familles : false = inscription fermée
// (les membres rejoignent via ?action=join + code d'invitation).
// Passer à true pour rouvrir les inscriptions.
const ALLOW_REGISTER = false;
// ==========================================

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Headers: Content-Type, X-Session-Token');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') {
    http_response_code(204);
    exit;
}

function out(array $data, int $code = 200): void
{
    http_response_code($code);
    echo json_encode($data, JSON_UNESCAPED_UNICODE);
    exit;
}

function fail(string $msg, int $code = 400): void
{
    out(['ok' => false, 'error' => $msg], $code);
}

function body(): array
{
    $input = json_decode(file_get_contents('php://input') ?: 'null', true);
    return is_array($input) ? $input : [];
}

function valid_email(string $e): bool
{
    return (bool) filter_var($e, FILTER_VALIDATE_EMAIL);
}

function new_token(): string
{
    return bin2hex(random_bytes(32));
}

function new_invite(PDO $db): string
{
    $alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // sans I/L/O/0/1
    for ($try = 0; $try < 50; $try++) {
        $code = '';
        for ($i = 0; $i < 6; $i++) {
            $code .= $alphabet[random_int(0, strlen($alphabet) - 1)];
        }
        $st = $db->prepare('SELECT 1 FROM families WHERE invite_code = :c');
        $st->execute([':c' => $code]);
        if (!$st->fetch()) return $code;
    }
    throw new RuntimeException('Impossible de générer un code.');
}

// ---- Base SQLite ----
try {
    @mkdir(__DIR__ . '/data', 0775, true);
    $db = new PDO('sqlite:' . DB_FILE);
    $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $db->exec('PRAGMA foreign_keys = ON');
    $db->exec(
        'CREATE TABLE IF NOT EXISTS families (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            invite_code TEXT NOT NULL UNIQUE,
            created_at INTEGER NOT NULL
        )'
    );
    $db->exec(
        'CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL,
            pass_hash TEXT NOT NULL,
            family_id INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
            role TEXT NOT NULL DEFAULT \'member\',
            created_at INTEGER NOT NULL
        )'
    );
    $db->exec(
        'CREATE TABLE IF NOT EXISTS sessions (
            token TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            created_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL
        )'
    );
    $db->exec(
        'CREATE TABLE IF NOT EXISTS lists (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            family_id INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            created_at INTEGER NOT NULL
        )'
    );
    $db->exec(
        'CREATE TABLE IF NOT EXISTS items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            qty TEXT NOT NULL DEFAULT \'\',
            checked INTEGER NOT NULL DEFAULT 0,
            added_by INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        )'
    );
    $db->exec('CREATE INDEX IF NOT EXISTS idx_items_list ON items(list_id)');
    $db->exec('CREATE INDEX IF NOT EXISTS idx_users_family ON users(family_id)');
    // Migrations douces (colonnes ajoutées après coup).
    foreach ([
        'ALTER TABLE items ADD COLUMN price REAL NOT NULL DEFAULT 0',
        "ALTER TABLE items ADD COLUMN rayon TEXT NOT NULL DEFAULT 'Divers'",
        'ALTER TABLE lists ADD COLUMN is_template INTEGER NOT NULL DEFAULT 0',
        'ALTER TABLE lists ADD COLUMN archived INTEGER NOT NULL DEFAULT 0',
        'ALTER TABLE lists ADD COLUMN archived_at INTEGER NOT NULL DEFAULT 0',
        "ALTER TABLE families ADD COLUMN gemini_key TEXT NOT NULL DEFAULT ''",
        "ALTER TABLE families ADD COLUMN gemini_model TEXT NOT NULL DEFAULT ''",
    ] as $sql) {
        try {
            $db->exec($sql);
        } catch (Throwable $e) { /* déjà présente */
        }
    }
    // Journal d'activité (qui a fait quoi) pour le temps réel côté app.
    // user_name dénormalisé : l'historique survit aux changements de profil.
    $db->exec(
        'CREATE TABLE IF NOT EXISTS activity (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            family_id INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
            user_id INTEGER NOT NULL,
            user_name TEXT NOT NULL,
            action TEXT NOT NULL,
            item_name TEXT NOT NULL DEFAULT \'\',
            list_name TEXT NOT NULL DEFAULT \'\',
            created_at INTEGER NOT NULL
        )'
    );
    $db->exec('CREATE INDEX IF NOT EXISTS idx_activity_family ON activity(family_id, id)');
    // Suivi diététique personnel : une ligne par assiette photographiée
    // (plat + aliments + estimation nutritionnelle IA + photo réduite).
    $db->exec(
        'CREATE TABLE IF NOT EXISTS diet_entries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            day TEXT NOT NULL,
            meal TEXT NOT NULL DEFAULT \'\',
            dish TEXT NOT NULL DEFAULT \'\',
            items TEXT NOT NULL DEFAULT \'[]\',
            kcal REAL NOT NULL DEFAULT 0,
            protein REAL NOT NULL DEFAULT 0,
            carbs REAL NOT NULL DEFAULT 0,
            fat REAL NOT NULL DEFAULT 0,
            score INTEGER NOT NULL DEFAULT 0,
            comment TEXT NOT NULL DEFAULT \'\',
            photo TEXT NOT NULL DEFAULT \'\',
            created_at INTEGER NOT NULL
        )'
    );
    try {
        $db->exec("ALTER TABLE diet_entries ADD COLUMN photo TEXT NOT NULL DEFAULT ''");
    } catch (Throwable $e) { /* déjà présente */
    }
    $db->exec('CREATE INDEX IF NOT EXISTS idx_diet_user_day ON diet_entries(user_id, day)');
    // Recettes MC favorites (par utilisateur).
    $db->exec(
        'CREATE TABLE IF NOT EXISTS favorite_recipes (
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            recipe_id TEXT NOT NULL,
            title TEXT NOT NULL DEFAULT \'\',
            image TEXT NOT NULL DEFAULT \'\',
            added_at INTEGER NOT NULL,
            PRIMARY KEY (user_id, recipe_id)
        )'
    );
} catch (Throwable $e) {
    fail('SQLite indisponible (php-sqlite3 ? dossier data/ writable ?) : ' . $e->getMessage(), 500);
}

$action = (string) ($_GET['action'] ?? 'ping');
$PUBLIC = ['ping', 'register', 'login', 'join'];

if ($action === 'ping') {
    out(['ok' => true, 'time' => time()]);
}

// ---------- inscription : crée famille + owner + liste "Courses" ----------
if ($action === 'register') {
    if (!ALLOW_REGISTER) fail('Création de famille désactivée : demande le code d’invitation à un membre.', 403);
    $b = body();
    $email = strtolower(trim((string) ($b['email'] ?? '')));
    $password = (string) ($b['password'] ?? '');
    $name = trim((string) ($b['name'] ?? ''));
    $familyName = trim((string) ($b['familyName'] ?? ''));
    if (!valid_email($email)) fail('Email invalide.', 400);
    if (strlen($password) < 6) fail('Mot de passe trop court (6 caractères min).', 400);
    if ($name === '' || $familyName === '') fail('Prénom et nom de famille requis.', 400);
    $st = $db->prepare('SELECT 1 FROM users WHERE email = :e');
    $st->execute([':e' => $email]);
    if ($st->fetch()) fail('Ce compte existe déjà (connecte-toi ou rejoins avec un code).', 409);
    try {
        $db->beginTransaction();
        $code = new_invite($db);
        $db->prepare('INSERT INTO families (name, invite_code, created_at) VALUES (:n, :c, :t)')
            ->execute([':n' => $familyName, ':c' => $code, ':t' => time()]);
        $famId = (int) $db->lastInsertId();
        $db->prepare('INSERT INTO users (email, name, pass_hash, family_id, role, created_at) VALUES (:e,:n,:h,:f,\'owner\',:t)')
            ->execute([':e' => $email, ':n' => $name, ':h' => password_hash($password, PASSWORD_DEFAULT), ':f' => $famId, ':t' => time()]);
        $userId = (int) $db->lastInsertId();
        $db->prepare('INSERT INTO lists (family_id, name, created_at) VALUES (:f, \'Courses\', :t)')
            ->execute([':f' => $famId, ':t' => time()]);
        $token = new_token();
        $db->prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (:t,:u,:c,:x)')
            ->execute([':t' => $token, ':u' => $userId, ':c' => time(), ':x' => time() + SESSION_TTL]);
        $db->commit();
    } catch (Throwable $e) {
        if ($db->inTransaction()) $db->rollBack();
        fail('Inscription impossible : ' . $e->getMessage(), 500);
    }
    out(['ok' => true, 'token' => $token, 'userId' => $userId, 'family' => family_payload($db, $famId)]);
}

// ---------- connexion ----------
if ($action === 'login') {
    $b = body();
    $email = strtolower(trim((string) ($b['email'] ?? '')));
    $password = (string) ($b['password'] ?? '');
    $st = $db->prepare('SELECT * FROM users WHERE email = :e');
    $st->execute([':e' => $email]);
    $u = $st->fetch(PDO::FETCH_ASSOC);
    if (!$u || !password_verify($password, (string) $u['pass_hash'])) {
        fail('Email ou mot de passe incorrect.', 401);
    }
    $token = new_token();
    $db->prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (:t,:u,:c,:x)')
        ->execute([':t' => $token, ':u' => (int) $u['id'], ':c' => time(), ':x' => time() + SESSION_TTL]);
    out(['ok' => true, 'token' => $token, 'userId' => (int) $u['id'], 'name' => (string) $u['name']]);
}

// ---------- rejoindre via code d'invitation ----------
if ($action === 'join') {
    $b = body();
    $email = strtolower(trim((string) ($b['email'] ?? '')));
    $password = (string) ($b['password'] ?? '');
    $name = trim((string) ($b['name'] ?? ''));
    $invite = strtoupper(trim((string) ($b['inviteCode'] ?? '')));
    if (!valid_email($email)) fail('Email invalide.', 400);
    if ($name === '') fail('Prénom requis.', 400);
    if ($invite === '') fail('Code d’invitation requis.', 400);
    $st = $db->prepare('SELECT * FROM families WHERE invite_code = :c');
    $st->execute([':c' => $invite]);
    $fam = $st->fetch(PDO::FETCH_ASSOC);
    if (!$fam) fail('Code d’invitation inconnu.', 404);
    $famId = (int) $fam['id'];
    $st = $db->prepare('SELECT * FROM users WHERE email = :e');
    $st->execute([':e' => $email]);
    $u = $st->fetch(PDO::FETCH_ASSOC);
    if ($u) {
        // Compte existant : vérifie le mot de passe puis rattache à la famille.
        if (strlen($password) < 1 || !password_verify($password, (string) $u['pass_hash'])) {
            fail('Ce compte existe déjà : mot de passe incorrect.', 401);
        }
        $db->prepare('UPDATE users SET family_id = :f WHERE id = :id')->execute([':f' => $famId, ':id' => (int) $u['id']]);
        $userId = (int) $u['id'];
        if (trim((string) $u['name']) === '') {
            $db->prepare('UPDATE users SET name = :n WHERE id = :id')->execute([':n' => $name, ':id' => $userId]);
        }
    } else {
        if (strlen($password) < 6) fail('Mot de passe trop court (6 caractères min).', 400);
        $db->prepare('INSERT INTO users (email, name, pass_hash, family_id, role, created_at) VALUES (:e,:n,:h,:f,\'member\',:t)')
            ->execute([':e' => $email, ':n' => $name, ':h' => password_hash($password, PASSWORD_DEFAULT), ':f' => $famId, ':t' => time()]);
        $userId = (int) $db->lastInsertId();
    }
    $token = new_token();
    $db->prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (:t,:u,:c,:x)')
        ->execute([':t' => $token, ':u' => $userId, ':c' => time(), ':x' => time() + SESSION_TTL]);
    out(['ok' => true, 'token' => $token, 'userId' => $userId, 'family' => family_payload($db, $famId)]);
}

// ---------- session requise pour la suite ----------
function session_token(): string
{
    if (function_exists('getallheaders')) {
        foreach (getallheaders() as $k => $v) {
            if (strtolower((string) $k) === 'x-session-token') return trim((string) $v);
        }
    }
    return trim((string) ($_GET['session'] ?? ''));
}

function require_user(PDO $db): array
{
    $tok = session_token();
    if ($tok === '') fail('Session requise.', 401);
    $st = $db->prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = :t AND s.expires_at > :now');
    $st->execute([':t' => $tok, ':now' => time()]);
    $u = $st->fetch(PDO::FETCH_ASSOC);
    if (!$u) fail('Session invalide ou expirée.', 401);
    return $u;
}

function family_payload(PDO $db, int $famId): array
{
    $st = $db->prepare('SELECT * FROM families WHERE id = :id');
    $st->execute([':id' => $famId]);
    $fam = $st->fetch(PDO::FETCH_ASSOC);
    if (!$fam) fail('Famille introuvable.', 404);
    $st = $db->prepare('SELECT id, email, name, role, created_at FROM users WHERE family_id = :f ORDER BY created_at ASC');
    $st->execute([':f' => $famId]);
    $members = [];
    foreach ($st->fetchAll(PDO::FETCH_ASSOC) as $m) {
        $members[] = [
            'id' => (int) $m['id'], 'email' => (string) $m['email'],
            'name' => (string) $m['name'], 'role' => (string) $m['role'],
            'createdAt' => (int) $m['created_at'],
        ];
    }
    return [
        'id' => (int) $fam['id'], 'name' => (string) $fam['name'],
        'inviteCode' => (string) $fam['invite_code'], 'members' => $members,
        // Clé Gemini partagée : poussée aux apps à la connexion (me/register/join).
        'geminiKey' => (string) ($fam['gemini_key'] ?? ''),
        'geminiModel' => (string) ($fam['gemini_model'] ?? ''),
    ];
}

/** Vérifie que la liste appartient à la famille de l'utilisateur, sinon 403/404. */
function require_family_list(PDO $db, array $user, int $listId): array
{
    $st = $db->prepare('SELECT * FROM lists WHERE id = :id');
    $st->execute([':id' => $listId]);
    $list = $st->fetch(PDO::FETCH_ASSOC);
    if (!$list) fail('Liste introuvable.', 404);
    if ((int) $list['family_id'] !== (int) $user['family_id']) fail('Liste d’une autre famille.', 403);
    return $list;
}

/**
 * Journal d'activité (best effort, jamais bloquant).
 * Actions : list_create | add | add_many | check | uncheck | edit | delete | clear
 *   | duplicate | template | archive | unarchive | delete_list.
 * Pour add_many/clear, item_name porte le nombre ("3") — voir client.
 */
function log_activity(PDO $db, array $user, string $action, string $item = '', string $list = ''): void
{
    try {
        $db->prepare(
            'INSERT INTO activity (family_id, user_id, user_name, action, item_name, list_name, created_at)
             VALUES (:f, :u, :n, :a, :i, :l, :t)'
        )->execute([
            ':f' => (int) $user['family_id'], ':u' => (int) $user['id'],
            ':n' => mb_substr((string) $user['name'], 0, 60), ':a' => $action,
            ':i' => mb_substr($item, 0, 120), ':l' => mb_substr($list, 0, 60),
            ':t' => time(),
        ]);
        // Plafond : 100 dernières entrées par famille.
        $famId = (int) $user['family_id'];
        $db->exec(
            'DELETE FROM activity WHERE family_id = ' . $famId .
            ' AND id NOT IN (SELECT id FROM activity WHERE family_id = ' . $famId . ' ORDER BY id DESC LIMIT 100)'
        );
    } catch (Throwable $e) { /* ignore */
    }
}

if (!in_array($action, $PUBLIC, true)) {
    // Nettoyage opportuniste des sessions expirées (1 fois sur ~50 appels).
    if (random_int(1, 50) === 1) {
        try {
            $db->prepare('DELETE FROM sessions WHERE expires_at <= :now')->execute([':now' => time()]);
        } catch (Throwable $e) { /* ignore */
        }
    }
}

if ($action === 'me') {
    $u = require_user($db);
    out([
        'ok' => true,
        'user' => ['id' => (int) $u['id'], 'email' => (string) $u['email'], 'name' => (string) $u['name'], 'role' => (string) $u['role'], 'createdAt' => (int) $u['created_at']],
        'family' => family_payload($db, (int) $u['family_id']),
    ]);
}

if ($action === 'logout') {
    $tok = session_token();
    if ($tok !== '') {
        $db->prepare('DELETE FROM sessions WHERE token = :t')->execute([':t' => $tok]);
    }
    out(['ok' => true]);
}

if ($action === 'invite_rotate') {
    $u = require_user($db);
    if (($u['role'] ?? '') !== 'owner') fail('Seul le créateur peut régénérer le code.', 403);
    $code = new_invite($db);
    $db->prepare('UPDATE families SET invite_code = :c WHERE id = :id')
        ->execute([':c' => $code, ':id' => (int) $u['family_id']]);
    out(['ok' => true, 'inviteCode' => $code]);
}

/**
 * Clé Gemini partagée de la famille (owner uniquement).
 * Poussée aux apps via me/register/join → plus de saisie par appareil.
 */
if ($action === 'family_set_gemini') {
    $u = require_user($db);
    if (($u['role'] ?? '') !== 'owner') fail('Seul le créateur peut changer la clé IA.', 403);
    $b = body();
    $key = trim((string) ($b['key'] ?? ''));
    $model = trim((string) ($b['model'] ?? ''));
    if (mb_strlen($key) > 200) $key = mb_substr($key, 0, 200);
    if (mb_strlen($model) > 80) $model = mb_substr($model, 0, 80);
    $db->prepare('UPDATE families SET gemini_key = :k, gemini_model = :m WHERE id = :id')
        ->execute([':k' => $key, ':m' => $model, ':id' => (int) $u['family_id']]);
    out(['ok' => true]);
}

if ($action === 'lists_get') {
    $u = require_user($db);
    $st = $db->prepare('SELECT * FROM lists WHERE family_id = :f ORDER BY archived ASC, is_template ASC, created_at ASC');
    $st->execute([':f' => (int) $u['family_id']]);
    $lists = [];
    // Noms des membres pour "ajouté par".
    $names = [];
    $ms = $db->prepare('SELECT id, name FROM users WHERE family_id = :f');
    $ms->execute([':f' => (int) $u['family_id']]);
    foreach ($ms->fetchAll(PDO::FETCH_ASSOC) as $m) $names[(int) $m['id']] = (string) $m['name'];
    foreach ($st->fetchAll(PDO::FETCH_ASSOC) as $l) {
        $is = $db->prepare('SELECT * FROM items WHERE list_id = :l ORDER BY checked ASC, updated_at DESC, id DESC');
        $is->execute([':l' => (int) $l['id']]);
        $items = [];
        foreach ($is->fetchAll(PDO::FETCH_ASSOC) as $it) {
            $items[] = [
                'id' => (int) $it['id'], 'listId' => (int) $it['list_id'],
                'name' => (string) $it['name'], 'qty' => (string) $it['qty'],
                'price' => isset($it['price']) ? (float) $it['price'] : 0.0,
                'rayon' => isset($it['rayon']) && (string) $it['rayon'] !== '' ? (string) $it['rayon'] : 'Divers',
                'checked' => ((int) $it['checked']) === 1,
                'addedBy' => (int) $it['added_by'],
                'addedByName' => $names[(int) $it['added_by']] ?? '',
                'createdAt' => (int) $it['created_at'], 'updatedAt' => (int) $it['updated_at'],
            ];
        }
        $lists[] = [
            'id' => (int) $l['id'], 'familyId' => (int) $l['family_id'], 'name' => (string) $l['name'],
            'isTemplate' => ((int) ($l['is_template'] ?? 0)) === 1,
            'archived' => ((int) ($l['archived'] ?? 0)) === 1,
            'archivedAt' => (int) ($l['archived_at'] ?? 0),
            'items' => $items,
        ];
    }
    // Fil d'activité pour le temps réel (15 dernières, ordre chrono).
    $as = $db->prepare('SELECT * FROM activity WHERE family_id = :f ORDER BY id DESC LIMIT 15');
    $as->execute([':f' => (int) $u['family_id']]);
    $activity = [];
    foreach (array_reverse($as->fetchAll(PDO::FETCH_ASSOC)) as $a) {
        $activity[] = [
            'id' => (int) $a['id'], 'userId' => (int) $a['user_id'],
            'actor' => (string) $a['user_name'], 'action' => (string) $a['action'],
            'item' => (string) $a['item_name'], 'list' => (string) $a['list_name'],
            'at' => (int) $a['created_at'],
        ];
    }
    out(['ok' => true, 'lists' => $lists, 'activity' => $activity, 'you' => (int) $u['id'], 'youRole' => (string) $u['role']]);
}

if ($action === 'lists_create') {
    $u = require_user($db);
    if (($u['role'] ?? '') !== 'owner') fail('Seul le créateur de la famille peut créer une liste.', 403);
    $b = body();
    $name = trim((string) ($b['name'] ?? ''));
    $isTemplate = !empty($b['isTemplate']);
    if ($name === '') fail('Nom de liste requis.', 400);
    if (mb_strlen($name) > 60) $name = mb_substr($name, 0, 60);
    $db->prepare('INSERT INTO lists (family_id, name, is_template, archived, archived_at, created_at) VALUES (:f,:n,:t,0,0,:c)')
        ->execute([':f' => (int) $u['family_id'], ':n' => $name, ':t' => $isTemplate ? 1 : 0, ':c' => time()]);
    $id = (int) $db->lastInsertId();
    log_activity($db, $u, $isTemplate ? 'template' : 'list_create', $name, '');
    out(['ok' => true, 'list' => ['id' => $id, 'familyId' => (int) $u['family_id'], 'name' => $name, 'isTemplate' => $isTemplate, 'archived' => false, 'archivedAt' => 0, 'items' => []]]);
}

/**
 * Duplique une liste : nouvelle semaine depuis un modèle/une archive
 * (tout membre), ou enregistrement comme modèle (owner).
 * Les articles repartent décochés, prix remis à zéro.
 */
if ($action === 'lists_duplicate') {
    $u = require_user($db);
    $b = body();
    $listId = (int) ($b['listId'] ?? 0);
    $name = trim((string) ($b['name'] ?? ''));
    $asTemplate = !empty($b['asTemplate']);
    if ($listId <= 0) fail('Liste source requise.', 400);
    if ($asTemplate && ($u['role'] ?? '') !== 'owner') fail('Seul le créateur peut enregistrer un modèle.', 403);
    $src = require_family_list($db, $u, $listId);
    if ($name === '') $name = trim((string) $src['name']) . ($asTemplate ? ' (modèle)' : ' (copie)');
    if (mb_strlen($name) > 60) $name = mb_substr($name, 0, 60);
    $db->prepare('INSERT INTO lists (family_id, name, is_template, archived, archived_at, created_at) VALUES (:f,:n,:t,0,0,:c)')
        ->execute([':f' => (int) $u['family_id'], ':n' => $name, ':t' => $asTemplate ? 1 : 0, ':c' => time()]);
    $newId = (int) $db->lastInsertId();
    $is = $db->prepare('SELECT name, qty, rayon FROM items WHERE list_id = :l');
    $is->execute([':l' => $listId]);
    $ins = $db->prepare('INSERT INTO items (list_id, name, qty, price, rayon, checked, added_by, created_at, updated_at) VALUES (:l,:n,:q,0,:r,0,:u,:t,:t)');
    $copied = 0;
    foreach ($is->fetchAll(PDO::FETCH_ASSOC) as $it) {
        $ins->execute([':l' => $newId, ':n' => (string) $it['name'], ':q' => (string) $it['qty'], ':r' => (string) $it['rayon'], ':u' => (int) $u['id'], ':t' => time()]);
        $copied++;
    }
    log_activity($db, $u, $asTemplate ? 'template' : 'duplicate', $name, (string) $src['name']);
    out(['ok' => true, 'list' => ['id' => $newId, 'isTemplate' => $asTemplate, 'copied' => $copied]]);
}

/** Clôturer (archiver) / rouvrir une liste — tout membre (le flux hebdo). */
if ($action === 'lists_set_archived') {
    $u = require_user($db);
    $b = body();
    $listId = (int) ($b['listId'] ?? 0);
    $archived = !empty($b['archived']);
    $list = require_family_list($db, $u, $listId);
    if (((int) $list['is_template']) === 1) fail('On ne clôture pas un modèle.', 400);
    $db->prepare('UPDATE lists SET archived = :a, archived_at = :t WHERE id = :id')
        ->execute([':a' => $archived ? 1 : 0, ':t' => $archived ? time() : 0, ':id' => $listId]);
    log_activity($db, $u, $archived ? 'archive' : 'unarchive', (string) $list['name'], '');
    out(['ok' => true]);
}

/** Supprimer définitivement une liste + ses articles + son activité liée — owner. */
if ($action === 'lists_delete') {
    $u = require_user($db);
    if (($u['role'] ?? '') !== 'owner') fail('Seul le créateur peut supprimer une liste.', 403);
    $b = body();
    $listId = (int) ($b['listId'] ?? 0);
    $list = require_family_list($db, $u, $listId);
    $db->prepare('DELETE FROM items WHERE list_id = :l')->execute([':l' => $listId]);
    $db->prepare('DELETE FROM lists WHERE id = :id')->execute([':id' => $listId]);
    log_activity($db, $u, 'delete_list', (string) $list['name'], '');
    out(['ok' => true]);
}

if ($action === 'items_add') {
    $u = require_user($db);
    $b = body();
    $listId = (int) ($b['listId'] ?? 0);
    $name = trim((string) ($b['name'] ?? ''));
    $qty = trim((string) ($b['qty'] ?? ''));
    $price = max(0.0, (float) ($b['price'] ?? 0));
    $rayon = trim((string) ($b['rayon'] ?? 'Divers'));
    if ($listId <= 0 || $name === '') fail('Liste et nom requis.', 400);
    $list = require_family_list($db, $u, $listId);
    if (mb_strlen($name) > 120) $name = mb_substr($name, 0, 120);
    if (mb_strlen($qty) > 30) $qty = mb_substr($qty, 0, 30);
    if ($rayon === '' || mb_strlen($rayon) > 40) $rayon = 'Divers';
    $db->prepare('INSERT INTO items (list_id, name, qty, price, rayon, checked, added_by, created_at, updated_at) VALUES (:l,:n,:q,:p,:r,0,:u,:t,:t)')
        ->execute([':l' => $listId, ':n' => $name, ':q' => $qty, ':p' => $price, ':r' => $rayon, ':u' => (int) $u['id'], ':t' => time()]);
    $id = (int) $db->lastInsertId();
    log_activity($db, $u, 'add', $qty !== '' ? "$name ($qty)" : $name, (string) $list['name']);
    out(['ok' => true, 'item' => ['id' => $id, 'listId' => $listId, 'name' => $name, 'qty' => $qty, 'price' => $price, 'rayon' => $rayon, 'checked' => false]]);
}

if ($action === 'items_add_many') {
    $u = require_user($db);
    $b = body();
    $listId = (int) ($b['listId'] ?? 0);
    $names = $b['names'] ?? [];
    if ($listId <= 0 || !is_array($names)) fail('Liste et noms requis.', 400);
    $list = require_family_list($db, $u, $listId);
    $ins = $db->prepare('INSERT INTO items (list_id, name, qty, price, rayon, checked, added_by, created_at, updated_at) VALUES (:l,:n,:q,:p,:r,0,:u,:t,:t)');
    $added = 0;
    // names accepte "Lait" ou {name:"Lait", qty:"2", price:1.5, rayon:"Frais"}.
    foreach (array_slice($names, 0, 50) as $n) {
        $qty = '';
        $price = 0.0;
        $rayon = 'Divers';
        if (is_array($n)) {
            $qty = trim((string) ($n['qty'] ?? ''));
            $price = max(0.0, (float) ($n['price'] ?? 0));
            $rayon = trim((string) ($n['rayon'] ?? 'Divers'));
            $n = (string) ($n['name'] ?? '');
        }
        $n = trim((string) $n);
        if ($n === '') continue;
        if (mb_strlen($n) > 120) $n = mb_substr($n, 0, 120);
        if (mb_strlen($qty) > 30) $qty = mb_substr($qty, 0, 30);
        if ($rayon === '' || mb_strlen($rayon) > 40) $rayon = 'Divers';
        $ins->execute([':l' => $listId, ':n' => $n, ':q' => $qty, ':p' => $price, ':r' => $rayon, ':u' => (int) $u['id'], ':t' => time()]);
        $added++;
    }
    if ($added > 0) log_activity($db, $u, 'add_many', (string) $added, (string) $list['name']);
    out(['ok' => true, 'added' => $added]);
}

if ($action === 'items_update') {
    $u = require_user($db);
    $b = body();
    $itemId = (int) ($b['itemId'] ?? 0);
    $st = $db->prepare('SELECT it.*, l.family_id AS fam, l.name AS list_name FROM items it JOIN lists l ON l.id = it.list_id WHERE it.id = :id');
    $st->execute([':id' => $itemId]);
    $it = $st->fetch(PDO::FETCH_ASSOC);
    if (!$it) fail('Article introuvable.', 404);
    if ((int) $it['fam'] !== (int) $u['family_id']) fail('Article d’une autre famille.', 403);
    $sets = [];
    $params = [':id' => $itemId, ':t' => time()];
    if (array_key_exists('name', $b)) {
        $name = trim((string) $b['name']);
        if ($name === '') fail('Nom vide.', 400);
        if (mb_strlen($name) > 120) $name = mb_substr($name, 0, 120);
        $sets[] = 'name = :n';
        $params[':n'] = $name;
    }
    if (array_key_exists('qty', $b)) {
        $qty = trim((string) $b['qty']);
        if (mb_strlen($qty) > 30) $qty = mb_substr($qty, 0, 30);
        $sets[] = 'qty = :q';
        $params[':q'] = $qty;
    }
    if (array_key_exists('price', $b)) {
        $sets[] = 'price = :p';
        $params[':p'] = max(0.0, (float) $b['price']);
    }
    if (array_key_exists('rayon', $b)) {
        $rayon = trim((string) $b['rayon']);
        if ($rayon === '' || mb_strlen($rayon) > 40) $rayon = 'Divers';
        $sets[] = 'rayon = :r';
        $params[':r'] = $rayon;
    }
    if (count($sets) === 0) fail('Rien à modifier.', 400);
    $sets[] = 'updated_at = :t';
    $db->prepare('UPDATE items SET ' . implode(', ', $sets) . ' WHERE id = :id')->execute($params);
    log_activity($db, $u, 'edit', (string) $it['name'], (string) $it['list_name']);
    out(['ok' => true]);
}

if ($action === 'items_toggle') {
    $u = require_user($db);
    $b = body();
    $itemId = (int) ($b['itemId'] ?? 0);
    $checked = !empty($b['checked']);
    $st = $db->prepare('SELECT it.*, l.family_id AS fam, l.name AS list_name FROM items it JOIN lists l ON l.id = it.list_id WHERE it.id = :id');
    $st->execute([':id' => $itemId]);
    $it = $st->fetch(PDO::FETCH_ASSOC);
    if (!$it) fail('Article introuvable.', 404);
    if ((int) $it['fam'] !== (int) $u['family_id']) fail('Article d’une autre famille.', 403);
    $db->prepare('UPDATE items SET checked = :c, updated_at = :t WHERE id = :id')
        ->execute([':c' => $checked ? 1 : 0, ':t' => time(), ':id' => $itemId]);
    log_activity($db, $u, $checked ? 'check' : 'uncheck', (string) $it['name'], (string) $it['list_name']);
    out(['ok' => true]);
}

if ($action === 'items_delete') {
    $u = require_user($db);
    $b = body();
    $itemId = (int) ($b['itemId'] ?? 0);
    $st = $db->prepare('SELECT it.name AS item_name, l.family_id AS fam, l.name AS list_name FROM items it JOIN lists l ON l.id = it.list_id WHERE it.id = :id');
    $st->execute([':id' => $itemId]);
    $it = $st->fetch(PDO::FETCH_ASSOC);
    if (!$it) fail('Article introuvable.', 404);
    if ((int) $it['fam'] !== (int) $u['family_id']) fail('Article d’une autre famille.', 403);
    $db->prepare('DELETE FROM items WHERE id = :id')->execute([':id' => $itemId]);
    log_activity($db, $u, 'delete', (string) $it['item_name'], (string) $it['list_name']);
    out(['ok' => true]);
}

if ($action === 'items_clear_checked') {
    $u = require_user($db);
    $b = body();
    $listId = (int) ($b['listId'] ?? 0);
    $list = require_family_list($db, $u, $listId);
    $st = $db->prepare('DELETE FROM items WHERE list_id = :l AND checked = 1');
    $st->execute([':l' => $listId]);
    $deleted = $st->rowCount();
    if ($deleted > 0) log_activity($db, $u, 'clear', (string) $deleted, (string) $list['name']);
    out(['ok' => true, 'deleted' => $deleted]);
}

/**
 * Nettoie un cookie copié depuis DevTools (retours ligne, préfixe "Cookie:").
 */
function mc_clean_cookie(string $c): string
{
    $c = trim($c);
    $c = (string) preg_replace('/^cookie\s*:\s*/i', '', $c);
    $c = str_replace(["\r", "\n", "\t"], '', $c);
    return trim($c);
}

/**
 * Appel proxy-api Monsieur Cuisine (cf. smart-recipe/src/mc/client.ts, MIT).
 * Retourne [httpCode, data|null]. Échec réseau → fail() 502 direct.
 */
function mc_proxy_call(string $cookie, string $endpoint, string $method, string $lang, $payload, string $referer): array
{
    $body = ['endpoint' => $endpoint, 'method' => $method, 'lang' => $lang];
    if ($payload !== null) $body['payload'] = $payload;
    $json = json_encode($body, JSON_UNESCAPED_UNICODE);
    $headers = [
        'Content-Type: application/json',
        'User-Agent: Mozilla/5.0',
        'X-Request-ID: ' . bin2hex(random_bytes(16)),
        'x-bypass-cdn: cd844315-77c4-46ba-83fe-7702d13b12b2',
        'device-type: web',
        'Accept-Language: ' . $lang,
        'Referer: ' . $referer,
        'Cookie: ' . $cookie,
    ];
    $raw = null;
    $httpCode = 0;
    if (function_exists('curl_init')) {
        $ch = curl_init('https://www.monsieur-cuisine.com/proxy-api');
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => $json,
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_TIMEOUT => 20,
            CURLOPT_CONNECTTIMEOUT => 10,
        ]);
        $raw = curl_exec($ch);
        $httpCode = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $curlErr = (string) curl_error($ch);
        curl_close($ch);
        if (!is_string($raw) || $raw === '') fail('Monsieur Cuisine injoignable (' . $curlErr . ').', 502);
    } else {
        $ctx = stream_context_create(['http' => [
            'method' => 'POST',
            'header' => implode("\r\n", $headers),
            'content' => $json,
            'timeout' => 20,
            'ignore_errors' => true,
        ]]);
        $raw = @file_get_contents('https://www.monsieur-cuisine.com/proxy-api', false, $ctx);
        if (!is_string($raw) || $raw === '') fail('Monsieur Cuisine injoignable.', 502);
        if (isset($http_response_header[0]) && preg_match('/\s(\d{3})\s/', (string) $http_response_header[0], $m)) {
            $httpCode = (int) $m[1];
        }
    }
    $data = json_decode((string) $raw, true);
    return [$httpCode, is_array($data) ? $data : null];
}

/** Erreur MC standard : 401/403 → cookie, sinon HTTP ou message applicatif. */
function mc_check_error(int $httpCode, $data): void
{
    if ($httpCode === 401 || $httpCode === 403) {
        fail('Cookie MC refusé (expiré ou incomplet ?) : reconnecte-toi sur monsieur-cuisine.com et recopie TOUT le cookie (Réglages).', 401);
    }
    if ($httpCode < 200 || $httpCode >= 300) fail('Monsieur Cuisine : HTTP ' . $httpCode . '.', 502);
    if ($data === null) fail('Réponse Monsieur Cuisine illisible.', 502);
    if (($data['code'] ?? null) !== 0) {
        $msg = (string) ($data['message'] ?? 'erreur inconnue');
        if (mb_strlen($msg) > 160) $msg = mb_substr($msg, 0, 160);
        fail('Monsieur Cuisine : ' . $msg, 502);
    }
}

if ($action === 'mc_session') {
    // Valide la session MC seule (sans charger de recette) : permet de
    // distinguer "cookie invalide" de "recette introuvable".
    $u = require_user($db);
    $b = body();
    $cookie = mc_clean_cookie(trim((string) ($b['cookie'] ?? '')));
    if ($cookie === '') fail('Cookie Monsieur Cuisine manquant (Réglages > Cookie MC).', 400);
    if (mb_strlen($cookie) > 4000) fail('Cookie trop long (copie incomplète ?).', 400);
    $lang = trim((string) ($b['lang'] ?? 'fr-FR'));
    if (!preg_match('/^[a-z]{2}-[A-Z]{2}$/', $lang)) $lang = 'fr-FR';
    [$httpCode, $data] = mc_proxy_call(
        $cookie,
        'api/v1/users',
        'GET',
        $lang,
        null,
        'https://www.monsieur-cuisine.com/fr/creer-une-recette?devices=mc-smart'
    );
    mc_check_error($httpCode, $data);
    $user = [];
    if (isset($data['data']['user']) && is_array($data['data']['user'])) $user = $data['data']['user'];
    elseif (isset($data['data']) && is_array($data['data'])) $user = $data['data'];
    $label = '';
    foreach (['email', 'name', 'username', 'displayName', 'id'] as $k) {
        if (isset($user[$k]) && (is_string($user[$k]) || is_numeric($user[$k])) && trim((string) $user[$k]) !== '') {
            $label = trim((string) $user[$k]);
            break;
        }
    }
    out(['ok' => true, 'user' => $label]);
}

/**
 * GET JSON public (mc-api.tecpal.com). Retourne [httpCode, data|null].
 */
function mc_http_get(string $url, string $lang): array
{
    $headers = ['User-Agent: Mozilla/5.0', 'Accept-Language: ' . $lang, 'device-type: MC3.0'];
    $httpCode = 0;
    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HTTPGET => true,
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_TIMEOUT => 15,
            CURLOPT_CONNECTTIMEOUT => 8,
        ]);
        $raw = curl_exec($ch);
        $httpCode = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        if (!is_string($raw) || $raw === '') return [0, null];
    } else {
        $ctx = stream_context_create(['http' => [
            'method' => 'GET',
            'header' => implode("\r\n", $headers),
            'timeout' => 15,
            'ignore_errors' => true,
        ]]);
        $raw = @file_get_contents($url, false, $ctx);
        if (!is_string($raw) || $raw === '') return [0, null];
        if (isset($http_response_header[0]) && preg_match('/\s(\d{3})\s/', (string) $http_response_header[0], $m)) {
            $httpCode = (int) $m[1];
        }
    }
    $data = json_decode((string) $raw, true);
    return [$httpCode, is_array($data) ? $data : null];
}

/**
 * Noms d'ingrédients système MC (id → nom FR), cache fichier 7 j.
 * Nécessaire car le détail public laisse parfois name=null + systemIngredientId.
 */
function mc_sys_names(string $lang): array
{
    $safe = preg_replace('/[^a-zA-Z-]/', '', $lang);
    $file = __DIR__ . '/data/mc-ingredients-' . $safe . '.json';
    if (is_file($file) && (time() - (int) @filemtime($file)) < 7 * 24 * 3600) {
        $j = json_decode((string) @file_get_contents($file), true);
        if (is_array($j)) return $j;
    }
    [$httpCode, $data] = mc_http_get('https://mc-api.tecpal.com/api/v2/ingredients', $lang);
    $map = [];
    if ($httpCode >= 200 && $httpCode < 300 && is_array($data)) {
        $list = (isset($data['data']['ingredients']) && is_array($data['data']['ingredients'])) ? $data['data']['ingredients'] : [];
        foreach ($list as $ing) {
            if (!is_array($ing) || !isset($ing['id'])) continue;
            $tr = (isset($ing['translations']) && is_array($ing['translations'])) ? $ing['translations'] : [];
            $name = '';
            foreach ([$lang, 'en-US'] as $want) {
                foreach ($tr as $t) {
                    if (is_array($t) && ($t['language'] ?? '') === $want && trim((string) ($t['name'] ?? '')) !== '') {
                        $name = trim((string) $t['name']);
                        break 2;
                    }
                }
            }
            if ($name === '') {
                foreach ($tr as $t) {
                    if (is_array($t) && trim((string) ($t['name'] ?? '')) !== '') {
                        $name = trim((string) $t['name']);
                        break;
                    }
                }
            }
            if ($name !== '') $map[(string) $ing['id']] = $name;
        }
        if (count($map) > 1000) @file_put_contents($file, json_encode($map, JSON_UNESCAPED_UNICODE));
    }
    return $map;
}

/**
 * Devine les noms d'ingrédients MC inconnus du référentiel (créations de
 * membres) via Gemini : contexte titre + ingrédients connus + qté/catégorie.
 * Retourne [idx => nom]. Best effort : échec → tableau vide.
 */
function mc_guess_names(string $apiKey, string $model, string $title, array $known, array $unknown, string $stepsText = ''): array
{
    if ($apiKey === '' || count($unknown) === 0) return [];
    if (!preg_match('/^[a-zA-Z0-9_.-]{1,60}$/', $model)) $model = 'gemini-2.0-flash';
    $lines = [];
    foreach ($unknown as $idx => $u) {
        $bits = trim((string) ($u['qty'] ?? ''));
        if (trim((string) ($u['cat'] ?? '')) !== '') $bits .= ($bits !== '' ? ' ' : '') . '(catégorie : ' . trim((string) $u['cat']) . ')';
        $lines[] = $idx . ': ' . ($bits !== '' ? $bits : 'quantité inconnue');
    }
    $prompt = 'Recette Monsieur Cuisine « ' . mb_substr($title, 0, 80) . ' ».' . "\n"
        . 'Ingrédients connus : ' . implode(' ; ', array_slice($known, 0, 30)) . "\n"
        . 'Ingrédients à identifier (index : quantité + catégorie) :' . "\n" . implode("\n", $lines) . "\n";
    if ($stepsText !== '') {
        $prompt .= 'Pas-à-pas qui cite les ingrédients (source de vérité pour les noms) :' . "\n" . mb_substr($stepsText, 0, 1500) . "\n";
    }
    $prompt .= 'Donne le nom EXACT du produit tel qu’acheté en magasin, sans le raccourcir ni le banaliser : '
        . '« Concentré de tomate » (jamais « Tomate »), « Fécule de maïs » (jamais « Maïs »), '
        . '« Sucre en poudre » seulement si le pas-à-pas parle bien de sucre, '
        . '« Sauce soja sucrée » (jamais « Sauce soja »). En cas de vrai doute, réponds "" pour cet index. '
        . 'Réponds UNIQUEMENT un objet JSON {"index":"nom en français"} (noms courts). Sans explication.';
    $body = json_encode([
        'contents' => [['parts' => [['text' => $prompt]]]],
        'generationConfig' => ['temperature' => 0.2, 'maxOutputTokens' => 256, 'responseMimeType' => 'application/json'],
    ], JSON_UNESCAPED_UNICODE);
    $url = 'https://generativelanguage.googleapis.com/v1beta/models/' . rawurlencode($model) . ':generateContent?key=' . rawurlencode($apiKey);
    $raw = null;
    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => $body,
            CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
            CURLOPT_TIMEOUT => 15,
            CURLOPT_CONNECTTIMEOUT => 8,
        ]);
        $raw = curl_exec($ch);
        curl_close($ch);
    } else {
        $ctx = stream_context_create(['http' => [
            'method' => 'POST',
            'header' => 'Content-Type: application/json',
            'content' => $body,
            'timeout' => 15,
            'ignore_errors' => true,
        ]]);
        $raw = @file_get_contents($url, false, $ctx);
    }
    if (!is_string($raw) || $raw === '') return [];
    $data = json_decode($raw, true);
    $text = '';
    if (is_array($data)) {
        $parts = $data['candidates'][0]['content']['parts'] ?? [];
        if (is_array($parts)) {
            foreach ($parts as $p) {
                if (is_array($p) && isset($p['text'])) $text .= (string) $p['text'];
            }
        }
    }
    $start = strpos($text, '{');
    $end = strrpos($text, '}');
    if ($start === false || $end === false || $end <= $start) return [];
    $map = json_decode(substr($text, $start, $end - $start + 1), true);
    if (!is_array($map)) return [];
    $out = [];
    foreach ($map as $k => $v) {
        $nm = trim((string) $v);
        if ($nm === '' || mb_strlen($nm) > 80) continue;
        $out[(string) $k] = $nm;
    }
    return $out;
}

/**
 * Libellé de mode MC (comme le site : "Cuisson personnalisée", "Saisir"...).
 */
function mc_cook_label(string $norm, $ds): string
{
    $labels = [
        'scale' => 'Pesée', 'customized' => 'Cuisson personnalisée',
        'roast' => 'Saisir', 'roasting' => 'Saisir', 'slowcook' => 'Mijoter', 'slowcooking' => 'Mijoter',
        'steam' => 'Vapeur', 'knead' => 'Pétrir', 'doughkneading' => 'Pétrir',
        'sousvide' => 'Sous-vide', 'turbo' => 'Turbo',
        'precleaning' => 'Prélavage', 'preclean' => 'Prélavage',
        'fermentation' => 'Fermentation', 'ferment' => 'Fermentation',
        'ricecooking' => 'Riz', 'ricecook' => 'Riz', 'rice' => 'Riz',
        'foodprocessor' => 'Robot', 'puree' => 'Mixer', 'smoothie' => 'Smoothie',
        'boil' => 'Bouillir', 'fry' => 'Frire',
    ];
    $raw = trim((string) (is_array($ds) ? ($ds['mode'] ?? '') : ''));
    $label = $labels[$norm] ?? ($norm !== '' ? ucfirst($raw) : '');
    return $label;
}

/**
 * Détail cuisson structuré (pour les icônes façon site MC) :
 * {mode, label, temperature, time, speed, weight, reverse, turbo}
 * ou null si rien d'exploitable.
 */
function mc_cook_detail($ds): ?array
{
    if (!is_array($ds)) return null;
    $norm = strtolower(str_replace(['-', '_', ' '], '', trim((string) ($ds['mode'] ?? ''))));
    if ($norm === '') return null;
    $s = [];
    if (isset($ds['settings']) && is_array($ds['settings']) && isset($ds['settings'][0]) && is_array($ds['settings'][0])) {
        $s = $ds['settings'][0];
    }
    $label = mc_cook_label($norm, $ds);
    // "Cuisson personnalisée" seule sans réglages : rien à afficher.
    if ($norm === 'customized' && empty($s)) return null;
    $detail = ['mode' => $norm, 'label' => $label, 'temperature' => null, 'time' => null, 'speed' => null, 'weight' => null, 'reverse' => null, 'turbo' => !empty($ds['turbo'])];
    $isScale = ($norm === 'scale');
    if (!$isScale && isset($s['temperature']) && is_numeric($s['temperature'])) $detail['temperature'] = (float) $s['temperature'];
    if (isset($s['time']) && is_numeric($s['time']) && (int) $s['time'] > 0) $detail['time'] = (int) $s['time'];
    if (!$isScale && isset($s['speed']) && is_numeric($s['speed'])) $detail['speed'] = (int) $s['speed'];
    if (isset($s['weight']) && is_numeric($s['weight']) && (float) $s['weight'] > 0) $detail['weight'] = (float) $s['weight'];
    if (!$isScale && array_key_exists('reverse', $ds)) $detail['reverse'] = !empty($ds['reverse']);
    if ($detail['temperature'] === null && $detail['time'] === null && $detail['speed'] === null && $detail['weight'] === null && $detail['reverse'] === null && ($label === '' || $isScale && $detail['weight'] === null)) return null;
    return $detail;
}

/**
 * Ligne de cuisson MC lisible depuis deviceSetting (compat) :
 * "Saisir · 130 °C · 4 min · Vitesse 1 · À droite".
 * time en secondes, weight en g. '' si rien d'exploitable.
 */
function mc_cook_line($ds): string
{
    if (!is_array($ds)) return '';
    $norm = strtolower(str_replace(['-', '_', ' '], '', trim((string) ($ds['mode'] ?? ''))));
    $label = mc_cook_label($norm, $ds);
    $s = [];
    if (isset($ds['settings']) && is_array($ds['settings']) && isset($ds['settings'][0]) && is_array($ds['settings'][0])) {
        $s = $ds['settings'][0];
    }
    $parts = [];
    // "Manuel" seul n'apporte rien : on l'affiche seulement avec des réglages.
    if ($label !== '' && ($norm !== 'customized' || !empty($s))) $parts[] = $label;
    $isScale = ($norm === 'scale');
    // Température : affichée même à 0 (comme le site officiel), sauf pesée.
    $temp = $s['temperature'] ?? null;
    if (!$isScale && is_numeric($temp)) {
        $parts[] = ((float) $temp == (int) $temp ? (int) $temp : (float) $temp) . ' °C';
    }
    $time = $s['time'] ?? null;
    if (is_numeric($time) && (int) $time > 0) {
        $t = (int) $time;
        if ($t < 60) $parts[] = $t . ' s';
        elseif ($t % 60 === 0) $parts[] = (int) ($t / 60) . ' min';
        else $parts[] = (int) floor($t / 60) . ' min ' . ($t % 60) . ' s';
    }
    $speed = $s['speed'] ?? null;
    if (!$isScale && is_numeric($speed)) $parts[] = 'Vitesse ' . (int) $speed;
    $weight = $s['weight'] ?? null;
    if (is_numeric($weight) && (float) $weight > 0) {
        $parts[] = ((float) $weight == (int) $weight ? (int) $weight : (float) $weight) . ' g';
    }
    // Sens de rotation toujours précisé (comme le site), sauf pesée.
    if (!$isScale && array_key_exists('reverse', $ds)) {
        $parts[] = !empty($ds['reverse']) ? 'À gauche' : 'À droite';
    }
    if (!empty($ds['turbo']) && $norm !== 'turbo') $parts[] = 'Turbo';
    return implode(' · ', $parts);
}

/**
 * Étapes de préparation (v3 auth et v2 public partagent la forme
 * {titre, description} sous des clés différentes).
 */
function mc_parse_steps(array $serving): array
{
    $steps = [];
    $list = (isset($serving['steps']) && is_array($serving['steps'])) ? array_slice($serving['steps'], 0, 40) : [];
    $n = 0;
    foreach ($list as $st) {
        if (!is_array($st)) continue;
        $n++;
        $name = trim((string) ($st['name'] ?? $st['title'] ?? ''));
        $text = trim((string) ($st['description'] ?? $st['text'] ?? ''));
        if (mb_strlen($name) > 120) $name = mb_substr($name, 0, 120);
        if (mb_strlen($text) > 800) $text = mb_substr($text, 0, 800);
        $ds = $st['deviceSetting'] ?? $st['mode'] ?? null;
        $cook = mc_cook_line($ds);
        $cookDetail = mc_cook_detail($ds);
        if ($name === '' && $text === '' && $cook === '') continue;
        $ord = $st['order'] ?? $st['step'] ?? $n;
        $row = ['order' => is_numeric($ord) ? (int) $ord : $n, 'name' => $name, 'text' => $text, 'cook' => $cook];
        if ($cookDetail !== null) $row['cookDetail'] = $cookDetail;
        $steps[] = $row;
    }
    return $steps;
}

/**
 * Pitch / texte de présentation de la recette (champ "description" côté MC).
 * Tronqué à 600 caractères. '' si absent.
 */
function mc_pick_pitch(array $recipe, array $serving): string
{
    $cands = [];
    foreach (['description', 'pitch', 'story', 'introduction', 'summary', 'teaser', 'comment'] as $k) {
        if (isset($recipe[$k]) && is_string($recipe[$k])) $cands[] = trim($recipe[$k]);
    }
    // Repli : consigne du serving (souvent vide, mais certains brouillons l'utilisent).
    if (isset($serving['instruction']) && is_string($serving['instruction'])) $cands[] = trim($serving['instruction']);
    foreach ($cands as $c) {
        $c = (string) preg_replace('/\s+/', ' ', $c);
        $c = trim($c);
        if ($c !== '') {
            if (mb_strlen($c) > 600) $c = mb_substr($c, 0, 600) . '…';
            return $c;
        }
    }
    return '';
}

/**
 * Méta d'en-tête : difficulté + durées (minutes).
 * Champs v2 public (preparationDuration, duration, complexity) et
 * variantes v3 auth. Durées bornées 0..1440, '' si inconnue.
 * Retourne [complexity, prepMin, totalMin].
 */
function mc_pick_meta(array $recipe, array $serving): array
{
    $complexity = '';
    foreach (['complexity', 'difficulty', 'level'] as $k) {
        if (isset($recipe[$k]) && is_string($recipe[$k]) && trim($recipe[$k]) !== '') {
            $complexity = trim($recipe[$k]);
            break;
        }
    }
    if ($complexity === '') {
        $lvl = $recipe['complexityLevel'] ?? $serving['complexityLevel'] ?? null;
        if (is_numeric($lvl)) {
            $lvl = (int) $lvl;
            if ($lvl <= 1) $complexity = 'Facile';
            elseif ($lvl == 2) $complexity = 'Moyen';
            else $complexity = 'Difficile';
        }
    }
    if (mb_strlen($complexity) > 30) $complexity = mb_substr($complexity, 0, 30);
    $num = function ($v): int {
        if (!is_numeric($v)) return 0;
        $m = (int) round((float) $v);
        if ($m < 0) $m = 0;
        if ($m > 1440) $m = 1440;
        return $m;
    };
    $prep = 0;
    foreach (['preparationDuration', 'preparationTime', 'prepDuration', 'prepTime'] as $k) {
        $prep = $num($recipe[$k] ?? $serving[$k] ?? 0);
        if ($prep > 0) break;
    }
    $total = 0;
    foreach (['duration', 'totalDuration', 'totalTime', 'cookTime'] as $k) {
        $total = $num($recipe[$k] ?? $serving[$k] ?? 0);
        if ($total > 0) break;
    }
    return [$complexity, $prep, $total];
}

/**
 * Nombre brut d'une quantité MC (number ou string "60"/"0,48"), sinon null.
 */
function mc_num($v) {
    if (is_int($v) || is_float($v)) return (float) $v;
    if (is_string($v)) {
        $t = trim(str_replace(',', '.', $v));
        if (preg_match('/^-?\d+(?:\.\d+)?$/', $t)) return (float) $t;
    }
    return null;
}

/**
 * Portion de référence : celle marquée defaultServingSizeId, sinon la 1re.
 */
function mc_pick_serving(array $recipe): array
{
    $all = (isset($recipe['servingSizes']) && is_array($recipe['servingSizes'])) ? array_values($recipe['servingSizes']) : [];
    if (count($all) > 0) {
        $serving = (is_array($all[0]) ? $all[0] : []);
        $defId = $recipe['defaultServingSizeId'] ?? null;
        if ($defId !== null) {
            foreach ($all as $s) {
                if (is_array($s) && ($s['id'] ?? null) == $defId) {
                    $serving = $s;
                    break;
                }
            }
        }
        return $serving;
    }
    if (isset($recipe['servingSize']) && is_array($recipe['servingSize'])) return $recipe['servingSize'];
    return [];
}

/**
 * Photo principale d'une recette (détail HD puis vignette).
 */
function mc_pick_image(array $recipe): string
{
    foreach (['detailsImage', 'thumbnail', 'image'] as $k) {
        if (!isset($recipe[$k]) || !is_array($recipe[$k])) continue;
        foreach (['landscape', 'portrait', 'url'] as $f) {
            $u = trim((string) ($recipe[$k][$f] ?? ''));
            if ($u !== '') return $u;
        }
    }
    if (isset($recipe['media']) && is_string($recipe['media']) && trim($recipe['media']) !== '') {
        return trim($recipe['media']);
    }
    return '';
}

if ($action === 'mc_recipe') {
    // Prototype recettes Monsieur Cuisine → ingrédients.
    // Chaîne (cf. smart-recipe/src/mc/client.ts, MIT) :
    //   POST https://www.monsieur-cuisine.com/proxy-api
    //   {endpoint:"api/v3/auth/user/recipes/<id>", method:"GET", lang}
    //   + headers Cookie (session Lidl Plus, fournie par l'app à chaque
    //     appel, jamais stockée), x-bypass-cdn, device-type, Referer.
    // Réponse : {code:0, data:{recipe:{title, servingSizes:[{amount, unit,
    //   ingredientGroups:[{name, ingredients:[{amount,unit,name,isOptional}]}]}]}}}.
    $u = require_user($db);
    $b = body();
    $cookie = mc_clean_cookie(trim((string) ($b['cookie'] ?? '')));
    $recipeId = trim((string) ($b['recipeId'] ?? ''));
    $url = trim((string) ($b['url'] ?? ''));
    $lang = trim((string) ($b['lang'] ?? 'fr-FR'));
    $geminiKey = trim((string) ($b['geminiKey'] ?? ''));
    $geminiModel = trim((string) ($b['geminiModel'] ?? 'gemini-2.0-flash'));
    if (mb_strlen($cookie) > 4000) fail('Cookie trop long.', 400);
    if (!preg_match('/^[a-z]{2}-[A-Z]{2}$/', $lang)) $lang = 'fr-FR';
    // ID : chiffres seuls, ou ?recipe-id= / ?recipeId= dans l'URL.
    $id = '';
    if (preg_match('/^\d{1,12}$/', $recipeId)) {
        $id = $recipeId;
    } elseif ($url !== '') {
        $parts = parse_url($url);
        if (is_array($parts) && !empty($parts['query'])) {
            parse_str((string) $parts['query'], $qs);
            $cand = (string) ($qs['recipe-id'] ?? $qs['recipeId'] ?? '');
            if (preg_match('/^\d{1,12}$/', $cand)) $id = $cand;
        }
        if ($id === '' && preg_match('/^\d{1,12}$/', trim($url))) $id = trim($url);
    }
    if ($id === '') fail('ID recette introuvable : colle l’URL monsieur-cuisine.com (…?recipe-id=…) ou l’ID numérique.', 400);

    $title = '';
    $servings = '';
    $servingsNum = 0;
    $skipped = 0;
    $pitch = '';
    $complexity = '';
    $prepMin = 0;
    $totalMin = 0;
    $groups = null;
    $steps = [];
    $image = '';
    $authInfo = 'non tentée (pas de cookie)';
    $pubInfo = 'non tentée';

    // 1) Voie authentifiée (brouillons privés) si cookie fourni.
    if ($cookie !== '') {
        $referer = 'https://www.monsieur-cuisine.com/fr/creer-une-recette?devices=mc-smart&recipe-id=' . $id;
        [$httpCode, $data] = mc_proxy_call($cookie, 'api/v3/auth/user/recipes/' . $id, 'GET', $lang, null, $referer);
        $authInfo = 'HTTP ' . $httpCode;
        if (is_array($data)) {
            $authInfo .= ' code=' . (string) ($data['code'] ?? '?') . ' ' . mb_substr((string) ($data['message'] ?? ''), 0, 80);
        }
        if ($httpCode >= 200 && $httpCode < 300 && is_array($data) && ($data['code'] ?? null) === 0) {
            $recipe = (isset($data['data']['recipe']) && is_array($data['data']['recipe'])) ? $data['data']['recipe'] : null;
            if (!is_array($recipe) && isset($data['data']) && is_array($data['data'])) $recipe = $data['data'];
            if (is_array($recipe)) {
                $title = trim((string) ($recipe['title'] ?? $recipe['name'] ?? ''));
                $image = mc_pick_image($recipe);
                $serving = mc_pick_serving($recipe);
                if (is_numeric($serving['amount'] ?? null)) {
                    $servings = trim((string) $serving['amount'] . ' ' . trim((string) ($serving['unit'] ?? 'parts')));
                    $servingsNum = (float) $serving['amount'];
                }
                if ($pitch === '') $pitch = mc_pick_pitch($recipe, $serving);
                [$complexity, $prepMin, $totalMin] = mc_pick_meta($recipe, $serving);
                $steps = mc_parse_steps($serving);
                $tmp = [];
                $ig = (isset($serving['ingredientGroups']) && is_array($serving['ingredientGroups'])) ? $serving['ingredientGroups'] : [];
                foreach ($ig as $g) {
                    if (!is_array($g)) continue;
                    $items = [];
                    $ing = (isset($g['ingredients']) && is_array($g['ingredients'])) ? $g['ingredients'] : [];
                    foreach ($ing as $in) {
                        if (!is_array($in)) continue;
                        $nm = trim((string) ($in['name'] ?? ''));
                        if ($nm === '') { $skipped++; continue; }
                        if (mb_strlen($nm) > 120) $nm = mb_substr($nm, 0, 120);
                        $qtyParts = [];
                        $amount = $in['amount'] ?? null;
                        if (is_int($amount) || is_float($amount)) {
                            $f = (float) $amount;
                            $qtyParts[] = (string) ((round($f, 2) == (int) $amount) ? (int) $amount : round($f, 2));
                        } elseif (is_string($amount) && trim($amount) !== '') {
                            $qtyParts[] = trim($amount);
                        }
                        $unit = trim((string) ($in['unit'] ?? ''));
                        if ($unit !== '') $qtyParts[] = $unit;
                        $qty = trim(implode(' ', $qtyParts));
                        if (mb_strlen($qty) > 30) $qty = mb_substr($qty, 0, 30);
                        $items[] = ['name' => $nm, 'qty' => $qty, 'optional' => !empty($in['isOptional']), 'amount' => mc_num($amount), 'unit' => $unit];
                    }
                    if (count($items) === 0) continue;
                    $tmp[] = ['name' => trim((string) ($g['name'] ?? '')), 'items' => $items];
                }
                if (count($tmp) > 0) $groups = $tmp;
            }
        }
        // Échec voie auth (401/404/autre) : repli public ci-dessous, sans erreur.
    }

    // 2) Voie publique (catalogue, sans cookie) : GET mc-api/api/v2/recipes/<id>.
    //    Ingrédients à plat + ingredientGroupId ; name parfois null → résolu
    //    via le référentiel système (cache fichier 7 j).
    if ($groups === null) {
        [$httpCode, $data] = mc_http_get('https://mc-api.tecpal.com/api/v2/recipes/' . $id, $lang);
        $pubInfo = 'HTTP ' . $httpCode;
        if (is_array($data)) {
            $pubInfo .= ' code=' . (string) ($data['code'] ?? '?') . ' ' . mb_substr((string) ($data['message'] ?? ''), 0, 80);
        }
        $recipe = (isset($data['data']['recipe']) && is_array($data['data']['recipe'])) ? $data['data']['recipe'] : null;
        if ($httpCode >= 200 && $httpCode < 300 && is_array($recipe)) {
            $title = trim((string) ($recipe['name'] ?? $recipe['title'] ?? ''));
            $image = mc_pick_image($recipe);
            $serving = mc_pick_serving($recipe);
            if (is_numeric($serving['amount'] ?? null)) {
                $servings = trim((string) $serving['amount'] . ' ' . trim((string) ($serving['servingUnit'] ?? $serving['unit'] ?? 'parts')));
                $servingsNum = (float) $serving['amount'];
            }
            if ($pitch === '') $pitch = mc_pick_pitch($recipe, $serving);
            if ($complexity === '' && $prepMin === 0 && $totalMin === 0) [$complexity, $prepMin, $totalMin] = mc_pick_meta($recipe, $serving);
            $steps = mc_parse_steps($serving);
            $gNames = [];
            $ig = (isset($serving['ingredientGroups']) && is_array($serving['ingredientGroups'])) ? $serving['ingredientGroups'] : [];
            foreach ($ig as $g) {
                if (is_array($g) && isset($g['id'])) $gNames[(string) $g['id']] = trim((string) ($g['name'] ?? ''));
            }
            $byGroup = [];
            $order = [];
            $ing = (isset($serving['ingredients']) && is_array($serving['ingredients'])) ? $serving['ingredients'] : [];            $sysNames = null;
            $unknown = [];
            $uIdx = 0;
            foreach ($ing as $in) {
                if (!is_array($in)) continue;
                $nm = trim((string) ($in['name'] ?? ''));
                $cat = '';
                if (is_array($in['ingredientCategory'] ?? null)) $cat = trim((string) ($in['ingredientCategory']['name'] ?? ''));
                if ($nm === '' && isset($in['systemIngredientId'])) {
                    if ($sysNames === null) $sysNames = mc_sys_names($lang);
                    $nm = trim((string) ($sysNames[(string) $in['systemIngredientId']] ?? ''));
                }
                if (mb_strlen($nm) > 120) $nm = mb_substr($nm, 0, 120);
                $qtyParts = [];
                $amount = $in['amount'] ?? null;
                if (is_int($amount) || is_float($amount)) {
                    $f = (float) $amount;
                    $qtyParts[] = (string) ((round($f, 2) == (int) $amount) ? (int) $amount : round($f, 2));
                } elseif (is_string($amount) && trim($amount) !== '') {
                    $qtyParts[] = trim($amount);
                }
                $unit = trim((string) ($in['unit'] ?? ''));
                if ($unit !== '') $qtyParts[] = $unit;
                $qty = trim(implode(' ', $qtyParts));
                if (mb_strlen($qty) > 30) $qty = mb_substr($qty, 0, 30);
                $gid = (isset($in['ingredientGroupId']) && $in['ingredientGroupId'] !== null) ? (string) $in['ingredientGroupId'] : '';
                if (!isset($byGroup[$gid])) {
                    $byGroup[$gid] = [];
                    $order[] = $gid;
                }
                $pos = count($byGroup[$gid]);
                $byGroup[$gid][] = ['name' => $nm, 'qty' => $qty, 'optional' => false, 'amount' => mc_num($amount), 'unit' => $unit];
                if ($nm === '') {
                    $uIdx++;
                    $unknown['u' . $uIdx] = ['gid' => $gid, 'pos' => $pos, 'qty' => $qty, 'cat' => $cat];
                }
            }
            // Noms manquants (créations de membres hors référentiel) : devinette IA,
            // aidée du pas-à-pas qui cite les ingrédients.
            if (count($unknown) > 0 && $geminiKey !== '') {
                $known = [];
                foreach ($byGroup as $items) {
                    foreach ($items as $it) {
                        if ($it['name'] !== '') $known[] = trim($it['qty'] . ' ' . $it['name']);
                    }
                }
                $stepsText = '';
                foreach ($steps as $st) {
                    $bit = trim(trim((string) ($st['name'] ?? '')) . ' : ' . trim((string) ($st['text'] ?? '')), ' :');
                    if ($bit !== '') $stepsText .= $bit . "\n";
                }
                $guessed = mc_guess_names($geminiKey, $geminiModel, $title, $known, $unknown, $stepsText);
                foreach ($unknown as $idx => $ref) {
                    if (isset($guessed[$idx])) {
                        $byGroup[$ref['gid']][$ref['pos']]['name'] = $guessed[$idx];
                    }
                }
            }
            $tmp = [];
            foreach ($order as $gid) {
                $items = [];
                foreach ($byGroup[$gid] as $it) {
                    if ($it['name'] !== '') $items[] = $it;
                }
                if (count($items) === 0) continue;
                $tmp[] = ['name' => ($gid !== '' ? ($gNames[$gid] ?? '') : ''), 'items' => $items];
            }
            // Non identifiés (ni référentiel ni IA) : placeholders ❓ visibles
            // (jamais jetés), avec la catégorie en indice. Décochés par défaut.
            foreach ($unknown as $idx => $ref) {
                $cur = $byGroup[$ref['gid']][$ref['pos']]['name'] ?? '';
                if ($cur !== '') continue;
                $skipped++;
                $hint = trim((string) ($ref['cat'] ?? ''));
                $byGroup[$ref['gid']][$ref['pos']] = [
                    'name' => '❓ À identifier' . ($hint !== '' ? ' · ' . $hint : ''),
                    'qty' => $ref['qty'], 'optional' => false,
                    'amount' => null, 'unit' => '', 'unknown' => true,
                ];
            }
            $tmp = [];
            foreach ($order as $gid) {
                $items = [];
                foreach ($byGroup[$gid] as $it) {
                    if (($it['name'] ?? '') !== '') $items[] = $it;
                }
                if (count($items) === 0) continue;
                $tmp[] = ['name' => ($gid !== '' ? ($gNames[$gid] ?? '') : ''), 'items' => $items];
            }
            if (count($tmp) > 0) $groups = $tmp;
        }
    }

    if ($groups === null || count($groups) === 0) {
        fail('Recette ' . $id . ' introuvable (privé : ' . $authInfo . ' ; public : ' . $pubInfo . ').', 404);
    }
    if ($title === '') $title = 'Recette MC ' . $id;
    out(['ok' => true, 'recipe' => ['id' => $id, 'title' => $title, 'servings' => $servings, 'servingsNum' => $servingsNum, 'skipped' => $skipped, 'pitch' => $pitch, 'complexity' => $complexity, 'prepMin' => $prepMin, 'totalMin' => $totalMin, 'groups' => $groups, 'steps' => $steps, 'image' => $image]]);
}

if ($action === 'mc_categories') {
    // Catégories du catalogue MC : GET mc-api/api/v1/categories (cache 7 j).
    $u = require_user($db);
    $b = body();
    $lang = trim((string) ($b['lang'] ?? 'fr-FR'));
    if (!preg_match('/^[a-z]{2}-[A-Z]{2}$/', $lang)) $lang = 'fr-FR';
    $safe = preg_replace('/[^a-zA-Z-]/', '', $lang);
    $file = __DIR__ . '/data/mc-categories-' . $safe . '.json';
    if (is_file($file) && (time() - (int) @filemtime($file)) < 7 * 24 * 3600) {
        $j = json_decode((string) @file_get_contents($file), true);
        if (is_array($j) && count($j) > 0) out(['ok' => true, 'categories' => $j]);
    }
    [$httpCode, $data] = mc_http_get('https://mc-api.tecpal.com/api/v1/categories', $lang);
    if ($data === null) fail('Catalogue MC injoignable.', 502);
    if ($httpCode < 200 || $httpCode >= 300) fail('Catalogue MC : HTTP ' . $httpCode . '.', 502);
    $list = (isset($data['data']['categories']) && is_array($data['data']['categories'])) ? $data['data']['categories'] : [];
    // Ordre "repas" figé : entrées → plats → dessert → reste, cuisines,
    // accessoires en fin. Inconnues futures : avant les accessoires.
    $rank = [
        '339' => 1, '259' => 2, '243' => 3, '283' => 4, '227' => 5,
        '235' => 6, '251' => 7, '219' => 8, '307' => 9, '315' => 10,
        '323' => 11, '331' => 12, '275' => 13, '347' => 14, '267' => 15,
        '583' => 16, '574' => 17, '467' => 18, '468' => 19, '495' => 20,
        '466' => 21, '469' => 22,
    ];
    $tail = ['555' => true, '564' => true, '497' => true];
    $out = [];
    foreach ($list as $c) {
        if (!is_array($c)) continue;
        $nm = trim((string) ($c['name'] ?? ''));
        if (!isset($c['id']) || $nm === '') continue;
        $id = (string) $c['id'];
        $out[] = [
            'id' => $id,
            'name' => (mb_strlen($nm) > 40 ? mb_substr($nm, 0, 40) : $nm),
            '_rank' => isset($tail[$id]) ? 1000 : ($rank[$id] ?? 900),
        ];
    }
    if (count($out) === 0) fail('Aucune catégorie.', 502);
    usort($out, function ($a, $b) {
        if ($a['_rank'] !== $b['_rank']) return $a['_rank'] - $b['_rank'];
        return strcmp($a['name'], $b['name']);
    });
    $out = array_map(function ($c) { return ['id' => $c['id'], 'name' => $c['name']]; }, $out);
    @file_put_contents($file, json_encode($out, JSON_UNESCAPED_UNICODE));
    out(['ok' => true, 'categories' => $out]);
}

if ($action === 'mc_search') {
    // Catalogue public Monsieur Cuisine (SHOPPING SANS COMPTE) :
    //   GET https://mc-api.tecpal.com/api/v1/recipes/search/page/<n>?q=...
    //   + header Accept-Language (pas de cookie requis).
    // q vide = nouveautés. 20 résultats/page.
    $u = require_user($db);
    $b = body();
    $q = trim((string) ($b['q'] ?? ''));
    $page = (int) ($b['page'] ?? 1);
    $lang = trim((string) ($b['lang'] ?? 'fr-FR'));
    $sort = trim((string) ($b['sort'] ?? 'new'));
    if ($page < 1) $page = 1;
    if ($page > 200) $page = 200;
    if (mb_strlen($q) > 80) $q = mb_substr($q, 0, 80);
    if (!preg_match('/^[a-z]{2}-[A-Z]{2}$/', $lang)) $lang = 'fr-FR';
    // Tri : new (nouveautés) | popular (populaires) | top (mieux notés).
    $sortMap = ['new' => 'lastUpdated', 'popular' => 'popularity', 'top' => 'rating'];
    $sortField = $sortMap[$sort] ?? 'lastUpdated';
    // Catégories : IDs numériques MC (cf. mc_categories), max 10.
    $cats = [];
    $rawCats = $b['categories'] ?? [];
    if (is_string($rawCats)) $rawCats = explode(',', $rawCats);
    if (is_array($rawCats)) {
        foreach (array_slice($rawCats, 0, 10) as $c) {
            $c = trim((string) (is_array($c) ? ($c['id'] ?? '') : $c));
            if (preg_match('/^\d{1,6}$/', $c)) $cats[] = $c;
        }
    }
    $qs = 'sortBy%5B0%5D%5Bfield%5D=' . $sortField . '&sortBy%5B0%5D%5Bdirection%5D=DESC';
    if ($q !== '') $qs .= '&q=' . rawurlencode($q);
    foreach ($cats as $c) $qs .= '&filters%5Bcategory%5D%5B%5D=' . $c;
    [$httpCode, $data] = mc_http_get('https://mc-api.tecpal.com/api/v1/recipes/search/page/' . $page . '?' . $qs, $lang);
    if ($data === null) fail('Catalogue MC injoignable.', 502);
    if ($httpCode < 200 || $httpCode >= 300) fail('Catalogue MC : HTTP ' . $httpCode . '.', 502);
    if (($data['code'] ?? null) !== 0 || !isset($data['data']) || !is_array($data['data'])) {
        fail('Catalogue MC : ' . mb_substr((string) ($data['message'] ?? 'erreur inconnue'), 0, 160), 502);
    }
    $dd = $data['data'];
    $out = [];
    $list = (isset($dd['recipes']) && is_array($dd['recipes'])) ? $dd['recipes'] : [];
    foreach ($list as $r) {
        if (!is_array($r)) continue;
        $rid = (string) ($r['id'] ?? '');
        $nm = trim((string) ($r['name'] ?? ''));
        if ($rid === '' || $nm === '') continue;
        $thumb = $r['thumbnail'] ?? [];
        $img = trim((string) (is_array($thumb) ? ($thumb['landscape'] ?? $thumb['portrait'] ?? '') : ''));
        $cats = [];
        if (isset($r['categories']) && is_array($r['categories'])) {
            foreach ($r['categories'] as $c) {
                if (is_array($c) && trim((string) ($c['name'] ?? '')) !== '') $cats[] = trim((string) $c['name']);
            }
        }
        $out[] = [
            'id' => $rid,
            'name' => (mb_strlen($nm) > 120 ? mb_substr($nm, 0, 120) : $nm),
            'image' => $img,
            'complexity' => trim((string) ($r['complexity'] ?? '')),
            'prep' => (int) ($r['preparationDuration'] ?? 0),
            'duration' => (int) ($r['duration'] ?? 0),
            'rating' => (float) ($r['rating'] ?? 0),
            'ratings' => (int) ($r['totalRating'] ?? 0),
            'categories' => array_slice($cats, 0, 3),
            'url' => trim((string) ($r['url'] ?? '')),
        ];
    }
    out(['ok' => true, 'total' => (int) ($dd['total'] ?? count($out)), 'totalPage' => (int) ($dd['totalPage'] ?? 1),
        'currentPage' => (int) ($dd['currentPage'] ?? $page), 'recipes' => $out]);
}

if ($action === 'diet_add') {
    $u = require_user($db);
    $b = body();
    $day = trim((string) ($b['day'] ?? ''));
    $meal = trim((string) ($b['meal'] ?? ''));
    $dish = trim((string) ($b['dish'] ?? ''));
    if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $day)) fail('Date invalide (AAAA-MM-JJ).', 400);
    $meals = ['Petit-déjeuner', 'Déjeuner', 'Goûter', 'Dîner', 'Collation'];
    if (!in_array($meal, $meals, true)) $meal = 'Déjeuner';
    if (mb_strlen($dish) > 120) $dish = mb_substr($dish, 0, 120);
    $items = [];
    $rawItems = $b['items'] ?? [];
    if (is_array($rawItems)) {
        foreach (array_slice($rawItems, 0, 20) as $n) {
            $nm = trim((string) (is_array($n) ? ($n['name'] ?? '') : $n));
            if ($nm === '') continue;
            if (mb_strlen($nm) > 120) $nm = mb_substr($nm, 0, 120);
            $qty = trim((string) (is_array($n) ? ($n['qty'] ?? '') : ''));
            if (mb_strlen($qty) > 30) $qty = mb_substr($qty, 0, 30);
            $items[] = ['name' => $nm, 'qty' => $qty];
        }
    }
    if ($dish === '' && count($items) === 0) fail('Plat ou aliments requis.', 400);
    $num = function ($v) {
        $f = (float) $v;
        if ($f < 0) $f = 0;
        if ($f > 100000) $f = 100000;
        return round($f, 1);
    };
    $score = (int) ($b['score'] ?? 0);
    if ($score < 0) $score = 0;
    if ($score > 100) $score = 100;
    $comment = trim((string) ($b['comment'] ?? ''));
    if (mb_strlen($comment) > 300) $comment = mb_substr($comment, 0, 300);
    // Photo réduite (JPEG base64, ~480px) : plafonnée à 200 Ko, sinon ignorée.
    $photo = (string) ($b['photo'] ?? '');
    if (strpos($photo, ',') !== false) $photo = substr($photo, (int) strpos($photo, ',') + 1);
    $photo = trim($photo);
    if (mb_strlen($photo) > 280000 || $photo !== '' && base64_decode($photo, true) === false) $photo = '';
    $db->prepare('INSERT INTO diet_entries (user_id, day, meal, dish, items, kcal, protein, carbs, fat, score, comment, photo, created_at) VALUES (:u,:d,:m,:dish,:it,:k,:p,:c,:f,:s,:com,:ph,:t)')
        ->execute([
            ':u' => (int) $u['id'], ':d' => $day, ':m' => $meal, ':dish' => $dish,
            ':it' => json_encode($items, JSON_UNESCAPED_UNICODE),
            ':k' => $num($b['kcal'] ?? 0), ':p' => $num($b['protein'] ?? 0),
            ':c' => $num($b['carbs'] ?? 0), ':f' => $num($b['fat'] ?? 0),
            ':s' => $score, ':com' => $comment, ':ph' => $photo, ':t' => time(),
        ]);
    out(['ok' => true, 'id' => (int) $db->lastInsertId()]);
}

if ($action === 'diet_list') {
    $u = require_user($db);
    $b = body();
    $limit = (int) ($b['limit'] ?? 100);
    if ($limit < 1) $limit = 1;
    if ($limit > 200) $limit = 200;
    $st = $db->prepare('SELECT * FROM diet_entries WHERE user_id = :u ORDER BY day DESC, id DESC LIMIT ' . $limit);
    $st->execute([':u' => (int) $u['id']]);
    $out = [];
    while ($r = $st->fetch(PDO::FETCH_ASSOC)) {
        $items = json_decode((string) ($r['items'] ?? '[]'), true);
        $out[] = [
            'id' => (int) $r['id'], 'day' => (string) $r['day'], 'meal' => (string) $r['meal'],
            'dish' => (string) $r['dish'], 'items' => is_array($items) ? $items : [],
            'kcal' => (float) $r['kcal'], 'protein' => (float) $r['protein'],
            'carbs' => (float) $r['carbs'], 'fat' => (float) $r['fat'],
            'score' => (int) $r['score'], 'comment' => (string) $r['comment'],
            'hasPhoto' => trim((string) ($r['photo'] ?? '')) !== '',
        ];
    }
    out(['ok' => true, 'entries' => $out]);
}

if ($action === 'diet_photo') {
    // Photo JPEG d'une entrée (ses propres entrées). Utilisable en <img>
    // avec ?session= (X-Session-Token impossible dans une URL d'image).
    $u = require_user($db);
    $entryId = (int) (($_GET['entryId'] ?? 0) ?: (body()['entryId'] ?? 0));
    $st = $db->prepare('SELECT photo FROM diet_entries WHERE id = :id AND user_id = :u');
    $st->execute([':id' => $entryId, ':u' => (int) $u['id']]);
    $r = $st->fetch(PDO::FETCH_ASSOC);
    $bin = ($r && trim((string) ($r['photo'] ?? '')) !== '') ? base64_decode((string) $r['photo'], true) : false;
    if ($bin === false || $bin === '') fail('Photo introuvable.', 404);
    header('Content-Type: image/jpeg');
    header('Content-Length: ' . strlen($bin));
    header('Cache-Control: private, max-age=86400');
    echo $bin;
    exit;
}

if ($action === 'diet_delete') {
    $u = require_user($db);
    $b = body();
    $entryId = (int) ($b['entryId'] ?? 0);
    $st = $db->prepare('SELECT id FROM diet_entries WHERE id = :id AND user_id = :u');
    $st->execute([':id' => $entryId, ':u' => (int) $u['id']]);
    if (!$st->fetch()) fail('Entrée introuvable.', 404);
    $db->prepare('DELETE FROM diet_entries WHERE id = :id')->execute([':id' => $entryId]);
    out(['ok' => true]);
}

if ($action === 'fav_add') {
    $u = require_user($db);
    $b = body();
    $recipeId = trim((string) ($b['recipeId'] ?? ''));
    if (!preg_match('/^\d{1,12}$/', $recipeId)) fail('ID recette invalide.', 400);
    $title = trim((string) ($b['title'] ?? ''));
    if (mb_strlen($title) > 120) $title = mb_substr($title, 0, 120);
    $image = trim((string) ($b['image'] ?? ''));
    if (mb_strlen($image) > 500) $image = mb_substr($image, 0, 500);
    $db->prepare('INSERT OR REPLACE INTO favorite_recipes (user_id, recipe_id, title, image, added_at) VALUES (:u,:r,:t,:i,:a)')
        ->execute([':u' => (int) $u['id'], ':r' => $recipeId, ':t' => $title, ':i' => $image, ':a' => time()]);
    out(['ok' => true]);
}

if ($action === 'fav_list') {
    $u = require_user($db);
    $st = $db->prepare('SELECT recipe_id, title, image, added_at FROM favorite_recipes WHERE user_id = :u ORDER BY added_at DESC');
    $st->execute([':u' => (int) $u['id']]);
    $out = [];
    while ($r = $st->fetch(PDO::FETCH_ASSOC)) {
        $out[] = [
            'recipeId' => (string) $r['recipe_id'], 'title' => (string) $r['title'],
            'image' => (string) $r['image'], 'addedAt' => (int) $r['added_at'],
        ];
    }
    out(['ok' => true, 'favorites' => $out]);
}

if ($action === 'fav_delete') {
    $u = require_user($db);
    $b = body();
    $recipeId = trim((string) ($b['recipeId'] ?? ''));
    $db->prepare('DELETE FROM favorite_recipes WHERE user_id = :u AND recipe_id = :r')
        ->execute([':u' => (int) $u['id'], ':r' => $recipeId]);
    out(['ok' => true]);
}

fail('Action inconnue (ping, register, login, join, me, logout, invite_rotate, family_set_gemini, lists_get, lists_create, lists_duplicate, lists_set_archived, lists_delete, items_add, items_add_many, items_toggle, items_update, items_delete, items_clear_checked, mc_recipe, mc_search, mc_session, mc_categories, diet_add, diet_list, diet_photo, diet_delete, fav_add, fav_list, fav_delete).', 400);
