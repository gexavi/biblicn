// Fonctions pures utilisées par la recherche ISBN (server.js) : conversion
// ISBN-10/13, fusion des résultats de plusieurs sources, parsing XML minimal
// pour la BnF, normalisation des champs type/status. Aucune ici ne fait
// d'appel réseau ni de base de données, ce qui les rend testables isolément
// (voir test/isbn-utils.test.js).

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

// La BnF fournit les auteurs au format bibliothécaire "Nom, Prénom" (ex.
// "Herbert, Frank"), à l'inverse d'Open Library et Google Books qui donnent
// déjà "Prénom Nom" — sans cette conversion, un livre trouvé via une source
// puis l'autre selon l'ISBN se retrouve avec un format d'auteur incohérent
// dans la bibliothèque. On ne coupe que sur la première virgule : un nom
// composé après celle-ci (ex. "Saint-Exupéry, Antoine de") reste intact et
// se retrouve simplement déplacé en tête ("Antoine de Saint-Exupéry").
function bnfAuthorToDisplayName(creator) {
  const m = creator.match(/^([^,]+),\s*(.+)$/);
  return m ? `${m[2]} ${m[1]}`.trim() : creator;
}

// Fusionne les réponses déjà arrivées (title/author/genre/publisher/cover_url),
// en gardant la première valeur non vide rencontrée dans l'ordre du tableau.
function mergeIsbnResults(results) {
  const firstNonEmpty = (key) => {
    for (const r of results) {
      if (r && r[key] && String(r[key]).trim()) return r[key];
    }
    return '';
  };
  return {
    title: firstNonEmpty('title'),
    author: firstNonEmpty('author'),
    genre: firstNonEmpty('genre'),
    publisher: firstNonEmpty('publisher'),
    cover_url: firstNonEmpty('cover_url') || null
  };
}

// Statuts valides pour la fiche d'un livre : 'possede' (bibliothèque),
// 'souhaite' (liste de souhaits), 'revendu' (n'apparaît plus dans les listes
// possédées ni dans les statistiques de collection, mais reste compté dans
// l'historique de lecture des propriétaires — voir /api/stats/owners).
const VALID_STATUSES = ['possede', 'souhaite', 'revendu'];
function normalizeStatus(raw) {
  return VALID_STATUSES.includes(raw) ? raw : 'possede';
}

// Types valides pour la fiche d'un livre.
const VALID_TYPES = ['roman', 'bd', 'manga', 'essai', 'autre'];
function normalizeType(raw) {
  const t = String(raw || '').trim().toLowerCase();
  const aliases = { bds: 'bd', mangas: 'manga', essais: 'essai', 'roman graphique': 'bd' };
  const normalized = aliases[t] || t;
  return VALID_TYPES.includes(normalized) ? normalized : 'roman';
}

module.exports = {
  isbn10to13,
  isbn13to10,
  isbnVariants,
  xmlUnescape,
  extractAllXmlTags,
  bnfAuthorToDisplayName,
  mergeIsbnResults,
  VALID_STATUSES,
  normalizeStatus,
  VALID_TYPES,
  normalizeType
};
