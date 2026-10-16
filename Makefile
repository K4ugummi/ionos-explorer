.PHONY: test fixture exporter explorer-app explorer-dev explorer-build

test:
	cd exporter && go vet ./... && go test ./...
	cd explorer && npm run lint && npm test && npm run build

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

explorer-dev:
	cd explorer && npm run dev

explorer-build:
	cd explorer && npm run build
