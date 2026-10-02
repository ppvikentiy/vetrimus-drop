# Data processing policy

of the Vetrimus Drop service

Formal edition.

## 1. General provisions

1.1. This data processing policy (the Policy) defines the categories of data that arise in the operation of the Vetrimus Drop service (the Service), the places where that data is processed and stored, the retention periods, and the deletion procedure.

1.2. The Service does not create user accounts.

1.3. The Policy describes the actual behaviour of the Service software, not stated intentions.

1.4. In the Policy, the Service means the Vetrimus Drop software system, including the server component, the web interface, and the object store.

## 2. Data that does not reach the server

2.1. The encryption master key is 32 random bytes. It is placed in the link after the character `#`. The browser does not include that part of the URL in HTTP requests. From the master key the browser derives separate AES-256-GCM keys by HKDF-SHA-256 with an empty salt: info `vde1 meta` for the metadata block, and info `vde1 file N` for file number N.

2.2. Plaintext file contents do not reach the server. The Service interface always creates an encrypted drop. The file is split into segments of 1 MiB. Each segment is encrypted with AES-256-GCM (format VDE1) and a 16-byte authentication tag is appended. Only ciphertext is transmitted to the server.

2.3. Names, MIME types, original sizes, and thumbnails do not reach the server in the clear. They are combined into JSON of the form `{ v, files: [{ name, type, size, thumb }] }` and encrypted into the `meta_ct` block. The server stores that block as bytes and does not decrypt it. The files table stores the names `file-0`, `file-1`, and so on, together with the ciphertext size.

2.4. The password is not stored in the clear. When a drop is created, a scrypt hash of the password is computed. Only the hash is stored in the database. On the download page the password is submitted again in the request body, compared with the hash, and not recorded. scrypt parameters: N = 16384, r = 8, p = 1, key length 64 bytes, salt 16 random bytes. The database stores a string of the form `scrypt$<salt>$<key>`. Both components are base64. The password length is at most 128 characters. The password is not an input to file encryption. It is a separate lock on the page. Until the password matches, the server returns only the indicator that a password is required and does not transmit the metadata, the file list, or the access key. A send-to-computer transfer by code does not accept a password.

2.5. Name, email address, telephone number, payment data, geolocation, and contacts are not processed, because the protocol has no fields for them. The server does not set cookies. The page does not issue requests to other sites: the content security policy permits connections only to the Service origin.

2.6. The server retains the technical ability to accept an unencrypted record when the client sends `enc` not equal to `true`. In that case the database stores a sanitized name and a thumbnail as specified in section 3. The published interface does not create such records.

## 3. PostgreSQL

3.1. The PostgreSQL database stores operational records of a drop, not a profile of a person. Deletion of a drop row cascades to the associated files, download sessions, and the attached pairing code.

3.2. The `drops` table contains: a UUID identifier; state `pending` or `ready`; SHA-256 of the link token (empty until the drop is published); SHA-256 of the upload secret; a scrypt password hash or an empty value; the lifetime in days; the download limit; the download counter; timestamps of creation, expiry, and the last download; the encryption flag; the metadata ciphertext `meta_ct` (from 16 bytes to 2 MiB). The token is 32 random bytes encoded as base64url, 43 characters. The database stores only its SHA-256. The upload secret is constructed in the same way and is delivered to the browser once. Thereafter the browser sends it in the header `X-Upload-Secret`.

3.3. The `files` table contains: the file identifier; the position; the name; the size; the object key in storage; the flag that the whole file has been accepted; the number of bytes already accepted; the identifier of an unfinished multipart upload; the thumbnail. For an encrypted drop the name is recorded as `file-N`, the thumbnail is not stored, and the size is the ciphertext length. For an unencrypted drop the stored name has slashes and control characters replaced by an underscore, has length at most 200 characters (an empty name, `.`, and `..` become `file`), and a JPEG thumbnail of at most 40 KB may be stored. The server accepts a thumbnail only as `data:image/jpeg;base64` with a JPEG signature.

3.4. Limits of one drop: from 1 to 10 files; each file up to 500 MiB of plaintext (the ciphertext may exceed that size by approximately 1 MiB); from 1 to 1000 downloads. A photo or video thumbnail is produced in the sender's browser. The thumbnail side is at most 192 pixels. Display of a thumbnail does not consume the download limit.

3.5. The `download_sessions` table contains: the drop identifier; SHA-256 of the access key; the session creation time. The client address is not written to that table. The access key is an HMAC-SHA256 signature produced with the application secret, valid for 24 hours, and contains a random nonce. The key is passed as the `key` query parameter on the download URL. The first request that presents a new key counts as one download. Repeated requests, resume, and retrieval of the other files of the same drop with the same key within 24 hours do not consume the limit. The key is not bound to an IP address. If delivery is aborted before response headers are sent, the new session is cancelled and the counter is decremented. The session row exists for as long as the drop exists.

3.6. The `pairings` table contains: SHA-256 of the string `pair:` concatenated with the normalized code; SHA-256 of the receive-page secret; state `waiting`, `attached`, or `ready`; the drop reference; the plaintext token; creation and expiry times. The code consists of 9 Crockford base32 characters. While the phone is uploading, the computer receives the file count, the total ciphertext size, and the number of accepted bytes. It does not receive names. The plaintext token of the finished link is stored in that table until the computer retrieves it, and for at most 15 minutes. After the token is issued, the row is deleted immediately. The same deletion occurs when the receive page is left.

## 4. Object storage

4.1. A file passes through the server and is written to the bucket under the key `drops/<drop identifier>/<file identifier>` with type `application/octet-stream`. The application server disk does not retain a copy.

4.2. A file may be sent in full as one stream of any permitted size: the server does not assemble the body in memory and writes it to the bucket directly. The same file may arrive in fragments when an upload was interrupted and then continued. Except for the last fragment, a fragment is not shorter than 5 MiB and not longer than 32 MiB. Such a fragment is briefly assembled in process memory and is sent as one part of a multipart upload. The identifier of that upload is stored in `files` until the drop is published, and is then cleared. A repeated transmission of a file that has already been accepted is acknowledged without a new write.

4.3. When encryption is used, the bucket stores ciphertext. The server does not hold the key and does not decrypt the contents.

4.4. An encrypted drop is not served by the server as a single archive. The browser fetches ciphertext by file index, decrypts it, and, when several files are present, builds a ZIP.

4.5. In Chrome on Android, file transfer may continue after the page is closed, by means of Background Fetch. The requests are the same: `PUT` of a file with the header `X-Upload-Secret`, then the publication `POST`. If the tab is already closed, the page's service worker performs publication. This method adds no new data categories.

## 5. IP address, logs, and HTTP headers

5.1. The IP address is used only as the key of a rate counter in process memory and is not written to the database. The address is taken from the request. The header `X-Forwarded-For` is honoured only when the connection arrived from the loopback interface. The counters cease to exist when the process restarts.

5.2. The following limits apply: 30 new drops per hour; 30 pairing codes per hour; 20 incorrect codes per 15 minutes (a correct code is not included in that counter); 20 incorrect passwords per 15 minutes; 300 code-status polls per minute. The same poll limit applies to a request that deletes a code.

5.3. The application log contains processing errors, the drop UUID when a deletion fails, and the number of deleted drops. File bodies, passwords, tokens, and keys are not written to the log. A connection abort by the client is not logged.

5.4. The link token is part of the page path and of the download API path. The access key is part of the `key` query parameter of those requests. The database stores only their SHA-256 values. If an access log of the web server in front of the application is enabled, the path, the `key` parameter, and with them the token, the access key, and the IP address may appear in that log until it is rotated. Such a log is a record of the deployment, not a table of the application.

5.5. Responses are sent with the header `Referrer-Policy: no-referrer`, so that the browser does not attach the drop URL to requests to other sites. The following are also set: a prohibition on embedding in another page; `nosniff`; a camera policy limited to the Service origin; a prohibition on geolocation, microphone, and interest-cohort. When HTTPS is used, `Strict-Transport-Security` is added with a lifetime of one year. Responses that contain a download are marked `Cache-Control: private, no-store`. A thumbnail of an unencrypted drop uses `private, max-age=3600`.

## 6. Data processed only in the browser

6.1. `localStorage`, key `vd-theme`: the selected appearance, `dark`, `light`, or `simple`.

6.2. `localStorage`, key `vd-consent`: the value `accepted` or `declined`. It is not sent to the server. The installed application does not request that record. While the browser holds `declined`, the send, receive, download, and QR-transfer pages do not open.

6.3. `IndexedDB`, database `vd-uploads`, store `drops`: the identifier of an unfinished drop; the upload secret in the clear; the lifetime; the download limit; the flags "password is set" and "send to computer" (the password itself is not recorded); the master key of a link drop; and, for each file, the identifier, the real name, the original size, `lastModified`, and the number of bytes already sent. File contents are not stored. On a send-to-computer transfer the key is not placed in that database: it remains on the receive page. After publication the record is not erased at once. For up to 7 hours it retains the identifier, the upload secret, the link token, the master key of a link drop, the lifetime, the limit, and the file names, so that the link can be shown again and so that the drop can be deleted early. The password is still not recorded. The record is also deleted when the person declines to continue an unfinished upload or deletes the link. On the next opening of the upload page, records older than 7 hours are erased. On the server an unfinished drop exists for 6 hours.

6.4. `sessionStorage`, key `vd-pairing`: the code, the receive-page secret, and the master key generated by the computer for the phone. The record exists while the receive page is open. Leaving the page and retrieving the finished link erase it. At the same time a request to delete the code row is sent to the server.

6.5. OPFS, directory `vqd/<file identifier>`: segments and the assembled file `data.bin` of one unfinished QR transfer. Those data are the plaintext bytes of the file. The data do not leave the device. A new transfer deletes the previous unfinished one.

6.6. `Cache Storage` of the application service worker: caches `vd-assets-<build>` and `vd-shell-<build>` hold the shell and static files. The shell includes the last HTML document that was opened successfully, under the key `/__shell`, without the drop URL. API responses and drop files are not cached. The cache `vd-share` temporarily stores the bytes of files passed through the system Share menu, together with the name, the type, and the modification date. A new share replaces the previous one. The upload page receives the files and deletes those records immediately. If the page was not opened, the files remain in the site cache until that cache is cleared.

6.7. The camera is requested only on the QR receive page. Frames are processed on the device and are not sent to the server. Copying the link, and the system Share action, at the person's choice transmit the page URL and, for an encrypted drop, the key after `#`, to the clipboard or to the selected application. The server does not take part in those actions.

6.8. OPFS, directory `vd-bg/<drop identifier>`: ciphertext prepared for background upload in Chrome on Android. The directory is deleted after the drop is published. If the upload did not start, the directory is deleted when the page switches to an ordinary upload in the open tab.

## 7. QR transfer without a network

7.1. The server does not take part in QR transfer.

7.2. One file of at most 256 MiB is transferred.

7.3. Frames contain file fragments without encryption. The manifest contains the name (at most 255 bytes of UTF-8), the MIME type, the size, and the SHA-256 of each segment. Any camera that observes the display obtains the same data.

7.4. The received file remains on the recipient's device until it is saved or deleted.

## 8. Deletion periods

8.1. An unfinished drop receives an expiry of 6 hours at the moment of creation. It has no token. After publication the lifetime is replaced by the 1, 3, 7, or 30 days selected by the sender, and the state becomes `ready`.

8.2. A ready drop exists for 1, 3, 7, or 30 days. The period is determined by the sender. The sender may delete it earlier, as specified in clause 8.7.

8.3. A drop whose lifetime has expired, or whose download limit is exhausted, is not deleted immediately if a download request has already occurred: a 24-hour period from that request is observed, so that an interrupted download can be continued. If there have been no downloads, those 24 hours do not delay deletion.

8.4. A background job runs at process start and then every 10 minutes. In one pass it deletes at most 500 drops: objects in the bucket, unfinished multipart uploads, and database rows. Expired pairing codes are deleted in the same pass without that limit, together with the plaintext token if it is still in the row.

8.5. A pairing code with no attached phone exists for 10 minutes. After attachment it exists while the upload proceeds, and for at most 6 hours. The plaintext token after readiness exists for at most 15 minutes, or until the computer retrieves it. One code is bound to one drop.

8.6. The download access key is valid for 24 hours. The database stores the session hash, not the key itself. That row is deleted together with the drop.

8.7. The sender may delete a drop immediately by sending the upload secret in the header `X-Upload-Secret` to `DELETE /api/drops/<identifier>`. The server compares the SHA-256 of the secret and, on a match, deletes the bucket objects, the unfinished multipart upload, and the drop row. The 24-hour period of clause 8.3 does not apply to that deletion. If storage does not confirm deletion of an object, the row remains and the request may be repeated. The control is available on the page after sending and on a later opening, while the record of clause 6.3 is still stored in the browser.

## 9. Recipients of data

9.1. A separate user profile is not formed. Transmission of such a profile to third parties therefore does not occur.

9.2. A drop record is processed by the application process, by PostgreSQL, and by the bucket of the instance on which the Service is deployed. The operational tables do not provide for other recipients.

9.3. The bucket provider sees objects in the form in which they were written: for an encrypted drop, ciphertext and a key of the form `drops/<uuid>/<uuid>`.
