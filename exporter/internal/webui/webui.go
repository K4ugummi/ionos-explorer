// Package webui is the explorer UI that ionos-explorer serves.
//
// Built with the tag embedui (make explorer-app), it is the production build
// of explorer/ copied into dist/ and embedded. Without the tag (go build,
// go test, go vet) it is a single placeholder page, so the Go code builds and
// tests without Node or a UI build, and no tracked file is overwritten by one.
package webui

import (
	"io/fs"
	"testing/fstest"
)

// FS returns the UI files, index.html at the root, and whether this is the
// real UI rather than the placeholder.
func FS() (fs.FS, bool) {
	if ui := embedded(); ui != nil {
		return ui, true
	}
	return fstest.MapFS{"index.html": {Data: []byte(placeholder)}}, false
}

const placeholder = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>IONOS Explorer</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 40em; margin: 4em auto; padding: 0 1em">
<h1>IONOS Explorer</h1>
<p>This ionos-explorer was built without the user interface. Build it with
<code>make explorer-app</code> (or <code>go build -tags embedui</code> after
copying the explorer's production build into <code>exporter/internal/webui/dist</code>).</p>
</body>
</html>
`
