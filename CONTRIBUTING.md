# Contributing

Bug reports, ideas and pull requests are welcome. A security problem goes
through [SECURITY.md](SECURITY.md) instead, not into a public issue.

## No real data, ever

Snapshots, tokens, logs and screenshots of a real contract hold IP
addresses, firewall rules, names and maybe credentials. Never put them in
an issue, a pull request, a test or a commit, not even in parts. Show the
problem with the synthetic demo contract instead:

- `fixtures/demo-contract.ionx` (open it in the explorer, or "Load demo
  snapshot");
- the fake IONOS API that serves it (token `demo-token`): the dev setups in
  [deploy/](deploy/README.md), or
  `go run ./cmd/ionos-fakeapi` in `exporter/` with
  `ionos-explorer --base-url http://127.0.0.1:8792`;
- a resource the generator lacks goes into `exporter/internal/fixture`
  (`make fixture` regenerates the demo files), made up.

CI refuses tracked `*.ionx`, `*.age`, `*.token` and `.env` files except the
demo fixtures, and scans the history for secrets (gitleaks).

## Working on it

Requirements, the quick start and how to run the UI with hot reload are
in the [README](README.md#development); the design and the reasons behind
it in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Before a pull request:

```sh
make test          # Go vet and tests, UI lint, tests and build
make test-race vuln check
```

CI runs these and more (the image, the deployment files, browser checks
with Compose and kind); see `.github/workflows/`.

An encrypted demo snapshot, to test opening `.ionx.age` files:

```sh
cd exporter
go run ./cmd/ionos-fixture -o /tmp/demo.ionx.age --recipient age1...
go run ./cmd/ionos-fixture -o /tmp/demo.ionx.age --passphrase-file pass.txt
```

Some rules the code follows:

- **Read-only against IONOS.** The HTTP client sends GET requests only. A
  feature that would change something in a contract does not belong here.
- **The browser talks to its own server only.** No CDNs, fonts, analytics
  or other hosts; the Content-Security-Policy enforces it.
- **No credentials or data where they do not belong**: not in logs, error
  messages, answers to the browser or files, unless the user downloads
  them. Each such rule has a test; a change keeps it.
- **Tests never call the real IONOS API.** Use `internal/fakeapi`.
- **Dependencies** must be AGPL-compatible, and few: say why one is
  needed. Third-party licences go into `NOTICE`.
- Write like the code around it: names, comments and the style of the
  messages the program shows.

## Licence

The project is licensed under the [AGPL-3.0-only](LICENSE). By opening a
pull request you agree that your contribution is licensed the same way.
