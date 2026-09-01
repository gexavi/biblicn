FROM node:20-alpine

WORKDIR /app

# Dépendances système nécessaires pour compiler better-sqlite3
RUN apk add --no-cache python3 make g++

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY lib ./lib
COPY public ./public

ENV DATA_DIR=/app/data
ENV PORT=3000

VOLUME ["/app/data"]
EXPOSE 3000

CMD ["node", "server.js"]
