FROM node:24-alpine

WORKDIR /app

# Applique les derniers correctifs de sécurité Alpine (libssl3, libcrypto3,
# libexpat, tar...) au moment du build plutôt que de dépendre de la date de
# publication de l'image de base node:24-alpine. su-exec : permet de démarrer
# le conteneur en root juste le temps de fixer les permissions de DATA_DIR
# (voir docker-entrypoint.sh) avant d'abandonner les privilèges root.
RUN apk upgrade --no-cache && apk add --no-cache su-exec

COPY package.json ./
# Pas de chaîne de compilation (python3/make/g++) : better-sqlite3 et sharp
# embarquent tous les deux des binaires précompilés pour musl (Alpine), donc
# rien à compiler ici — ça évite aussi de tirer node-gyp et ses dépendances
# transitives (glob, cross-spawn, brace-expansion...) dans l'image finale.
# npm (et npx/corepack) ne servent plus une fois `npm install` terminé —
# seul `node server.js` tourne au final. On les retire de l'image : le CLI
# npm embarque lui-même tar/undici/ip-address/brace-expansion, dont les
# versions suivent le rythme de publication de l'image de base node:24-alpine
# et remontent régulièrement comme vulnérables dans les scans, alors qu'ils
# ne sont jamais exécutés en prod.
RUN npm install --omit=dev \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/corepack.cjs

COPY server.js ./
COPY lib ./lib
COPY public ./public
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

ENV DATA_DIR=/app/data
ENV PORT=3000

VOLUME ["/app/data"]
EXPOSE 3000

# Conteneur lancé en root (défaut), le temps que docker-entrypoint.sh cède la
# place à l'utilisateur non-privilégié "node" — voir ce fichier.
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "server.js"]
