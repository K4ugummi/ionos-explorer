.PHONY: test test-race check vuln lint-actions fixture exporter explorer-app image smoke e2e-compose e2e-kind release explorer-dev explorer-build common-passwords

test:
	cd exporter && go vet ./... && go test ./...
	cd explorer && npm run lint && npm test && npm run build

# What CI runs besides test (.github/workflows): the race detector; no
# snapshots or credentials tracked, the deployment files valid; known
# vulnerabilities in Go modules and the npm packages shipped; the workflows.
# Tools are pinned and run with go run, so local runs match CI.
GO_TOOLCHAIN = $(shell cd exporter && go env GOVERSION)
test-race:
	cd exporter && go test -race ./...

check:
	scripts/check-repo.sh
	scripts/check-deploy.sh

vuln:
	cd exporter && GOTOOLCHAIN=$(GO_TOOLCHAIN) go run golang.org/x/vuln/cmd/govulncheck@v1.9.0 ./...
	cd explorer && npm audit --omit=dev --audit-level=high

lint-actions:
	cd exporter && go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.12 -color ../.github/workflows/*.yaml

# Regenerate the synthetic demo snapshot (deterministic for a given seed).
fixture:
	cd exporter && go run ./cmd/ionos-fixture -o ../fixtures/demo-contract.ionx --annotations ../fixtures/demo-annotations.json
	cd exporter && go run ./cmd/ionos-fixture -previous -o ../fixtures/demo-contract-previous.ionx

exporter:
	cd exporter && go build -trimpath -o ../bin/ionos-export ./cmd/ionos-export

# The single binary: the explorer's production build embedded (build tag
# embedui) in ionos-explorer, which serves it and fetches from IONOS itself.
explorer-app:
	cd explorer && npm run build
	rm -rf exporter/internal/webui/dist
	cp -R explorer/dist exporter/internal/webui/dist
	cd exporter && go build -trimpath -tags embedui -o ../bin/ionos-explorer ./cmd/ionos-explorer

# The container image (Dockerfile): hosted mode, non-root, distroless.
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
image:
	docker build --build-arg VERSION=$(VERSION) -t ionos-explorer:$(VERSION) -t ionos-explorer .

# The image run hardened, with probes, users command and a clean stop.
smoke:
	scripts/smoke-image.sh ionos-explorer

# Browser checks of deploy/ with the fake IONOS API (cd e2e && npm ci first,
# and npx playwright install chromium).
e2e-compose:
	e2e/compose.sh

e2e-kind:
	e2e/kind.sh

# Release archives and SHA256SUMS in dist/ (the release workflow does this
# for a tag v*).
release:
	scripts/build-release.sh $(VERSION)

# The common passwords local users may not choose: those of 12 characters or
# more (shorter ones fail the length rule anyway) from SecLists (MIT).
SECLISTS = https://raw.githubusercontent.com/danielmiessler/SecLists/master/Passwords/Common-Credentials
common-passwords:
	curl -fsSL $(SECLISTS)/xato-net-10-million-passwords-1000000.txt \
	  | tr -d '\r' | LC_ALL=C awk 'length($$0) >= 12 && length($$0) <= 256' | LC_ALL=C tr 'A-Z' 'a-z' | LC_ALL=C sort -u \
	  | gzip -9n > exporter/internal/users/common-passwords.txt.gz

explorer-dev:
	cd explorer && npm run dev

explorer-build:
	cd explorer && npm run build
