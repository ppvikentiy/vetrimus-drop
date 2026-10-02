# VQD format, version 1

VQD transfers one file from one display to one camera. The channel has no network path and no acknowledgement. The sender emits a repeating sequence of QR symbols. The receiver may begin at an arbitrary frame, may omit an arbitrary frame, and completes when a sufficient set of distinct symbols has been observed.

Text in this document is normative unless marked *informative*. The key words MUST, SHOULD, and MAY are to be interpreted as described in RFC 2119.

Status: draft, version 1. Reference implementation: `src/` in this directory. License: Apache-2.0.

Russian edition: [SPEC-RU.md](SPEC-RU.md).

## 1. Design

- The channel is one-way. Frames carry LT fountain symbols. No individual frame is required. Loss, duplication, reordering, and a delayed start increase only the transfer duration.
- The file is partitioned into **segments** of at most 4096 **blocks**. The default target is 2048 blocks. Each segment is encoded, decoded, and verified independently. A segment is accepted only when its SHA-256 equals the value in the manifest.
- Version 1 defines neither compression nor encryption. Bit 0 of the manifest flags is reserved for the condition "segments are gzip-compressed". Senders MUST write flags `0`. Receivers MUST reject every other value.
- Rendering of the QR symbol is outside the scope of this specification. A frame is an opaque byte string. The value 2953 is the capacity of QR version 40, error correction L, byte mode. A frame size is valid when the resulting block length lies in the closed interval from 16 to 65535 bytes.

Multi-byte integers are big-endian.

## 2. Frame header and trailer

Every frame begins with the same four bytes and ends with a CRC-16 computed over all preceding bytes.

| Offset | Size | Field |
| ---: | ---: | --- |
| 0 | 2 | Magic `0x56 0x51` (`VQ`) |
| 2 | 1 | Format version, value `1` |
| 3 | 1 | Type: `1` manifest, `2` data |

CRC-16/CCITT-FALSE: polynomial `0x1021`, initial value `0xFFFF`, no reflection, xor-out `0`. Check value: `crc16("123456789") = 0x29B1`.

### 2.1 Data frame

| Offset | Size | Field |
| ---: | ---: | --- |
| 4 | 6 | File identifier |
| 10 | 2 | Segment number |
| 12 | 4 | Symbol index (`uint32`) |
| 16 | `blockLen` | Symbol payload |
| 16 + `blockLen` | 2 | CRC-16 |

`blockLen = frameBytes - 18`. Every data frame of one stream MUST use the `blockLen` recorded in the manifest.

### 2.2 Manifest frame

| Offset | Size | Field |
| ---: | ---: | --- |
| 4 | 6 | File identifier |
| 10 | 1 | Part number, origin 0 |
| 11 | 1 | Part count, range 1..255, with `part < parts` |
| 12 | `n` | Slice of the manifest body |
| 12 + `n` | 2 | CRC-16 |

The body is partitioned into slices of length `frameBytes - 14`. The final slice may be shorter.

### 2.3 Receiver classification

1. The input does not begin with `56 51`, or its length is less than 4 bytes: verdict **foreign**. The input is ignored. A camera observes every symbol in the field of view.
2. The version byte differs from the receiver version: verdict **unsupported-version**. The receiver reports that an application update is required.
3. The length is below the minimum for the type, or the CRC does not match: verdict **corrupt**. The input is discarded, equivalently to a failed read.
4. Otherwise the verdict is **ok**.

A receiver tracks exactly one file identifier at a time. After a manifest has been accepted, frames that carry a different file identifier are ignored.

## 3. Manifest body

| Size | Field |
| ---: | --- |
| 1 | Manifest version (`1`) |
| 1 | Flags (MUST be `0` in version 1) |
| 2 | `blockLen` |
| 2 | `K`: block count of the largest segment, range 1..4096 |
| 4 | `segmentCount` |
| 4 + 4 | `fileSize`, high word followed by low word |
| 1 | Degree-table length `L` |
| 2 · `L` | Degree table, each entry a `uint16` |
| 1 + `n` | File name, UTF-8, `n` ≤ 255 |
| 1 + `n` | Media type, UTF-8, `n` ≤ 255 |
| 32 · `segmentCount` | SHA-256 of the real bytes of each segment |

The **file identifier** is the first 6 bytes of `SHA-256(body)`. A receiver MUST reassemble the body, recompute the identifier, and discard the manifest when the values differ. This construction binds the name, the size, the segment hashes, and the degree table to the identifier carried by every frame.

Before a manifest is used to size a buffer, a receiver MUST reject it if any of the following conditions fails: `blockLen` ≥ 16; `1 ≤ K ≤ 4096`; `1 ≤ fileSize` and `fileSize` does not exceed the receiver limit (the reference limit is 256 MiB); `segmentCount = ceil(ceil(fileSize / blockLen) / K)`; flags equal `0`; the degree table is valid (section 4.3); both strings are valid UTF-8; the body terminates exactly after the hash list. A receiver MUST NOT interpret the file name as a filesystem path before sanitization.

The sender repeats the manifest during the stream (section 6). A receiver requires every part of one manifest before a data frame may be consumed.

### 3.1 Segmentation

`totalBlocks = ceil(fileSize / blockLen)`. The file is partitioned into blocks of `blockLen` bytes. The final block is zero-padded for coding only. The blocks form `segmentCount` consecutive segments. Let `base = floor(totalBlocks / segmentCount)` and `extra = totalBlocks mod segmentCount`. Segment `s` contains `base + 1` blocks when `s < extra`, and `base` blocks otherwise. Segment lengths differ by at most one block. Segment `s` begins at block `s · base + min(s, extra)`. The segment hash covers real file bytes. Padding of the final block is excluded from the hash.

A sender selects `segmentCount = ceil(totalBlocks / kMax)` and `K = ceil(totalBlocks / segmentCount)`. *Informative: any `segmentCount` that satisfies the validation rule above is acceptable.*

## 4. Symbols

### 4.1 Generator

Arithmetic is integer-only. Products wrap as `uint32` (`Math.imul`).

```
fmix32(h):  h ^= h >>> 16; h *= 0x85ebca6b; h ^= h >>> 13; h *= 0xc2b2ae35; h ^= h >>> 16
Rng(seed):  state = seed;  next(): state += 0x9e3779b9; return fmix32(state)
symbolSeed(id32, segment, index):
    h = fmix32(id32 ^ 0x5651445f)
    h = fmix32(h ^ ((segment + 1) * 0x9e3779b1))
    h = fmix32(h ^ ((index + 1) * 0x85ebca77))
```

`id32` is the first 4 bytes of the file identifier, interpreted as a big-endian `uint32`. Test vectors are given in section 8.

### 4.2 Symbol construction

Given a segment that contains `k` blocks (the size of that segment, not `K`), a table `T`, and a symbol `(segment, index)`:

```
rng    = Rng(symbolSeed(id32, segment, index))
r16    = rng.next() >>> 16
degree = min(k, 1 + smallest i such that r16 <= T[i])
set    = []
while |set| < degree:
    b = rng.next() mod k
    if b not in set: append b
```

The payload is the bitwise XOR of the blocks in `set`. Blocks beyond the real data are treated as zero. The decoder reconstructs `set` from `(segment, index)` alone. The frame therefore carries no neighbour list.

### 4.3 Degree table

`T` contains `L` entries, with `1 ≤ L ≤ K`. The sequence is non-decreasing, and `T[L - 1] = 0xFFFF`. `T[i]` is the largest 16-bit sample that still maps to degree `i + 1`. Receivers read the table and do not recompute it. The construction used by a sender is unconstrained, because the table is carried in the manifest and floating-point values do not enter the receiver.

*Informative. Reference sender:*

- For `K ≤ 64`: the binomial distribution `Binomial(K, 1/2)` conditioned on degree ≥ 1, `P(d) = C(K, d) / (2^K - 1)`.
- Otherwise: the robust soliton distribution (Luby, 2002) with `c = 0.05` and `δ = 0.01`, truncated at degree 128 and stored as 16-bit cumulative thresholds.

## 5. Decoding

*Informative, except the hash verification, which is normative.*

A segment is decodable from any set of symbols whose equations have full rank over GF(2). The result is a function of the set of indices. It is independent of arrival order and of duplicates. The reference decoder applies belief propagation as symbols arrive and completes the unresolved remainder by Gaussian elimination over GF(2). A structure-only pass, without payloads, determines whether a full decode is to be attempted.

After decoding, the receiver MUST compute SHA-256 over the real bytes and compare the digest with the manifest. On mismatch the receiver MUST discard all state held for that segment and restart collection of the segment. A symbol may carry a valid CRC and incorrect contents. Measured overhead for the reference table is approximately 1.01–1.04 times `K` on average for `K ≥ 200`. The 99th percentile is below 1.1 times `K` (`bench/overhead.js`).

## 6. Transmission schedule

*Informative. This section is not part of the wire format. Receivers MUST NOT depend on it.*

- The stream has no terminal frame. The reference sender emits the complete manifest first, then one manifest part after every 90 data frames.
- Data frames are emitted in laps. Lap 0 supplies each segment with `1.06·K + 2` fresh symbols. Subsequent laps supply `min(1, 0.06·2^(lap-1))·K + 2`, interleaving segments one symbol at a time. Symbol indices are not reused within a session. A random initial offset prevents a restarted sender from repeating indices already held by a resuming receiver.
- Sender memory retains only the segments inside the current window. The default window is 32 MiB.
- A repeated transmission of the same bytes yields the same manifest and the same file identifier. An interrupted receiver may therefore resume against a later session.

## 7. Security considerations

Version 1 provides integrity against corruption by means of per-segment SHA-256 and a manifest bound to the file identifier. The specification does not authenticate the display. A party that can present a QR stream can present an arbitrary file. Encryption is not defined. Observation of the display yields the file. Receivers MUST treat the file name and the media type as untrusted, MUST bound every allocation by the validated manifest, and MUST NOT execute a received file.

## 8. Test vectors

```
crc16("123456789")                         = 0x29B1
fmix32(0) = 0
fmix32(1)                                  = 1364076727
Rng(1)           -> 2527132011, 314344336, 2535364964, 2041432039
Rng(0xFFFFFFFF)  -> 920564995, 4230986166
symbolSeed(0x01020304, 0, 0)               = 1162425510
symbolSeed(0x01020304, 3, 100)             = 581488596
symbolSeed(0xDEADBEEF, 65535, 0xFFFFFFFF)  = 3022913814
```

Reference degree tables for `K = 1, 2, 8, 65, 100, 1037, 2048` are defined in `test/vectors.test.js`.

Symbol sets for `K = 2048` and `id32 = 0x01020304`:

- `(0, 0)` → `{1135, 1440}`
- `(0, 1)` → `{1540, 1242}`
- `(0, 2)` → `{1338, 1380}`
- `(7, 4000000000)` → `{1600, 1010, 589, 1308}`

For `K = 100` with the corresponding table and `id32 = 0xDEADBEEF`, the symbol `(3, 17)` maps to `{42, 8, 87, 65, 97, 46}`.

Complete stream of minimal size. The payload is the UTF-8 encoding of `Hello, Vetrimus QR Drop!`. The name is `hello.txt`. The media type is `text/plain`. `frameBytes = 64`. The file identifier is `2bb6387a8b7c`. `K = 1`. The stream contains one segment. `blockLen = 46`. The manifest comprises two parts. The first part is:

```
565101012bb6387a8b7c00020100002e000100000001000000000000001801ffff0968656c6c6f2e7478740a746578742f706c61696e627b56225eaabbf2f246
```

The data frame for symbol index `0xF6B7BBEC` (initial offset 7) is:

```
565101022bb6387a8b7c0000f6b7bbec48656c6c6f2c2056657472696d75732051522044726f7021000000000000000000000000000000000000000000000622
```
