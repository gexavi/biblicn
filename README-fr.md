# Ma Bibliothèque

🇬🇧 [English version](README.md)

Application auto-hébergée de gestion de bibliothèque personnelle : recherche de livres par ISBN, fiches avec titre, auteur, éditeur, type (roman/BD/manga/essai/autre), genre, série (avec numéro de tome), lecture (avec date), note sur 20, emplacement de rangement, prêt et propriétaire. Interface web responsive, utilisable sur mobile ou navigateur.

## Fonctionnement

- **Backend** : Node.js + Express, expose une API REST et sert le front-end.
- **Base de données** : SQLite (un simple fichier, aucun serveur de BDD à gérer), stockée dans le dossier `data/` monté en volume Docker — vos livres survivent aux mises à jour et redémarrages du conteneur.
- **Recherche ISBN** : interroge l'API publique et gratuite [Open Library](https://openlibrary.org/), avec [Google Books](https://developers.google.com/books) en secours si le livre n'y est pas référencé. Ces deux services nécessitent un accès Internet sortant depuis le NAS.
- **Front-end** : HTML/CSS/JS natifs, aucune dépendance de build, responsive du mobile au bureau.
- **Traitement d'image** : la bibliothèque `sharp` (redimensionnement/compression des couvertures) télécharge un binaire précompilé adapté au processeur du NAS au moment du build Docker (`npm install` se fait directement sur le NAS, pas besoin de compilation croisée). Ça fonctionne normalement aussi bien sur les NAS Intel/AMD (x64) que sur les modèles ARM. Si jamais le build échoue spécifiquement sur l'installation de `sharp` (rare, en général sur un très vieux modèle ARM32), voir la section [Dépannage](#dépannage-sharp-si-le-build-échoue) plus bas.

## Déploiement sur un NAS Synology

### Option A — via Container Manager (interface graphique)

1. Copiez tout le dossier `bibliotheque-app` sur votre NAS, par exemple dans `/volume1/docker/bibliotheque-app/`. Vous pouvez le faire via **File Station** (glisser-déposer le zip puis l'extraire) ou en réseau (SMB).
2. Ouvrez **Container Manager** (anciennement Docker) sur le DSM.
3. Allez dans **Projet** → **Créer**.
4. Nom du projet : `bibliotheque`. Chemin : sélectionnez le dossier `bibliotheque-app` copié à l'étape 1.
5. Container Manager détecte automatiquement le fichier `docker-compose.yml`. Avant de lancer, éditez-le (bouton "Éditer le fichier YAML" dans l'assistant, ou directement dans File Station) pour remplacer la ligne de volume par un chemin explicite de votre NAS :
   ```yaml
   volumes:
     - /volume1/docker/bibliotheque-app/data:/app/data
   ```
6. Cliquez sur **Suivant** puis **Terminé**. La construction de l'image prend une à deux minutes la première fois.
7. Une fois le conteneur démarré, l'application est accessible sur `http://IP_DE_VOTRE_NAS:7000`.

### Option B — en ligne de commande (SSH)

```bash
# Connectez-vous en SSH au NAS, puis :
cd /volume1/docker
mkdir -p bibliotheque-app && cd bibliotheque-app
# copiez-y les fichiers du projet (scp, git, ou File Station), puis :
sudo docker compose up -d --build
```

### Accès mobile et web

L'application est une simple page web responsive : ouvrez `http://IP_DE_VOTRE_NAS:7000` depuis le navigateur de votre téléphone (connecté au même réseau, ou via votre VPN/reverse proxy Synology si vous voulez y accéder depuis l'extérieur).

Pour un accès distant sécurisé, le plus simple est de passer par le **Reverse Proxy** intégré au DSM (Panneau de configuration → Portail des applications → Reverse Proxy) en pointant un sous-domaine vers `localhost:3000`, combiné à Quick Connect ou un certificat Let's Encrypt déjà configuré sur votre NAS.

### Installation en application (PWA)

L'application est installable comme une vraie app, avec sa propre icône et sans barre d'adresse de navigateur. Une fois connecté depuis un navigateur mobile, utilisez le menu du navigateur → **Ajouter à l'écran d'accueil** (Android/Chrome) ou **Partager → Sur l'écran d'accueil** (iPhone/Safari).

**Nécessite HTTPS**, comme le scanner de code-barres (voir la section dédiée plus bas) — les navigateurs n'autorisent l'installation d'une PWA que sur une connexion sécurisée. Sans HTTPS, l'application reste utilisable normalement, seule l'option d'installation n'apparaît pas.

## Connexion

L'application est protégée par un identifiant et un mot de passe uniques, partagés par tout le foyer (pas de comptes individuels). Le `docker-compose.yml` lit ces valeurs depuis les variables `AUTH_USERNAME`/`AUTH_PASSWORD` sans valeur par défaut : l'application (et même le déploiement de la stack) refuse de démarrer tant qu'elles ne sont pas définies, pour éviter de tourner avec un mot de passe oublié à sa valeur par défaut.

**Avec Portainer** : ouvrez la stack → onglet **Environment variables** → ajoutez `AUTH_USERNAME` et `AUTH_PASSWORD` avec vos valeurs, puis redéployez. Ne les modifiez pas directement dans le fichier `docker-compose.yml` affiché — Portainer les injecte séparément au moment du déploiement.

**En ligne de commande (`docker compose`)** : créez un fichier `.env` à côté de `docker-compose.yml` :
```
AUTH_USERNAME=admin
AUTH_PASSWORD=votre_mot_de_passe
```

Une fois connecté depuis un navigateur, la session reste active 30 jours (même après un redémarrage du conteneur) ; un bouton **⏻ Déconnexion** en haut à droite permet de fermer la session manuellement.

**Protection anti-bruteforce** : après 5 tentatives de connexion échouées, l'adresse IP à l'origine des tentatives est bloquée 5 minutes avant de pouvoir réessayer. Si vous accédez à l'application via le **Reverse Proxy** du DSM (voir plus haut), toutes les requêtes arrivent à l'application avec l'adresse IP interne du reverse proxy plutôt que celle du visiteur : le blocage s'applique alors à tous les utilisateurs passant par ce proxy en cas d'échecs répétés, plutôt qu'à un seul visiteur malveillant. Sans incidence pour un usage familial normal (peu de monde se trompe 5 fois de suite), mais à garder en tête.

## Réglages avancés (optionnels)

En plus de `AUTH_USERNAME`/`AUTH_PASSWORD`, quelques variables d'environnement optionnelles (valeur par défaut appliquée si absentes) permettent d'ajuster le comportement de l'application sans toucher au code. Voir le fichier `.env.example` pour la liste complète avec description :

| Variable | Défaut | Effet |
|---|---|---|
| `SESSION_DURATION_DAYS` | `30` | Durée de validité d'une session avant reconnexion |
| `COVER_MAX_WIDTH` | `500` | Largeur max (px) des couvertures mises en cache |
| `COVER_JPEG_QUALITY` | `82` | Qualité de compression JPEG des couvertures |
| `BACKUP_INTERVAL_DAYS` | `15` | Fréquence de la sauvegarde automatique |
| `BACKUP_KEEP` | `6` | Nombre de sauvegardes automatiques conservées |
| `COOKIE_SECURE` | `false` | `auto` active l'attribut Secure du cookie de session dès qu'un Reverse Proxy HTTPS est détecté (`X-Forwarded-Proto`) ; `true` le force toujours |

Ajoutez-les au fichier `.env` (ligne de commande) ou aux **Environment variables** de la stack (Portainer), comme pour `AUTH_USERNAME`/`AUTH_PASSWORD`.

## Changer le port

L'application est configurée pour être accessible sur le port **7000**. Si besoin, modifiez `docker-compose.yml` :
```yaml
ports:
  - "8090:3000"   # accès via http://IP_DU_NAS:8090
```

## Sauvegarde

Toutes les données sont dans le dossier `data/` (fichier `bibliotheque.db`). Il suffit de sauvegarder ce dossier (Hyper Backup, snapshot du volume partagé, etc.) pour sauvegarder toute la bibliothèque.

**Sauvegarde automatique intégrée** : en plus de la sauvegarde NAS ci-dessus, l'application copie elle-même la base et les couvertures dans `data/backup/AAAA-MM-JJ/` tous les 15 jours (au démarrage si la dernière sauvegarde a plus de 15 jours, puis à intervalle régulier tant que le conteneur tourne). Les 6 dernières sont conservées (~3 mois d'historique), les plus anciennes sont supprimées automatiquement. La base est sauvegardée à chaud via l'API de backup de SQLite (pas une simple copie de fichier), donc sans risque de corruption même si l'application est utilisée au moment de la sauvegarde.

## Développement / test en local (sans Docker)

```bash
npm install
npm start
# puis ouvrez http://localhost:3000
```

**Tests** : la logique pure sans effet de bord (conversion ISBN-10/13, fusion des sources de recherche, anti-bruteforce sur la connexion, etc.) est extraite dans `lib/` et testée isolément ; les routes de `server.js` (CRUD des livres, import en masse, statistiques) sont couvertes par des tests d'intégration qui démarrent l'app sur un port libre et une base de données temporaire — le tout avec le testeur intégré à Node.js, sans dépendance supplémentaire :
```bash
npm test
```

## Import en masse

Le bouton **Import en masse** (en haut de l'écran) propose deux méthodes :

- **Liste d'ISBN** : collez un ISBN par ligne (avec ou sans tirets). Chaque livre est recherché automatiquement comme pour l'ajout unitaire, avec un type, un rangement et un propriétaire par défaut appliqués à tous. Les ISBN introuvables sont listés à part, sans bloquer les autres.
- **Fichier CSV** : importez un fichier avec les colonnes `title, author, type, genre, publisher, lu, note, location, lent_to, owner, isbn, series, series_number` (première ligne = en-têtes, seule `title` est obligatoire ; `type` = `roman`, `bd`, `manga`, `essai` ou `autre` ; `lu` = `oui`/`non`). Le séparateur (virgule ou point-virgule) est détecté automatiquement — utile pour les exports Excel en français, qui utilisent le point-virgule par défaut. Un bouton **Télécharger un modèle CSV** dans la modale fournit un exemple prêt à remplir dans un tableur. Pratique pour ressaisir un catalogue existant (export Excel, Babelio, Goodreads reformaté, etc.) sans dépendre de la recherche par ISBN.

## Interface

- **Couvertures mises en cache localement** : dès qu'un livre est ajouté ou modifié avec une couverture (recherche ISBN automatique, ou URL collée manuellement), l'application télécharge l'image une seule fois, la redimensionne à une largeur maximale de 500px et la compresse en JPEG (qualité 82%), puis la stocke dans `data/covers/` sur le NAS. Elle est ensuite servie localement (`/covers/{id}.jpg`) sans plus jamais dépendre des sites externes (Open Library, Amazon, etc.) au quotidien — plus rapide à charger, et à l'abri si une des sources disparaît un jour. Si le téléchargement échoue au moment de l'enregistrement, l'URL externe d'origine est conservée telle quelle en repli.
  - **Optimiser les couvertures existantes** : le bouton 🖼️ en haut de l'écran repasse sur tous les livres déjà en base dont la couverture pointe encore vers une source externe (livres ajoutés avant cette fonctionnalité, ou dont la mise en cache avait échoué au moment de l'ajout) et les met en cache local. Sans effet sur les livres déjà optimisés — on peut le relancer autant de fois que nécessaire sans risque.
  - **Attention aux grosses bibliothèques** : cette opération traite les livres un par un (téléchargement + redimensionnement), ce qui peut prendre plusieurs minutes pour une bibliothèque de plusieurs centaines de livres et dépasser le délai d'attente d'un navigateur ou d'un reverse proxy. Sans danger si ça arrive : les couvertures déjà traitées restent en cache, il suffit de recliquer sur le bouton pour reprendre là où ça s'est arrêté (les livres déjà optimisés sont automatiquement ignorés).
  - Si aucune source automatique ne trouve de couverture (fréquent pour les BD, la BnF ne fournissant pas d'images), le champ « URL de couverture » dans la fiche du livre permet d'en coller une manuellement (depuis le site de l'éditeur, un revendeur, etc.) — elle sera mise en cache local de la même façon.
- **Vue grille / liste** : deux boutons en haut à droite de la barre d'outils permettent de basculer entre l'affichage en grille (par défaut) et une vue en liste plus compacte. Le choix est mémorisé dans le navigateur.
- **Bandeau figé au défilement** : sur ordinateur (écrans de plus de 640px de large), le bandeau du haut et la barre d'outils restent visibles en permanence pendant qu'on fait défiler les livres, pour garder la recherche/les filtres à portée de main. Sur mobile, ce comportement est désactivé pour ne pas grignoter l'espace vertical déjà limité.
- **Thème sombre** : l'application est en thème sombre par défaut, avec un bandeau bleu nuit sous le titre « Ma Bibliothèque ».
- **Date de lecture** : en cochant « Lu » dans la fiche d'un livre, un champ date apparaît (pré-rempli avec la date du jour, modifiable). Elle s'affiche ensuite sur la carte, à côté de la coche.
- **Filtre par genre** : un menu déroulant dans la barre d'outils liste tous les genres utilisés dans la bibliothèque (les genres multiples séparés par des virgules sur une même fiche sont bien pris en compte séparément) et filtre l'affichage en conséquence.
- **Filtre par note** : un menu déroulant (« 18/20 et plus », « 16/20 et plus », etc.) affiche uniquement les livres notés au moins à ce niveau. Les livres sans note (non lus, ou lus mais pas encore notés) sont exclus dès qu'un seuil est sélectionné.
- **Statistiques par propriétaire** : le bouton 📊 Statistiques ouvre une vue avec une carte par personne (celles renseignées dans le champ « Appartient à »), affichant le nombre de livres possédés, la répartition par genre, et les lectures par année. Un livre partagé entre plusieurs personnes (ex. « Papa, Fils ») compte pour chacune d'elles séparément. Les livres sans propriétaire renseigné sont regroupés sous « Sans propriétaire » plutôt que d'être ignorés. Un livre revendu (voir plus bas) sort du total et de la répartition par genre, mais continue de compter dans les lectures par année : l'avoir lu reste vrai même après l'avoir revendu.
- **Liste de souhaits** : le bouton 🎁 en haut de l'écran bascule vers une vue séparée des livres que vous souhaitez acquérir (recherche ISBN, couverture, genres... tout fonctionne pareil que pour la bibliothèque). Les vues ne se mélangent jamais : les statistiques, les filtres et le compte de livres ne portent que sur les livres réellement possédés, avec un compteur « souhaités » à part.
  - **Passer un souhait en bibliothèque** : quand vous achetez ou recevez un livre de la liste de souhaits, un bouton **« ✓ Marquer comme acquis »** directement sur sa fiche (dans la vue grille) ou dans sa fiche détaillée le fait basculer instantanément dans votre bibliothèque, sans rien ressaisir — titre, auteur, couverture, genre restent tels quels.
  - **Vérifier l'occasion (Gibert, Chasse aux livres)** : dans la fiche détaillée d'un livre de la liste de souhaits, deux liens 🔍 ouvrent une recherche Google ciblée sur gibert.com et chasse-aux-livres.fr pour ce livre précis. Chasse aux livres étant lui-même un comparateur de prix qui interroge notamment Momox et RecycLivre entre autres revendeurs, un lien dédié à chacun de ceux-ci serait redondant. Aucun de ces deux sites n'a d'API publique pour interroger prix et disponibilité automatiquement (Gibert n'a pas d'API du tout ; Chasse aux livres bloque explicitement les robots d'indexation IA dans son `robots.txt`) — plutôt que de scraper leurs pages (fragile, contraire à leurs conditions d'utilisation, comme déjà écarté pour Amazon et la Fnac), l'application ouvre directement les résultats de recherche pertinents dans un nouvel onglet, à vérifier manuellement. La recherche se fait par ISBN quand il est renseigné (une recherche par titre peut remonter n'importe quelle édition, alors que l'ISBN cible précisément celle que vous avez en fiche) ; sans ISBN, elle retombe sur titre + auteur.
  - Le nouveau livre ajouté dépend de la vue active au moment de l'ajout : cliquez sur 🎁 avant d'ajouter pour l'envoyer dans la liste de souhaits, ou sur 📚 pour l'ajouter directement à votre bibliothèque.
- **Revendus** : quand vous revendez un livre, le bouton **« 📚→📦 Marquer comme revendu »** dans sa fiche détaillée le retire de votre bibliothèque (et des statistiques de collection — total, répartition par genre) sans le supprimer. Il reste consultable dans l'onglet 📦 Revendus, aux côtés de 📚 Ma bibliothèque et 🎁 Liste de souhaits, et un bouton **« 📦→📚 Remettre dans la bibliothèque »** permet d'annuler à tout moment. Les statistiques de lecture par année (dans 📊 Statistiques) continuent de le compter : le fait d'avoir lu ce livre reste acquis même après l'avoir revendu.
- **Éditeur** : champ dans la fiche du livre, rempli automatiquement lors de la recherche ISBN quand l'information est disponible (Open Library, Google Books ou BnF). Un filtre dédié dans la barre d'outils liste tous les éditeurs présents dans la bibliothèque.
- **Série** : deux champs libres dans la fiche du livre — le nom de la série et le numéro du tome (au format texte, pour couvrir aussi les hors-séries ou demi-tomes comme « 3.5 »). Aucune des sources de recherche ISBN ne fournit cette information de façon fiable, donc ces champs se remplissent manuellement. Quand renseigné, le nom de la série s'affiche sur la carte du livre (vue grille), avec le numéro entre parenthèses.
- **Appartient à** : champ pour indiquer à qui appartient le livre (utile pour une bibliothèque partagée entre plusieurs personnes d'un même foyer — peut contenir plusieurs noms séparés par des virgules pour un livre en copropriété). S'affiche en tag 📚 sur la carte (vue grille) et dispose de son propre filtre. C'est un champ distinct de « Prêté à », qui sert lui à noter un prêt temporaire à quelqu'un d'extérieur.
- **Types de livre** : Roman, BD, Manga, Essai, Autre — disponibles partout où le type est choisi (fiche, import CSV, import ISBN en masse, filtre).
- **Scanner de code-barres** : dans la fiche d'ajout d'un livre, le bouton 📷 à côté du champ ISBN ouvre la caméra du téléphone pour scanner directement le code-barres (EAN-13) au dos du livre. L'ISBN détecté est rempli automatiquement et la recherche se lance toute seule.

  **⚠️ Nécessite HTTPS.** Les navigateurs interdisent l'accès à la caméra sur les pages chargées en `http://` simple, pour des raisons de sécurité — ce qui est le cas par défaut de votre NAS (`http://IP_DU_NAS:7000`). Pour que le bouton scanner fonctionne, il faut activer un accès HTTPS, par exemple via le **Reverse Proxy** intégré au DSM :
  1. Panneau de configuration → Portail des applications → Reverse Proxy → Créer.
  2. Source : HTTPS, le port de votre choix (443 ou autre).
  3. Destination : HTTP, `localhost`, port **7000** (le port publié sur l'hôte défini dans `docker-compose.yml`, PAS le port interne 3000 du conteneur — le proxy inverse de DSM tourne au niveau du système, en dehors du réseau Docker, il ne peut donc joindre l'appli que via le port réellement exposé sur le NAS).
  4. Il vous faut un certificat SSL valide sur ce nom d'hôte — Panneau de configuration → Sécurité → Certificat, avec Let's Encrypt si votre NAS est accessible depuis Internet, ou un certificat auto-signé accepté manuellement dans le navigateur sinon (moins pratique sur mobile).
  5. Accédez ensuite à l'application via `https://votre-nom-dhote` au lieu de `http://IP:7000`.

  Sans HTTPS, le reste de l'application fonctionne normalement — seul le bouton scanner affichera un message expliquant qu'il faut l'HTTPS, et vous pourrez toujours saisir l'ISBN à la main.

## Notes sur la recherche ISBN
- Fonctionne avec les ISBN-10 et ISBN-13, avec ou sans tirets.
- Les deux sources (Open Library et Google Books) sont interrogées en parallèle et fusionnées : si l'une manque l'auteur ou la couverture, l'autre vient compléter automatiquement. Une troisième requête interroge directement la fiche technique Open Library (utile pour les vieilles éditions ou les BD mal cataloguées où l'auteur n'est pas toujours lié). Une quatrième source interroge le catalogue de la **BnF** (Bibliothèque nationale de France), qui référence quasiment tout ce qui est publié en France via le dépôt légal — bien plus fiable qu'Open Library/Google Books pour les livres et BD francophones (elle ne fournit pas de couverture, seulement titre/auteur/genre).
- Une cinquième source récupère la couverture via le **widget image officiel d'Amazon** (pas de scraping HTML — Amazon utilise l'ISBN-10 comme identifiant produit "ASIN" et expose un widget d'image prévu pour l'intégration, sans compte ni clé nécessaire pour cet usage). C'est un complément de dernier recours, uniquement pour l'image (jamais pour le titre/auteur), utilisé seulement si aucune des autres sources n'a de couverture.
  **Si Amazon change son site et que cette source arrête de fonctionner :** ouvrez `server.js`, cherchez le bloc commenté `SOURCE COUVERTURE : AMAZON` (juste avant la fonction `lookupOpenLibraryEdition`). Une seule constante à modifier : `AMAZON_COVER_URL_TEMPLATE`. Pour trouver le nouveau format d'URL, ouvrez la fiche d'un livre sur amazon.fr dans un navigateur, faites un clic droit sur l'image de couverture → « Copier l'adresse de l'image », et adaptez le modèle en remplaçant l'ISBN-10 du livre par `{ASIN}` dans l'URL copiée. Le reste du code (fonction `lookupAmazonCover`) n'a normalement pas besoin d'être touché.
- Une sixième source (**Geobib**, `couverture.geobib.fr`) récupère la couverture directement depuis les collections numérisées de la BnF à partir de l'ISBN — complémentaire à la BnF elle-même, qui ne fournit que du texte. **Attention à sa fiabilité** : contrairement aux autres sources, ce n'est pas un service officiel adossé à une grosse structure, mais un projet personnel d'un bibliothécaire hébergé sur un petit serveur. Il peut ralentir, devenir indisponible, ou disparaître un jour sans préavis. Le code échoue silencieusement dans ce cas, comme pour les autres sources, sans bloquer la recherche. S'il disparaissait, il n'y a rien à réparer : supprimez simplement le bloc `SOURCE COUVERTURE : GEOBIB` dans `server.js` (fonction `lookupGeobibCover`) et la boucle qui l'appelle dans `lookupIsbn`.
- Si aucune des sources n'a de couverture, le champ reste vide plutôt que d'afficher l'image "couverture introuvable" générique d'Open Library.
- **Limite honnête** : pour les livres de petits éditeurs ou de niche (faible tirage, distribution confidentielle), il arrive qu'aucune des 5 sources ne connaisse tout simplement le livre — ni titre, ni auteur, ni couverture. Ce n'est pas un bug de l'application : l'information n'existe nulle part dans ces bases publiques et gratuites. Dans ce cas, seule la saisie manuelle (avec, si besoin, une URL de couverture trouvée sur le site de l'éditeur ou un revendeur) permet de compléter la fiche.
- Si malgré tout l'auteur ou la couverture restent introuvables pour un livre précis, c'est que l'information n'existe tout simplement pas dans ces bases publiques pour cette édition (fréquent pour les éditions françaises anciennes ou les petits éditeurs) — il faut alors les compléter manuellement.
- Si aucun des deux services (Open Library / Google Books) ne trouve le livre, un message l'indique et vous pouvez toujours remplir la fiche manuellement.
- Aucune clé API n'est nécessaire.

## Dépannage sharp (si le build échoue)

La bibliothèque `sharp`, utilisée pour redimensionner et compresser les couvertures avant de les stocker localement, télécharge automatiquement un binaire précompilé adapté à l'architecture de votre NAS pendant `npm install` (au moment du build Docker). Ça fonctionne sans intervention sur l'immense majorité des NAS Synology (Intel/AMD comme ARM64).

Si le build Docker échoue avec une erreur mentionnant `sharp` (rare, en général uniquement sur un très ancien modèle 32 bits) :
1. Vérifiez le modèle de votre NAS et son processeur (Panneau de configuration → Info système, ou la fiche produit Synology).
2. Si c'est bien un cas d'architecture non supportée par le binaire précompilé, une alternative consiste à retirer `sharp` du projet et désactiver la mise en cache locale des couvertures — l'application continuera de fonctionner normalement en affichant les images directement depuis les sources externes (comme avant l'ajout de cette fonctionnalité). Dans ce cas, contactez-moi avec le message d'erreur exact du build pour que je vous prépare cette version simplifiée.
