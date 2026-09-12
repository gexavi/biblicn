// Serveur MCP (lecture seule) pour "Ma Bibliothèque", exposé en SSE pour
// l'intégration "Model Context Protocol" de Home Assistant
// (http://<ip-nas>:MCP_PORT/sse). Processus séparé du serveur principal
// (server.js) : même volume de données (DATA_DIR), lu uniquement (voir
// db.js), jamais démarré/arrêté en même temps que l'appli web.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
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

// Un transport SSE par connexion cliente, indexé par sessionId (généré par
// le SDK) — nécessaire pour router les POST /messages suivants vers la
// bonne connexion SSE ouverte sur /sse.
const transports = {};

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
  if (!transport) {
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
  console.log(`Serveur MCP "Ma Bibliothèque" (lecture seule) sur le port ${PORT} — flux SSE sur /sse`);
});

process.on('SIGINT', async () => {
  for (const sessionId of Object.keys(transports)) {
    try { await transports[sessionId].close(); } catch { /* déjà fermé */ }
  }
  process.exit(0);
});
