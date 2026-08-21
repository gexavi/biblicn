// Service worker minimal : uniquement pour rendre l'app installable
// (icône + mode plein écran sur mobile). Pas de cache : les livres, les
// couvertures et les statistiques doivent toujours venir du réseau, jamais
// d'une version périmée ou de la session d'un autre utilisateur.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
