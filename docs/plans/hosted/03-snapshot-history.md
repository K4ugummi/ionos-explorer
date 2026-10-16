# 03 Snapshot history

**Problem.** In hosted mode every fetch is lost when the user leaves, so the
Changes tab can only compare two fetches in one sitting. The user chose a
volume with history: snapshots kept, encrypted, with retention.

## Design

- **Where:** `DATA_DIR` (default `/data` in hosted mode; empty disables
  history). Layout:
  `DATA_DIR/v1/<scope>/<contract>/<UTC timestamp>-<8 random hex>.ionx.age`
  where `<scope>` is `u-<sha256(iss + "\n" + sub)[:32]>` (private, default)
  or `shared` (`IONOS_EXPLORER_HISTORY=shared`). No names or emails in
  paths. Contract numbers are only digits (validated), so they are safe as
  folder names. All access goes through a small `Store` interface (put,
  list, get, delete) so an object-storage backend can follow (07).
- **Encryption:** every file is age-encrypted to the recipient derived from
  `AGE_IDENTITY` (X25519, from a Secret; the program can print a new one
  with `ionos-explorer keygen`). Written via temp file + fsync + rename in
  the same folder, mode 0600, folders 0700. Key rotation: several
  identities may be given (one per line); new files use the first, reading
  tries all; `ionos-explorer rekey` re-encrypts old files to the first.
- **When:** after each successful fetch the server stores the result (the
  same bytes the user receives) before handing it out. Failed and
  cancelled fetches are not stored. A fetch with partial errors is stored
  and marked (the manifest already lists errors).
- **API:** `GET /api/history?contract=` (list: id, time, size, counts from
  the manifest, partial flag), `GET /api/history/<id>` (the snapshot
  bytes, decrypted on the server: the browser never holds the age key),
  `DELETE /api/history/<id>`. Only the caller's scope (private) or the
  shared scope. IDs are the file names, validated by pattern; no paths
  from the client are ever joined.
- **Retention:** grandfather-father-son per scope and contract,
  `KEEP=daily=14,weekly=8,monthly=12` (default): the newest snapshot of
  each of the last 14 days, 8 weeks, 12 months; the newest 3 are always
  kept. Applied after each store and once an hour. Quota `MAX_USER_BYTES`
  per scope (default 500 MB): when exceeded, the oldest beyond the
  "newest 3" go first; if still exceeded the store is refused with a
  message, the fetch result is still handed out.
- **UI:**
  - The open screen (hosted) lists the history of the user's contracts:
    "Open latest" and the list.
  - The Changes tab gets a "Compare with…" picker over the history of the
    loaded contract (besides "open a file"), defaulting to the newest older
    snapshot; the automatic "previous fetch in this sitting" (merged-app)
    becomes "previous snapshot in the history".
  - Delete per snapshot (with confirm in the app, not a browser dialog).
  - Download stays (plain or encrypted with the user's own passphrase,
    independent of the server key).
- **Shared mode** (option, not default): all logged-in users share one
  history per contract. The UI says "shared with everyone who can log in"
  next to the fetch button. Deleting needs the user who stored it or an
  admin group (`OIDC_ADMIN_GROUPS`).

## Tests

- Store/list/read/delete round trip with a temp dir; files are age
  ciphertext (header check), 0600/0700; atomic write (no partial file
  visible after a simulated crash between write and rename).
- Scope isolation: user B cannot list, read or delete user A's snapshots
  (403/404, not 500), also with crafted IDs (`../`, absolute paths, other
  scope's IDs, URL-encoded variants).
- Retention: a year of synthetic timestamps → exactly the expected
  survivors; quota eviction order; refusal when the newest 3 exceed it.
- Key rotation: files under the old key readable with both keys
  configured; `rekey` result readable with the new key alone.
- Start-up: hosted with `DATA_DIR` but no identity → refuses; unreadable
  identity → refuses; `DATA_DIR` not writable → refuses with the path.
- UI: history picker sorting, default base selection, shared-mode label.

## Accept

- Browser (fake API, Dex): fetch, restart the container, log in again,
  "Open latest" shows the same data, a second fetch shows changes against
  the stored one; a second user sees an empty history (private mode).
- `ls -R` of the volume shows only hashed scopes, contract numbers and
  timestamps; `head -c 30` of a file shows the age header.
