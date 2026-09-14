#!/bin/sh
# Le conteneur démarre en root (image de base) uniquement le temps de
# remettre DATA_DIR (volume monté depuis le NAS, souvent créé appartenant à
# root) à l'utilisateur non-privilégié "node" fourni par l'image node:alpine,
# puis abandonne définitivement les privilèges root avant de lancer l'appli.
set -e
chown -R node:node "$DATA_DIR" 2>/dev/null || true
exec su-exec node "$@"
