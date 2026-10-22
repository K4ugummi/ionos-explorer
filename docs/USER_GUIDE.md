# Using IONOS Explorer

How to find your way around a contract once a snapshot is open. To get one
open, see the [README](../README.md). The demo snapshot (14 datacenters,
synthetic) is on the start screen and comes with examples of everything
below.

The explorer has three tabs:

- **Diagram:** the contract, a datacenter, or a focus or path view.
- **Overview:** datacenters by location, Cross Connects, network
  appliances, and your notes.
- **Changes:** the comparison with an older snapshot.

## Search

The search box looks through the whole contract, across all datacenters.
All parts of a query must match, and case does not matter.

| Query | Finds |
|---|---|
| `fra-core` | free text: name, ID, IPs, MACs, labels, descriptions |
| `"two words"` | a phrase |
| `kind:server` | a kind of resource (aliases: `vm`, `dc`, `lan`, `cc`, `k8s`, `pg`, `vpn`, …) |
| `type:cube` | a server type (`cube`, `dedicated`, `vcpu`, `gpu`) or other subtype |
| `dc:fra-prod`, `loc:de/fra` | datacenter name, location (part of it, or a glob) |
| `ip:10.7.*`, `mac:02:01:ab` | an IP (prefix or glob), a MAC |
| `label:env=prod` | a label: key, or key=value, glob allowed |
| `state:shutoff` | VM or resource state |
| `is:appliance` | servers that look like routers, firewalls or VPN endpoints |
| `is:added`, `is:changed` | new or changed since the compared snapshot |
| `is:expiring`, `is:expired` | certificates ended or ending within 30 days |
| `is:dangling` | DNS records naming an IP or host that is not in the contract |
| `dhcp:off` | NICs whose IP IONOS does not assign (the VM may use another) |
| `is:corrected` | NICs with an IP correction you entered |
| `-term`, `-kind:nic` | leave out |

Pick a result to see its details and to show it in the diagram.

## The diagram

**All datacenters** shows one card per datacenter, grouped by location,
with counts per kind and the Cross Connects between them. Click a card to
open that datacenter with all its resources.

To keep large datacenters readable:

- **Groups:** a group of more than eight servers shows six and a "+N more"
  box that opens it. The selected server, appliances, changes and search
  hits are always shown, or counted on the box.
- **Routers:** a server in four or more LANs is drawn as a router, with one
  line to its first LAN and the others while it or one of those LANs is
  selected. LANs that only it uses fold into its box, and a LAN that only
  leads to a Cross Connect becomes a line to the Cross Connect ("+N LANs
  only here" unfolds them).
- **Zoom:** below 60 % the boxes lose subtitles and IPs, and below 30 % they
  show names only. The selection, its neighbours and search hits keep their
  details.

**Layers** in the diagram bar:

- **Hide** load balancers, gateways, managed services, tunnels and links,
  leftover groups or Cross Connect peers. The layout closes the gap.
- **Dim** everything except appliances or, when comparing, except changes.
- **Expand all / Collapse all** opens or folds every group and router of
  the current view.
- **Snap moved boxes to the grid.**

What you choose is remembered in this browser per contract, and is part of
the link (`hide=`, `emphasis=`), so a shared link shows the same view. A
search result that a hidden layer leaves out gets a note with a "Show"
button.

### Placing boxes yourself

- **Drag** a box, a datacenter card or a group (a location, a server group)
  to place it. It stays there, its lines follow, and the automatic layout
  keeps placing everything else.
- **Several at once:** Shift and drag, or Ctrl/Cmd and click, picks several
  boxes, which then move together.
- **Keyboard:** the arrow keys move the selected box (with Shift: further).
- **Touch screen:** tap a box first, then drag it.
- **Reset layout** in the diagram bar puts the view back.

Positions are kept with your other notes (see below).

## Focus and paths

- **Focus**, in a resource's details, shows everything it is connected to
  across datacenters, 1 to 3 hops out (a LAN, a Cross Connect, a server each
  count as one).
- **Path to…** picks a second resource and shows the shortest routes
  between the two: step by step in the details, and as a diagram grouped by
  datacenter.

Routes pass LANs, Cross Connects, load balancers (listener to target), VPN
gateways and tunnels, your manual links and sites, and servers detected as
appliances. Other servers in two LANs are used only as a last resort, and
marked as such. With no route at all, both neighbourhoods are shown with a
hint to add the missing link.

With several routes, "Show" next to one lights it up and dims the others,
and "Copy as text" copies all routes for a ticket. Both views are part of
the link (`focus=`, `path=`, `hops=`, `route=`). The breadcrumbs, ✕ or the
browser's back button return to the view before.

## Appliances

Servers that look like routers, firewalls or VPN endpoints are flagged.
The flag is based on image names, firewall rules and LAN placement, and the
details always show the reasons. IONOS VPN Gateway tunnels are drawn as
lines. The Overview lists all appliances.

## Your notes: links, IP corrections, positions

Some things the IONOS API cannot know:

- **Manual links:** a connection such as an IPsec tunnel between two Cisco
  VMs. Add it in a resource's details. Paths use it like any other link.
- **IP corrections:** for NICs with DHCP off, IONOS only keeps a record of
  the IP, which may be outdated (`dhcp:off` finds them). Enter the IP the
  VM really uses per NIC, or paste a list on the Overview page. It is shown
  next to the IONOS value.

Links, corrections and box positions stay in your browser. Export and
import them as a file on the Overview page to share them or move them to
another browser. The demo comes with examples
(`fixtures/demo-annotations.json`).

## Comparing snapshots

On the Changes tab, load an older snapshot of the same contract. Everything
added, removed or changed in between (servers, NICs and IPs, firewall
rules, LANs, Cross Connects, labels, …) is:

- listed by datacenter;
- marked in the diagram;
- searchable with `is:added` and `is:changed`.

With `ionos-explorer`, **Refresh** compares by itself, with the snapshot
open before as the older one. In hosted mode with a history, any earlier
snapshot can be picked. With the demo, "Compare with the demo two weeks
earlier" loads `fixtures/demo-contract-previous.ionx`.

## Export

**Export** in the diagram bar saves the current view in one of these
formats:

- **SVG**;
- **PNG**, at 1×, 2× or 4× its size, optionally with a transparent
  background;
- **PDF**;
- **draw.io**, to edit in diagrams.net.

The file shows the picture as laid out, with your positions, hidden layers
and collapsed groups. It has full detail whatever the zoom, always light
colours, and a title, the snapshot date and a legend. Comparison markers
are kept, and the selection and search highlighting are left out.

**All views** saves the overview and every datacenter at once: one PDF or
draw.io file with a page each, or the SVGs in a ZIP.

Files are named `ionos-<contract>-<view>-<snapshot date>.<ext>`. They are
made in the browser, and nothing is uploaded.
