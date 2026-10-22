//go:build !unix

package users

import "os"

// Without flock (Windows) the file is not locked between processes: change
// users with the server stopped there. Hosted mode runs on Linux.
func lockFile(*os.File) error { return nil }

func unlockFile(*os.File) error { return nil }
