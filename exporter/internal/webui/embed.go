//go:build embedui

package webui

import (
	"embed"
	"io/fs"
)

//go:embed all:dist
var dist embed.FS

func embedded() fs.FS {
	ui, err := fs.Sub(dist, "dist")
	if err != nil {
		panic(err) // cannot happen: dist is embedded
	}
	return ui
}
