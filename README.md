# Ma Bibliothèque (*My Library*)

🇫🇷 [Version française](README-fr.md)

Self-hosted personal library management app: search books by ISBN, records with title, author, publisher, type (novel/comic/manga/essay/other), genre, series (with volume number), read status (with date), rating out of 20, storage location, loan tracking, and owner. Responsive web interface, usable on mobile or desktop browsers.

## How it works

- **Backend**: Node.js + Express, exposes a REST API and serves the frontend.
- **Database**: SQLite (a single file, no database server to manage), stored in the `data/` folder mounted as a Docker volume — your books survive container updates and restarts.
- **ISBN search**: queries the free, public [Open Library](https://openlibrary.org/) API, falling back to [Google Books](https://developers.google.com/books) if the book isn't referenced there. Both services require outbound internet access from the NAS.
- **Frontend**: plain HTML/CSS/JS, no build step, responsive from mobile to desktop.
- **Image processing**: the `sharp` library (cover resizing/compression) downloads a precompiled binary matching the NAS's processor at Docker build time (`npm install` runs directly on the NAS, no cross-compilation needed). This works out of the box on both Intel/AMD (x64) and ARM Synology models. If the build fails specifically on installing `sharp` (rare, generally only on a very old 32-bit ARM model), see the [Troubleshooting](#troubleshooting-sharp-if-the-build-fails) section below.

## Deploying on a Synology NAS

### Option A — via Container Manager (graphical interface)

1. Copy the whole `bibliotheque-app` folder to your NAS, e.g. into `/volume1/docker/bibliotheque-app/`. You can do this via **File Station** (drag and drop the zip, then extract it) or over the network (SMB).
2. Open **Container Manager** (formerly Docker) in DSM.
3. Go to **Project** → **Create**.
4. Project name: `bibliotheque`. Path: select the `bibliotheque-app` folder copied in step 1.
5. Container Manager automatically detects the `docker-compose.yml` file. Before launching, edit it (the "Edit YAML file" button in the wizard, or directly in File Station) to replace the volume line with an explicit path on your NAS:
   ```yaml
   volumes:
     - /volume1/docker/bibliotheque-app/data:/app/data
   ```
6. Click **Next** then **Done**. Building the image takes one to two minutes the first time.
7. Once the container has started, the app is accessible at `http://YOUR_NAS_IP:7000`.

### Option B — command line (SSH)

```bash
# SSH into the NAS, then:
cd /volume1/docker
mkdir -p bibliotheque-app && cd bibliotheque-app
# copy the project files here (scp, git, or File Station), then:
sudo docker compose up -d --build
```

### Mobile and web access

The app is a simple responsive web page: open `http://YOUR_NAS_IP:7000` from your phone's browser (on the same network, or via your Synology VPN/reverse proxy for access from outside).

For secure remote access, the easiest way is to go through DSM's built-in **Reverse Proxy** (Control Panel → Login Portal → Reverse Proxy) pointing a subdomain to `localhost:3000`, combined with QuickConnect or a Let's Encrypt certificate already configured on your NAS.

### Installing as an app (PWA)

The app can be installed like a real app, with its own icon and no browser address bar. Once logged in from a mobile browser, use the browser menu → **Add to Home Screen** (Android/Chrome) or **Share → Add to Home Screen** (iPhone/Safari).

**Requires HTTPS**, like the barcode scanner (see the dedicated section below) — browsers only allow installing a PWA over a secure connection. Without HTTPS, the rest of the app works normally; only the install option won't appear.

## Login

The app is protected by a single username and password, shared by the whole household (no individual accounts). `docker-compose.yml` reads these values from the `AUTH_USERNAME`/`AUTH_PASSWORD` variables with no default: the app (and even the stack deployment itself) refuses to start until they're set, to avoid ever running with a forgotten default password.

**With Portainer**: open the stack → **Environment variables** tab → add `AUTH_USERNAME` and `AUTH_PASSWORD` with your values, then redeploy. Don't edit them directly in the displayed `docker-compose.yml` file — Portainer injects them separately at deploy time.

**Command line (`docker compose`)**: create a `.env` file next to `docker-compose.yml`:
```
AUTH_USERNAME=admin
AUTH_PASSWORD=your_password
```

Once logged in from a browser, the session stays active for 30 days (even after a container restart); a **⏻ Logout** button in the top right lets you end the session manually.

**Anti-bruteforce protection**: after 5 failed login attempts, the IP address behind them is locked out for 5 minutes before it can try again. If you access the app through DSM's **Reverse Proxy** (see above), all requests reach the app with the reverse proxy's internal IP address rather than the visitor's: the lockout then applies to everyone going through that proxy after repeated failures, rather than to a single malicious visitor. No impact for normal household use (few people mistype a password 5 times in a row), but worth keeping in mind.

## Advanced settings (optional)

Besides `AUTH_USERNAME`/`AUTH_PASSWORD`, a few optional environment variables (with a default value applied when absent) let you adjust the app's behavior without touching the code. See the `.env.example` file for the full list with descriptions:

| Variable | Default | Effect |
|---|---|---|
| `SESSION_DURATION_DAYS` | `30` | How long a session stays valid before requiring login again |
| `COVER_MAX_WIDTH` | `500` | Max width (px) of cached covers |
| `COVER_JPEG_QUALITY` | `82` | JPEG compression quality of covers |
| `BACKUP_INTERVAL_DAYS` | `15` | How often the automatic backup runs |
| `BACKUP_KEEP` | `6` | Number of automatic backups kept |
| `COOKIE_SECURE` | `false` | `auto` enables the session cookie's Secure attribute as soon as an HTTPS Reverse Proxy is detected (`X-Forwarded-Proto`); `true` always forces it |

Add them to the `.env` file (command line) or to the stack's **Environment variables** (Portainer), just like `AUTH_USERNAME`/`AUTH_PASSWORD`.

## Changing the port

The app is configured to be accessible on port **7000**. If needed, edit `docker-compose.yml`:
```yaml
ports:
  - "8090:3000"   # access via http://NAS_IP:8090
```

## Backup

All data lives in the `data/` folder (the `bibliotheque.db` file). Simply back up this folder (Hyper Backup, shared volume snapshot, etc.) to back up the whole library.

**Built-in automatic backup**: in addition to the NAS backup above, the app itself copies the database and covers into `data/backup/YYYY-MM-DD/` every 15 days (on startup if the last backup is older than 15 days, then at regular intervals as long as the container runs). The last 6 are kept (~3 months of history), older ones are automatically deleted. The database is backed up live via SQLite's backup API (not a plain file copy), so there's no risk of corruption even if the app is being used at the moment of the backup.

## Local development / testing (without Docker)

```bash
npm install
npm start
# then open http://localhost:3000
```

**Tests**: pure logic with no side effects (ISBN-10/13 conversion, merging search sources, login anti-bruteforce, etc.) is extracted into `lib/` and tested in isolation; `server.js` routes (book CRUD, bulk import, statistics) are covered by integration tests that start the app on a free port with a temporary database — all using Node.js's built-in test runner, no extra dependency:
```bash
npm test
```

## Bulk import

The **Bulk import** button (at the top of the screen) offers two methods:

- **ISBN list**: paste one ISBN per line (with or without dashes). Each book is looked up automatically just like a single addition, with a default type, storage location, and owner applied to all of them. ISBNs that can't be found are listed separately, without blocking the others.
- **CSV file**: import a file with the columns `title, author, type, genre, publisher, lu, note, location, lent_to, owner, isbn, series, series_number` (first line = headers, only `title` is required; `type` = `roman`, `bd`, `manga`, `essai`, or `autre`; `lu` = `oui`/`non`). The separator (comma or semicolon) is detected automatically — useful for French Excel exports, which use semicolons by default. A **Download a CSV template** button in the modal provides a ready-to-fill example for a spreadsheet. Handy for re-entering an existing catalog (Excel export, Babelio, reformatted Goodreads, etc.) without relying on ISBN search.

## Interface

- **Locally cached covers**: as soon as a book is added or edited with a cover (automatic ISBN search, or a manually pasted URL), the app downloads the image once, resizes it to a maximum width of 500px, compresses it to JPEG (82% quality), and stores it in `data/covers/` on the NAS. It's then served locally (`/covers/{id}.jpg`) without ever depending on external sites (Open Library, Amazon, etc.) day-to-day — faster to load, and safe if one of the sources disappears someday. If the download fails at save time, the original external URL is kept as-is as a fallback.
  - **Optimize existing covers**: the 🖼️ button at the top of the screen goes through all books already in the database whose cover still points to an external source (books added before this feature, or whose caching failed at the time) and caches them locally. No effect on already-optimized books — you can run it as many times as needed without risk.
  - **Watch out for large libraries**: this operation processes books one at a time (download + resize), which can take several minutes for a library of several hundred books and exceed a browser's or reverse proxy's timeout. Safe if that happens: already-processed covers stay cached, just click the button again to resume where it left off (already-optimized books are automatically skipped).
  - If no automatic source finds a cover (common for comics, since the BnF doesn't provide images), the "Cover URL" field on the book's record lets you paste one manually (from the publisher's site, a retailer, etc.) — it will be cached locally the same way.
- **Grid / list view**: two buttons at the top right of the toolbar let you switch between grid display (default) and a more compact list view. The choice is remembered in the browser.
- **Sticky header on scroll**: on desktop (screens wider than 640px), the top banner and toolbar stay visible at all times while scrolling through books, keeping search/filters within reach. On mobile, this behavior is disabled so as not to eat into the already-limited vertical space.
- **Dark theme**: the app uses a dark theme by default, with a midnight-blue banner under the "Ma Bibliothèque" title.
- **Read date**: checking "Read" on a book's record reveals a date field (pre-filled with today's date, editable). It's then shown on the card, next to the checkmark.
- **Genre filter**: a dropdown in the toolbar lists every genre used in the library (multiple genres separated by commas on the same record are correctly counted separately) and filters the display accordingly.
- **Rating filter**: a dropdown ("18/20 and above", "16/20 and above", etc.) shows only books rated at least that high. Books without a rating (unread, or read but not yet rated) are excluded as soon as a threshold is selected.
- **Per-owner statistics**: the 📊 Statistics button opens a view with one card per person (those entered in the "Belongs to" field), showing the number of books owned, the breakdown by genre, and reads by year. A book shared between several people (e.g. "Dad, Son") counts for each of them separately. Books with no owner set are grouped under "No owner" rather than being ignored. A sold book (see below) drops out of the total and genre breakdown, but still counts in reads by year: having read it stays true even after selling it.
- **Wishlist**: the 🎁 button at the top of the screen switches to a separate view of books you'd like to acquire (ISBN search, cover, genres... everything works the same as for the library). The views never mix: statistics, filters, and the book count only cover books actually owned, with a separate "wished for" counter.
  - **Turning a wish into a library book**: when you buy or receive a book from the wishlist, a **"✓ Mark as acquired"** button directly on its card (grid view) or in its detail view instantly moves it into your library, without re-entering anything — title, author, cover, genre stay as they are.
  - **Check secondhand availability (Gibert, Chasse aux livres)**: on a wishlist book's detail view, two 🔍 links open a Google search targeted at gibert.com and chasse-aux-livres.fr for that specific book. Since Chasse aux livres is itself a price comparison site that queries Momox and RecycLivre among other resellers, a dedicated link for each of those would be redundant. Neither site has a public API to query price and availability automatically (Gibert has no API at all; Chasse aux livres explicitly blocks AI crawlers in its `robots.txt`) — rather than scraping their pages (fragile, against their terms of service, as already ruled out for Amazon and Fnac), the app opens the relevant search results directly in a new tab, to check manually. The search uses the ISBN when available (a title search can surface any edition, whereas the ISBN targets precisely the one on your record); without an ISBN, it falls back to title + author.
  - The newly added book depends on the active view at the time of adding: click 🎁 before adding to send it to the wishlist, or 📚 to add it directly to your library.
- **Sold books**: when you sell a book, the **"📚→📦 Mark as sold"** button on its detail view removes it from your library (and from collection statistics — total, genre breakdown) without deleting it. It remains viewable under the 📦 Sold tab, alongside 📚 My Library and 🎁 Wishlist, and a **"📦→📚 Put back in library"** button lets you undo this at any time. Reads-by-year statistics (under 📊 Statistics) keep counting it: having read the book stays true even after selling it.
- **Publisher**: a field on the book's record, filled in automatically during ISBN search when the information is available (Open Library, Google Books, or BnF). A dedicated filter in the toolbar lists every publisher present in the library.
- **Series**: two free-text fields on the book's record — the series name and the volume number (stored as text, to also cover special or half volumes like "3.5"). None of the ISBN search sources reliably provide this information, so these fields are filled in manually. When set, the series name is shown on the book's card (grid view), with the number in parentheses.
- **Belongs to**: a field indicating who owns the book (useful for a library shared between several people in the same household — can contain several names separated by commas for a jointly-owned book). Shown as a 📚 tag on the card (grid view) and has its own filter. This is a separate field from "Lent to", which is used to track a temporary loan to someone outside the household.
- **Book types**: Novel, Comic, Manga, Essay, Other — available everywhere a type is chosen (record, CSV import, bulk ISBN import, filter).
- **Barcode scanner**: on the add-book form, the 📷 button next to the ISBN field opens the phone's camera to scan the barcode (EAN-13) on the back of the book directly. The detected ISBN is filled in automatically and the search starts on its own.

  **⚠️ Requires HTTPS.** Browsers forbid camera access on pages loaded over plain `http://`, for security reasons — which is your NAS's default (`http://NAS_IP:7000`). For the scanner button to work, you need to enable HTTPS access, for example via DSM's built-in **Reverse Proxy**:
  1. Control Panel → Login Portal → Reverse Proxy → Create.
  2. Source: HTTPS, the port of your choice (443 or other).
  3. Destination: HTTP, `localhost`, port **7000** (the port published on the host as defined in `docker-compose.yml`, NOT the container's internal port 3000 — DSM's reverse proxy runs at the system level, outside the Docker network, so it can only reach the app through the port actually exposed on the NAS).
  4. You need a valid SSL certificate on this hostname — Control Panel → Security → Certificate, with Let's Encrypt if your NAS is reachable from the internet, or a self-signed certificate accepted manually in the browser otherwise (less convenient on mobile).
  5. Then access the app via `https://your-hostname` instead of `http://IP:7000`.

  Without HTTPS, the rest of the app works normally — only the scanner button will show a message explaining that HTTPS is required, and you can always type the ISBN by hand.

## Notes on ISBN search
- Works with both ISBN-10 and ISBN-13, with or without dashes.
- The two main sources (Open Library and Google Books) are queried in parallel and merged: if one is missing the author or cover, the other fills it in automatically. A third request queries Open Library's raw edition record directly (useful for old editions or poorly cataloged comics where the author isn't always linked). A fourth source queries the **BnF** (Bibliothèque nationale de France) catalog, which references almost everything published in France through legal deposit — far more reliable than Open Library/Google Books for French-language books and comics (it doesn't provide a cover, only title/author/genre).
- A fifth source fetches the cover via **Amazon's official image widget** (no HTML scraping — Amazon uses the ISBN-10 as its product identifier, the "ASIN", and exposes an image widget meant for embedding, no account or key needed for this basic use). This is a last-resort complement, only for the image (never for title/author), used only if none of the other sources has a cover.
  **If Amazon changes its site and this source stops working:** open `server.js`, find the commented block `SOURCE COUVERTURE : AMAZON` (right before the `lookupOpenLibraryEdition` function). Only one constant needs changing: `AMAZON_COVER_URL_TEMPLATE`. To find the new URL format, open a book's page on amazon.fr in a browser, right-click the cover image → "Copy image address", and adapt the template by replacing the book's ISBN-10 with `{ASIN}` in the copied URL. The rest of the code (the `lookupAmazonCover` function) shouldn't normally need to be touched.
- A sixth source (**Geobib**, `couverture.geobib.fr`) fetches the cover directly from the BnF's digitized collections based on the ISBN — complementary to the BnF source itself, which only provides text. **Mind its reliability**: unlike the other sources, this isn't an official service backed by a large organization, but a librarian's personal project hosted on a small server. It may slow down, become unavailable, or disappear one day without notice. The code fails silently in that case, just like the other sources, without blocking the search. If it disappears, there's nothing to fix: just remove the `SOURCE COUVERTURE : GEOBIB` block in `server.js` (the `lookupGeobibCover` function) and the loop that calls it in `lookupIsbn`.
- If none of the sources has a cover, the field stays empty rather than showing Open Library's generic "cover not found" image.
- **Honest limitation**: for books from small or niche publishers (low print runs, limited distribution), it can happen that none of the 5 sources knows the book at all — no title, author, or cover. This isn't a bug: the information simply doesn't exist in these free, public databases. In that case, only manual entry (with, if needed, a cover URL found on the publisher's site or a retailer) can complete the record.
- If the author or cover still can't be found for a specific book despite all this, it's simply because the information doesn't exist in these public databases for that edition (common for old French editions or small publishers) — you'll need to fill them in manually.
- If neither service (Open Library / Google Books) finds the book, a message says so and you can always fill in the record manually.
- No API key is needed.

## Troubleshooting sharp (if the build fails)

The `sharp` library, used to resize and compress covers before storing them locally, automatically downloads a precompiled binary matching your NAS's architecture during `npm install` (at Docker build time). This works without any intervention on the vast majority of Synology NAS models (Intel/AMD as well as ARM64).

If the Docker build fails with an error mentioning `sharp` (rare, generally only on a very old 32-bit model):
1. Check your NAS model and its processor (Control Panel → Info Center, or the Synology product page).
2. If it is indeed a case of an architecture unsupported by the precompiled binary, an alternative is to remove `sharp` from the project and disable local cover caching — the app will keep working normally, displaying images directly from external sources (as it did before this feature was added). In that case, contact me with the exact build error message so I can prepare this simplified version for you.
