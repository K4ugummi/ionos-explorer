package main

import (
	"context"
	"fmt"
	"os"
	"slices"
	"sort"
	"strings"

	"github.com/K4ugummi/ionos-explorer/exporter/internal/oidc"
	"github.com/K4ugummi/ionos-explorer/exporter/internal/server"
)

// oidcPrefix starts the environment variables of the OIDC providers:
// IONOS_EXPLORER_OIDC_<ID>_<SETTING>, the ID in capitals and - as _.
const oidcPrefix = envPrefix + "OIDC_"

// oidcSettings are the settings of a provider (each also as _FILE).
var oidcSettings = []string{"ISSUER", "CLIENT_ID", "CLIENT_SECRET", "NAME", "SCOPES", "GROUPS_CLAIM", "ALLOWED_GROUPS", "ALLOWED_EMAILS", "ADMIN_GROUPS"}

// newAuth makes the login providers of hosted mode besides local users:
// the OIDC providers in list (--oidc-providers), each set up from its
// environment variables and fetching its discovery document until ctx
// ends. Tests put in a fake.
var newAuth = oidcProviders

func oidcProviders(ctx context.Context, list, publicURL string, logger *server.Logger) ([]server.Authenticator, error) {
	var ids []string
	for _, id := range strings.Split(list, ",") {
		if id = strings.TrimSpace(id); id == "" {
			continue
		}
		if slices.Contains(ids, id) {
			return nil, fmt.Errorf("--oidc-providers: %s twice", id)
		}
		ids = append(ids, id)
	}
	if err := unknownOIDCSettings(ids); err != nil {
		return nil, err
	}
	var auth []server.Authenticator
	for _, id := range ids {
		cfg, err := oidcConfig(id)
		if err != nil {
			return nil, err
		}
		p, err := oidc.New(cfg, oidc.Options{PublicURL: publicURL, Log: logger})
		if err != nil {
			return nil, err
		}
		p.Start(ctx)
		auth = append(auth, p)
	}
	return auth, nil
}

func oidcEnvName(id, setting string) string {
	return oidcPrefix + strings.ToUpper(strings.ReplaceAll(id, "-", "_")) + "_" + setting
}

// oidcConfig reads one provider's settings.
func oidcConfig(id string) (oidc.Config, error) {
	cfg := oidc.Config{ID: id}
	var err error
	get := func(setting string) string {
		if err != nil {
			return ""
		}
		var v string
		v, err = envOrFile(oidcEnvName(id, setting))
		return v
	}
	list := func(setting string) []string {
		return strings.FieldsFunc(get(setting), func(r rune) bool { return r == ',' || r == ' ' || r == '\n' })
	}
	cfg.Issuer, cfg.ClientID, cfg.ClientSecret = get("ISSUER"), get("CLIENT_ID"), get("CLIENT_SECRET")
	cfg.Name, cfg.GroupsClaim = get("NAME"), get("GROUPS_CLAIM")
	cfg.Scopes, cfg.AllowedEmails = list("SCOPES"), list("ALLOWED_EMAILS")
	// Group names may hold spaces (Entra ID display names, Keycloak paths):
	// commas only.
	groups := func(setting string) []string {
		var out []string
		for _, v := range strings.Split(get(setting), ",") {
			if v = strings.TrimSpace(v); v != "" {
				out = append(out, v)
			}
		}
		return out
	}
	cfg.AllowedGroups, cfg.AdminGroups = groups("ALLOWED_GROUPS"), groups("ADMIN_GROUPS")
	if err != nil {
		return cfg, err
	}
	if cfg.Issuer == "" || cfg.ClientID == "" || cfg.ClientSecret == "" {
		return cfg, fmt.Errorf("OIDC provider %s needs %s, %s and %s (or %s_FILE)", id,
			oidcEnvName(id, "ISSUER"), oidcEnvName(id, "CLIENT_ID"), oidcEnvName(id, "CLIENT_SECRET"), oidcEnvName(id, "CLIENT_SECRET"))
	}
	return cfg, nil
}

// envOrFile reads a variable, or the file its _FILE variable names.
func envOrFile(name string) (string, error) {
	v, ok := os.LookupEnv(name)
	file, fromFile := os.LookupEnv(name + "_FILE")
	switch {
	case ok && fromFile:
		return "", fmt.Errorf("%s and %s_FILE are both set; use one", name, name)
	case !fromFile:
		return strings.TrimSpace(v), nil
	}
	data, err := os.ReadFile(file)
	if err != nil {
		return "", fmt.Errorf("%s_FILE: %v", name, err)
	}
	defer clear(data)
	return strings.TrimSpace(string(data)), nil
}

// unknownOIDCSettings refuses OIDC variables of no listed provider or with
// no known setting: a typo would otherwise go unnoticed (a provider
// without its allow list, say).
func unknownOIDCSettings(ids []string) error {
	known := map[string]bool{oidcPrefix + "PROVIDERS": true, oidcPrefix + "PROVIDERS_FILE": true}
	for _, id := range ids {
		for _, s := range oidcSettings {
			known[oidcEnvName(id, s)] = true
			known[oidcEnvName(id, s)+"_FILE"] = true
		}
	}
	var unknown []string
	for _, kv := range os.Environ() {
		name, _, _ := strings.Cut(kv, "=")
		if strings.HasPrefix(name, oidcPrefix) && !known[name] {
			unknown = append(unknown, name)
		}
	}
	if len(unknown) == 0 {
		return nil
	}
	sort.Strings(unknown)
	return fmt.Errorf("%s: not a setting of a provider in --oidc-providers (%q); the settings are %s_<ID>_%s",
		strings.Join(unknown, ", "), strings.Join(ids, ","), strings.TrimSuffix(oidcPrefix, "_"), strings.Join(oidcSettings, ", "))
}
