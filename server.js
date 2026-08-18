const express = require('express');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const fetch = require('node-fetch');
const sharp = require('sharp');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const COVERS_DIR = path.join(DATA_DIR, 'covers');

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

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/covers', express.static(COVERS_DIR, { maxAge: '30d' }));

// ---------- Conversion ISBN-10 <-> ISBN-13 ----------
// De nombreux livres (surtout les BD françaises anciennes) ne sont indexés
// que sous une seule des deux formes selon la source. On génère donc
// systématiquement l'autre forme et on interroge les deux.
function isbn10to13(isbn10) {
  if (!/^\d{9}[\dXx]$/.test(isbn10)) return null;
  const core = '978' + isbn10.slice(0, 9);
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(core[i]) * (i % 2 === 0 ? 1 : 3);
  const check = (10 - (sum % 10)) % 10;
  return core + check;
}

function isbn13to10(isbn13) {
  if (!/^978\d{9}[\dXx]$/.test(isbn13)) return null;
  const core = isbn13.slice(3, 12);
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(core[i]) * (10 - i);
  let check = (11 - (sum % 11)) % 11;
  const checkChar = check === 10 ? 'X' : String(check);
  return core + checkChar;
}

function isbnVariants(isbn) {
  const variants = [isbn];
  if (isbn.length === 10) {
    const conv = isbn10to13(isbn);
    if (conv) variants.push(conv);
  } else if (isbn.length === 13) {
    const conv = isbn13to10(isbn);
    if (conv) variants.push(conv);
  }
  return variants;
}

// ---------- Recherche ISBN (Open Library + Google Books, fusionnés) ----------
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
function xmlUnescape(str) {
  return str
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

function extractAllXmlTags(xml, tag) {
  const re = new RegExp(`<[^:>]*:?${tag}[^>]*>([\\s\\S]*?)<\\/[^:>]*:?${tag}>`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(xml)) !== null) {
    const val = xmlUnescape(m[1].trim());
    if (val) out.push(val);
  }
  return out;
}

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
    author: creators.slice(0, 2).join(', '),
    genre: subjects.slice(0, 3).join(', '),
    publisher: publishers.slice(0, 1).join(', '),
    cover_url: null
  };
}

// Interroge Open Library + Google Books, sur la forme ISBN-10 ET ISBN-13,
// et fusionne tous les résultats non vides (l'auteur et la couverture sont
// souvent absents d'une des quatre réponses selon la source et le format).
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
  const results = (await Promise.all(calls)).filter(Boolean);

  if (!results.length) {
    console.error(`ISBN ${isbn} (variantes testées : ${variants.join(', ')}) : aucune source n'a répondu.`);
    return null;
  }

  const firstNonEmpty = (key) => {
    for (const r of results) {
      if (r[key] && String(r[key]).trim()) return r[key];
    }
    return '';
  };

  const title = firstNonEmpty('title');
  if (!title) return null;

  let cover_url = firstNonEmpty('cover_url');
  if (!cover_url) {
    // Open Library renvoie une petite image "introuvable" (~800 octets) plutôt
    // qu'une erreur HTTP quand aucune couverture n'existe pour cet ISBN : on
    // vérifie donc la taille réelle avant de proposer l'URL de repli.
    const fallbackUrl = `https://covers.openlibrary.org/b/isbn/${isbn}-M.jpg`;
    try {
      const headRes = await fetch(fallbackUrl, { method: 'GET', timeout: 6000 });
      const len = Number(headRes.headers.get('content-length') || 0);
      if (headRes.ok && len > 1000) cover_url = fallbackUrl;
    } catch {
      // pas de couverture disponible, on laisse cover_url vide
    }
  }

  const result = {
    isbn,
    title,
    author: firstNonEmpty('author'),
    genre: firstNonEmpty('genre'),
    publisher: firstNonEmpty('publisher'),
    cover_url: cover_url || null
  };
  console.log(`ISBN ${isbn} → ${results.length}/${calls.length} réponse(s) exploitable(s) | auteur="${result.author}" couverture=${result.cover_url ? 'trouvée' : 'aucune'}`);
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
const COVER_MAX_WIDTH = 500;
const COVER_JPEG_QUALITY = 82;

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
  const { q, type, genre, lu, sort, publisher, owner, status } = req.query;
  let query = 'SELECT * FROM books WHERE 1=1';
  const params = [];

  // Par défaut on ne montre que les livres possédés (pas la liste de souhaits),
  // pour ne jamais mélanger les deux vues par accident.
  query += ' AND status = ?';
  params.push(status === 'souhaite' ? 'souhaite' : 'possede');

  if (q) {
    query += ' AND (title LIKE ? OR author LIKE ? OR isbn LIKE ?)';
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
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
  if (owner) {
    query += ' AND owner LIKE ?';
    params.push(`%${owner}%`);
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
    INSERT INTO books (isbn, title, author, type, genre, lu, note, location, lent_to, cover_url, read_date, publisher, owner, status)
    VALUES (@isbn, @title, @author, @type, @genre, @lu, @note, @location, @lent_to, @cover_url, @read_date, @publisher, @owner, @status)
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
    status: b.status === 'souhaite' ? 'souhaite' : 'possede'
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
      publisher=@publisher, owner=@owner, status=@status
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
    status: b.status === 'souhaite' ? 'souhaite' : 'possede'
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
  const status = req.query.status === 'souhaite' ? 'souhaite' : 'possede';
  const rows = db.prepare("SELECT genre FROM books WHERE status = ? AND genre IS NOT NULL AND genre != ''").all(status);
  const set = new Set();
  for (const row of rows) {
    row.genre.split(',').map(g => g.trim()).filter(Boolean).forEach(g => set.add(g));
  }
  res.json([...set].sort((a, b) => a.localeCompare(b, 'fr')));
});

// Liste des éditeurs distincts.
app.get('/api/publishers', (req, res) => {
  const status = req.query.status === 'souhaite' ? 'souhaite' : 'possede';
  const rows = db.prepare("SELECT DISTINCT publisher FROM books WHERE status = ? AND publisher IS NOT NULL AND publisher != '' ORDER BY publisher COLLATE NOCASE").all(status);
  res.json(rows.map(r => r.publisher));
});

// Liste des propriétaires distincts (comme le genre, plusieurs noms peuvent
// être séparés par des virgules pour un livre partagé entre plusieurs personnes).
app.get('/api/owners', (req, res) => {
  const status = req.query.status === 'souhaite' ? 'souhaite' : 'possede';
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
    INSERT INTO books (isbn, title, author, type, genre, lu, note, location, lent_to, cover_url, read_date, publisher, owner, status)
    VALUES (@isbn, @title, @author, @type, @genre, @lu, @note, @location, @lent_to, @cover_url, @read_date, @publisher, @owner, @status)
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
        status
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

// Types valides pour la fiche d'un livre.
const VALID_TYPES = ['roman', 'bd', 'manga', 'essai', 'autre'];
function normalizeType(raw) {
  const t = String(raw || '').trim().toLowerCase();
  const aliases = { bds: 'bd', mangas: 'manga', essais: 'essai', 'roman graphique': 'bd' };
  const normalized = aliases[t] || t;
  return VALID_TYPES.includes(normalized) ? normalized : 'roman';
}

// ---------- Import en masse par liste d'objets (CSV déjà parsé côté client) ----------
app.post('/api/books/bulk', async (req, res) => {
  const books = Array.isArray(req.body.books) ? req.body.books : [];
  const insertStmt = db.prepare(`
    INSERT INTO books (isbn, title, author, type, genre, lu, note, location, lent_to, cover_url, read_date, publisher, owner, status)
    VALUES (@isbn, @title, @author, @type, @genre, @lu, @note, @location, @lent_to, @cover_url, @read_date, @publisher, @owner, @status)
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
        status: String(b.status || '').toLowerCase() === 'souhaite' ? 'souhaite' : 'possede'
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

app.get('/api/stats', (req, res) => {
  const total = db.prepare("SELECT COUNT(*) c FROM books WHERE status = 'possede'").get().c;
  const lus = db.prepare("SELECT COUNT(*) c FROM books WHERE status = 'possede' AND lu = 1").get().c;
  const pretes = db.prepare("SELECT COUNT(*) c FROM books WHERE status = 'possede' AND lent_to IS NOT NULL AND lent_to != ''").get().c;
  const souhaites = db.prepare("SELECT COUNT(*) c FROM books WHERE status = 'souhaite'").get().c;
  res.json({ total, lus, pretes, souhaites });
});

app.listen(PORT, () => {
  console.log(`Bibliothèque disponible sur le port ${PORT}`);
});
