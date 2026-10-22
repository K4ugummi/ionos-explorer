package server

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"time"
)

// Logger writes the program's log lines: "15:04:05 text" for a terminal,
// or one JSON object per line (time, level, msg and attributes) for a log
// collector. Never a secret: no token, cookie, session key, password or
// login code (tests look for them); the setup link is the one exception,
// as the way to create the first admin.
type Logger struct {
	w    io.Writer
	json *slog.Logger
}

// NewLogger writes to w, as JSON objects if json.
func NewLogger(w io.Writer, json bool) *Logger {
	if w == nil {
		w = io.Discard
	}
	l := &Logger{w: w}
	if json {
		l.json = slog.New(slog.NewJSONHandler(w, nil))
	}
	return l
}

// Print logs an event.
func (l *Logger) Print(msg string) { l.log(slog.LevelInfo, msg) }

// Error logs a failure the operator has to look at.
func (l *Logger) Error(msg string) { l.log(slog.LevelError, msg) }

// Session logs an event of a hosted session (its log ID and user subject).
func (l *Logger) Session(id, user, msg string) {
	if l.json == nil {
		l.text("[" + id + " " + printable(user) + "] " + msg)
		return
	}
	l.json.LogAttrs(context.Background(), slog.LevelInfo, msg, slog.String("session", id), slog.String("user", user))
}

// Link logs a message and the link it is about, set apart in text.
func (l *Logger) Link(msg, link string) {
	if l.json == nil {
		l.text(msg + ":\n\n  " + link + "\n")
		return
	}
	l.json.LogAttrs(context.Background(), slog.LevelInfo, msg, slog.String("link", link))
}

func (l *Logger) log(level slog.Level, msg string) {
	if l.json == nil {
		l.text(msg)
		return
	}
	l.json.LogAttrs(context.Background(), level, msg)
}

func (l *Logger) text(msg string) {
	fmt.Fprintln(l.w, time.Now().Format("15:04:05")+" "+msg)
}
