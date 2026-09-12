// Serveur MCP (lecture seule) pour "Ma Bibliothèque", exposé aux agents de
// conversation (Home Assistant Assist + Google Gemini, ou l'inspecteur MCP
// pour tester). Processus séparé du serveur principal (server.js) : même
// volume de données (DATA_DIR), lu uniquement (voir db.js), jamais démarré/
// arrêté en même temps que l'appli web.
//
// Deux transports exposés côte à côte, sur le modèle officiel du SDK
// (backwards-compatible server) : Home Assistant (testé en conditions
// réelles) utilise le Streamable HTTP moderne sur /mcp ; /sse + /messages
// restent disponibles pour d'anciens clients (dont l'inspecteur MCP, qui
// supporte les deux).
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { registerTools } from './tools.js';

const PORT = Number(process.env.MCP_PORT) || 3100;
// Liste blanche optionnelle de hosts autorisés (protection anti DNS-rebinding
// de la SDK) : ex. "192.168.1.10:3100,mon-nas.local:3100". Laissé vide par
// défaut, ce service étant destiné à un réseau local de confiance — voir
// MCP_SHARED_SECRET ci-dessous pour une protection en défense en profondeur.
const ALLOWED_HOSTS = (process.env.MCP_ALLOWED_HOSTS || '').split(',').map((h) => h.trim()).filter(Boolean);
// Secret partagé optionnel entre Home Assistant et ce serveur (défense en
// profondeur, tout restant sur le réseau local) : si défini, chaque requête
// doit porter l'en-tête "Authorization: Bearer <secret>".
const SHARED_SECRET = process.env.MCP_SHARED_SECRET || '';

function getServer() {
  const server = new McpServer({ name: 'ma-bibliotheque', version: '1.0.0' });
  registerTools(server);
  return server;
}

const app = createMcpExpressApp({
  host: '0.0.0.0',
  ...(ALLOWED_HOSTS.length ? { allowedHosts: ALLOWED_HOSTS } : {})
});

function checkSharedSecret(req, res) {
  if (!SHARED_SECRET) return true;
  const header = req.headers.authorization || '';
  if (header === `Bearer ${SHARED_SECRET}`) return true;
  res.status(401).send('Non autorisé');
  return false;
}

// Un transport par session cliente (Streamable HTTP ou SSE), indexé par
// l'identifiant de session — nécessaire pour router les requêtes suivantes
// vers la bonne connexion.
const transports = {};

//=============================================================================
// STREAMABLE HTTP (protocole moderne) — /mcp, utilisé par Home Assistant.
//=============================================================================
app.all('/mcp', async (req, res) => {
  if (!checkSharedSecret(req, res)) return;
  try {
    const sessionId = req.headers['mcp-session-id'];
    let transport;

    if (sessionId && transports[sessionId]) {
      const existing = transports[sessionId];
      if (!(existing instanceof StreamableHTTPServerTransport)) {
        res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Cette session utilise un autre transport' },
          id: null
        });
        return;
      }
      transport = existing;
    } else if (!sessionId && req.method === 'POST' && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => { transports[id] = transport; }
      });
      transport.onclose = () => {
        if (transport.sessionId) delete transports[transport.sessionId];
      };
      await getServer().connect(transport);
    } else {
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Identifiant de session manquant ou invalide' },
        id: null
      });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('Erreur en traitant la requête MCP (/mcp) :', err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Erreur interne' }, id: null });
    }
  }
});

//=============================================================================
// HTTP+SSE (protocole historique) — /sse + /messages, pour d'anciens clients.
//=============================================================================
app.get('/sse', async (req, res) => {
  if (!checkSharedSecret(req, res)) return;
  try {
    const transport = new SSEServerTransport('/messages', res);
    transports[transport.sessionId] = transport;
    transport.onclose = () => { delete transports[transport.sessionId]; };
    await getServer().connect(transport);
  } catch (err) {
    console.error('Erreur à l\'ouverture du flux SSE :', err);
    if (!res.headersSent) res.status(500).send('Erreur à l\'ouverture du flux SSE');
  }
});

app.post('/messages', async (req, res) => {
  if (!checkSharedSecret(req, res)) return;
  const sessionId = req.query.sessionId;
  const transport = sessionId && transports[sessionId];
  if (!transport || !(transport instanceof SSEServerTransport)) {
    res.status(404).send('Session MCP inconnue (le flux SSE a peut-être expiré, relancez la connexion)');
    return;
  }
  try {
    await transport.handlePostMessage(req, res, req.body);
  } catch (err) {
    console.error('Erreur en traitant le message MCP :', err);
    if (!res.headersSent) res.status(500).send('Erreur en traitant le message');
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Serveur MCP "Ma Bibliothèque" (lecture seule) sur le port ${PORT} — Streamable HTTP sur /mcp, SSE historique sur /sse`);
});

process.on('SIGINT', async () => {
  for (const sessionId of Object.keys(transports)) {
    try { await transports[sessionId].close(); } catch { /* déjà fermé */ }
  }
  process.exit(0);
});
