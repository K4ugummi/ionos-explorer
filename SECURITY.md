# Security

## Reporting a vulnerability

Please report it privately through GitHub: the repository's **Security**
tab, **Report a vulnerability**. Do not open a public issue, and do not
attach a real snapshot (`.ionx`), token, log or screenshot of a real
contract: describe the problem with the demo contract
(`fixtures/demo-contract.ionx`, or the fake API in
[deploy/](deploy/README.md)) wherever you can.

Reports are answered as soon as possible. Fixes go into the next release;
only the latest release is supported.

## What the program can access

- **The IONOS API, read-only.** Only Go code talks to the API, with a
  client that sends GET requests and nothing else, with the token the user
  typed in (or `ionos-export` was given). It changes nothing in the
  contract. Use a token of a user that may read but not change, where you
  can.
- **The token** stays in the server's memory: never on disk, never in a
  log, never in an answer to the browser. It is dropped on Forget, at
  logout or exit, after `--forget-after` unused, or right after the fetch
  if the user chose so.
- **Fetched data** (IP addresses, firewall rules, names) stays in the
  server's memory, per session, until the user downloads it. The browser
  talks to nothing but the server it came from.
- **On disk**, in hosted mode only: the user accounts in the data
  directory (password hashes with argon2id, no passwords; second-factor
  secrets age-encrypted, recovery codes hashed), and, if the
  operator gave it an age identity, each user's snapshot history,
  age-encrypted to that identity, readable only by its owner through the
  server.
- **Nothing else**: no telemetry, no update checks, no other hosts.

How each of these is enforced, and tested: [docs/ARCHITECTURE.md,
"Security notes"](docs/ARCHITECTURE.md#security-notes).

## Verifying a release

Releases are built by the `release` workflow from the tag, and signed
with [cosign](https://docs.sigstore.dev/) without a key: the signature
names the workflow and the tag. For version `1.2.3`:

```sh
id=https://github.com/K4ugummi/ionos-explorer/.github/workflows/release.yaml@refs/tags/v1.2.3
issuer=https://token.actions.githubusercontent.com

# The image
cosign verify --certificate-identity "$id" --certificate-oidc-issuer "$issuer" \
  ghcr.io/k4ugummi/ionos-explorer:1.2.3

# The binaries: the signed checksums, then the archive you downloaded
cosign verify-blob --bundle SHA256SUMS.sigstore.json \
  --certificate-identity "$id" --certificate-oidc-issuer "$issuer" SHA256SUMS
sha256sum --ignore-missing -c SHA256SUMS
```

The image's SBOM and build provenance:

```sh
docker buildx imagetools inspect ghcr.io/k4ugummi/ionos-explorer:1.2.3 --format '{{ json .SBOM }}'
docker buildx imagetools inspect ghcr.io/k4ugummi/ionos-explorer:1.2.3 --format '{{ json .Provenance }}'
```

Before a release the image is scanned (grype); a fixable vulnerability of
high or critical severity stops it.
