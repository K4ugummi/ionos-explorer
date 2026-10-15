
.PHONY: test fixture exporter explorer-dev explorer-build

test:
	cd exporter && go vet ./... && go test ./...
	cd explorer && npm run lint && npm test && npm run build

# Regenerate the synthetic demo snapshot (deterministic for a given seed).
fixture:
	cd exporter && go run ./cmd/ionos-fixture -o ../fixtures/demo-contract.ionx

exporter:
	cd exporter && go build -trimpath -o ../bin/ionos-export ./cmd/ionos-export

explorer-dev:
	cd explorer && npm run dev

explorer-build:
	cd explorer && npm run build
