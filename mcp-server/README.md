# Serveur MCP — Ma Bibliothèque

Petit service **en lecture seule**, séparé de l'application principale, qui expose la bibliothèque à un agent de conversation (Home Assistant Assist + intégration Anthropic Conversation) via le protocole [MCP](https://modelcontextprotocol.io) en transport SSE.

Il ouvre directement le même fichier `bibliotheque.db` que le serveur principal (lecture seule, jamais d'écriture), donc aucune API réseau supplémentaire n'est nécessaire côté appli principale.

## Tools exposés

- `search_books` — recherche par titre/auteur/série, genre, type, propriétaire, statut de lecture.
- `get_book_details` — détail complet d'un livre (dont qui l'a lu, quand, avec quelle note).
- `list_wishlist` — liste de souhaits.
- `get_library_stats` — chiffres globaux (total, lus, prêtés, souhaités).
- `get_owner_stats` — statistiques par propriétaire (genres favoris, lectures par année, note moyenne).

Aucun tool ne modifie la bibliothèque.

## Lancer en local

```
cd mcp-server
npm install
DATA_DIR=../data npm start
```

Le serveur écoute sur `http://localhost:3100` (`MCP_PORT` pour changer), avec le flux SSE sur `/sse`.

## Déployer sur le NAS

Le service `bibliotheque-mcp` est déjà défini dans `docker-compose.yml`, à côté du service `bibliotheque` — il partage le même volume de données (monté en lecture seule) et écoute sur le port `3100`. Retirez ce service du fichier si vous ne comptez pas vous en servir.

Variable optionnelle : `MCP_SHARED_SECRET` (voir `.env.example`) — si définie, Home Assistant doit envoyer l'en-tête `Authorization: Bearer <valeur>` pour interroger le serveur. Laissez vide pour un usage réseau local uniquement.

**Ordre de démarrage** : lancez d'abord (ou gardez déjà lancé) le service `bibliotheque` au moins une fois avant `bibliotheque-mcp` — celui-ci a besoin que `bibliotheque.db` existe déjà sur le volume partagé.

## Brancher sur Home Assistant

1. **Intégration "Model Context Protocol"** — Paramètres → Appareils et services → Ajouter une intégration → `Model Context Protocol` → URL : `http://<ip-nas>:3100/sse` (ajoutez l'en-tête `Authorization: Bearer <secret>` dans la configuration avancée si `MCP_SHARED_SECRET` est défini).
2. **Intégration "Anthropic Conversation"** — Paramètres → Appareils et services → Ajouter → clé API Anthropic.
3. Dans la configuration de l'agent de conversation Anthropic, activez l'option "LLM API"/contrôle et sélectionnez l'intégration MCP créée à l'étape 1.
4. Définissez cet agent comme agent de conversation par défaut d'Assist (Paramètres → Assistants vocaux).
5. Testez d'abord en texte dans l'onglet **Assist** de Home Assistant (ex. "Est-ce que je possède des livres de Harlan Coben ?") avant de passer au vocal.

## Non testé

Ce service n'a pas pu être exécuté ni testé (pas d'environnement Node disponible côté outil au moment où il a été écrit) — vérifiez `npm install` + `npm start` en local, puis la connexion Home Assistant, avant de considérer que c'est en état de marche.
