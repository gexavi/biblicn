// Déclaration des tools MCP exposés par ce serveur — tous en lecture seule
// (voir db.js) : aucun tool ne peut modifier la bibliothèque. Pensés pour
// être appelés par un agent de conversation (Claude via l'intégration
// Anthropic Conversation de Home Assistant) répondant à une question posée
// à voix haute, donc chaque réponse est un texte déjà lisible/prononçable
// plutôt qu'un JSON brut à reformuler.
import * as z from 'zod/v4';
import { searchBooks, findBooksByTitle, getBookReads, getLibraryStats, getOwnerStats } from './db.js';

const TYPE_LABELS = { roman: 'roman', bd: 'BD', manga: 'manga', essai: 'essai', autre: 'autre' };
const STATUS_LABELS = { possede: 'possédé', souhaite: 'liste de souhaits', revendu: 'revendu' };

function textResult(text) {
  return { content: [{ type: 'text', text }] };
}

function describeBook(book) {
  const parts = [`« ${book.title} »`];
  if (book.author) parts.push(`de ${book.author}`);
  parts.push(`(${TYPE_LABELS[book.type] || book.type}${book.genre ? `, ${book.genre}` : ''})`);
  if (book.series) parts.push(`— ${book.series}${book.series_number ? ` T.${book.series_number}` : ''}`);
  if (book.owner) parts.push(`— appartient à ${book.owner}`);
  parts.push(book.lu ? `— lu${book.read_date ? ` le ${book.read_date}` : ''}${book.note != null ? ` (${book.note}/20)` : ''}` : '— non lu');
  if (book.status !== 'possede') parts.push(`[${STATUS_LABELS[book.status] || book.status}]`);
  return parts.join(' ');
}

export function registerTools(server) {
  server.registerTool(
    'search_books',
    {
      title: 'Rechercher des livres',
      description: "Recherche des livres dans la bibliothèque par titre/auteur/série, genre, type, propriétaire ou statut de lecture. Par défaut, ne cherche que parmi les livres possédés (pas la liste de souhaits ni les livres revendus).",
      inputSchema: {
        query: z.string().optional().describe('Texte à chercher dans le titre, l\'auteur ou la série'),
        author: z.string().optional().describe('Filtrer par auteur (correspondance partielle)'),
        genre: z.string().optional().describe('Filtrer par genre, ex. "Fantasy" ou "policier"'),
        type: z.enum(['roman', 'bd', 'manga', 'essai', 'autre']).optional().describe('Filtrer par type de livre'),
        owner: z.string().optional().describe('Filtrer par propriétaire, ex. "Alice"'),
        lu: z.boolean().optional().describe('true = uniquement les livres déjà lus, false = uniquement les non lus'),
        status: z.enum(['possede', 'souhaite', 'revendu']).optional().describe('Statut du livre (par défaut "possede")'),
        limit: z.number().int().min(1).max(50).optional().describe('Nombre maximum de résultats (20 par défaut)')
      }
    },
    async (args) => {
      const { rows, total, truncated } = searchBooks(args);
      if (!rows.length) return textResult("Aucun livre ne correspond à cette recherche.");
      const lines = rows.map((b) => `- ${describeBook(b)}`);
      const header = truncated
        ? `${total} livres trouvés, voici les ${rows.length} premiers :`
        : `${total} livre${total > 1 ? 's' : ''} trouvé${total > 1 ? 's' : ''} :`;
      return textResult([header, ...lines].join('\n'));
    }
  );

  server.registerTool(
    'get_book_details',
    {
      title: 'Détails d\'un livre',
      description: "Donne le détail complet d'un livre à partir de son titre (exact ou approximatif), y compris qui l'a lu, quand, et avec quelle note.",
      inputSchema: {
        title: z.string().describe('Titre exact ou approximatif du livre recherché')
      }
    },
    async ({ title }) => {
      const matches = findBooksByTitle(title);
      if (!matches.length) return textResult(`Aucun livre ne correspond au titre "${title}".`);
      if (matches.length > 1) {
        const lines = matches.map((b) => `- ${describeBook(b)}`);
        return textResult([`Plusieurs livres correspondent à "${title}", précisez lequel :`, ...lines].join('\n'));
      }
      const book = matches[0];
      const reads = getBookReads(book.id);
      const lines = [describeBook(book)];
      if (book.publisher) lines.push(`Éditeur : ${book.publisher}`);
      if (book.location) lines.push(`Rangé : ${book.location}`);
      if (book.lent_to) lines.push(`Prêté à : ${book.lent_to}`);
      if (reads.length) {
        lines.push('Lectures par personne :');
        reads.forEach((r) => {
          lines.push(`- ${r.owner} : lu${r.read_date ? ` le ${r.read_date}` : ''}${r.note != null ? ` (${r.note}/20)` : ''}`);
        });
      }
      return textResult(lines.join('\n'));
    }
  );

  server.registerTool(
    'list_wishlist',
    {
      title: 'Liste de souhaits',
      description: 'Liste les livres de la liste de souhaits (pas encore achetés), avec filtres optionnels par titre/auteur ou genre.',
      inputSchema: {
        query: z.string().optional().describe('Texte à chercher dans le titre, l\'auteur ou la série'),
        genre: z.string().optional().describe('Filtrer par genre'),
        limit: z.number().int().min(1).max(50).optional().describe('Nombre maximum de résultats (20 par défaut)')
      }
    },
    async ({ query, genre, limit }) => {
      const { rows, total, truncated } = searchBooks({ query, genre, status: 'souhaite', limit });
      if (!rows.length) return textResult('La liste de souhaits est vide (ou aucun résultat pour ces critères).');
      const lines = rows.map((b) => `- ${describeBook(b)}`);
      const header = truncated
        ? `${total} livres dans la liste de souhaits, voici les ${rows.length} premiers :`
        : `${total} livre${total > 1 ? 's' : ''} dans la liste de souhaits :`;
      return textResult([header, ...lines].join('\n'));
    }
  );

  server.registerTool(
    'get_library_stats',
    {
      title: 'Statistiques globales',
      description: 'Donne les chiffres globaux de la bibliothèque : nombre de livres possédés, lus, prêtés, et taille de la liste de souhaits.',
      inputSchema: {}
    },
    async () => {
      const s = getLibraryStats();
      const pct = s.total ? Math.round((s.lus / s.total) * 100) : 0;
      return textResult(
        `La bibliothèque compte ${s.total} livre${s.total > 1 ? 's' : ''}, dont ${s.lus} lu${s.lus > 1 ? 's' : ''} (${pct}%). ` +
        `${s.pretes} livre${s.pretes > 1 ? 's' : ''} actuellement prêté${s.pretes > 1 ? 's' : ''}. ` +
        `${s.souhaites} livre${s.souhaites > 1 ? 's' : ''} dans la liste de souhaits.`
      );
    }
  );

  server.registerTool(
    'get_owner_stats',
    {
      title: 'Statistiques par propriétaire',
      description: "Donne, pour un propriétaire donné (ou tous si non précisé) : nombre de livres possédés, genres préférés, lectures par année, et note moyenne donnée.",
      inputSchema: {
        owner: z.string().optional().describe('Nom du propriétaire ; si omis, les statistiques de tout le monde sont renvoyées')
      }
    },
    async ({ owner }) => {
      const stats = getOwnerStats(owner);
      if (!stats.length) {
        return textResult(owner ? `Aucune statistique pour "${owner}".` : 'Aucune statistique disponible.');
      }
      const lines = stats.map((o) => {
        const topGenres = o.byGenre.slice(0, 3).map((g) => g.genre).join(', ');
        const lastYears = o.byYear.slice(0, 3).map((y) => `${y.year} (${y.count})`).join(', ');
        const parts = [`${o.name} : ${o.total} livre${o.total > 1 ? 's' : ''}`];
        if (topGenres) parts.push(`genres favoris : ${topGenres}`);
        if (o.avgNote != null) parts.push(`note moyenne : ${o.avgNote}/20`);
        if (lastYears) parts.push(`lectures récentes par année : ${lastYears}`);
        return `- ${parts.join(', ')}`;
      });
      return textResult(lines.join('\n'));
    }
  );
}
