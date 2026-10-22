# Running IONOS Explorer for a team

Files to run `ionos-explorer` in hosted mode: each user logs in, types
their own IONOS API token, and sees only their own fetches. Tokens stay
in the server's memory, per session. The volume holds the user accounts
and, with an age identity, each user's snapshot history, encrypted (see
[The snapshot history](#the-snapshot-history)). Users log in with local
accounts, an [identity provider](#login-with-an-identity-provider-oidc),
or both.

| Directory | For | Status |
|---|---|---|
| [`compose/`](compose) | one server with Docker Compose; optional Caddy for TLS; a dev setup with a fake IONOS API | tested |
| [`kubernetes/`](kubernetes) | Kustomize: base, an example overlay with ingress, a dev overlay for kind/minikube | tested (kind) |
| [`swarm/`](swarm) | a Docker Swarm stack | validated, not run |

Whatever you run it on:

- **TLS in front.** The explorer speaks plain HTTP on port 8080. A proxy or
  ingress terminates TLS and must pass the original `Host` header (all
  common ones do). `X-Forwarded-*` headers are not used.
- **The public URL** (`IONOS_EXPLORER_PUBLIC_URL`) is the address users
  open: `https://explorer.example.com`, or with a path if the proxy serves
  it below one (`https://tools.example.com/ionos-explorer`). Requests for
  any other host are refused (421).
- **Exactly one instance.** Sessions and held tokens live in its memory: a
  restart logs everyone out, and two instances must never share the
  volume. No autoscaling, no scale to zero.
- **The volume** (`/data`) must be writable by the container's user
  (65532 by default). Back it up (see [Backups](#backups)).
- **Egress:** HTTPS to the IONOS API hosts. A proxy works through
  `HTTPS_PROXY`/`NO_PROXY`.
- **Probes:** `GET /healthz` (alive) and `GET /readyz` (can serve users)
  on port 8080, at the root whatever the public URL's path.

Until release images are published, build the image from the repository
root with `make image` (it tags `ionos-explorer`), and push it to a
registry your servers or cluster can pull from.

## The first admin

At the first start, with no accounts yet, the log shows a one-time link
(valid for an hour; a restart makes a new one):

```
No user accounts yet. To create the first admin, open this link within 1h0m0s …:
  https://explorer.example.com/#setup=…
```

Open it, choose a username and a password (at least 12 characters, not a
common one). That admin adds the other users under their name → **Manage
users…**, and passes on the one-time link each new user gets (24 hours).
The explorer sends no mail.

Instead of the link, the first admin can come from a secret:
`IONOS_EXPLORER_ADMIN_PASSWORD_FILE` (username `admin`, or
`IONOS_EXPLORER_ADMIN_USERNAME`). That password must be changed at the
first login; once accounts exist, the file is ignored.

Users can also be managed on the command line, also while the server runs:

```sh
docker compose exec explorer ionos-explorer users list
kubectl -n ionos-explorer exec deploy/ionos-explorer -- ionos-explorer users add alice --role admin
```

(`users -h` lists the commands: add, reset, disable, enable, role, delete.)

## The snapshot history

With an age identity, every fetch is kept in the user's own history on
the volume, encrypted to that identity: it survives restarts, the open
screen lists it, and the Changes tab compares with any earlier snapshot.
Other users, admins included, never see it. Without an identity there is
no history, and fetched data stays in memory until the user takes it.

```sh
docker run --rm ghcr.io/k4ugummi/ionos-explorer keygen > secrets/age_identity
```

Give the file to the explorer as a secret,
`IONOS_EXPLORER_AGE_IDENTITY_FILE` (the Compose, Kubernetes and Swarm
files have the lines for it, commented out), and **keep a copy where you
keep your other secrets**: without it the history cannot be read.

- **Retention** (`IONOS_EXPLORER_KEEP`, default
  `daily=14,weekly=8,monthly=12`): per user and contract, the newest 3
  snapshots and the newest of each of the last 14 days, 8 weeks and 12
  months.
- **Quota** (`IONOS_EXPLORER_MAX_USER_BYTES`, default `500MB`, `0` for
  none): the oldest snapshots beyond the newest 3 go first; a snapshot that
  still does not fit is not stored (the user is told; the fetch works).
- **Deleting a user** deletes their history.
- **Second factor:** with the identity, local users can turn on
  two-factor authentication (an authenticator app) in their account;
  `IONOS_EXPLORER_LOCAL_TOTP=required` makes everyone set it up at their
  next login (`off` hides it). A lost phone: a recovery code, or an
  admin's "Reset two-factor" (`ionos-explorer users reset-totp <name>`).
- **A new key:** put the new identity first in the file and the old one
  after it, restart, run `ionos-explorer rekey` in the container (as for
  `users`), then remove the old identity and restart again. It re-encrypts the
  second-factor secrets too.

## Login with an identity provider (OIDC)

Local users need no identity provider. To log in with Keycloak, Entra ID,
Google or any other OpenID Connect provider instead, or as well, list the
providers and set each one up with variables (`<ID>` in capitals, `-` as
`_`):

```sh
IONOS_EXPLORER_OIDC_PROVIDERS=keycloak            # several: keycloak,entra
IONOS_EXPLORER_OIDC_KEYCLOAK_ISSUER=https://sso.example.com/realms/company
IONOS_EXPLORER_OIDC_KEYCLOAK_CLIENT_ID=ionos-explorer
IONOS_EXPLORER_OIDC_KEYCLOAK_CLIENT_SECRET_FILE=/run/secrets/keycloak-client-secret
IONOS_EXPLORER_OIDC_KEYCLOAK_NAME=Keycloak         # the button: "Log in with Keycloak"
IONOS_EXPLORER_OIDC_KEYCLOAK_ALLOWED_GROUPS=ionos-explorer
IONOS_EXPLORER_OIDC_KEYCLOAK_ADMIN_GROUPS=ionos-explorer-admins
```

At the provider, register a confidential client (authorization code flow)
with the redirect URI `<public URL>/callback/<id>`
(`https://explorer.example.com/callback/keycloak`) and the post-logout
redirect URI `<public URL>/`.

| Setting | |
|---|---|
| `ISSUER`, `CLIENT_ID`, `CLIENT_SECRET` | required; every setting can also come from a file (`_FILE`) |
| `NAME` | the label on the login button (default: the ID) |
| `ALLOWED_GROUPS` | comma-separated groups that may log in |
| `ALLOWED_EMAILS` | addresses or `@domain` that may log in (verified emails only) |
| `ADMIN_GROUPS` | groups whose members are admins; they may always log in |
| `GROUPS_CLAIM` | the token claim with the groups (default `groups`; `a.b` reads a nested claim) |
| `SCOPES` | default `openid profile email` |

- **Who may log in:** members of an allowed group, or users with an allowed
  email. With neither list set, everyone the provider lets log in to the
  client may use the explorer, and the log says so at the start.
- **Only providers:** `IONOS_EXPLORER_LOCAL_USERS=false` turns local
  accounts off.
- **A provider that cannot be reached** shows a disabled button. The other
  ways to log in keep working.
- **Identities are separate:** the same person logging in locally and via
  Keycloak has two histories.
- **Typos are caught:** an `IONOS_EXPLORER_OIDC_*` variable that is not a
  known setting stops the start.
- **An identity provider with a certificate from an internal CA:** mount
  the CA certificate (PEM) into a directory and set
  `SSL_CERT_DIR=/that/directory`. The image's public CAs stay trusted too,
  so the IONOS API keeps working.

Notes per provider:

- **Keycloak:** turn client authentication on and use the standard flow
  only. Groups: in the client's dedicated scope, add a "Group Membership"
  mapper with token claim name `groups`, "Full group path" off, "Add to ID
  token" on (or keep the full path and write `/ionos-explorer`). Realm
  roles work too: `GROUPS_CLAIM=realm_access.roles`.
- **Entra ID:** an app registration with platform "Web", the redirect URI
  and a client secret. The issuer is
  `https://login.microsoftonline.com/<tenant ID>/v2.0`. Entra ID sends no
  `email_verified`, so allow by group or app role. App roles assigned to
  users and groups, with `GROUPS_CLAIM=roles`, are recommended. The other
  way is "Token configuration → Add groups claim": those groups are object
  IDs, and users in more than 200 groups get none (the log says so).
- **Google:** an OAuth client of type "Web application" with the redirect
  URI; the issuer is `https://accounts.google.com`. Google puts no groups
  in its tokens: use `ALLOWED_EMAILS=@example.com`. Logging out ends only
  the explorer's session, because Google offers no logout endpoint.

## Docker Compose

```sh
cd deploy/compose
cp .env.example .env          # set PUBLIC_URL (and IONOS_EXPLORER_IMAGE until releases exist)
docker compose up -d
docker compose logs explorer  # the setup link
```

The explorer listens on `127.0.0.1:8080` only. Put your proxy in front,
or let Caddy do it, with a certificate from Let's Encrypt or ZeroSSL:

```sh
# .env: DOMAIN=explorer.example.com and PUBLIC_URL=https://explorer.example.com
docker compose -f compose.yaml -f compose.caddy.yaml up -d
```

`DOMAIN` must resolve to the server, with ports 80 and 443 reachable.
With Traefik or nginx instead, forward the host to `127.0.0.1:8080`, or put
the explorer on the proxy's network.

### Trying it without an IONOS account

`compose.dev.yaml` builds the image from this checkout and adds a fake
IONOS API that serves a synthetic demo contract (14 datacenters, no real
data):

```sh
cd deploy/compose
docker compose -f compose.dev.yaml up -d --build
docker compose -f compose.dev.yaml logs explorer   # the setup link
```

Open the link, create the admin, and fetch with the token `demo-token`.
Stop with `docker compose -f compose.dev.yaml down -v` (`-v` also removes
the accounts). Use `stop`/`start` rather than `restart`: the explorer
shares the fake API's network namespace.

To try login with an identity provider, add `compose.dev-idp.yaml`: a
Keycloak with a test realm (`dev-idp/realm.json`) next to local users.

```sh
docker compose -f compose.dev.yaml -f compose.dev-idp.yaml up -d --build
```

"Log in with Keycloak" at http://localhost:8080 as `alice` (admin), `bob`
(user) or `carol` (in no allowed group: refused), each with the password
`<name>-dev-password`; Keycloak's console is at http://localhost:8180/admin
(`admin`/`admin`). Logging out of the explorer logs out of Keycloak too.
Test data only.

## Kubernetes

The base (`kubernetes/base`) runs one replica (`Recreate`) under the
`restricted` Pod Security Standard:

- non-root (65532), read-only root filesystem, no capabilities, seccomp
  `RuntimeDefault`, no service account token;
- readiness and liveness probes;
- a 1 Gi PersistentVolumeClaim (ReadWriteOnce) for the accounts;
- a NetworkPolicy: traffic in only from the namespace `ingress-nginx`
  (change the label to your ingress controller's namespace), and out only
  to DNS and port 443.

Copy `overlays/example`, then in your copy set the host (`ingress.yaml`,
and `IONOS_EXPLORER_PUBLIC_URL` in `kustomization.yaml`), the image
version, the ingress class and the cert-manager issuer. Then:

```sh
kubectl apply -k path/to/your-overlay
kubectl -n ionos-explorer logs deploy/ionos-explorer   # the setup link
```

For OIDC login, set the provider in the ConfigMap and its client secret
in the Secret `ionos-explorer-oidc` with the component `components/oidc`
(commented in `overlays/example`). The NetworkPolicy lets the pod out to
port 443 only, and an identity provider on another port needs a rule.
That includes an identity provider in the same cluster that the pod
reaches through the ingress controller: the policy then sees the
controller pod's port (often 8443), not 443.

For the first admin from a Secret, put the password into
`secrets/admin_password` next to your overlay's `kustomization.yaml` and
uncomment the `secretGenerator` and `components` lines there. Keep that
file out of git (`deploy/**/secrets/` is ignored in this repository), or
create the Secret `ionos-explorer-admin` another way (External Secrets,
Sealed Secrets, SOPS) and keep only the `components` line.

On OpenShift, drop `runAsUser`, `runAsGroup` and `fsGroup` from the
deployment: the image also runs with the random UID and group 0 that
OpenShift assigns.

### Trying it on kind or minikube

`overlays/dev` uses the images built from this checkout, with the fake
IONOS API as a second container in the pod, and no ingress:

```sh
docker build -t ionos-explorer:dev .
docker build --target fakeapi -t ionos-fakeapi:dev .
kind load docker-image ionos-explorer:dev ionos-fakeapi:dev   # or minikube image load …
kubectl apply -k deploy/kubernetes/overlays/dev
kubectl -n ionos-explorer port-forward svc/ionos-explorer 8080:80
kubectl -n ionos-explorer logs deploy/ionos-explorer -c explorer   # the setup link
```

Then open the link on `http://localhost:8080` and fetch with the token
`demo-token`.

## Docker Swarm

```sh
docker node update --label-add ionos-explorer.data=true <node>   # the node that keeps the volume
PUBLIC_URL=https://explorer.example.com docker stack deploy -c deploy/swarm/stack.yaml ionos-explorer
docker service logs ionos-explorer_explorer                       # the setup link
```

The stack expects an external network `proxy` that your proxy is on.
The labels are for Traefik; adapt them, or remove them for another proxy.
`update_config: stop-first` keeps a second instance from starting on the
same volume during updates.

## Backups

Back up the volume (`/data`). It holds `v1/users.json` with the accounts
(usernames, argon2id password hashes, roles) and `v1/history/` with the
snapshot histories, encrypted, in folders named by a hash of the user
(no names). Without the volume the accounts are gone and the setup link
appears again, and the histories are lost.

Keep the age identity apart from the volume's backup: the backup is only
readable with it, and anyone with both can read every history.
