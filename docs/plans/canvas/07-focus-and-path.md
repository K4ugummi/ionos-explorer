# 07 Focus and path view

The two views a network diagram is really used for: "what is this connected
to" and "how does A reach B". Both work across datacenters, which the
per-datacenter view cannot show.

## Model: `explorer/src/model/paths.ts` (pure, tested)

- **Network graph** from the model: nodes are servers, NICs, LANs, Cross
  Connects, NAT/VPN gateways, load balancers, managed services, external
  endpoints, sites; edges from `model.edges`: `member`/`attached`
  (server/NIC ↔ LAN), `cross-connect` (LAN ↔ Cross Connect), `gateway`
  (NAT ↔ LAN), `connection` (managed service/VPN gateway ↔ LAN), `listener`
  and `target-lan` (LB ↔ LAN), `target` (LB → server), `tunnel` (VPN ↔
  remote), `manual` (user links). Treat them as undirected for reachability.
- `neighbourhood(model, id, hops)`: everything within `hops` (default 2,
  counting LANs and Cross Connects as hops), across datacenters.
- `findPaths(model, a, b, { max: 3 })`: shortest paths by hop count (BFS,
  then the k shortest without repeated nodes). A path is a list of node ids
  with the edge kind between each pair. Servers in the middle of a path are
  allowed only if they look like appliances (`node.appliance`) or have
  NICs in both LANs: that is how traffic is routed through firewall VMs.
  Explain each step in words ("member of LAN app", "Cross Connect
  fra-backbone to txl-prod-core", "routed by fra-core-fw-01 (likely
  firewall)").
- Annotations matter: manual links and sites are part of the graph (use the
  applied model).

## Views

- **Focus**: details panel button "Focus" (servers, LANs, gateways,
  Cross Connects) → diagram mode `focus=<id>` in the hash. A diagram built
  from `neighbourhood` (new builder `focusDiagram` in `build.ts`): the
  selected resource in the middle, grouped by datacenter, same node
  renderers. "Hops: 1 2 3" control.
- **Path**: details panel "Path to…" opens a resource picker (reuse the
  search picker from `ui/ManualLinks.tsx`) → mode `path=<a>,<b>`. A
  left-to-right diagram of the paths (`pathDiagram`): A, then each hop
  (LAN, Cross Connect, router, …) to B; several paths stacked. A text list
  of the steps in the details panel, so it is usable without the canvas.
- No path found: say so and show the two neighbourhoods side by side, with
  the hint that tunnels or routes inside VMs can be added as manual links.
- Breadcrumbs: "All datacenters › Path: web-01 → db-02", back returns to
  the previous view.

## Tests

- `paths.test.ts` on the demo: a web server in `fra-prod-core` to the
  database in `fra-prod-data` goes through the shared Cross Connect;
  `txl-core-vpn-01` reaches `fra-core-vpn-01` only through the manual link
  (demo annotations) or the managed VPN tunnel; neighbourhood hop counts.
- Builder tests for `focusDiagram`/`pathDiagram` (node types, ordering).

## Accept

- Browser: Focus on a firewall shows its LANs, their members (collapsed
  groups per package 03) and Cross Connect peers in other datacenters.
  Path from a London proxy to a Frankfurt API server shows a route or a
  clear "no route" message.

## Left over

(fill in when done)
