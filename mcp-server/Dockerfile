# Construire depuis la RACINE du dépôt (le contexte doit inclure lib/) :
#   docker build -f mcp-server/Dockerfile -t bibliotheque-mcp .
FROM node:24-alpine

WORKDIR /app

# Applique les derniers correctifs de sécurité Alpine au moment du build
# plutôt que de dépendre de la date de publication de l'image de base.
RUN apk upgrade --no-cache

COPY mcp-server/package.json ./mcp-server/package.json
# Pas de chaîne de compilation (python3/make/g++) : better-sqlite3 embarque
# des binaires précompilés pour musl (Alpine), rien à compiler ici. npm/npx/
# corepack ne servent plus une fois l'install terminée ; les retirer évite de
# traîner leurs propres dépendances (tar, undici, ip-address,
# brace-expansion...) jamais exécutées en prod.
RUN cd mcp-server && npm install --omit=dev \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/corepack.cjs

COPY lib ./lib
COPY mcp-server ./mcp-server

ENV DATA_DIR=/app/data
ENV MCP_PORT=3100

# Le même volume de données que le conteneur principal (server.js), monté
# ici en lecture seule : ce service ne doit jamais pouvoir écrire dedans.
VOLUME ["/app/data"]
EXPOSE 3100

WORKDIR /app/mcp-server

# Service en lecture seule sur le volume de données (monté :ro dans
# docker-compose.yml) : pas besoin de chown au démarrage comme le service
# principal, on peut passer directement en utilisateur non-privilégié.
# "node" est l'utilisateur fourni par l'image de base (même uid/gid que dans
# l'image du service principal, donc capable de lire les fichiers qu'il crée).
USER node
CMD ["node", "index.js"]
