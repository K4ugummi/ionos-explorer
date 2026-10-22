# Snapshot format v1 (`.ionx`)

The contract between `ionos-export` (or `ionos-explorer`, which runs the
same crawl) and the explorer. Any change that an
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
raw/postgresql-v2-de-fra/clusters.json
```

`<apiId>` comes from `manifest.apis[].id`: `<family>-v<major>`, and
`-<region>` for regional product APIs (PostgreSQL, MariaDB, In-Memory DB,
Kafka, Network File Storage, VPN Gateway, Logging, Monitoring), which get
one ID per region, e.g. `postgresql-v2-de-txl`.

## Raw files

Each file is the API's JSON response **as returned**, with three changes:

1. **Paginated collections are merged**: all pages' `items` concatenated,
   `offset` 0, `limit` = items fetched, `_links` (MongoDB: `links`) empty,
   a page cursor (`pagination`) removed. Pages are requested by `offset`,
   or by `pagination.token` where an API returns one; the next link is
   never followed.
2. **Canonical serialization**: object keys sorted, 2-space indent, numbers
   kept verbatim, no HTML escaping.
3. **Secrets removed**: a non-empty string in a field named `password`,
   `imagePassword`, `preSharedKey`, `psk`, `privateKey`, `secret`,
   `secretKey`, `keySecret` or `userData` (any case), and `key` in the
   Logging and Monitoring pipelines, becomes `"[removed by ionos-export]"`. The APIs should not return these;
   this is a safety net. Should an API's error message echo the
   credentials, they become `[credentials removed]` in `coverage[].error`.

Nothing else is renamed, dropped or interpreted.

## Manifest

Validated by [`schema/manifest.schema.json`](../schema/manifest.schema.json).

| Field | Meaning |
|---|---|
| `formatVersion` | `1` |
| `createdAt` | export time (UTC, RFC 3339) |
| `generator` | `{name: "ionos-export" \| "ionos-explorer" \| "ionos-fixture", version}`; `ionos-explorer` runs the same crawl as `ionos-export` |
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
| `path`, `query` | the concrete request, e.g. `depth=5` |
| `status` | `ok`, `forbidden` (401/403), `not_found`, `error`, `skipped` (excluded with `--skip`, or its parent collection was not readable; `path` is then the template) |
| `httpStatus` | last HTTP status |
| `file` | raw file (only for `ok`) |
| `items`, `pages` | item count and number of pages fetched |
| `error` | API error message (never contains credentials) |

## Fetch plan (Cloud API v6)

The explorer relies on these paths and depths. The authoritative list is
`exporter/internal/endpoints` (`ionos-export --list`); a test keeps it and
the fixture in sync.

| Path | Query | Contains |
|---|---|---|
| `/contracts` | | contract number, resource limits |
| `/datacenters` | `depth=1` | datacenter properties |
| `/datacenters/{id}/servers` | `depth=5` | servers + attached volumes, CD-ROMs, NICs, firewall rules, flow logs, Security Groups (at `depth=4` firewall rules are only references) |
| `/datacenters/{id}/securitygroups` | `depth=3` | network Security Groups with `entities.rules` (same properties as firewall rules), `entities.servers`, `entities.nics` |
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

DBaaS PostgreSQL v2 (regional, `https://postgresql.<region>.ionos.com`, API id
`postgresql-v2-<region>`, all regions): `/clusters` (`connection.datacenterId/lanId/primaryInstanceAddress`,
`instances.count/cores/ram/storageSize` in GB, `metadata.dnsName`). The global
v1 API (`postgresql-v1`, `connections[]`, sizes in MB) was shut down on
2026-09-15; the explorer still reads older snapshots that contain it.

VPN Gateway (regional, `https://vpn.<region>.ionos.com`, API id
`vpn-v1-<region>`, all regions): `/ipsecgateways`,
`/ipsecgateways/{gatewayId}/tunnels`, `/wireguardgateways`,
`/wireguardgateways/{gatewayId}/peers` (`connections[].datacenterId/lanId`,
`gatewayIP`, tunnel `remoteHost` / peer `endpoint.host`).

Cloud API, also: `/backupunits` and `/snapshots` (volume snapshots), `depth=1`.

The other product APIs, each listed in every region it has (the servers of
its OpenAPI document); none takes `depth`:

| API id | Base URL | Collections |
|---|---|---|
| `dns-v1` | `https://dns.de-fra.ionos.com` | `/zones`, `/records` (all zones; `metadata.fqdn`, `metadata.zoneId`), `/secondaryzones`, `/reverserecords` |
| `mariadb-v2-<region>` | `https://mariadb.<region>.ionos.com/v2` | `/clusters` (`connection`, sizes in GB per instance) |
| `inmemorydb-v2-<region>` | `https://in-memory-db.<region>.ionos.com/v2` | `/clusters` (`connection`, `persistenceMode`) |
| `mongodb-v1` | `https://api.ionos.com/databases/mongodb` | `/clusters` (`connections[].cidrList`, `location`, sizes in MB; its lists say `links`, not `_links`) |
| `kafka-v1-<region>` | `https://kafka.<region>.ionos.com` | `/clusters`, `/clusters/{clusterId}/topics` (no paging). Never `/users/{id}/access`: it returns private keys |
| `nfs-v1-<region>` | `https://nfs.<region>.ionos.com` (no gb-bhx) | `/clusters` (`connections[].lan`, `metadata.status`), `/clusters/{clusterId}/shares` |
| `certmanager-v2` | `https://certificate-manager.de-fra.ionos.com` | `/certificates` (`metadata.notAfter`, `expired`, names), `/auto-certificates` |
| `cdn-v1` | `https://cdn.de-fra.ionos.com` | `/distributions` |
| `logging-v1-<region>`, `monitoring-v1-<region>` | `https://logging.<region>.ionos.com`, `https://monitoring.<region>.ionos.com` | `/pipelines` (their `key` is removed) |
| `containerregistry-v1` | `https://api.ionos.com/containerregistries` | `/registries` (paged by cursor, `pagination.token`), `/registries/{registryId}/repositories` |
| `autoscaling-v1` | `https://api.ionos.com/autoscaling` | `/groups`, `/groups/{groupId}/servers` (`depth=1`) |

Not read: Object Storage buckets (the S3 API needs access keys, not a
token), API Gateway (end of life), Data Platform.

## Key cross-references

- NIC `properties.lan` (integer) → LAN `id` (numeric string) in the same datacenter
- LAN `properties.pcc` → `/pccs` item `id`; PCC `peers[]` → `{datacenterId, id: lanId}`
- Server `properties.templateUuid` → `/templates` item (Cubes)
- Volume `properties.image` → `/images` item (same location)
- NLB/ALB `listenerLan` / `targetLan` → LAN id; ALB `httpRules[].targetGroup` → `/targetgroups`
- Node pool `datacenterId` + `lans[].id`; Postgres `connection` (v1: `connections[]`)
- IP block `ipConsumers[]` → `datacenterId`, `serverId`, `nicId`
- VPN tunnel `remoteHost` / WireGuard peer `endpoint.host` → a public IP in the contract (NIC, NAT, load balancer, VPN gateway `gatewayIP`), else outside
- MariaDB / In-Memory DB `connection`, MongoDB and Kafka `connections[]` (`lanId`), NFS `connections[]` (`lan`) → datacenter and LAN
- DNS record (A, AAAA) `content` and reverse record `ip` → any resource with that IP; CNAME/ALIAS/MX/NS/SRV `content` → records of that name, or a service's host (registry `hostname`, database `dnsName`, MongoDB `connectionString`, CDN `domain`)
- CDN `certificateId` and ALB forwarding rule `serverCertificates[]` → Certificate Manager `/certificates`; CDN `routingRules[].upstream.host` → an IP or DNS name as above
- Auto scaling group `datacenter.id` + `replicaConfiguration.nics[].lan` (integer); group server `datacenterServer.id` → server
