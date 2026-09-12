# Construire depuis la RACINE du dépôt (le contexte doit inclure lib/) :
#   docker build -f mcp-server/Dockerfile -t bibliotheque-mcp .
FROM node:20-alpine

WORKDIR /app

# Dépendances système nécessaires pour compiler better-sqlite3
RUN apk add --no-cache python3 make g++

COPY mcp-server/package.json ./mcp-server/package.json
RUN cd mcp-server && npm install --omit=dev

COPY lib ./lib
COPY mcp-server ./mcp-server

ENV DATA_DIR=/app/data
ENV MCP_PORT=3100

# Le même volume de données que le conteneur principal (server.js), monté
# ici en lecture seule : ce service ne doit jamais pouvoir écrire dedans.
VOLUME ["/app/data"]
EXPOSE 3100

WORKDIR /app/mcp-server
CMD ["node", "index.js"]
