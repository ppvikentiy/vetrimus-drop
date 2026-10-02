# Vetrimus Drop

Web service for file transfer without user accounts.

The client encrypts each drop prior to upload. The server stores ciphertext in an S3-compatible bucket. PostgreSQL stores hashes and operational records. A share URL has the form `https://host/<token>#<key>`, where `<token>` is 43 characters. The key is carried in the URL fragment and is not included in HTTP requests.

Russian edition: [README-RU.md](README-RU.md).

## Limits

- Maximum file count per drop: 10.
- Maximum size per file: 500 MB.
- Retention, measured from publication: 1, 3, 7, or 30 days.
- Download limit: 1, 5, 10, or an integer in the range 1..1000.
- Password: optional. Until verification succeeds, the API response contains only `requiresPassword`. The file list and the access key are omitted.
- Multiple files are retrieved individually or assembled into a ZIP in the recipient browser. A single file supports HTTP Range.
- Thumbnails of images and video are JPEG objects of at most 40 KB, produced in the sender browser and included in the encrypted metadata. Thumbnail display does not increment the download counter.
- The sender can delete a drop immediately. The upload secret remains in the browser for about 6 hours, on the page after publication and on the next visit.
- In Chrome on Android, upload continues after the application is closed (Background Fetch). The link is shown on the next visit.

Drops past `expires_at`, and drops with `download_count >= max_downloads`, are deleted from object storage and from the database by a job with a period of 10 minutes. Deletion is deferred until 24 hours after `last_download_at`, which permits completion of an interrupted Range request.

## Routes

| Path | Function |
| --- | --- |
| `/home` | Landing page. `GET /` responds with a redirect to `/home`. In standalone display mode the client replaces `/home` with `/upload` when the navigator reports an online state. |
| `/upload` | File selection and publication. Parameters: retention, download limit, optional password. |
| `/<token>` | Retrieval page. The token matches `^[A-Za-z0-9_-]{43}$`. |
| `/receive` | Pairing endpoint for a host without a camera. The page displays a short code and a QR symbol. |
| `/p/<code>` | Pairing URL encoded in that symbol. The client rewrites the path to `/upload?pair=<code>` and retains the fragment. |
| `/offline` | Optical transfer without a network. Transmission: `/offline/send`. Reception: `/offline/receive`. |
| `/policy` | Data-processing policy. The text enumerates data categories stored by the implementation. |

Outside standalone display mode, the routes `/upload`, `/receive`, `/offline` (and its children), and `/<token>` are not rendered until consent state `accepted` is recorded. The value is stored in `localStorage` under the key `vd-consent`. Standalone mode does not present the consent control.

Theme identifiers: `dark`, `light`, `simple`. The value `simple` selects increased type size, disabled animation, stepwise labels, and a visible outline on the primary action. The selection is stored under `vd-theme`. In the absence of a stored value, `prefers-color-scheme: light` selects `light`; otherwise the client selects `dark`.

The user interface language is Russian. The default presentation is a dark monospace layout. The client bundle includes JetBrains Mono and Inter.

## Encryption

Drops created by the published client are encrypted in the sender browser. The format is VDE1. Specification: [client/src/crypto/VDE.md](client/src/crypto/VDE.md). Russian edition: [client/src/crypto/VDE-RU.md](client/src/crypto/VDE-RU.md). Implementation: `client/src/crypto/vde.js`. Test command: `cd client && npm test`.

- Master key: 256 bits, CSPRNG, one value per drop. Encoding: base64url without padding (43 characters). Placement: URL fragment after `#`.
- Key derivation: HKDF-SHA-256, empty salt. Metadata key info: `vde1 meta`. File key info: `vde1 file N`, with `N` the zero-based file index.
- Names, media types, plaintext sizes, and thumbnails are contained in the encrypted metadata block. Database file names are the placeholders `file-0`, `file-1`, and so on. The database stores ciphertext lengths.
- The recipient service worker retrieves ciphertext with HTTP Range, decrypts segments of 1 MiB, and may emit a ZIP via `client-zip`. If the worker does not control the page, decryption is performed in the page memory.

The password is a server-side predicate on the listing. It is not an input to key derivation. `POST /api/drops` rejects a password when `pairCode` is present: the master key is already present in the pairing URL fragment.

Absence of the fragment prevents decryption. Possession of the complete URL is sufficient to decrypt. A substituted client application can read the key in the browser. Installation of the PWA and a reproducible build reduce exposure to substitution of the served application. Disclosure of the database or the bucket does not disclose names or plaintext.

## Pairing

`/receive` is the pairing page for a host that does not use a camera. The page issues `POST /api/pair` and displays a code of the form `K7M-4QX-9TD` and a QR symbol whose payload is `/p/<code>#<key>`. The host generates the master key and places it only in the fragment.

The sending client opens that URL, encrypts under the fragment key, and uploads a drop with `pairCode` on `POST /api/drops`. The receiving host polls `GET /api/pair/:code/status` with the header `X-Pair-Secret`. On state `ready` the host navigates to `/<token>#<key>`.

- Code alphabet: Crockford base32, length 9, entropy 45 bits. Case and separator characters are ignored by normalization. The stored value is `SHA-256` of the prefix `pair:` concatenated with the normalized code.
- Lifetime before attachment: 10 minutes. Lifetime after attachment: equal to the pending-drop lifetime, 6 hours. The plaintext token is retained for retrieval for at most 15 minutes, after which the pairing row is deleted.
- Failed code lookups: 20 per 15 minutes per IP address. Code creation: 30 per hour per IP address.

## Optical transfer

One file of at most 256 MiB is transferred as a sequence of QR symbols from a display to a camera. The channel has no network path and no return path. The codec is the package `vqd`. Description: [vqd/README.md](vqd/README.md). Format: [vqd/SPEC.md](vqd/SPEC.md). Russian editions: [vqd/README-RU.md](vqd/README-RU.md), [vqd/SPEC-RU.md](vqd/SPEC-RU.md). Operation at approximately 150 MiB is the measured comfortable bound.

The sender selects QR version 40, 30, or 20 and a frame rate in the range 5..30 frames per second. The receiver decodes with zxing-wasm inside a worker and writes accepted bytes to OPFS. Reception survives a page reload. A single incomplete transfer is retained on the device. Each segment is verified with SHA-256. Frame loss, duplication, reordering, and late join are tolerated by the fountain code.

On installation the service worker precaches the application shell, including the WebAssembly decoder. After one online load, the optical routes function without a network. Camera permission is restricted by `Permissions-Policy: camera=(self)`. This mode does not apply encryption. A camera that observes the display obtains the file.

## Installed application

The site is a progressive web application. When the browser exposes an install prompt, the footer renders the corresponding control. On iOS the footer documents the Safari sequence Share, then Add to Home Screen.

After installation, the Android share target delivers files to `/upload`. The service worker handles `POST /share-target`. If the worker is not yet controlling the client, the server responds to that URL with a redirect to `/upload`.

When the navigator reports an offline state, the shell is served from cache and a banner links to optical transfer. API responses and file bodies are excluded from the cache. Document responses use `Cache-Control: no-cache`. Files under `/assets/` use immutable caching for one year. `sw.js` and the web manifest use `Cache-Control: no-cache`.

The manifest members `handle_links` and `launch_handler` request that Android and desktop Chromium open Drop URLs in the installed application. Safari on iOS does not implement this behaviour for web applications.

## Build identification

The footer displays the version from `client/package.json`, the build type (`release` or `dev`), the build number, and, when present, a short commit identifier. The number is taken from `BUILD_NUMBER`, else from `client/build-info.json` (written by `deploy.ps1` when git is available), else from `git rev-list --count HEAD`, else from a UTC timestamp `YYYYMMDD.HHMM`. The type is `release` for a production Vite build and `dev` otherwise, unless `BUILD_TYPE` is set. The commit identifier is taken from `GIT_SHA`, else from the same JSON file, else from `git rev-parse --short HEAD`.

## Repository layout

```
browser → nginx :80/:443 → Node.js (Express, 127.0.0.1:3000) → S3 bucket
                                      │
                                      └── PostgreSQL (drops, limits, password hashes)
```

| Directory | Contents |
| --- | --- |
| `client/` | React 18 and Vite interface, service worker, VDE |
| `server/` | Express API, streaming to S3, PostgreSQL, cleanup |
| `vqd/` | Fountain codec for QR frames, Apache-2.0, no interface |
| `deploy/` | `deploy.bat` and `deploy.ps1` for Windows; `install.sh` for the server |

Object bytes are streamed through the API into the bucket. The server filesystem does not retain a copy. Passwords are stored as scrypt hashes with parameters `N=16384`, `r=8`, `p=1`, a 16-byte salt, and a 64-byte derived key. The database representation is `scrypt$<salt>$<key>`, with both components in base64.

## Deployment from Windows

Required inputs: a VPS running Ubuntu or Debian with SSH, an S3-compatible bucket, and, optionally, a domain whose A record resolves to the server address. The operator host requires Windows 10 or Windows 11 and an OpenSSH client.

`deploy\deploy.bat` collects the SSH endpoint, an optional domain and email address for Let's Encrypt, and the S3 endpoint, region, bucket name, and credentials. An empty domain and email leave the service reachable by IP address.

The script verifies SSH. Password authentication results in installation of the key `%USERPROFILE%\.ssh\vetrimus_deploy_ed25519`. The script then uploads the tree and executes `deploy/install.sh`. The installer provisions nginx, PostgreSQL, and Node.js. Node.js 22 is installed when the present major version is below 20. The database role is created only if absent. The client is built. Bucket write and delete are verified. The systemd unit `vetrimus-drop` is installed. The nginx site `vetrimus-drop` is written. When a domain and an email address are set, the certificate is requested with `certbot certonly --nginx --keep-until-expiring`. A certificate still inside its validity window is not replaced.

A subsequent execution applies changes and retains the existing database password and `APP_SECRET`. The nginx configuration managed by the installer is limited to the site `vetrimus-drop`. A configured domain does not set `default_server`. Service by IP address sets `default_server` only when no other site already holds that flag. The installation log path is `/var/log/vetrimus-drop-install.log`. Collected parameters other than the S3 secret key are stored in `deploy/deploy.settings.json`.

```bash
systemctl status vetrimus-drop
journalctl -u vetrimus-drop -f
cat /opt/vetrimus-drop/.env
```

The bucket lifecycle policy should abort incomplete multipart uploads after one day. Otherwise parts from an upload interrupted by process termination remain in the bucket.

## Local development

Requirements: Node.js 20.6 or newer, PostgreSQL, and an S3-compatible endpoint. MinIO satisfies the storage requirement.

```bash
cd server
cp .env.example .env
npm install
npm run check-s3
npm run dev
```

The API binds to `http://127.0.0.1:3000`. Schema migration runs at process start.

```bash
cd client
npm install
npm run dev
```

The interface is served at `http://localhost:5173`. Requests under `/api` are proxied to the API process.

`server/.env.example` defines `DATABASE_URL`, `APP_SECRET`, `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, and `S3_FORCE_PATH_STYLE`. `PORT` and `HOST` are optional.

## HTTP API

| Method and path | Function |
| --- | --- |
| `GET /api/health` | Response body `{ ok: true }`. |
| `POST /api/drops` | Creates a pending drop. JSON body: `files` as an array of `{ size, name?, thumb? }`, `expiry` in `{1d, 3d, 7d, 30d}`, `maxDownloads`, optional `password`, `enc: true` with base64 `meta`, optional `pairCode`. |
| `GET /api/drops/:id/files/:fileId/status` | Returns the stored byte count. Requires the header `X-Upload-Secret`. |
| `PUT /api/drops/:id/files/:fileId` | Writes object bytes. A partial write uses `Content-Range: bytes START-END/SIZE`. A body that covers the whole object is streamed without that header. Requires `X-Upload-Secret`. |
| `POST /api/drops/:id/finalize` | Publishes a pending drop and returns the public token. A second call after publication responds with status 409. |
| `DELETE /api/drops/:id` | Deletes a pending or published drop. Requires `X-Upload-Secret`. Success status is 204. An unknown identifier or a secret that does not match responds with 404. |
| `GET /api/d/:token` | Returns drop metadata, or `{ requiresPassword: true }`. |
| `POST /api/d/:token/unlock` | Verifies the password and returns the file list and an access key. |
| `GET /api/d/:token/files/:index?key=` | Returns one ciphertext object. Supports HTTP Range. |
| `GET /api/d/:token/download?key=` | Returns a ZIP or a single file for a drop with `enc` false. A drop with `enc` true responds with status 409. Decryption uses `/files/:index`. |
| `GET /api/d/:token/thumbs/:index?key=` | Returns a JPEG thumbnail. Defined only for a drop with `enc` false. |
| `POST /api/pair` | Allocates a pairing code and a secret. |
| `GET /api/pair/:code/check` | Reports whether the code is in state `waiting`. |
| `GET /api/pair/:code/status` | Returns `waiting`, `uploading`, or `ready` with the token. Requires the header `X-Pair-Secret`. |
| `DELETE /api/pair/:code` | Deletes the pairing row. Requires `X-Pair-Secret`. |

The published client sets `enc` to `true` on every create request. The API accepts a create request with `enc` not equal to `true` and then stores a sanitized file name and an optional thumbnail. The published interface does not emit that request.

**Download accounting.** Page open, or a successful unlock, returns an access key: HMAC-SHA256 under `APP_SECRET`, lifetime 24 hours, containing a random nonce. The first request that presents a previously unseen key increments `download_count` by one. Subsequent requests that present the same key within 24 hours, including Range continuation, additional files, and ZIP retrieval, do not increment the counter. The key is not bound to an IP address.

**Upload continuation.** Objects larger than 5 MiB are uploaded in parts of 8 MiB through S3 multipart upload. The server rejects a non-final part smaller than 5 MiB and a partial part larger than 32 MiB. A `PUT` whose range is the entire object is streamed at any size up to the drop limit and is not buffered as one part. If a multipart upload is already open for that object, it is aborted before the stream is accepted. A `PUT` for a file already marked uploaded is acknowledged as success and the body is discarded. A partial `PUT` whose start offset is not the stored `uploaded_bytes` responds with status 409 and the current offset. The client stores `dropId`, the upload secret, the master key, and per-file offsets in IndexedDB (`vd-uploads`). After a transport failure the client resumes at the stored offset. Reopening the document while the record is still present presents a continuation prompt when the same files are selected. A pending drop that is not finalized expires on the server after 6 hours. The client deletes IndexedDB records whose `updatedAt` is older than 7 hours.

**Publication race.** The page and the service worker may both call `POST /api/drops/:id/finalize`. The first call that observes `status = 'pending'` publishes the drop. The later call receives status 409. The caller that receives 409 reads the token from the IndexedDB record written by the winner (`waitForReady`, timeout 10 seconds).

**Background upload.** The path is used only in Chrome on Android, and only when `BackgroundFetchManager`, a controlling service worker, and the origin-private file system are present, and when `navigator.storage.estimate` reports at least `2 × ciphertext length + 8 MiB` of free quota. The page encrypts each file into OPFS, one segment resident in memory at a time, under a directory removed after publication. It then submits one whole-object `PUT` per file through Background Fetch. The registration identifier is `dropId`. The browser may continue the transfer after the document is closed. On `backgroundfetchsuccess` the service worker calls finalize, deletes the ciphertext directory, and posts `vd-bg-ready` to open windows. On `backgroundfetchfail` the notification title is set to a failure string. `backgroundfetchclick` opens `/upload`. If the background registration cannot be started, the page uploads while the document is open. Other user agents upload only while the document is open.

**Deletion by the sender.** `DELETE /api/drops/:id` with `X-Upload-Secret` removes bucket objects and then the database row, without waiting for expiry or the download limit. The compared value is `SHA-256` of the upload secret. Object deletion is strict: if storage does not confirm deletion, the row is retained and the request may be repeated. The client treats status 204 and status 404 as completion and then deletes the IndexedDB record and the OPFS ciphertext directory. After publication the local record, and therefore the delete control, remains until the 7-hour `updatedAt` cutoff.

**Response headers.** `Content-Security-Policy` permits `'wasm-unsafe-eval'` in `script-src` for the QR decoder. Additional headers: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy: same-origin`, and `Permissions-Policy` with `camera=(self)`. HTTPS responses include `Strict-Transport-Security`. Download responses set the stored media type and `Content-Disposition: attachment`.

**Rate limits, per IP address.** Drop creation: 30 per hour. Pairing-code creation: 30 per hour. Password verification: 20 per 15 minutes. Failed pairing lookups: 20 per 15 minutes. Pairing status requests: 300 per minute.

Indexable document paths: `/home`, `/upload`, `/receive`, `/offline`, `/offline/send`, `/offline/receive`, `/policy`. Other HTML responses, including share URLs, include `X-Robots-Tag: noindex`.
