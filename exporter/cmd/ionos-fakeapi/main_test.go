package main

import (
	"bytes"
	"context"
	"net"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"
)

type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}
func (s *syncBuffer) String() string { s.mu.Lock(); defer s.mu.Unlock(); return s.b.String() }

func TestServesTheDemo(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	ln.Close()
	var log syncBuffer
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan int, 1)
	go func() { done <- run(ctx, []string{"--listen", addr, "--token", "t0k"}, &log) }()
	get := func(token string) int {
		req, _ := http.NewRequest("GET", "http://"+addr+"/api.ionos.com/cloudapi/v6/datacenters?depth=1", nil)
		req.Header.Set("Authorization", "Bearer "+token)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			return 0
		}
		resp.Body.Close()
		return resp.StatusCode
	}
	for deadline := time.Now().Add(10 * time.Second); get("t0k") == 0 && time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
	}
	if code := get("t0k"); code != http.StatusOK {
		t.Errorf("right token: %d", code)
	}
	if code := get("wrong"); code != http.StatusUnauthorized {
		t.Errorf("wrong token: %d", code)
	}
	cancel()
	if code := <-done; code != 0 || !strings.Contains(log.String(), "stopped after") {
		t.Errorf("exit %d: %s", code, log.String())
	}
}
