// Accès lecture seule à la même base SQLite que server.js (même volume
// Docker, même fichier bibliotheque.db). Ce service ne crée ni ne migre
// jamais le schéma : il suppose que l'appli principale a déjà tourné au
// moins une fois et créé/mis à jour les tables.
import path from 'path';
import Database from 'better-sqlite3';
import { normalizeStatus, normalizeType, VALID_TYPES } from '../lib/isbn-utils.js';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'bibliotheque.db');

let db;
export function openDb() {
  if (db) return db;
  try {
    db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  } catch (err) {
    throw new Error(
      `Impossible d'ouvrir ${DB_PATH} en lecture (${err.message}). ` +
      `Vérifiez que DATA_DIR pointe bien vers le même volume que l'appli Ma Bibliothèque, ` +
      `et que celle-ci a déjà démarré au moins une fois.`
    );
  }
  return db;
}

const MAX_RESULTS = 20;

// Reprend telle quelle la logique de construction de requête de
// GET /api/books (server.js) : mêmes filtres, même comportement par défaut
// (uniquement les livres possédés si `status` n'est pas précisé).
export function searchBooks({ query, author, genre, type, owner, status, lu, limit } = {}) {
  const db = openDb();
  let sql = 'SELECT * FROM books WHERE 1=1';
  const params = [];

  sql += ' AND status = ?';
  params.push(normalizeStatus(status));

  if (query) {
    sql += ' AND (title LIKE ? OR author LIKE ? OR series LIKE ?)';
    params.push(`%${query}%`, `%${query}%`, `%${query}%`);
  }
  if (author) {
    sql += ' AND author LIKE ?';
    params.push(`%${author}%`);
  }
  if (genre) {
    sql += ' AND genre LIKE ?';
    params.push(`%${genre}%`);
  }
  if (type) {
    sql += ' AND type = ?';
    params.push(normalizeType(type));
  }
  if (owner) {
    sql += ' AND owner LIKE ?';
    params.push(`%${owner}%`);
  }
  if (lu === true || lu === false) {
    sql += ' AND lu = ?';
    params.push(lu ? 1 : 0);
  }
  sql += ' ORDER BY title COLLATE NOCASE ASC';

  const capped = Math.min(Math.max(Number(limit) || MAX_RESULTS, 1), 50);
  const rows = db.prepare(sql).all(...params);
  return { rows: rows.slice(0, capped), total: rows.length, truncated: rows.length > capped };
}

export function findBooksByTitle(title) {
  const db = openDb();
  return db.prepare(
    "SELECT * FROM books WHERE status != 'revendu' AND title LIKE ? ORDER BY title COLLATE NOCASE ASC LIMIT 10"
  ).all(`%${title}%`);
}

export function getBookReads(bookId) {
  const db = openDb();
  return db.prepare('SELECT owner, read_date, note FROM book_owner_reads WHERE book_id = ?').all(bookId);
}

export function getLibraryStats() {
  const db = openDb();
  const total = db.prepare("SELECT COUNT(*) c FROM books WHERE status = 'possede'").get().c;
  const lus = db.prepare("SELECT COUNT(*) c FROM books WHERE status = 'possede' AND lu = 1").get().c;
  const pretes = db.prepare("SELECT COUNT(*) c FROM books WHERE status = 'possede' AND lent_to IS NOT NULL AND lent_to != ''").get().c;
  const souhaites = db.prepare("SELECT COUNT(*) c FROM books WHERE status = 'souhaite'").get().c;
  return { total, lus, pretes, souhaites };
}

// Reprend l'algorithme de GET /api/stats/owners (server.js) : total/genres
// à partir de `books.owner`, lectures/notes à partir de `book_owner_reads`
// (précis par personne), avec le même repli "Sans propriétaire" pour les
// livres sans propriétaire renseigné.
export function getOwnerStats(ownerFilter) {
  const db = openDb();
  const rows = db.prepare("SELECT owner, genre, lu, read_date, note, status FROM books WHERE status IN ('possede', 'revendu')").all();
  const reads = db.prepare(`
    SELECT br.owner, br.read_date, br.note
    FROM book_owner_reads br
    JOIN books b ON b.id = br.book_id
    WHERE b.status IN ('possede', 'revendu')
  `).all();

  const owners = new Map();
  const getOwnerEntry = (name) => {
    if (!owners.has(name)) owners.set(name, { total: 0, byGenre: new Map(), byYear: new Map(), noteSum: 0, noteCount: 0 });
    return owners.get(name);
  };
  const bump = (map, key) => map.set(key, (map.get(key) || 0) + 1);

  for (const row of rows) {
    const ownerNames = (row.owner || '').split(',').map((o) => o.trim()).filter(Boolean);
    const genres = (row.genre || '').split(',').map((g) => g.trim()).filter(Boolean);

    if (ownerNames.length) {
      for (const name of ownerNames) {
        if (row.status === 'possede') {
          const entry = getOwnerEntry(name);
          entry.total++;
          genres.forEach((g) => bump(entry.byGenre, g));
        }
      }
    } else {
      const entry = getOwnerEntry('Sans propriétaire');
      if (row.status === 'possede') {
        entry.total++;
        genres.forEach((g) => bump(entry.byGenre, g));
      }
      if (row.lu && row.read_date) bump(entry.byYear, row.read_date.slice(0, 4));
      if (row.lu && row.note != null) { entry.noteSum += row.note; entry.noteCount++; }
    }
  }

  for (const r of reads) {
    if (!r.owner) continue;
    const entry = getOwnerEntry(r.owner);
    if (r.read_date) bump(entry.byYear, r.read_date.slice(0, 4));
    if (r.note != null) { entry.noteSum += r.note; entry.noteCount++; }
  }

  let result = [...owners.entries()]
    .filter(([, entry]) => entry.total > 0 || entry.byGenre.size > 0 || entry.byYear.size > 0)
    .map(([name, entry]) => ({
      name,
      total: entry.total,
      byGenre: [...entry.byGenre.entries()].sort((a, b) => b[1] - a[1]).map(([genre, count]) => ({ genre, count })),
      byYear: [...entry.byYear.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([year, count]) => ({ year, count })),
      avgNote: entry.noteCount ? Math.round((entry.noteSum / entry.noteCount) * 10) / 10 : null
    }))
    .sort((a, b) => b.total - a.total);

  if (ownerFilter) {
    const needle = ownerFilter.trim().toLowerCase();
    result = result.filter((o) => o.name.toLowerCase().includes(needle));
  }
  return result;
}

export { VALID_TYPES };
