const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const fetch = require('node-fetch');
const sharp = require('sharp');
const {
  isbn10to13, isbn13to10, isbnVariants, xmlUnescape, extractAllXmlTags,
  bnfAuthorToDisplayName, mergeIsbnResults, normalizeStatus, normalizeType
} = require('./lib/isbn-utils');
const { createLoginThrottle } = require('./lib/login-throttle');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const COVERS_DIR = path.join(DATA_DIR, 'covers');

// ---------- Authentification (accès unique) ----------
// Un seul couple identifiant/mot de passe, défini par variables d'environnement
// (voir docker-compose.yml). L'app refuse de démarrer sans eux plutôt que de
// tourner sans protection par erreur.
const AUTH_USERNAME = process.env.AUTH_USERNAME;
const AUTH_PASSWORD = process.env.AUTH_PASSWORD;
if (!AUTH_USERNAME || !AUTH_PASSWORD) {
  console.error('AUTH_USERNAME et AUTH_PASSWORD doivent être définis (voir docker-compose.yml). Arrêt.');
  process.exit(1);
}
const SESSION_COOKIE = 'bibli_session';
const SESSION_DURATION_MS = (Number(process.env.SESSION_DURATION_DAYS) || 30) * 24 * 60 * 60 * 1000;

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
if (!fs.existsSync(COVERS_DIR)) {
  fs.mkdirSync(COVERS_DIR, { recursive: true });
}

const db = new Database(path.join(DATA_DIR, 'bibliotheque.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS books (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    isbn TEXT,
    title TEXT NOT NULL,
    author TEXT,
    type TEXT DEFAULT 'roman',
    genre TEXT,
    lu INTEGER DEFAULT 0,
    note INTEGER,
    location TEXT,
    lent_to TEXT,
    cover_url TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

// Migration : ajoute les colonnes read_date, publisher, owner, status si
// elles n'existent pas encore (bases créées avant ces fonctionnalités).
const existingColumns = db.prepare("PRAGMA table_info(books)").all().map(c => c.name);
if (!existingColumns.includes('read_date')) {
  db.exec('ALTER TABLE books ADD COLUMN read_date TEXT');
}
if (!existingColumns.includes('publisher')) {
  db.exec('ALTER TABLE books ADD COLUMN publisher TEXT');
}
if (!existingColumns.includes('owner')) {
  db.exec('ALTER TABLE books ADD COLUMN owner TEXT');
}
if (!existingColumns.includes('status')) {
  // 'possede' = dans la bibliothèque, 'souhaite' = liste de souhaits.
  // Tous les livres déjà en base sont considérés possédés par défaut.
  db.exec("ALTER TABLE books ADD COLUMN status TEXT DEFAULT 'possede'");
  db.exec("UPDATE books SET status = 'possede' WHERE status IS NULL");
}
if (!existingColumns.includes('series')) {
  db.exec('ALTER TABLE books ADD COLUMN series TEXT');
}
if (!existingColumns.includes('series_number')) {
  // Stocké en texte plutôt qu'en entier : certaines séries numérotent des
  // hors-séries ou demi-tomes ("3.5", "HS1"), pas seulement des entiers.
  db.exec('ALTER TABLE books ADD COLUMN series_number TEXT');
}

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    created_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  )
`);
// Sessions stockées en base (et non en mémoire) pour survivre aux redémarrages
// du conteneur sans déconnecter l'utilisateur à chaque mise à jour du NAS.
db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run();
setInterval(() => {
  db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run();
}, 60 * 60 * 1000).unref();

function safeCompare(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// ---------- Anti-bruteforce sur /api/login ----------
// L'identifiant/mot de passe est unique et partagé (voir plus haut) : sans
// limite de tentatives, une app exposée via reverse proxy (recommandé par le
// README pour l'accès distant) serait vulnérable à un bruteforce en ligne.
// Compteur en mémoire par IP (pas besoin de survivre à un redémarrage) : après
// 5 échecs consécutifs, l'IP est bloquée 5 minutes avant de pouvoir retenter.
// Logique dans lib/login-throttle.js (testée dans test/login-throttle.test.js).
const loginThrottle = createLoginThrottle({ maxAttempts: 5, lockoutMs: 5 * 60 * 1000 });
setInterval(() => loginThrottle.prune(60 * 60 * 1000), 60 * 60 * 1000).unref();

function parseCookies(req) {
  const header = req.headers.cookie;
  const cookies = {};
  if (!header) return cookies;
  header.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    cookies[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return cookies;
}

function isValidSession(token) {
  if (!token) return false;
  const row = db.prepare("SELECT 1 FROM sessions WHERE token = ? AND expires_at > datetime('now')").get(token);
  return !!row;
}

app.use(express.json());

const PUBLIC_PATHS = new Set(['/login.html', '/api/login', '/style.css']);

app.use((req, res, next) => {
  if (PUBLIC_PATHS.has(req.path)) return next();
  const { [SESSION_COOKIE]: token } = parseCookies(req);
  if (isValidSession(token)) return next();
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Non authentifié' });
  }
  return res.redirect('/login.html');
});

app.post('/api/login', (req, res) => {
  const remaining = loginThrottle.checkLockout(req.ip);
  if (remaining > 0) {
    const retryAfterSec = Math.ceil(remaining / 1000);
    res.setHeader('Retry-After', retryAfterSec);
    return res.status(429).json({ error: `Trop de tentatives, réessayez dans ${retryAfterSec}s` });
  }

  const { username, password } = req.body || {};
  const validUser = typeof username === 'string' && safeCompare(username, AUTH_USERNAME);
  const validPass = typeof password === 'string' && safeCompare(password, AUTH_PASSWORD);
  if (!validUser || !validPass) {
    loginThrottle.registerFailure(req.ip);
    return res.status(401).json({ error: 'Identifiant ou mot de passe incorrect' });
  }
  loginThrottle.clearFailures(req.ip);
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS).toISOString();
  db.prepare('INSERT INTO sessions (token, expires_at) VALUES (?, ?)').run(token, expiresAt);
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DURATION_MS / 1000}; Path=/`);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  const { [SESSION_COOKIE]: token } = parseCookies(req);
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Max-Age=0; Path=/`);
  res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/covers', express.static(COVERS_DIR, { maxAge: '30d' }));

// ---------- Recherche ISBN (Open Library + Google Books, fusionnés) ----------
// isbn10to13/isbn13to10/isbnVariants sont dans lib/isbn-utils.js (fonctions
// pures, testées dans test/isbn-utils.test.js).
async function lookupOpenLibrary(isbn) {
  const url = `https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`;
  const res = await fetch(url, { timeout: 8000 });
  if (!res.ok) return null;
  const json = await res.json();
  const entry = json[`ISBN:${isbn}`];
  if (!entry) return null;
  return {
    isbn,
    title: entry.title || '',
    author: (entry.authors || []).map(a => a.name).join(', '),
    genre: (entry.subjects || []).slice(0, 3).map(s => s.name).join(', '),
    publisher: (entry.publishers || []).map(p => p.name).join(', '),
    cover_url: entry.cover ? (entry.cover.medium || entry.cover.large || entry.cover.small) : null
  };
}

async function lookupGoogleBooks(isbn) {
  // Le paramètre country=FR évite que Google masque la couverture ou la fiche
  // pour des raisons de restriction géographique liées aux droits d'édition
  // (fréquent pour les livres publiés uniquement en France).
  const url = `https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}&country=FR`;
  const res = await fetch(url, { timeout: 8000 });
  if (!res.ok) return null;
  const json = await res.json();
  if (!json.items || !json.items.length) return null;
  const info = json.items[0].volumeInfo;
  return {
    isbn,
    title: info.title || '',
    author: (info.authors || []).join(', '),
    genre: (info.categories || []).join(', '),
    publisher: info.publisher || '',
    cover_url: info.imageLinks ? (info.imageLinks.thumbnail || info.imageLinks.smallThumbnail) : null
  };
}

// ============================================================================
// SOURCE COUVERTURE : AMAZON (widget image officiel, pas de scraping HTML)
// ============================================================================
// Amazon utilise l'ISBN-10 comme identifiant produit ("ASIN") pour les livres,
// et expose un widget d'image conçu pour être intégré directement via URL
// (à l'origine pour les liens d'affiliation), sans compte ni clé API pour cet
// usage basique. C'est plus stable qu'un scraping de la page produit (qui
// change de mise en page régulièrement et bloque les robots), mais Amazon
// peut un jour modifier ou fermer ce service.
//
// SI ÇA CASSE UN JOUR : le seul endroit à modifier est AMAZON_COVER_URL_TEMPLATE
// ci-dessous. Remplacez {ASIN} par le nouveau format d'URL trouvé (cherchez
// "amazon book cover image url isbn" ou inspectez, dans un navigateur, l'URL
// de l'image d'une fiche produit livre sur amazon.fr — clic droit sur la
// couverture → "Copier l'adresse de l'image"). La fonction lookupAmazonCover
// juste en dessous n'a normalement pas besoin d'être touchée.
const AMAZON_COVER_URL_TEMPLATE =
  'https://ws-na.amazon-adsystem.com/widgets/q?_encoding=UTF8&MarketPlace=FR&ASIN={ASIN}&ServiceVersion=20070822&ID=AsinImage&WS=1&Format=_SL500_';

async function lookupAmazonCover(isbn) {
  // Amazon indexe historiquement les livres par ISBN-10 (leur "ASIN") ; mais
  // les ISBN commençant par 979 (de plus en plus fréquents en France depuis
  // l'épuisement de la tranche 978-2) n'ont pas d'équivalent ISBN-10. Pour ces
  // livres, on tente quand même l'EAN-13 brut comme ASIN : Amazon l'accepte
  // pour une partie des ouvrages récents/européens, même si ce n'est pas garanti.
  const candidates = [];
  const asin10 = isbn.length === 10 ? isbn : isbn13to10(isbn);
  if (asin10) candidates.push(asin10);
  if (isbn.length === 13) candidates.push(isbn);

  for (const asin of candidates) {
    try {
      const url = AMAZON_COVER_URL_TEMPLATE.replace('{ASIN}', asin);
      const res = await fetch(url, { timeout: 8000 });
      if (!res.ok) continue;
      const contentType = res.headers.get('content-type') || '';
      const buf = await res.buffer();
      // Amazon renvoie une petite image générique quand l'ASIN est inconnu ou
      // n'a pas de couverture ; une vraie couverture fait presque toujours plus
      // de 3 Ko à cette taille (_SL500_).
      if (contentType.startsWith('image/') && buf.length >= 3000) {
        return { isbn, title: '', author: '', genre: '', cover_url: url };
      }
    } catch {
      // on essaie le candidat suivant s'il y en a un
    }
  }
  return null;
}

// ============================================================================
// SOURCE COUVERTURE : GEOBIB (proxy communautaire vers les images de la BnF)
// ============================================================================
// Service gratuit tenu par un bibliothécaire (couverture.geobib.fr), qui va
// chercher les couvertures dans les collections numérisées de la BnF à partir
// de l'ISBN. Complémentaire à notre source BnF principale (celle-ci ne fournit
// que du texte, jamais d'image).
//
// ATTENTION FIABILITÉ : contrairement aux autres sources (Open Library, Google,
// Amazon, BnF elle-même), ce n'est PAS un service officiel adossé à une grosse
// structure — c'est un projet personnel hébergé sur un petit serveur. Il peut
// devenir lent, indisponible, ou disparaître un jour sans préavis. Le code est
// écrit pour échouer silencieusement dans ce cas (comme les autres sources) et
// ne bloque jamais la recherche du livre.
//
// SI ÇA CASSE UN JOUR : pas de format d'URL à corriger ici (contrairement à
// Amazon) — si le service disparaît, il n'y a rien à réparer, seulement à
// retirer. Pour le faire : supprimez le bloc "lookupGeobibCover" ci-dessous et
// la ligne qui l'appelle dans lookupIsbn (cherchez "lookupGeobibCover").
async function lookupGeobibCover(isbn) {
  const url = `https://couverture.geobib.fr/api/v1/${isbn}/medium`;
  const res = await fetch(url, { timeout: 8000 });
  if (!res.ok) return null;
  const contentType = res.headers.get('content-type') || '';
  const buf = await res.buffer();
  if (!contentType.startsWith('image/') || buf.length < 3000) return null;
  return { isbn, title: '', author: '', genre: '', cover_url: url };
}

// Troisième source : la fiche "édition" brute d'Open Library (/isbn/{isbn}.json).
// Elle référence parfois l'auteur et la couverture sous forme de clés (author_key,
// cover ID) que l'endpoint jscmd=data ne résout pas toujours — utile pour les
// éditions étrangères ou anciennes mal cataloguées (BD, livres de poche des années 80-90).
async function lookupOpenLibraryEdition(isbn) {
  const res = await fetch(`https://openlibrary.org/isbn/${isbn}.json`, { timeout: 8000, redirect: 'follow' });
  if (!res.ok) return null;
  const edition = await res.json();

  let author = '';
  if (Array.isArray(edition.authors) && edition.authors.length) {
    const names = await Promise.all(edition.authors.map(async (a) => {
      try {
        const key = a.key || (a.author && a.author.key);
        if (!key) return null;
        const authRes = await fetch(`https://openlibrary.org${key}.json`, { timeout: 6000 });
        if (!authRes.ok) return null;
        const authJson = await authRes.json();
        return authJson.name || null;
      } catch {
        return null;
      }
    }));
    author = names.filter(Boolean).join(', ');
  }

  let cover_url = null;
  if (Array.isArray(edition.covers) && edition.covers.length && edition.covers[0] > 0) {
    cover_url = `https://covers.openlibrary.org/b/id/${edition.covers[0]}-M.jpg`;
  }

  return {
    isbn,
    title: edition.title || '',
    author,
    genre: (edition.subjects || []).slice(0, 3).join(', '),
    publisher: (edition.publishers || []).join(', '),
    cover_url
  };
}

// Quatrième source : le catalogue SRU de la BnF (Bibliothèque nationale de
// France). Open Library et Google Books sont d'abord pensés pour le marché
// anglophone et couvrent mal l'édition française (BD, poche, petits
// éditeurs) ; la BnF, elle, référence quasiment tout ce qui est publié en
// France via le dépôt légal. Pas de couverture fournie par cette API, mais
// titre/auteur/genre y sont souvent plus fiables pour ces cas-là.
// xmlUnescape/extractAllXmlTags/bnfAuthorToDisplayName sont dans
// lib/isbn-utils.js (fonctions pures, testées).
async function lookupBnf(isbn) {
  const url = `https://catalogue.bnf.fr/api/SRU?version=1.2&operation=searchRetrieve&query=bib.isbn%20all%20%22${isbn}%22&recordSchema=dublincore&maximumRecords=1`;
  const res = await fetch(url, { timeout: 8000 });
  if (!res.ok) return null;
  const xml = await res.text();

  const titles = extractAllXmlTags(xml, 'title');
  const creators = extractAllXmlTags(xml, 'creator');
  const subjects = extractAllXmlTags(xml, 'subject');
  const publishers = extractAllXmlTags(xml, 'publisher');
  if (!titles.length) return null;

  return {
    isbn,
    title: titles[0].split(/[\/:]/)[0].trim(),
    author: creators.slice(0, 2).map(bnfAuthorToDisplayName).join(', '),
    genre: subjects.slice(0, 3).join(', '),
    publisher: publishers.slice(0, 1).join(', '),
    cover_url: null
  };
}

// mergeIsbnResults est dans lib/isbn-utils.js (fonction pure, testée).

// Interroge Open Library + Google Books, sur la forme ISBN-10 ET ISBN-13,
// et fusionne tous les résultats non vides (l'auteur et la couverture sont
// souvent absents d'une des quatre réponses selon la source et le format).
//
// Sortie anticipée : dès qu'une fiche exploitable (titre + auteur + couverture)
// peut être formée à partir des réponses déjà arrivées, on répond tout de
// suite plutôt que d'attendre les sources restantes — souvent les plus lentes
// ou les moins fiables (BnF, Amazon, Geobib), qui n'apportent alors qu'une
// confirmation d'un champ déjà rempli. Les appels encore en cours continuent
// en arrière-plan (déjà protégés par un .catch) mais leur résultat est ignoré.
async function lookupIsbn(isbn) {
  const variants = isbnVariants(isbn);
  const calls = [];
  for (const v of variants) {
    calls.push(lookupOpenLibrary(v).catch(err => { console.error(`Erreur Open Library (${v}):`, err.message); return null; }));
    calls.push(lookupGoogleBooks(v).catch(err => { console.error(`Erreur Google Books (${v}):`, err.message); return null; }));
    calls.push(lookupOpenLibraryEdition(v).catch(err => { console.error(`Erreur Open Library édition (${v}):`, err.message); return null; }));
    calls.push(lookupBnf(v).catch(err => { console.error(`Erreur BnF (${v}):`, err.message); return null; }));
  }
  // Un seul appel Amazon : la fonction convertit elle-même vers l'ISBN-10 nécessaire.
  calls.push(lookupAmazonCover(isbn).catch(err => { console.error(`Erreur Amazon (${isbn}):`, err.message); return null; }));
  // Geobib accepte ISBN-10 et ISBN-13 : on tente les deux variantes comme les autres sources.
  for (const v of variants) {
    calls.push(lookupGeobibCover(v).catch(err => { console.error(`Erreur Geobib (${v}):`, err.message); return null; }));
  }

  const arrived = [];
  const { merged, allSettled } = await new Promise((resolveOnce) => {
    let settledCount = 0;
    calls.forEach((call) => {
      call.then((r) => {
        arrived.push(r);
        settledCount++;
        const merged = mergeIsbnResults(arrived);
        if ((merged.title && merged.author && merged.cover_url) || settledCount === calls.length) {
          resolveOnce({ merged, allSettled: settledCount === calls.length });
        }
      });
    });
  });

  if (!merged.title) {
    console.error(`ISBN ${isbn} (variantes testées : ${variants.join(', ')}) : aucune source n'a répondu.`);
    return null;
  }

  let cover_url = merged.cover_url;
  if (!cover_url && allSettled) {
    // Open Library renvoie une petite image "introuvable" (~800 octets) plutôt
    // qu'une erreur HTTP quand aucune couverture n'existe pour cet ISBN : on
    // vérifie donc la taille réelle avant de proposer l'URL de repli. Inutile
    // si la sortie était anticipée : une couverture a alors déjà été trouvée.
    const fallbackUrl = `https://covers.openlibrary.org/b/isbn/${isbn}-M.jpg`;
    try {
      const headRes = await fetch(fallbackUrl, { method: 'GET', timeout: 6000 });
      const len = Number(headRes.headers.get('content-length') || 0);
      if (headRes.ok && len > 1000) cover_url = fallbackUrl;
    } catch {
      // pas de couverture disponible, on laisse cover_url vide
    }
  }

  const result = { isbn, ...merged, cover_url: cover_url || null };
  const exploitable = arrived.filter(Boolean).length;
  console.log(`ISBN ${isbn} → ${exploitable} source(s) exploitable(s) (${arrived.length}/${calls.length} arrivée(s)${allSettled ? '' : ', sortie anticipée'}) | auteur="${result.author}" couverture=${result.cover_url ? 'trouvée' : 'aucune'}`);
  return result;
}

// ============================================================================
// STOCKAGE LOCAL DES COUVERTURES (redimensionnées et optimisées)
// ============================================================================
// Les couvertures trouvées automatiquement (Open Library, Google Books,
// Amazon, Geobib...) ou collées manuellement sont des URL externes : le
// navigateur les recharge à chaque affichage, et elles cassent si la source
// disparaît un jour. Cette fonction télécharge l'image une seule fois, la
// redimensionne à une taille raisonnable pour l'affichage (largeur max 500px),
// la compresse en JPEG, et la stocke dans data/covers/{id}.jpg — servie
// ensuite localement via /covers/{id}.jpg, sans dépendre d'aucune source
// externe pour l'affichage au quotidien.
const COVER_MAX_WIDTH = Number(process.env.COVER_MAX_WIDTH) || 500;
const COVER_JPEG_QUALITY = Number(process.env.COVER_JPEG_QUALITY) || 82;

async function localizeCover(bookId, remoteUrl) {
  if (!remoteUrl || remoteUrl.startsWith('/covers/')) return remoteUrl || null;
  try {
    const res = await fetch(remoteUrl, { timeout: 12000 });
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.startsWith('image/')) return null;
    const buf = await res.buffer();
    if (buf.length < 500) return null; // image manifestement invalide/vide

    const outPath = path.join(COVERS_DIR, `${bookId}.jpg`);
    await sharp(buf)
      .resize({ width: COVER_MAX_WIDTH, withoutEnlargement: true })
      .jpeg({ quality: COVER_JPEG_QUALITY })
      .toFile(outPath);

    return `/covers/${bookId}.jpg?v=${Date.now()}`;
  } catch (err) {
    console.error(`Échec de mise en cache locale de la couverture (livre ${bookId}) :`, err.message);
    return null;
  }
}

function deleteLocalCover(bookId) {
  const p = path.join(COVERS_DIR, `${bookId}.jpg`);
  fs.promises.unlink(p).catch(() => {});
}

app.get('/api/isbn/:isbn', async (req, res) => {
  const isbn = req.params.isbn.replace(/[^0-9Xx]/g, '');
  try {
    const data = await lookupIsbn(isbn);
    if (!data || !data.title) {
      return res.status(404).json({ error: 'Aucun livre trouvé pour cet ISBN' });
    }
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur lors de la recherche ISBN' });
  }
});

// ---------- CRUD Livres ----------
app.get('/api/books', (req, res) => {
  const { q, type, genre, lu, sort, publisher, owner, status, minNote, series } = req.query;
  let query = 'SELECT * FROM books WHERE 1=1';
  const params = [];

  // Par défaut on ne montre que les livres possédés (pas la liste de souhaits
  // ni les revendus), pour ne jamais mélanger les vues par accident.
  query += ' AND status = ?';
  params.push(normalizeStatus(status));

  if (q) {
    query += ' AND (title LIKE ? OR author LIKE ? OR isbn LIKE ? OR series LIKE ?)';
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (type) {
    query += ' AND type = ?';
    params.push(type);
  }
  if (genre) {
    query += ' AND genre LIKE ?';
    params.push(`%${genre}%`);
  }
  if (publisher) {
    query += ' AND publisher = ?';
    params.push(publisher);
  }
  if (series) {
    query += ' AND series = ?';
    params.push(series);
  }
  if (owner) {
    query += ' AND owner LIKE ?';
    params.push(`%${owner}%`);
  }
  if (minNote) {
    query += ' AND note >= ?';
    params.push(Number(minNote));
  }
  if (lu === '1' || lu === '0') {
    query += ' AND lu = ?';
    params.push(Number(lu));
  }

  const sortMap = {
    title: 'title COLLATE NOCASE ASC',
    author: 'author COLLATE NOCASE ASC',
    note: 'note DESC',
    recent: 'created_at DESC'
  };
  query += ' ORDER BY ' + (sortMap[sort] || sortMap.recent);

  const rows = db.prepare(query).all(...params);
  res.json(rows);
});

app.get('/api/books/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM books WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Livre non trouvé' });
  res.json(row);
});

app.post('/api/books', async (req, res) => {
  const b = req.body;
  if (!b.title) return res.status(400).json({ error: 'Le titre est requis' });
  const stmt = db.prepare(`
    INSERT INTO books (isbn, title, author, type, genre, lu, note, location, lent_to, cover_url, read_date, publisher, owner, status, series, series_number)
    VALUES (@isbn, @title, @author, @type, @genre, @lu, @note, @location, @lent_to, @cover_url, @read_date, @publisher, @owner, @status, @series, @series_number)
  `);
  const info = stmt.run({
    isbn: b.isbn || null,
    title: b.title,
    author: b.author || '',
    type: b.type || 'roman',
    genre: b.genre || '',
    lu: b.lu ? 1 : 0,
    note: b.note != null && b.note !== '' ? Number(b.note) : null,
    location: b.location || '',
    lent_to: b.lent_to || '',
    cover_url: b.cover_url || null,
    read_date: b.read_date || null,
    publisher: b.publisher || '',
    owner: b.owner || '',
    status: normalizeStatus(b.status),
    series: b.series || '',
    series_number: b.series_number || ''
  });
  const bookId = info.lastInsertRowid;

  // Mise en cache locale de la couverture (si une URL externe a été fournie).
  // Ne bloque jamais la création du livre en cas d'échec : on garde l'URL
  // externe telle quelle si le téléchargement/redimensionnement échoue.
  if (b.cover_url) {
    const localUrl = await localizeCover(bookId, b.cover_url);
    if (localUrl) {
      db.prepare('UPDATE books SET cover_url = ? WHERE id = ?').run(localUrl, bookId);
    }
  }

  const created = db.prepare('SELECT * FROM books WHERE id = ?').get(bookId);
  res.status(201).json(created);
});

app.put('/api/books/:id', async (req, res) => {
  const existing = db.prepare('SELECT * FROM books WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Livre non trouvé' });
  const b = { ...existing, ...req.body };

  // Si une nouvelle URL externe de couverture est fournie (différente de celle
  // déjà en cache local), on la télécharge et remplace le fichier local existant.
  let coverToStore = b.cover_url || null;
  if (coverToStore && !coverToStore.startsWith('/covers/') && coverToStore !== existing.cover_url) {
    const localUrl = await localizeCover(req.params.id, coverToStore);
    if (localUrl) coverToStore = localUrl;
  }

  db.prepare(`
    UPDATE books SET isbn=@isbn, title=@title, author=@author, type=@type, genre=@genre,
      lu=@lu, note=@note, location=@location, lent_to=@lent_to, cover_url=@cover_url, read_date=@read_date,
      publisher=@publisher, owner=@owner, status=@status, series=@series, series_number=@series_number
    WHERE id=@id
  `).run({
    id: req.params.id,
    isbn: b.isbn || null,
    title: b.title,
    author: b.author || '',
    type: b.type || 'roman',
    genre: b.genre || '',
    lu: b.lu ? 1 : 0,
    note: b.note != null && b.note !== '' ? Number(b.note) : null,
    location: b.location || '',
    lent_to: b.lent_to || '',
    cover_url: coverToStore,
    read_date: b.read_date || null,
    publisher: b.publisher || '',
    owner: b.owner || '',
    status: normalizeStatus(b.status),
    series: b.series || '',
    series_number: b.series_number || ''
  });
  const updated = db.prepare('SELECT * FROM books WHERE id = ?').get(req.params.id);
  res.json(updated);
});

app.delete('/api/books/:id', (req, res) => {
  const info = db.prepare('DELETE FROM books WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Livre non trouvé' });
  deleteLocalCover(req.params.id);
  res.status(204).send();
});

// Liste des genres distincts (les livres peuvent avoir plusieurs genres
// séparés par des virgules, ex. "Fantasy, Aventure" -> on les éclate ici).
app.get('/api/genres', (req, res) => {
  const status = normalizeStatus(req.query.status);
  const rows = db.prepare("SELECT genre FROM books WHERE status = ? AND genre IS NOT NULL AND genre != ''").all(status);
  const set = new Set();
  for (const row of rows) {
    row.genre.split(',').map(g => g.trim()).filter(Boolean).forEach(g => set.add(g));
  }
  res.json([...set].sort((a, b) => a.localeCompare(b, 'fr')));
});

// Liste des éditeurs distincts.
app.get('/api/publishers', (req, res) => {
  const status = normalizeStatus(req.query.status);
  const rows = db.prepare("SELECT DISTINCT publisher FROM books WHERE status = ? AND publisher IS NOT NULL AND publisher != '' ORDER BY publisher COLLATE NOCASE").all(status);
  res.json(rows.map(r => r.publisher));
});

// Liste des séries distinctes.
app.get('/api/series', (req, res) => {
  const status = normalizeStatus(req.query.status);
  const rows = db.prepare("SELECT DISTINCT series FROM books WHERE status = ? AND series IS NOT NULL AND series != '' ORDER BY series COLLATE NOCASE").all(status);
  res.json(rows.map(r => r.series));
});

// Liste des propriétaires distincts (comme le genre, plusieurs noms peuvent
// être séparés par des virgules pour un livre partagé entre plusieurs personnes).
app.get('/api/owners', (req, res) => {
  const status = normalizeStatus(req.query.status);
  const rows = db.prepare("SELECT owner FROM books WHERE status = ? AND owner IS NOT NULL AND owner != ''").all(status);
  const set = new Set();
  for (const row of rows) {
    row.owner.split(',').map(o => o.trim()).filter(Boolean).forEach(o => set.add(o));
  }
  res.json([...set].sort((a, b) => a.localeCompare(b, 'fr')));
});

// ---------- Import en masse par liste d'ISBN ----------
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

app.post('/api/books/bulk-isbn', async (req, res) => {
  const isbns = Array.isArray(req.body.isbns) ? req.body.isbns : [];
  const results = [];
  const insertStmt = db.prepare(`
    INSERT INTO books (isbn, title, author, type, genre, lu, note, location, lent_to, cover_url, read_date, publisher, owner, status, series, series_number)
    VALUES (@isbn, @title, @author, @type, @genre, @lu, @note, @location, @lent_to, @cover_url, @read_date, @publisher, @owner, @status, @series, @series_number)
  `);
  const defaults = req.body.defaults || {};
  const status = defaults.status === 'souhaite' ? 'souhaite' : 'possede';

  for (const raw of isbns) {
    const isbn = String(raw).replace(/[^0-9Xx]/g, '');
    if (!isbn) continue;
    try {
      const data = await lookupIsbn(isbn);
      if (!data || !data.title) {
        results.push({ isbn, ok: false, error: 'Introuvable' });
        continue;
      }
      const info = insertStmt.run({
        isbn: data.isbn || isbn,
        title: data.title,
        author: data.author || '',
        type: normalizeType(defaults.type),
        genre: data.genre || '',
        lu: defaults.lu ? 1 : 0,
        note: null,
        location: defaults.location || '',
        lent_to: '',
        cover_url: data.cover_url || null,
        read_date: null,
        publisher: data.publisher || '',
        owner: defaults.owner || '',
        status,
        series: '',
        series_number: ''
      });
      const bookId = info.lastInsertRowid;
      if (data.cover_url) {
        const localUrl = await localizeCover(bookId, data.cover_url);
        if (localUrl) db.prepare('UPDATE books SET cover_url = ? WHERE id = ?').run(localUrl, bookId);
      }
      results.push({ isbn, ok: true, id: bookId, title: data.title });
    } catch (err) {
      results.push({ isbn, ok: false, error: 'Erreur réseau' });
    }
    await sleep(150); // ménage l'API publique, évite le rate-limiting
  }

  res.json({
    total: isbns.length,
    added: results.filter(r => r.ok).length,
    failed: results.filter(r => !r.ok).length,
    results
  });
});

// normalizeStatus/normalizeType (+ VALID_STATUSES/VALID_TYPES) sont dans
// lib/isbn-utils.js (fonctions pures, testées).

// ---------- Import en masse par liste d'objets (CSV déjà parsé côté client) ----------
app.post('/api/books/bulk', async (req, res) => {
  const books = Array.isArray(req.body.books) ? req.body.books : [];
  const insertStmt = db.prepare(`
    INSERT INTO books (isbn, title, author, type, genre, lu, note, location, lent_to, cover_url, read_date, publisher, owner, status, series, series_number)
    VALUES (@isbn, @title, @author, @type, @genre, @lu, @note, @location, @lent_to, @cover_url, @read_date, @publisher, @owner, @status, @series, @series_number)
  `);
  let added = 0;
  const errors = [];
  const insertedIdsWithCover = []; // [{id, cover_url}], traité après la transaction (localizeCover est asynchrone)

  const insertMany = db.transaction((rows) => {
    rows.forEach((b, idx) => {
      if (!b.title || !String(b.title).trim()) {
        errors.push({ row: idx + 1, error: 'Titre manquant' });
        return;
      }
      const info = insertStmt.run({
        isbn: b.isbn || null,
        title: String(b.title).trim(),
        author: b.author || '',
        type: normalizeType(b.type),
        genre: b.genre || '',
        lu: (b.lu === true || b.lu === '1' || String(b.lu).toLowerCase() === 'oui' || String(b.lu).toLowerCase() === 'true') ? 1 : 0,
        note: b.note !== undefined && b.note !== '' && b.note !== null ? Number(b.note) : null,
        location: b.location || '',
        lent_to: b.lent_to || '',
        cover_url: b.cover_url || null,
        read_date: b.read_date || null,
        publisher: b.publisher || '',
        owner: b.owner || '',
        status: String(b.status || '').toLowerCase() === 'souhaite' ? 'souhaite' : 'possede',
        series: b.series || '',
        series_number: b.series_number || ''
      });
      added++;
      if (b.cover_url) insertedIdsWithCover.push({ id: info.lastInsertRowid, cover_url: b.cover_url });
    });
  });

  insertMany(books);

  // Mise en cache locale des couvertures fournies dans le CSV (colonne cover_url,
  // rarement utilisée mais gérée pour rester cohérent avec les autres méthodes d'ajout).
  for (const { id, cover_url } of insertedIdsWithCover) {
    const localUrl = await localizeCover(id, cover_url);
    if (localUrl) db.prepare('UPDATE books SET cover_url = ? WHERE id = ?').run(localUrl, id);
  }

  res.json({ total: books.length, added, failed: errors.length, errors });
});

// Stats simples (utilisées sur la page d'accueil)
// Optimise rétroactivement les couvertures des livres déjà en base qui
// pointent encore vers une URL externe (livres ajoutés avant la mise en
// cache locale des couvertures, ou dont la localisation avait échoué).
app.post('/api/covers/localize-all', async (req, res) => {
  const rows = db.prepare("SELECT id, cover_url FROM books WHERE cover_url IS NOT NULL AND cover_url != ''").all();
  const toProcess = rows.filter(r => !r.cover_url.startsWith('/covers/'));
  let done = 0;
  let failed = 0;

  for (const row of toProcess) {
    const localUrl = await localizeCover(row.id, row.cover_url);
    if (localUrl) {
      db.prepare('UPDATE books SET cover_url = ? WHERE id = ?').run(localUrl, row.id);
      done++;
    } else {
      failed++;
    }
  }

  res.json({ total: toProcess.length, done, failed, alreadyLocal: rows.length - toProcess.length });
});

// Statistiques par propriétaire : nombre de livres possédés, répartition par
// genre, et répartition des lectures par année. Un livre peut avoir plusieurs
// propriétaires (ex. "Papa, Fils") et plusieurs genres séparés par des
// virgules ; chaque nom/genre compte pour lui-même, comme pour les filtres.
app.get('/api/stats/owners', (req, res) => {
  // Un livre revendu (status='revendu') sort de la collection : il ne compte
  // plus dans le total ni dans la répartition par genre. Mais l'avoir lu reste
  // vrai même après l'avoir revendu, donc il continue de compter dans
  // l'historique de lecture (byYear) — d'où l'inclusion des deux statuts ici,
  // avec un filtre différent selon la statistique plus bas.
  const rows = db.prepare("SELECT owner, genre, lu, read_date, status FROM books WHERE status IN ('possede', 'revendu')").all();
  const owners = new Map(); // nom -> { total, byGenre: Map, byYear: Map }

  const getOwnerEntry = (name) => {
    if (!owners.has(name)) owners.set(name, { total: 0, byGenre: new Map(), byYear: new Map() });
    return owners.get(name);
  };
  const bump = (map, key) => map.set(key, (map.get(key) || 0) + 1);

  for (const row of rows) {
    const ownerNames = (row.owner || '').split(',').map(o => o.trim()).filter(Boolean);
    const names = ownerNames.length ? ownerNames : ['Sans propriétaire'];
    const genres = (row.genre || '').split(',').map(g => g.trim()).filter(Boolean);
    const year = (row.lu && row.read_date) ? row.read_date.slice(0, 4) : null;

    for (const name of names) {
      const entry = getOwnerEntry(name);
      if (row.status === 'possede') {
        entry.total++;
        genres.forEach(g => bump(entry.byGenre, g));
      }
      if (year) bump(entry.byYear, year);
    }
  }

  const result = [...owners.entries()]
    // Un livre revendu, sans propriétaire renseigné et jamais lu (ou lu sans
    // date) crée une entrée sans rien dedans (total à 0, aucun genre, aucune
    // année) : on l'exclut plutôt que d'afficher une carte vide à côté des
    // propriétaires ayant vraiment des livres.
    .filter(([, entry]) => entry.total > 0 || entry.byGenre.size > 0 || entry.byYear.size > 0)
    .map(([name, entry]) => ({
      name,
      total: entry.total,
      byGenre: [...entry.byGenre.entries()].sort((a, b) => b[1] - a[1]).map(([genre, count]) => ({ genre, count })),
      byYear: [...entry.byYear.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([year, count]) => ({ year, count }))
    }))
    .sort((a, b) => b.total - a.total);

  res.json(result);
});

app.get('/api/stats', (req, res) => {
  const total = db.prepare("SELECT COUNT(*) c FROM books WHERE status = 'possede'").get().c;
  const lus = db.prepare("SELECT COUNT(*) c FROM books WHERE status = 'possede' AND lu = 1").get().c;
  const pretes = db.prepare("SELECT COUNT(*) c FROM books WHERE status = 'possede' AND lent_to IS NOT NULL AND lent_to != ''").get().c;
  const souhaites = db.prepare("SELECT COUNT(*) c FROM books WHERE status = 'souhaite'").get().c;
  res.json({ total, lus, pretes, souhaites });
});

// ---------- Sauvegarde automatique ----------
// Copie périodique de la base et des couvertures dans data/backup/, en plus
// de la sauvegarde NAS habituelle (Hyper Backup, snapshot...) qui protège
// tout /app/data. La base est sauvegardée via l'API de backup à chaud de
// SQLite (db.backup), pas une simple copie de fichier : une copie brute d'un
// .db en WAL actif peut capturer un état incohérent en cas d'écriture
// concurrente, alors que db.backup() produit un instantané cohérent.
const BACKUP_DIR = path.join(DATA_DIR, 'backup');
const BACKUP_INTERVAL_MS = (Number(process.env.BACKUP_INTERVAL_DAYS) || 15) * 24 * 60 * 60 * 1000;
const BACKUP_KEEP = Number(process.env.BACKUP_KEEP) || 6; // ~3 mois d'historique à raison d'une sauvegarde tous les 15 jours par défaut

function pruneOldBackups() {
  const dirs = fs.readdirSync(BACKUP_DIR)
    .filter(name => /^\d{4}-\d{2}-\d{2}$/.test(name))
    .sort();
  while (dirs.length > BACKUP_KEEP) {
    fs.rmSync(path.join(BACKUP_DIR, dirs.shift()), { recursive: true, force: true });
  }
}

async function performBackup() {
  const stamp = new Date().toISOString().slice(0, 10);
  const dest = path.join(BACKUP_DIR, stamp);
  if (fs.existsSync(dest)) return; // déjà fait aujourd'hui (ex. redémarrage du conteneur)
  fs.mkdirSync(dest, { recursive: true });
  try {
    await db.backup(path.join(dest, 'bibliotheque.db'));
    if (fs.existsSync(COVERS_DIR)) {
      fs.cpSync(COVERS_DIR, path.join(dest, 'covers'), { recursive: true });
    }
    console.log(`Sauvegarde automatique effectuée dans ${dest}`);
  } catch (err) {
    console.error('Échec de la sauvegarde automatique :', err.message);
    fs.rmSync(dest, { recursive: true, force: true });
  }
  pruneOldBackups();
}

function scheduleBackups() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const existing = fs.readdirSync(BACKUP_DIR).filter(name => /^\d{4}-\d{2}-\d{2}$/.test(name)).sort();
  const lastBackup = existing.length ? new Date(existing[existing.length - 1]) : null;
  const elapsed = lastBackup ? Date.now() - lastBackup.getTime() : Infinity;
  const delay = elapsed >= BACKUP_INTERVAL_MS ? 0 : BACKUP_INTERVAL_MS - elapsed;

  setTimeout(() => {
    performBackup().finally(() => {
      setInterval(performBackup, BACKUP_INTERVAL_MS).unref();
    });
  }, delay).unref();
}

scheduleBackups();

app.listen(PORT, () => {
  console.log(`Bibliothèque disponible sur le port ${PORT}`);
});
