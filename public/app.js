const $ = (sel) => document.querySelector(sel);

const shelfEl = $('#shelf');
const emptyStateEl = $('#emptyState');
const modalBackdrop = $('#modalBackdrop');
const modalTitle = $('#modalTitle');
const bookForm = $('#bookForm');
const deleteBtn = $('#deleteBtn');
const isbnStatus = $('#isbnStatus');

let currentBooks = [];
let viewMode = localStorage.getItem('bibliotheque_view') || 'grid';
let currentStatus = 'possede'; // 'possede' = bibliothèque, 'souhaite' = liste de souhaits

const PLACEHOLDER_COVER = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="52" height="76"><rect width="52" height="76" fill="#212A36"/><text x="26" y="42" font-size="22" text-anchor="middle" fill="#57A181" font-family="serif">§</text></svg>'
);

function coverSrc(book) {
  if (book.cover_url) return book.cover_url;
  if (book.isbn) return `https://covers.openlibrary.org/b/isbn/${encodeURIComponent(book.isbn)}-M.jpg`;
  return PLACEHOLDER_COVER;
}

const TYPE_LABELS = { roman: 'Roman', bd: 'BD', manga: 'Manga', essai: 'Essai', autre: 'Autre' };
function typeLabel(type) {
  return TYPE_LABELS[type] || 'Roman';
}

// ---------- Chargement ----------
async function loadStats() {
  const res = await fetch('/api/stats');
  const stats = await res.json();
  $('#statTotal').textContent = stats.total;
  $('#statLus').textContent = stats.lus;
  $('#statPretes').textContent = stats.pretes;
  $('#statSouhaites').textContent = stats.souhaites;
}

async function loadBooks() {
  const params = new URLSearchParams();
  const q = $('#searchInput').value.trim();
  const type = $('#filterType').value;
  const lu = $('#filterLu').value;
  const genre = $('#filterGenre').value;
  const publisher = $('#filterPublisher').value;
  const owner = $('#filterOwner').value;
  const minNote = $('#filterNote').value;
  const sort = $('#sortBy').value;
  params.set('status', currentStatus);
  if (q) params.set('q', q);
  if (type) params.set('type', type);
  if (lu !== '') params.set('lu', lu);
  if (genre) params.set('genre', genre);
  if (publisher) params.set('publisher', publisher);
  if (owner) params.set('owner', owner);
  if (minNote) params.set('minNote', minNote);
  if (sort) params.set('sort', sort);

  const res = await fetch('/api/books?' + params.toString());
  currentBooks = await res.json();
  renderShelf();
}

async function loadGenreOptions() {
  const res = await fetch('/api/genres?status=' + currentStatus);
  const genres = await res.json();
  const select = $('#filterGenre');
  const current = select.value;
  select.innerHTML = '<option value="">Tous les genres</option>' +
    genres.map(g => `<option value="${escapeHtml(g)}">${escapeHtml(g)}</option>`).join('');
  if (genres.includes(current)) select.value = current;
}

async function loadPublisherOptions() {
  const res = await fetch('/api/publishers?status=' + currentStatus);
  const publishers = await res.json();
  const select = $('#filterPublisher');
  const current = select.value;
  select.innerHTML = '<option value="">Tous les éditeurs</option>' +
    publishers.map(p => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join('');
  if (publishers.includes(current)) select.value = current;
}

async function loadOwnerOptions() {
  const res = await fetch('/api/owners?status=' + currentStatus);
  const owners = await res.json();
  const select = $('#filterOwner');
  const current = select.value;
  select.innerHTML = '<option value="">Appartient à (tous)</option>' +
    owners.map(o => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join('');
  if (owners.includes(current)) select.value = current;
}

async function refreshFilterOptions() {
  loadGenreOptions();
  loadPublisherOptions();
  loadOwnerOptions();
}

function renderShelf() {
  shelfEl.innerHTML = '';
  shelfEl.classList.toggle('list-view', viewMode === 'list');
  emptyStateEl.hidden = currentBooks.length !== 0;
  for (const book of currentBooks) {
    shelfEl.appendChild(renderBookCard(book));
  }
}

function renderBookCard(book) {
  const el = document.createElement('div');
  el.className = 'book';
  el.dataset.type = book.type;
  el.addEventListener('click', () => openEditModal(book));

  const isWishlist = book.status === 'souhaite';
  const noteHtml = book.note != null ? `<span class="book-note">${book.note}/20</span>` : '<span></span>';
  const readDateHtml = book.lu && book.read_date ? ` <span class="book-read-date">le ${formatDateFr(book.read_date)}</span>` : '';
  const statusHtml = book.lu
    ? `<span class="book-status lu">✓ Lu${readDateHtml}</span>`
    : '<span class="book-status">Non lu</span>';
  const lentHtml = book.lent_to
    ? `<div class="book-lent">Prêté à ${escapeHtml(book.lent_to)}</div>`
    : '';
  const ownerHtml = book.owner
    ? `<div class="book-owner">${isWishlist ? '🎁' : '📚'} ${escapeHtml(book.owner)}</div>`
    : '';
  const metaHtml = isWishlist
    ? `<button class="quick-acquire-btn" type="button">✓ Marquer comme acquis</button>`
    : `${statusHtml}${noteHtml}`;

  el.innerHTML = `
    <img class="book-cover" src="${escapeHtml(coverSrc(book))}" alt="" loading="lazy"
      onerror="this.onerror=null;this.src='${PLACEHOLDER_COVER}';">
    <div class="book-content">
      <div class="book-top">
        <p class="book-title">${escapeHtml(book.title)}</p>
        <span class="book-type-tag">${typeLabel(book.type)}</span>
      </div>
      <p class="book-author">${escapeHtml(book.author || 'Auteur inconnu')}</p>
      ${book.genre ? `<p class="book-genre">${escapeHtml(book.genre)}</p>` : ''}
      ${!isWishlist && book.location ? `<p class="book-location">📍 ${escapeHtml(book.location)}</p>` : ''}
      ${ownerHtml}
      ${lentHtml}
    </div>
    <div class="book-meta">
      ${metaHtml}
    </div>
  `;

  if (isWishlist) {
    el.querySelector('.quick-acquire-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      quickMarkAcquired(book.id);
    });
  }

  return el;
}

async function quickMarkAcquired(id) {
  const res = await fetch(`/api/books/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'possede' })
  });
  if (res.ok) {
    await loadBooks();
    await loadStats();
    refreshFilterOptions();
  }
}

function formatDateFr(isoDate) {
  const [y, m, d] = isoDate.split('-');
  if (!y || !m || !d) return isoDate;
  return `${d}/${m}/${y}`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function updateModalCoverPreview() {
  const isbn = $('#fieldIsbn').value.trim();
  const cover = $('#fieldCover').value.trim();
  const src = cover || (isbn ? `https://covers.openlibrary.org/b/isbn/${encodeURIComponent(isbn)}-M.jpg` : '');
  const previewEl = $('#modalCoverPreview');
  if (!src) { previewEl.hidden = true; return; }
  $('#modalCoverImg').src = src;
  $('#modalCoverImg').onerror = () => { previewEl.hidden = true; };
  $('#modalCoverLabel').textContent = 'Couverture';
  previewEl.hidden = false;
}

// ---------- Modale ----------
function toggleReadDateVisibility() {
  const checked = $('#fieldLu').checked;
  $('#readDateWrap').hidden = !checked;
  if (checked && !$('#fieldReadDate').value) {
    $('#fieldReadDate').value = new Date().toISOString().slice(0, 10);
  }
}
$('#fieldLu').addEventListener('change', toggleReadDateVisibility);

function openAddModal() {
  bookForm.reset();
  $('#bookId').value = '';
  $('#fieldIsbn').value = '';
  $('#fieldCover').value = '';
  $('#fieldReadDate').value = '';
  $('#fieldPublisher').value = '';
  $('#fieldOwner').value = '';
  $('#fieldStatus').value = currentStatus;
  $('#isbnInput').value = '';
  isbnStatus.textContent = '';
  isbnStatus.className = 'isbn-status';
  $('#modalCoverPreview').hidden = true;
  modalTitle.textContent = currentStatus === 'souhaite' ? 'Ajouter à la liste de souhaits' : 'Ajouter un livre';
  deleteBtn.hidden = true;
  $('#markAcquiredBtn').hidden = true;
  $('#secondhandLinks').hidden = true;
  modalBackdrop.hidden = false;
  toggleReadDateVisibility();
  setTimeout(() => $('#isbnInput').focus(), 50);
}

function openEditModal(book) {
  bookForm.reset();
  $('#bookId').value = book.id;
  $('#fieldTitle').value = book.title || '';
  $('#fieldAuthor').value = book.author || '';
  $('#fieldType').value = book.type || 'roman';
  $('#fieldGenre').value = book.genre || '';
  $('#fieldPublisher').value = book.publisher || '';
  $('#fieldNote').value = book.note != null ? book.note : '';
  $('#fieldLu').checked = !!book.lu;
  $('#fieldReadDate').value = book.read_date || '';
  $('#fieldLocation').value = book.location || '';
  $('#fieldLentTo').value = book.lent_to || '';
  $('#fieldOwner').value = book.owner || '';
  $('#fieldIsbn').value = book.isbn || '';
  $('#fieldCover').value = book.cover_url || '';
  $('#fieldStatus').value = book.status || 'possede';
  $('#isbnInput').value = book.isbn || '';
  isbnStatus.textContent = '';
  isbnStatus.className = 'isbn-status';
  modalTitle.textContent = book.status === 'souhaite' ? 'Modifier le souhait' : 'Modifier le livre';
  deleteBtn.hidden = false;
  $('#markAcquiredBtn').hidden = book.status !== 'souhaite';
  updateSecondhandLinks(book);
  modalBackdrop.hidden = false;
  toggleReadDateVisibility();
  updateModalCoverPreview();
}

function updateSecondhandLinks(book) {
  const wrap = $('#secondhandLinks');
  if (!book || book.status !== 'souhaite' || !book.title) {
    wrap.hidden = true;
    return;
  }
  const query = encodeURIComponent(`${book.title} ${book.author || ''}`.trim());
  $('#linkGibert').href = `https://www.google.com/search?q=site%3Agibert.com+${query}`;
  $('#linkMomox').href = `https://www.google.com/search?q=site%3Amomox-shop.fr+${query}`;
  $('#linkRecyclivre').href = `https://www.google.com/search?q=site%3Arecyclivre.com+${query}`;
  wrap.hidden = false;
}

function closeModal() {
  modalBackdrop.hidden = true;
  closeBarcodeScanner();
}

$('#openAddBtn').addEventListener('click', openAddModal);
$('#emptyAddBtn').addEventListener('click', openAddModal);
$('#closeModalBtn').addEventListener('click', closeModal);
$('#cancelBtn').addEventListener('click', closeModal);
modalBackdrop.addEventListener('click', (e) => { if (e.target === modalBackdrop) closeModal(); });

// ---------- Scan de code-barres (caméra du téléphone) ----------
let barcodeScanner = null;

function openBarcodeScanner() {
  const overlay = $('#scannerOverlay');
  const statusEl = $('#scannerStatus');
  statusEl.textContent = '';
  statusEl.className = 'scanner-status';

  if (!window.isSecureContext) {
    statusEl.textContent = "L'accès à la caméra nécessite une connexion sécurisée (HTTPS). Configurez un accès HTTPS (reverse proxy) sur votre NAS, ou saisissez l'ISBN à la main.";
    statusEl.className = 'scanner-status error';
    overlay.hidden = false;
    return;
  }
  if (typeof Html5Qrcode === 'undefined') {
    statusEl.textContent = "La bibliothèque de scan n'a pas pu se charger (pas de connexion internet sur cet appareil ?). Saisissez l'ISBN à la main.";
    statusEl.className = 'scanner-status error';
    overlay.hidden = false;
    return;
  }

  overlay.hidden = false;
  barcodeScanner = new Html5Qrcode('barcodeReaderRegion', {
    formatsToSupport: [Html5QrcodeSupportedFormats.EAN_13, Html5QrcodeSupportedFormats.EAN_8, Html5QrcodeSupportedFormats.UPC_A],
    verbose: false
  });

  barcodeScanner.start(
    { facingMode: 'environment' },
    { fps: 10, qrbox: { width: 260, height: 140 } },
    (decodedText) => {
      $('#isbnInput').value = decodedText;
      closeBarcodeScanner();
      doIsbnLookup();
    },
    () => { /* frame sans code détecté : rien à faire, on continue de scanner */ }
  ).catch((err) => {
    statusEl.textContent = "Impossible d'accéder à la caméra : " + (err && err.message ? err.message : err) + ". Vérifiez que vous avez autorisé l'accès caméra pour ce site.";
    statusEl.className = 'scanner-status error';
  });
}

function closeBarcodeScanner() {
  $('#scannerOverlay').hidden = true;
  if (barcodeScanner) {
    barcodeScanner.stop().then(() => barcodeScanner.clear()).catch(() => {});
    barcodeScanner = null;
  }
}

$('#scanBarcodeBtn').addEventListener('click', openBarcodeScanner);
$('#closeScannerBtn').addEventListener('click', closeBarcodeScanner);

// ---------- Recherche ISBN ----------
$('#isbnLookupBtn').addEventListener('click', doIsbnLookup);
$('#isbnInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); doIsbnLookup(); }
});
$('#fieldCover').addEventListener('input', updateModalCoverPreview);

async function doIsbnLookup() {
  const isbn = $('#isbnInput').value.trim();
  if (!isbn) return;
  isbnStatus.textContent = 'Recherche en cours…';
  isbnStatus.className = 'isbn-status';
  try {
    const res = await fetch('/api/isbn/' + encodeURIComponent(isbn));
    if (!res.ok) {
      const err = await res.json();
      isbnStatus.textContent = err.error || 'Livre introuvable, remplissez manuellement.';
      isbnStatus.className = 'isbn-status error';
      $('#fieldIsbn').value = isbn;
      return;
    }
    const data = await res.json();
    $('#fieldTitle').value = data.title || '';
    $('#fieldAuthor').value = data.author || '';
    $('#fieldGenre').value = data.genre || '';
    $('#fieldPublisher').value = data.publisher || '';
    $('#fieldIsbn').value = data.isbn || isbn;
    $('#fieldCover').value = data.cover_url || '';
    isbnStatus.textContent = 'Livre trouvé — vérifiez et complétez les champs ci-dessous.';
    isbnStatus.className = 'isbn-status success';
    updateModalCoverPreview();
  } catch (err) {
    isbnStatus.textContent = 'Erreur réseau lors de la recherche.';
    isbnStatus.className = 'isbn-status error';
  }
}

// ---------- Sauvegarde / suppression ----------
bookForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = $('#bookId').value;
  const payload = {
    title: $('#fieldTitle').value.trim(),
    author: $('#fieldAuthor').value.trim(),
    type: $('#fieldType').value,
    genre: $('#fieldGenre').value.trim(),
    publisher: $('#fieldPublisher').value.trim(),
    note: $('#fieldNote').value === '' ? null : Number($('#fieldNote').value),
    lu: $('#fieldLu').checked,
    read_date: $('#fieldLu').checked ? ($('#fieldReadDate').value || null) : null,
    location: $('#fieldLocation').value.trim(),
    lent_to: $('#fieldLentTo').value.trim(),
    owner: $('#fieldOwner').value.trim(),
    isbn: $('#fieldIsbn').value.trim(),
    cover_url: $('#fieldCover').value.trim(),
    status: $('#fieldStatus').value === 'souhaite' ? 'souhaite' : 'possede'
  };

  const url = id ? `/api/books/${id}` : '/api/books';
  const method = id ? 'PUT' : 'POST';
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (res.ok) {
    closeModal();
    await loadBooks();
    await loadStats();
    refreshFilterOptions();
  } else {
    const err = await res.json();
    alert(err.error || 'Erreur lors de l\'enregistrement.');
  }
});

deleteBtn.addEventListener('click', async () => {
  const id = $('#bookId').value;
  if (!id) return;
  if (!confirm('Supprimer ce livre de la bibliothèque ?')) return;
  const res = await fetch(`/api/books/${id}`, { method: 'DELETE' });
  if (res.ok) {
    closeModal();
    await loadBooks();
    await loadStats();
    refreshFilterOptions();
  }
});

$('#markAcquiredBtn').addEventListener('click', async () => {
  const id = $('#bookId').value;
  if (!id) return;
  $('#fieldStatus').value = 'possede';
  const res = await fetch(`/api/books/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'possede' })
  });
  if (res.ok) {
    closeModal();
    await loadBooks();
    await loadStats();
    refreshFilterOptions();
  } else {
    alert('Erreur lors du passage en bibliothèque.');
  }
});

// ---------- Filtres ----------
let searchDebounce;
$('#searchInput').addEventListener('input', () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(loadBooks, 250);
});
$('#filterType').addEventListener('change', loadBooks);
$('#filterLu').addEventListener('change', loadBooks);
$('#filterGenre').addEventListener('change', loadBooks);
$('#filterPublisher').addEventListener('change', loadBooks);
$('#filterOwner').addEventListener('change', loadBooks);
$('#filterNote').addEventListener('change', loadBooks);
$('#sortBy').addEventListener('change', loadBooks);

// ---------- Vue grille / liste ----------
function setViewMode(mode) {
  viewMode = mode;
  localStorage.setItem('bibliotheque_view', mode);
  $('#viewGridBtn').classList.toggle('active', mode === 'grid');
  $('#viewListBtn').classList.toggle('active', mode === 'list');
  renderShelf();
}
$('#viewGridBtn').addEventListener('click', () => setViewMode('grid'));
$('#viewListBtn').addEventListener('click', () => setViewMode('list'));
setViewMode(viewMode);

// ---------- Bibliothèque / Liste de souhaits ----------
function setStatus(status) {
  currentStatus = status;
  $('#viewLibraryBtn').classList.toggle('active', status === 'possede');
  $('#viewWishlistBtn').classList.toggle('active', status === 'souhaite');
  $('#openAddBtn').textContent = status === 'souhaite' ? '+ Ajouter un souhait' : '+ Ajouter un livre';
  loadBooks();
  refreshFilterOptions();
}
$('#viewLibraryBtn').addEventListener('click', () => setStatus('possede'));
$('#viewWishlistBtn').addEventListener('click', () => setStatus('souhaite'));

// ---------- Import en masse ----------
const bulkModalBackdrop = $('#bulkModalBackdrop');

$('#openBulkBtn').addEventListener('click', () => {
  bulkModalBackdrop.hidden = false;
});
$('#closeBulkModalBtn').addEventListener('click', () => { bulkModalBackdrop.hidden = true; });
bulkModalBackdrop.addEventListener('click', (e) => { if (e.target === bulkModalBackdrop) bulkModalBackdrop.hidden = true; });

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    $('#tabIsbn').hidden = btn.dataset.tab !== 'isbn';
    $('#tabCsv').hidden = btn.dataset.tab !== 'csv';
  });
});

// --- Import par liste d'ISBN ---
$('#runBulkIsbnBtn').addEventListener('click', async () => {
  const raw = $('#bulkIsbnText').value.trim();
  if (!raw) return;
  const isbns = raw.split('\n').map(s => s.trim()).filter(Boolean);
  if (!isbns.length) return;

  const progressEl = $('#bulkIsbnProgress');
  const resultsEl = $('#bulkIsbnResults');
  resultsEl.innerHTML = '';
  progressEl.hidden = false;
  progressEl.textContent = `Recherche de ${isbns.length} livre(s) en cours… (cela peut prendre un moment)`;
  $('#runBulkIsbnBtn').disabled = true;

  try {
    const res = await fetch('/api/books/bulk-isbn', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        isbns,
        defaults: {
          type: $('#bulkDefaultType').value,
          location: $('#bulkDefaultLocation').value.trim(),
          owner: $('#bulkDefaultOwner').value.trim()
        }
      })
    });
    const data = await res.json();
    progressEl.hidden = true;
    renderBulkResults(resultsEl, data);
    await loadBooks();
    await loadStats();
    refreshFilterOptions();
  } catch (err) {
    progressEl.hidden = true;
    resultsEl.innerHTML = '<div class="bulk-result-row fail">Erreur réseau pendant l\'import.</div>';
  } finally {
    $('#runBulkIsbnBtn').disabled = false;
  }
});

function renderBulkResults(container, data) {
  const summary = document.createElement('div');
  summary.className = 'bulk-result-summary';
  summary.textContent = `${data.added} ajouté(s), ${data.failed} échec(s) sur ${data.total}`;
  container.appendChild(summary);

  (data.results || []).forEach(r => {
    const row = document.createElement('div');
    row.className = 'bulk-result-row ' + (r.ok ? 'ok' : 'fail');
    row.innerHTML = `<span>${escapeHtml(r.isbn)}</span><span>${r.ok ? '✓ ' + escapeHtml(r.title) : '✕ ' + escapeHtml(r.error)}</span>`;
    container.appendChild(row);
  });
}

// --- Import CSV ---
let parsedCsvBooks = [];

function detectCsvDelimiter(headerLine) {
  // Excel en français (et beaucoup de tableurs européens) exporte le CSV
  // avec des points-virgules, la virgule étant déjà utilisée comme séparateur
  // décimal. On compte les deux et on prend le plus fréquent sur l'en-tête.
  const commaCount = (headerLine.match(/,/g) || []).length;
  const semicolonCount = (headerLine.match(/;/g) || []).length;
  return semicolonCount > commaCount ? ';' : ',';
}

function parseCsv(text) {
  const lines = text.replace(/\r/g, '').split('\n').filter(l => l.trim() !== '');
  if (!lines.length) return [];
  const delimiter = detectCsvDelimiter(lines[0]);
  const headers = splitCsvLine(lines[0], delimiter).map(h => h.trim().toLowerCase());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i], delimiter);
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = (cells[idx] || '').trim(); });
    rows.push(obj);
  }
  return rows;
}

function splitCsvLine(line, delimiter) {
  const result = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else { cur += c; }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === delimiter) { result.push(cur); cur = ''; }
      else cur += c;
    }
  }
  result.push(cur);
  return result;
}

$('#csvFileInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    parsedCsvBooks = parseCsv(reader.result);
    renderCsvPreview(parsedCsvBooks);
    $('#runBulkCsvBtn').disabled = parsedCsvBooks.length === 0;
  };
  reader.readAsText(file, 'UTF-8');
});

function renderCsvPreview(rows) {
  const el = $('#csvPreview');
  if (!rows.length) { el.innerHTML = '<p>Aucune ligne détectée.</p>'; return; }
  const preview = rows.slice(0, 5);
  const headers = Object.keys(preview[0]);
  let html = `<p>${rows.length} ligne(s) détectée(s). Aperçu :</p><table><thead><tr>`;
  headers.forEach(h => html += `<th>${escapeHtml(h)}</th>`);
  html += '</tr></thead><tbody>';
  preview.forEach(row => {
    html += '<tr>' + headers.map(h => `<td>${escapeHtml(row[h] || '')}</td>`).join('') + '</tr>';
  });
  html += '</tbody></table>';
  el.innerHTML = html;
}

$('#runBulkCsvBtn').addEventListener('click', async () => {
  if (!parsedCsvBooks.length) return;
  $('#runBulkCsvBtn').disabled = true;
  const resultsEl = $('#bulkCsvResults');
  resultsEl.innerHTML = '<div class="bulk-progress">Import en cours…</div>';
  try {
    const res = await fetch('/api/books/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ books: parsedCsvBooks })
    });
    const data = await res.json();
    resultsEl.innerHTML = '';
    const summary = document.createElement('div');
    summary.className = 'bulk-result-summary';
    summary.textContent = `${data.added} ajouté(s), ${data.failed} échec(s) sur ${data.total}`;
    resultsEl.appendChild(summary);
    (data.errors || []).forEach(e => {
      const row = document.createElement('div');
      row.className = 'bulk-result-row fail';
      row.innerHTML = `<span>Ligne ${e.row}</span><span>✕ ${escapeHtml(e.error)}</span>`;
      resultsEl.appendChild(row);
    });
    await loadBooks();
    await loadStats();
    refreshFilterOptions();
  } catch (err) {
    resultsEl.innerHTML = '<div class="bulk-result-row fail">Erreur réseau pendant l\'import.</div>';
  } finally {
    $('#runBulkCsvBtn').disabled = false;
  }
});

$('#downloadTemplateBtn').addEventListener('click', () => {
  const csv = 'title,author,type,genre,publisher,lu,note,location,lent_to,owner,isbn\n'
    + 'Dune,Frank Herbert,roman,Science-fiction,Robert Laffont,oui,18,Salon,,Papa,9782070368228\n'
    + 'Watchmen,Alan Moore,bd,Super-héros,Urban Comics,non,,Bureau,Julie,Maman,9782205057114\n';
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'modele-import-bibliotheque.csv';
  a.click();
  URL.revokeObjectURL(url);
});

// ---------- Optimisation des couvertures existantes ----------
$('#localizeCoversBtn').addEventListener('click', async () => {
  const btn = $('#localizeCoversBtn');
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '⏳ Optimisation en cours…';
  try {
    const res = await fetch('/api/covers/localize-all', { method: 'POST' });
    const data = await res.json();
    if (data.total === 0) {
      alert(`Rien à faire : ${data.alreadyLocal} couverture(s) déjà en cache local.`);
    } else {
      alert(`${data.done} couverture(s) optimisée(s) et mise(s) en cache local, ${data.failed} échec(s) (source injoignable ou image invalide). ${data.alreadyLocal} l'étaient déjà.`);
    }
    await loadBooks();
  } catch (err) {
    alert("Erreur réseau pendant l'optimisation des couvertures.");
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
});

// ---------- Init ----------
loadBooks();
loadStats();
refreshFilterOptions();
