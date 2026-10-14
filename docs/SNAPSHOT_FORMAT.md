# Snapshot format v1 (`.ionx`)

The contract between `ionos-export` and the explorer. Any change that an
older explorer cannot read bumps `formatVersion`.

## Container

- A **zip** archive. Entries are deflate-compressed, sorted by path, with a
  fixed timestamp (`createdAt`). The same API state always yields identical
  file *contents* (and checksums). The compressed archive bytes are only
  stable for a given exporter build, since deflate output can change between
  Go releases. Compare snapshots by content, not by archive hash.
- `manifest.json` is the first entry.
- Optionally wrapped in **age** encryption (X25519 recipients or a
  passphrase). Encrypted files conventionally end in `.ionx.age` and start
  with the line `age-encryption.org/v1`; readers detect this instead of
  relying on the extension.

```
manifest.json
raw/<apiId>/<request path>.json
```

Examples:

```
raw/cloudapi-v6/datacenters.json
raw/cloudapi-v6/datacenters/<datacenterId>/servers.json
raw/cloudapi-v6/datacenters/<datacenterId>/lans.json
raw/cloudapi-v6/pccs.json
raw/cloudapi-v6/k8s/<clusterId>/nodepools.json
raw/postgresql-v1/clusters.json
```

`<apiId>` comes from `manifest.apis[].id`. Regional product APIs (e.g. MariaDB,
Kafka, In-Memory DB) get one ID per region, e.g. `mariadb-v1-de-txl`.

## Raw files

Each file is the API's JSON response **as returned**, with two changes:

1. **Paginated collections are merged**: all pages' `items` concatenated,
   `offset` 0, `limit` = items fetched, `_links` empty.
2. **Canonical serialization**: object keys sorted, 2-space indent, numbers
   kept verbatim, no HTML escaping.

Nothing is renamed, dropped or interpreted.

## Manifest

Validated by [`schema/manifest.schema.json`](../schema/manifest.schema.json).

| Field | Meaning |
|---|---|
| `formatVersion` | `1` |
| `createdAt` | export time (UTC, RFC 3339) |
| `generator` | `{name: "ionos-export" \| "ionos-fixture", version}` |
| `synthetic` | `true` for generated demo data. The explorer shows a banner. |
| `contract` | `{number, owner}` from `/contracts` |
| `apis[]` | `{id, name, version, baseUrl, region?}` |
| `coverage[]` | one entry per collection request (below) |
| `files[]` | `{path, size, sha256}` for every `raw/` file; readers must verify |

### Coverage

Lets consumers distinguish *"there are no X"* from *"we could not see X"*.

| Field | Meaning |
|---|---|
| `api` | API id |
| `endpoint` | path template, e.g. `/datacenters/{datacenterId}/servers` |
| `path`, `query` | the concrete request, e.g. `depth=4` |
| `status` | `ok`, `forbidden` (401/403), `not_found`, `error`, `skipped` |
| `httpStatus` | last HTTP status |
| `file` | raw file (only for `ok`) |
| `items`, `pages` | item count and number of pages fetched |
| `error` | API error message (never contains credentials) |

## Fetch plan (Cloud API v6)

The explorer relies on these paths and depths:

| Path | Query | Contains |
|---|---|---|
| `/contracts` | | contract number, resource limits |
| `/datacenters` | `depth=1` | datacenter properties |
| `/datacenters/{id}/servers` | `depth=4` | servers + attached volumes, CD-ROMs, NICs, firewall rules, flow logs |
| `/datacenters/{id}/volumes` | `depth=1` | all volumes incl. unattached |
| `/datacenters/{id}/lans` | `depth=1` | LANs incl. `pcc` and `ipFailover` |
| `/datacenters/{id}/natgateways` | `depth=3` | + rules, flow logs |
| `/datacenters/{id}/networkloadbalancers` | `depth=3` | + forwarding rules |
| `/datacenters/{id}/applicationloadbalancers` | `depth=3` | + forwarding rules |
| `/pccs` | `depth=1` | Cross Connects with `peers` (LAN id + datacenter) |
| `/ipblocks` | `depth=1` | reserved IPs with `ipConsumers` |
| `/targetgroups` | `depth=1` | ALB target groups |
| `/templates` | `depth=1` | Cube templates (resolves `templateUuid`) |
| `/images` | `depth=1` | public and private images (resolves volume `image`; private image names reveal appliances) |
| `/k8s`, `/k8s/{id}/nodepools` | `depth=1` | clusters, node pools (`datacenterId`, `lans`) |
| `/labels` | `depth=1` | labels of all resources |
| `/um/users`, `/um/groups` | `depth=1` | usually `forbidden` for read-only users |

DBaaS PostgreSQL: `/clusters` (`connections[].datacenterId/lanId`).

## Key cross-references

- NIC `properties.lan` (integer) → LAN `id` (numeric string) in the same datacenter
- LAN `properties.pcc` → `/pccs` item `id`; PCC `peers[]` → `{datacenterId, id: lanId}`
- Server `properties.templateUuid` → `/templates` item (Cubes)
- Volume `properties.image` → `/images` item (same location)
- NLB/ALB `listenerLan` / `targetLan` → LAN id; ALB `httpRules[].targetGroup` → `/targetgroups`
- Node pool `datacenterId` + `lans[].id`; Postgres `connections[]`
- IP block `ipConsumers[]` → `datacenterId`, `serverId`, `nicId`
