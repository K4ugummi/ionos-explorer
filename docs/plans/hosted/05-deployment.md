# 05 Deployment: Compose, Swarm stack, Kubernetes

**Problem.** People need copy-ready, secure defaults for the three common
ways to run a container. All files live in `deploy/`; the README gets a
short "Run for a team" section linking to `deploy/README.md`.

```
deploy/
  README.md                 overview, IdP setup (Entra ID, Keycloak, Google), key generation, backup
  compose/
    compose.yaml            app + volume + secrets
    compose.dev-idp.yaml    profile dev-idp: Dex + fake IONOS API for trials and CI (no real secrets)
    .env.example
  swarm/
    stack.yaml
  kubernetes/
    base/                   kustomization.yaml, namespace, deployment, service, pvc, networkpolicy, configmap
    overlays/example/       ingress (+ cert-manager), secret generator from files, image tag
```

## Docker Compose (single server)

```yaml
# deploy/compose/compose.yaml
name: ionos-explorer
services:
  explorer:
    image: ghcr.io/k4ugummi/ionos-explorer:1      # pin a version or digest
    restart: unless-stopped
    read_only: true
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    user: "65532:65532"
    environment:
      IONOS_EXPLORER_MODE: hosted
      IONOS_EXPLORER_PUBLIC_URL: ${PUBLIC_URL}           # https://explorer.example.com
      IONOS_EXPLORER_OIDC_ISSUER: ${OIDC_ISSUER}
      IONOS_EXPLORER_OIDC_CLIENT_ID: ${OIDC_CLIENT_ID}
      IONOS_EXPLORER_OIDC_CLIENT_SECRET_FILE: /run/secrets/oidc_client_secret
      IONOS_EXPLORER_OIDC_ALLOWED_GROUPS: ${OIDC_ALLOWED_GROUPS:-}
      IONOS_EXPLORER_AGE_IDENTITY_FILE: /run/secrets/age_identity
      IONOS_EXPLORER_LOG_FORMAT: json
    secrets: [oidc_client_secret, age_identity]
    volumes:
      - data:/data
    ports:
      - "127.0.0.1:8080:8080"      # TLS in front: Caddy/Traefik/nginx on the host, never expose plain HTTP
    deploy:
      resources:
        limits: { memory: 1g, cpus: "1.0" }
secrets:
  oidc_client_secret: { file: ./secrets/oidc_client_secret }
  age_identity: { file: ./secrets/age_identity }        # ionos-explorer keygen > secrets/age_identity
volumes:
  data: {}
```

`.env.example` lists the variables; `deploy/README.md` shows a Caddy
two-liner for TLS (automatic certificates) as the simplest reverse proxy,
and a Traefik label variant.

`compose.dev-idp.yaml` (profile `dev-idp`, for trials and CI only): Dex
with a static user and client, the fake IONOS API (a small command
`ionos-fakeapi` built from `internal/fakeapi`, only in a dev image tag,
never in the release image), and the explorer with
`PUBLIC_URL=http://localhost:8080` and `--base-url` pointing at the fake.

## Docker Swarm (stack)

```yaml
# deploy/swarm/stack.yaml   docker stack deploy -c stack.yaml ionos-explorer
services:
  explorer:
    image: ghcr.io/k4ugummi/ionos-explorer:1
    read_only: true
    cap_drop: [ALL]
    environment:                      # the same variables as in compose.yaml
      IONOS_EXPLORER_MODE: hosted
      IONOS_EXPLORER_PUBLIC_URL: https://explorer.example.com
      IONOS_EXPLORER_OIDC_CLIENT_SECRET_FILE: /run/secrets/oidc_client_secret
      IONOS_EXPLORER_AGE_IDENTITY_FILE: /run/secrets/age_identity
      # … issuer, client ID, allowed groups, log format
    secrets: [oidc_client_secret, age_identity]
    volumes: [data:/data]
    networks: [proxy]
    deploy:
      replicas: 1                     # sessions and tokens are in memory; see plan README "Later"
      update_config: { order: stop-first }   # never two instances on one volume
      restart_policy: { condition: any }
      placement: { constraints: [node.labels.ionos-explorer.data == true] }  # the node with the volume
      resources: { limits: { memory: 1g } }
      labels:                          # Traefik in Swarm mode, if used
        traefik.enable: "true"
        traefik.http.routers.ionos-explorer.rule: Host(`explorer.example.com`)
        traefik.http.routers.ionos-explorer.tls.certresolver: le
        traefik.http.services.ionos-explorer.loadbalancer.server.port: "8080"
secrets:
  oidc_client_secret: { external: true }   # docker secret create oidc_client_secret -
  age_identity: { external: true }
volumes:
  data: {}
networks:
  proxy: { external: true }
```

Swarm has no `security_opt`/`no-new-privileges` per service in stacks;
the image runs non-root without capabilities anyway. `stop-first` matters:
two instances writing one history would race.

## Kubernetes (Kustomize)

`deploy/kubernetes/base`:

- **Namespace** `ionos-explorer` with Pod Security Admission
  `enforce: restricted`.
- **Deployment**, `replicas: 1`, `strategy: Recreate` (RWO volume, memory
  sessions):

  ```yaml
  spec:
    template:
      spec:
        automountServiceAccountToken: false
        securityContext:
          runAsNonRoot: true
          runAsUser: 65532
          runAsGroup: 65532
          fsGroup: 65532
          seccompProfile: { type: RuntimeDefault }
        terminationGracePeriodSeconds: 30
        containers:
          - name: explorer
            image: ghcr.io/k4ugummi/ionos-explorer:1
            ports: [{ name: http, containerPort: 8080 }]
            envFrom: [{ configMapRef: { name: ionos-explorer } }]
            env:
              - name: IONOS_EXPLORER_OIDC_CLIENT_SECRET_FILE
                value: /secrets/oidc_client_secret
              - name: IONOS_EXPLORER_AGE_IDENTITY_FILE
                value: /secrets/age_identity
            securityContext:
              allowPrivilegeEscalation: false
              readOnlyRootFilesystem: true
              capabilities: { drop: [ALL] }
            readinessProbe: { httpGet: { path: /readyz, port: http }, periodSeconds: 10 }
            livenessProbe: { httpGet: { path: /healthz, port: http }, periodSeconds: 20 }
            resources:
              requests: { cpu: 50m, memory: 128Mi }
              limits: { memory: 1Gi }
            volumeMounts:
              - { name: data, mountPath: /data }
              - { name: secrets, mountPath: /secrets, readOnly: true }
        volumes:
          - name: data
            persistentVolumeClaim: { claimName: ionos-explorer-data }
          - name: secrets
            secret: { secretName: ionos-explorer, defaultMode: 0400 }
  ```

- **ConfigMap** with the non-secret variables (mode, public URL, issuer,
  client ID, allowed groups, retention, log format).
- **Secret** `ionos-explorer` (`oidc_client_secret`, `age_identity`)
  produced by a `secretGenerator` from files in the overlay (git-ignored),
  or by External Secrets / Sealed Secrets / SOPS: documented, not bundled.
- **PersistentVolumeClaim** `ionos-explorer-data`, RWO, 5 Gi (default
  quota 500 MB per user; size it as users × quota).
- **Service** ClusterIP, port 80 → `http`.
- **NetworkPolicy**: ingress only from the ingress controller's namespace
  (label selector to adapt); egress to DNS (kube-dns, 53/UDP+TCP) and
  443/TCP to anywhere outside the cluster (`ipBlock 0.0.0.0/0` except the
  cluster CIDRs), because IONOS API and IdP addresses are not stable;
  tighter with an egress gateway or a CNI that filters by FQDN (Cilium
  `toFQDNs: *.ionos.com` + the IdP host), shown as an optional example.

`overlays/example`: Ingress (`ingressClassName: nginx` as example,
cert-manager `cluster-issuer` annotation, TLS secret, host), image tag
pin, ConfigMap patch for `PUBLIC_URL`/issuer/client ID, secret generator.
Ingress notes: request body limit is irrelevant (bodies ≤ 64 KiB); long
polling is not used; no session affinity needed with one replica.

`kubectl apply -k deploy/kubernetes/overlays/example` after filling the
overlay; `kubectl kustomize` must render without errors in CI.

## Backups and keys (deploy/README.md)

- Back up the volume **and** the age identity separately; the volume alone
  is unreadable (that is the point), the identity alone is useless.
- Rotate the identity: add the new one first in the file, run
  `ionos-explorer rekey`, then remove the old one (03).
- Losing the identity loses the history; nothing else (no other state).

## Tests

- CI: `docker compose -f compose.yaml -f compose.dev-idp.yaml --profile
  dev-idp config` validates; a job brings the dev profile up, logs in
  through Dex with a scripted browser (playwright), fetches from the fake
  API, restarts the explorer container, sees the history.
- `kubectl kustomize` renders base and overlay; `kubeconform` validates
  the output against the Kubernetes schemas; `kube-linter` or `polaris`
  for security settings (no root, read-only fs, limits, probes).
- Optional CI job with `kind`: apply the overlay with a self-signed
  issuer, the dev IdP and fake API, run the same browser check.
- `docker stack config -c stack.yaml` validates the Swarm file.

## Accept

- From a clean clone, following only `deploy/README.md`: Compose with the
  dev IdP runs on a laptop in under 5 minutes; the Kubernetes overlay runs
  on kind with the same browser check passing.
