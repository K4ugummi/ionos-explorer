# 02 OIDC login

**Problem.** Hosted mode (01) needs to know who a user is and whether they
may use the explorer at all. The user chose built-in OpenID Connect: the
app talks to the company's IdP itself (Entra ID, Keycloak, Google,
Authentik, Dex, …), with no proxy in front.

## Design

- **Flow:** authorization code flow with PKCE (S256), confidential client
  (client secret), `state` and `nonce` per attempt, stored in a short-lived
  (10 min) HttpOnly cookie bound to the login attempt, not in the session.
  Routes: `GET /login` (redirect to the IdP), `GET /callback`,
  `POST /api/logout`. Redirect URI = `PUBLIC_URL + "/callback"`.
- **Verification:** discovery document from the issuer, JWKS with caching
  and key rotation; ID token signature (RS256/ES256/EdDSA as offered;
  never `none`, never HS* with the client secret unless explicitly
  configured), `iss`, `aud` (contains client ID; `azp` if several
  audiences), `exp`/`iat` with 2 min skew, `nonce`. The ID token is used
  once to establish the session and then discarded; access/refresh tokens
  of the IdP are not kept (the app calls no IdP API after login).
- **Library:** `github.com/coreos/go-oidc/v3` (Apache-2.0) and
  `golang.org/x/oauth2` (BSD-3-Clause): JWT and JWKS handling is exactly the
  kind of code not to write by hand. Both are AGPL-3.0-compatible; add them
  to `NOTICE`.
- **Who may log in:** anyone the IdP authenticates for this client, unless
  `OIDC_ALLOWED_GROUPS` (matched against the groups claim, default
  `groups`; Entra ID sends group object IDs, or use app roles via
  `OIDC_GROUPS_CLAIM=roles`) or `OIDC_ALLOWED_EMAILS` (addresses or
  `@domain`, only with `email_verified` true) is set. A refused user sees
  "You are logged in as … but not allowed to use this explorer" and a
  logout link, and the attempt is logged.
- **Identity in the session:** `sub` + `iss` (the stable key, used for the
  history folder in 03, hashed), display name and email (UI only).
- **UI:** top bar shows the user name with a menu "Log out"; an expired
  session sends the UI to `/login` and back to the same hash afterwards
  (the hash is kept in `sessionStorage`, not sent to the IdP).
- **Logout:** drops the session (01); if the discovery document has
  `end_session_endpoint`, redirect there with `id_token_hint` — so the ID
  token is kept after all, in the session, for that purpose only — and
  `post_logout_redirect_uri = PUBLIC_URL`.
- **Errors** from the IdP (`error`, `error_description`) are shown as text,
  escaped, length-limited.

## Tests

- In-process fake OIDC provider (`httptest`, own RSA/ECDSA keys, discovery,
  JWKS, token endpoint): happy path; wrong `state`; replayed code; wrong
  `nonce`; wrong `aud`/`iss`; expired token; `alg: none`; signature by an
  unknown key; key rotation (new `kid` fetched); PKCE verifier missing.
- Allow lists: group in/out, custom claim name, email with
  `email_verified` false refused, `@domain` match exactness
  (`@example.com` must not match `evil-example.com`).
- Session fixation: session ID changes at login.
- Logout with and without `end_session_endpoint`.

## Accept

- Browser check against Dex (or Keycloak) from the Compose profile
  `dev-idp` (package 05): log in, fetch the demo from `internal/fakeapi`,
  log out, back button does not show data, a second user in another
  context sees their own session only, a user outside the allowed group is
  refused.
- Documented setup snippets for Entra ID, Keycloak and Google in the
  README (redirect URI, scopes, group claim).
