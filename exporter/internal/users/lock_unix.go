//go:build unix

package users

import (
	"os"
	"syscall"
)

// lockFile takes an exclusive lock on f, waiting for it: the server and the
// users command may change the file at the same time.
func lockFile(f *os.File) error { return syscall.Flock(int(f.Fd()), syscall.LOCK_EX) }

func unlockFile(f *os.File) error { return syscall.Flock(int(f.Fd()), syscall.LOCK_UN) }
