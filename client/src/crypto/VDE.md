# VDE1

Vetrimus Drop Encryption, version 1. The sender browser encrypts the drop. The server stores ciphertext and does not receive the key.

Russian edition: [VDE-RU.md](VDE-RU.md). Implementation: [`vde.js`](vde.js). Tests: `client/test/vde.test.js`. Command: `npm test` in `client/`.

## Master key

Each drop has one master key of 256 bits (`KEY_BYTES = 32`), drawn from a CSPRNG. The key is transported only in the URL fragment:

```
https://host/<token>#<key>
```

`<key>` is the base64url encoding of the 32 bytes, without `=` padding, and therefore has length 43. HTTP clients do not transmit the fragment. `keyToString` and `keyFromString` convert between the raw key and this encoding. An input that does not decode to exactly 32 bytes is rejected.

## Derived keys

Derivation uses HKDF-SHA-256 with an empty salt. The output is an AES-256-GCM key.

| Purpose | HKDF info |
| --- | --- |
| Metadata block | `vde1 meta` |
| File index `i`, zero-based | `vde1 file <i>` |

`i` is encoded as an unsigned 32-bit integer (`index >>> 0`). The file key is a function of the file index. Substitution of a ciphertext between positions fails authentication.

## Segments

Plaintext is partitioned into segments of length `SEG = 1 MiB` (`SEGMENT_SIZE`). The final segment may be shorter. An empty plaintext occupies one segment and therefore carries an authentication tag.

Each segment is encrypted with AES-256-GCM.

- Nonce, 12 bytes: four bytes `0x00`, followed by the segment index as a big-endian `uint64` in the remaining eight bytes. The implementation writes the index with `DataView.setUint32` at offset 8. Only the low 32 bits are set. The high 32 bits remain zero. Uniqueness holds because each file uses a distinct key.
- Additional authenticated data, 1 byte: `0x01` for the final segment of the stream, otherwise `0x00`.
- Ciphertext: plaintext concatenated with the 16-byte GCM tag.

Decryption fails for an incorrect key, a modified bit, a reordered segment, a duplicated segment, a deleted segment, an appended segment, or a ciphertext taken from another drop or another file index. Both the final-segment flag and the segment index change when the stream is altered.

```
ciphertextLength(n) = n + 16 * ceil(max(1, n) / SEG)
```

`plaintextLength` is the inverse. A ciphertext length that is an integer multiple of `1 MiB + 16` denotes a sequence of full segments. Any other remainder must have length at least 16, equal to the tag length. A shorter remainder is not a valid ciphertext length.

A full segment on the wire occupies `CIPHER_SEGMENT_SIZE = 1 MiB + 16` bytes.

## Metadata block

The metadata block is UTF-8 JSON, encrypted under the metadata key, and transmitted to the server as standard base64 (`bytesToBase64`).

```json
{ "v": 1, "files": [{ "name": "...", "type": "...", "size": 0, "thumb": "data:image/jpeg;base64,..." }] }
```

The member `thumb` is optional. The server stores the ciphertext in `drops.meta_ct` and does not parse it. The only file columns retained in the database are the placeholder names `file-N` and the ciphertext lengths.

## Server-visible fields

The server observes the file count, each ciphertext length, timestamps, the expiry, the download counter, and the presence of a password hash. The server does not observe names, media types, thumbnails, or plaintext bytes.

## Threat model

VDE1 provides confidentiality of contents and names with respect to the operator, the object store, and a party that obtains stored records. Confidentiality does not hold for a party that obtains the complete URL, because the key is contained in the URL. Confidentiality does not hold against a substituted web application that reads the key in the browser. Version 1 does not define a password-based key-derivation function. The drop password is solely a server-side lock on the listing.
