// Tests d'intégration des routes Express (CRUD livres, import en masse,
// statistiques) — server.js exporte `app` sans démarrer de vrai serveur au
// require() (voir la garde `require.main === module` en bas du fichier),
// ce qui permet de le lancer ici sur un port libre choisi par l'OS.
//
// Les routes qui font de vrais appels réseau (recherche ISBN, import en
// masse par ISBN, localisation de couvertures) ne sont volontairement PAS
// testées ici : lentes, non déterministes, et dépendantes de services
// externes — hors de portée de tests unitaires/intégration rapides.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'biblicn-test-'));
process.env.DATA_DIR = dataDir;
process.env.AUTH_USERNAME = 'testuser';
process.env.AUTH_PASSWORD = 'testpass';

const app = require('../server');

let server;
let baseUrl;
let cookie;

before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const res = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'testuser', password: 'testpass' })
  });
  assert.equal(res.status, 200);
  cookie = res.headers.getSetCookie()[0].split(';')[0];
});

after(() => {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function authedFetch(pathAndQuery, options = {}) {
  return fetch(`${baseUrl}${pathAndQuery}`, {
    ...options,
    headers: { ...(options.headers || {}), Cookie: cookie }
  });
}

test('/api/books sans cookie de session renvoie 401', async () => {
  const res = await fetch(`${baseUrl}/api/books`);
  assert.equal(res.status, 401);
});

test('/api/login refuse un mauvais mot de passe', async () => {
  const res = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'testuser', password: 'mauvais' })
  });
  assert.equal(res.status, 401);
});

test('POST /api/books refuse un livre sans titre', async () => {
  const res = await authedFetch('/api/books', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ author: 'Sans titre' })
  });
  assert.equal(res.status, 400);
});

test('cycle complet : créer, lister, lire, modifier, supprimer un livre', async () => {
  const createRes = await authedFetch('/api/books', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Dune', author: 'Frank Herbert', genre: 'Science-fiction' })
  });
  assert.equal(createRes.status, 201);
  const created = await createRes.json();
  assert.equal(created.title, 'Dune');
  assert.equal(created.type, 'roman'); // valeur par défaut
  assert.equal(created.status, 'possede'); // valeur par défaut
  assert.ok(created.id);

  const listRes = await authedFetch('/api/books?q=Dune');
  const list = await listRes.json();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, created.id);

  const getRes = await authedFetch(`/api/books/${created.id}`);
  assert.equal(getRes.status, 200);
  const fetched = await getRes.json();
  assert.equal(fetched.author, 'Frank Herbert');

  const updateRes = await authedFetch(`/api/books/${created.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note: 18 })
  });
  assert.equal(updateRes.status, 200);
  const updated = await updateRes.json();
  assert.equal(updated.note, 18);
  assert.equal(updated.title, 'Dune'); // le reste de la fiche est conservé

  const deleteRes = await authedFetch(`/api/books/${created.id}`, { method: 'DELETE' });
  assert.equal(deleteRes.status, 204);

  const getAfterDelete = await authedFetch(`/api/books/${created.id}`);
  assert.equal(getAfterDelete.status, 404);
});

test('GET /api/books/:id sur un id inexistant renvoie 404', async () => {
  const res = await authedFetch('/api/books/999999');
  assert.equal(res.status, 404);
});

test('PUT /api/books/:id sur un id inexistant renvoie 404', async () => {
  const res = await authedFetch('/api/books/999999', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note: 10 })
  });
  assert.equal(res.status, 404);
});

test('DELETE /api/books/:id sur un id inexistant renvoie 404', async () => {
  const res = await authedFetch('/api/books/999999', { method: 'DELETE' });
  assert.equal(res.status, 404);
});

test('POST /api/books/bulk importe les lignes valides et rapporte les erreurs', async () => {
  const res = await authedFetch('/api/books/bulk', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      books: [
        { title: 'Le Petit Prince', type: 'roman' },
        { title: '' }, // titre manquant -> doit échouer
        { title: 'Watchmen', type: 'BDs' } // alias de type -> normalisé en "bd"
      ]
    })
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.total, 3);
  assert.equal(data.added, 2);
  assert.equal(data.failed, 1);
  assert.equal(data.errors[0].row, 2);

  const listRes = await authedFetch('/api/books?q=Watchmen');
  const [watchmen] = await listRes.json();
  assert.equal(watchmen.type, 'bd');
});

test('/api/stats compte les livres possédés créés plus haut', async () => {
  const res = await authedFetch('/api/stats');
  assert.equal(res.status, 200);
  const stats = await res.json();
  // Le livre "Dune" du test précédent a été supprimé ; les 2 livres importés
  // en masse (Le Petit Prince, Watchmen) sont encore là.
  assert.equal(stats.total, 2);
});

test('/api/genres liste les genres sans doublons, séparés sur les virgules', async () => {
  await authedFetch('/api/books', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Livre à deux genres', genre: 'Fantasy, Aventure' })
  });
  const res = await authedFetch('/api/genres');
  const genres = await res.json();
  assert.ok(genres.includes('Fantasy'));
  assert.ok(genres.includes('Aventure'));
  // Triés alphabétiquement (locale française)
  assert.deepEqual(genres, [...genres].sort((a, b) => a.localeCompare(b, 'fr')));
});

test('/api/books?status=souhaite isole la liste de souhaits de la bibliothèque', async () => {
  const wishRes = await authedFetch('/api/books', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Livre souhaité', status: 'souhaite' })
  });
  const wish = await wishRes.json();
  assert.equal(wish.status, 'souhaite');

  const libraryRes = await authedFetch('/api/books');
  const library = await libraryRes.json();
  assert.ok(!library.some(b => b.id === wish.id));

  const wishlistRes = await authedFetch('/api/books?status=souhaite');
  const wishlist = await wishlistRes.json();
  assert.ok(wishlist.some(b => b.id === wish.id));
});
