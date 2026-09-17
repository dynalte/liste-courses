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
      POST ?action=login    {email, password}
      POST ?action=join     {email, password, name, inviteCode}

    Actions authentifiées (header X-Session-Token ou ?session=) :
      GET  ?action=me
      POST ?action=invite_rotate                       → nouveau code (owner uniquement)
      GET  ?action=lists_get                           → listes + items de la famille
      POST ?action=lists_create {name}
      POST ?action=items_add {listId, name, qty?}
      POST ?action=items_add_many {listId, names:[...]} → ajout en masse (frigo IA,
        liste manuscrite). names accepte "Lait" ou {name, qty}.
      POST ?action=items_toggle {itemId, checked}
      POST ?action=items_delete {itemId}
      POST ?action=items_clear_checked {listId}
      POST ?action=logout
*/
declare(strict_types=1);

// ================= CONFIG =================
const DB_FILE = __DIR__ . '/data/liste-courses.sqlite';
const SESSION_TTL = 365 * 24 * 3600; // 1 an
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

if ($action === 'lists_get') {
    $u = require_user($db);
    $st = $db->prepare('SELECT * FROM lists WHERE family_id = :f ORDER BY created_at ASC');
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
                'checked' => ((int) $it['checked']) === 1,
                'addedBy' => (int) $it['added_by'],
                'addedByName' => $names[(int) $it['added_by']] ?? '',
                'createdAt' => (int) $it['created_at'], 'updatedAt' => (int) $it['updated_at'],
            ];
        }
        $lists[] = ['id' => (int) $l['id'], 'familyId' => (int) $l['family_id'], 'name' => (string) $l['name'], 'items' => $items];
    }
    out(['ok' => true, 'lists' => $lists]);
}

if ($action === 'lists_create') {
    $u = require_user($db);
    $b = body();
    $name = trim((string) ($b['name'] ?? ''));
    if ($name === '') fail('Nom de liste requis.', 400);
    if (mb_strlen($name) > 60) $name = mb_substr($name, 0, 60);
    $db->prepare('INSERT INTO lists (family_id, name, created_at) VALUES (:f,:n,:t)')
        ->execute([':f' => (int) $u['family_id'], ':n' => $name, ':t' => time()]);
    $id = (int) $db->lastInsertId();
    out(['ok' => true, 'list' => ['id' => $id, 'familyId' => (int) $u['family_id'], 'name' => $name, 'items' => []]]);
}

if ($action === 'items_add') {
    $u = require_user($db);
    $b = body();
    $listId = (int) ($b['listId'] ?? 0);
    $name = trim((string) ($b['name'] ?? ''));
    $qty = trim((string) ($b['qty'] ?? ''));
    if ($listId <= 0 || $name === '') fail('Liste et nom requis.', 400);
    require_family_list($db, $u, $listId);
    if (mb_strlen($name) > 120) $name = mb_substr($name, 0, 120);
    if (mb_strlen($qty) > 30) $qty = mb_substr($qty, 0, 30);
    $db->prepare('INSERT INTO items (list_id, name, qty, checked, added_by, created_at, updated_at) VALUES (:l,:n,:q,0,:u,:t,:t)')
        ->execute([':l' => $listId, ':n' => $name, ':q' => $qty, ':u' => (int) $u['id'], ':t' => time()]);
    $id = (int) $db->lastInsertId();
    out(['ok' => true, 'item' => ['id' => $id, 'listId' => $listId, 'name' => $name, 'qty' => $qty, 'checked' => false]]);
}

if ($action === 'items_add_many') {
    $u = require_user($db);
    $b = body();
    $listId = (int) ($b['listId'] ?? 0);
    $names = $b['names'] ?? [];
    if ($listId <= 0 || !is_array($names)) fail('Liste et noms requis.', 400);
    require_family_list($db, $u, $listId);
    $ins = $db->prepare('INSERT INTO items (list_id, name, qty, checked, added_by, created_at, updated_at) VALUES (:l,:n,:q,0,:u,:t,:t)');
    $added = 0;
    // names accepte "Lait" ou {name:"Lait", qty:"2"} (transcription manuscrite IA).
    foreach (array_slice($names, 0, 50) as $n) {
        $qty = '';
        if (is_array($n)) {
            $qty = trim((string) ($n['qty'] ?? ''));
            $n = (string) ($n['name'] ?? '');
        }
        $n = trim((string) $n);
        if ($n === '') continue;
        if (mb_strlen($n) > 120) $n = mb_substr($n, 0, 120);
        if (mb_strlen($qty) > 30) $qty = mb_substr($qty, 0, 30);
        $ins->execute([':l' => $listId, ':n' => $n, ':q' => $qty, ':u' => (int) $u['id'], ':t' => time()]);
        $added++;
    }
    out(['ok' => true, 'added' => $added]);
}

if ($action === 'items_toggle') {
    $u = require_user($db);
    $b = body();
    $itemId = (int) ($b['itemId'] ?? 0);
    $checked = !empty($b['checked']);
    $st = $db->prepare('SELECT it.*, l.family_id AS fam FROM items it JOIN lists l ON l.id = it.list_id WHERE it.id = :id');
    $st->execute([':id' => $itemId]);
    $it = $st->fetch(PDO::FETCH_ASSOC);
    if (!$it) fail('Article introuvable.', 404);
    if ((int) $it['fam'] !== (int) $u['family_id']) fail('Article d’une autre famille.', 403);
    $db->prepare('UPDATE items SET checked = :c, updated_at = :t WHERE id = :id')
        ->execute([':c' => $checked ? 1 : 0, ':t' => time(), ':id' => $itemId]);
    out(['ok' => true]);
}

if ($action === 'items_delete') {
    $u = require_user($db);
    $b = body();
    $itemId = (int) ($b['itemId'] ?? 0);
    $st = $db->prepare('SELECT l.family_id AS fam FROM items it JOIN lists l ON l.id = it.list_id WHERE it.id = :id');
    $st->execute([':id' => $itemId]);
    $it = $st->fetch(PDO::FETCH_ASSOC);
    if (!$it) fail('Article introuvable.', 404);
    if ((int) $it['fam'] !== (int) $u['family_id']) fail('Article d’une autre famille.', 403);
    $db->prepare('DELETE FROM items WHERE id = :id')->execute([':id' => $itemId]);
    out(['ok' => true]);
}

if ($action === 'items_clear_checked') {
    $u = require_user($db);
    $b = body();
    $listId = (int) ($b['listId'] ?? 0);
    require_family_list($db, $u, $listId);
    $st = $db->prepare('DELETE FROM items WHERE list_id = :l AND checked = 1');
    $st->execute([':l' => $listId]);
    out(['ok' => true, 'deleted' => $st->rowCount()]);
}

fail('Action inconnue (ping, register, login, join, me, logout, invite_rotate, lists_get, lists_create, items_add, items_add_many, items_toggle, items_delete, items_clear_checked).', 400);
