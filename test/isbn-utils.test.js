const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  isbn10to13, isbn13to10, isbnVariants, xmlUnescape, extractAllXmlTags,
  bnfAuthorToDisplayName, mergeIsbnResults, normalizeStatus, normalizeType
} = require('../lib/isbn-utils');

// Paire ISBN-10/ISBN-13 de référence (exemple documenté sur Wikipedia,
// "The Unicode Standard" — 0-306-40615-2 <-> 978-0-306-40615-7), utilisée
// pour vérifier le calcul du chiffre de contrôle sans dépendre d'une
// conversion supposée juste.
const REF_ISBN10 = '0306406152';
const REF_ISBN13 = '9780306406157';

test('isbn10to13 convertit un ISBN-10 valide', () => {
  assert.equal(isbn10to13(REF_ISBN10), REF_ISBN13);
});

test('isbn10to13 gère le chiffre de contrôle X sans planter (ignoré dans le calcul)', () => {
  assert.equal(isbn10to13('080442957X'), '9780804429573');
});

test('isbn10to13 renvoie null pour une entrée invalide', () => {
  assert.equal(isbn10to13('abc'), null);
  assert.equal(isbn10to13('12345'), null);
});

test('isbn13to10 convertit un ISBN-13 valide', () => {
  assert.equal(isbn13to10(REF_ISBN13), REF_ISBN10);
});

test('isbn13to10 renvoie null pour un préfixe non-978 (ex. 979, sans équivalent ISBN-10)', () => {
  assert.equal(isbn13to10('9791234567896'), null);
});

test('isbn10to13 et isbn13to10 sont réciproques', () => {
  assert.equal(isbn13to10(isbn10to13(REF_ISBN10)), REF_ISBN10);
});

test('isbnVariants ajoute la forme convertie pour un ISBN-10', () => {
  assert.deepEqual(isbnVariants(REF_ISBN10), [REF_ISBN10, REF_ISBN13]);
});

test('isbnVariants ajoute la forme convertie pour un ISBN-13', () => {
  assert.deepEqual(isbnVariants(REF_ISBN13), [REF_ISBN13, REF_ISBN10]);
});

test('isbnVariants renvoie seulement l\'entrée pour un ISBN-13 979 (pas d\'équivalent ISBN-10)', () => {
  assert.deepEqual(isbnVariants('9791234567896'), ['9791234567896']);
});

test('isbnVariants ne convertit pas une longueur inattendue', () => {
  assert.deepEqual(isbnVariants('123'), ['123']);
});

test('xmlUnescape décode les entités XML courantes', () => {
  assert.equal(xmlUnescape('Tom &amp; Jerry &lt;test&gt; &quot;a&quot; &apos;b&apos;'), 'Tom & Jerry <test> "a" \'b\'');
});

test('extractAllXmlTags extrait le contenu de balises simples', () => {
  const xml = '<record><dc:title>Dune</dc:title><dc:title>Autre titre</dc:title></record>';
  assert.deepEqual(extractAllXmlTags(xml, 'title'), ['Dune', 'Autre titre']);
});

test('extractAllXmlTags ignore les balises vides', () => {
  const xml = '<dc:creator></dc:creator><dc:creator>Herbert, Frank</dc:creator>';
  assert.deepEqual(extractAllXmlTags(xml, 'creator'), ['Herbert, Frank']);
});

test('extractAllXmlTags décode les entités dans le contenu extrait', () => {
  const xml = '<dc:title>Fils &amp; Filles</dc:title>';
  assert.deepEqual(extractAllXmlTags(xml, 'title'), ['Fils & Filles']);
});

test('bnfAuthorToDisplayName convertit "Nom, Prénom" en "Prénom Nom"', () => {
  assert.equal(bnfAuthorToDisplayName('Herbert, Frank'), 'Frank Herbert');
});

test('bnfAuthorToDisplayName ne coupe que sur la première virgule', () => {
  assert.equal(bnfAuthorToDisplayName('Saint-Exupéry, Antoine de'), 'Antoine de Saint-Exupéry');
});

test('bnfAuthorToDisplayName laisse intact un nom sans virgule', () => {
  assert.equal(bnfAuthorToDisplayName('Frank Herbert'), 'Frank Herbert');
});

test('mergeIsbnResults garde la première valeur non vide par champ, dans l\'ordre', () => {
  const results = [
    { title: '', author: '', genre: '', publisher: '', cover_url: null },
    { title: 'Dune', author: '', genre: 'Science-fiction', publisher: '', cover_url: null },
    { title: 'Autre titre', author: 'Frank Herbert', genre: 'Autre genre', publisher: 'Robert Laffont', cover_url: 'https://example.com/cover.jpg' }
  ];
  assert.deepEqual(mergeIsbnResults(results), {
    title: 'Dune',
    author: 'Frank Herbert',
    genre: 'Science-fiction',
    publisher: 'Robert Laffont',
    cover_url: 'https://example.com/cover.jpg'
  });
});

test('mergeIsbnResults ignore les entrées null (source échouée)', () => {
  const results = [null, { title: 'Dune', author: '', genre: '', publisher: '', cover_url: null }, null];
  assert.equal(mergeIsbnResults(results).title, 'Dune');
});

test('mergeIsbnResults renvoie des chaînes vides et cover_url null quand aucune source n\'a répondu', () => {
  assert.deepEqual(mergeIsbnResults([null, null]), {
    title: '', author: '', genre: '', publisher: '', cover_url: null
  });
});

test('normalizeStatus accepte les statuts valides', () => {
  assert.equal(normalizeStatus('possede'), 'possede');
  assert.equal(normalizeStatus('souhaite'), 'souhaite');
  assert.equal(normalizeStatus('revendu'), 'revendu');
});

test('normalizeStatus retombe sur "possede" pour une valeur invalide ou absente', () => {
  assert.equal(normalizeStatus('autre chose'), 'possede');
  assert.equal(normalizeStatus(undefined), 'possede');
  assert.equal(normalizeStatus(null), 'possede');
});

test('normalizeType accepte les types valides', () => {
  assert.equal(normalizeType('bd'), 'bd');
  assert.equal(normalizeType('manga'), 'manga');
});

test('normalizeType applique les alias connus (import CSV notamment)', () => {
  assert.equal(normalizeType('BDs'), 'bd');
  assert.equal(normalizeType('Mangas'), 'manga');
  assert.equal(normalizeType('Essais'), 'essai');
  assert.equal(normalizeType('roman graphique'), 'bd');
});

test('normalizeType est insensible à la casse et aux espaces', () => {
  assert.equal(normalizeType('  BD  '), 'bd');
});

test('normalizeType retombe sur "roman" pour une valeur invalide ou absente', () => {
  assert.equal(normalizeType('inconnu'), 'roman');
  assert.equal(normalizeType(undefined), 'roman');
});
