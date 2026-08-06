# Fruit Fuse Arena

A standalone, original browser game inspired by classic grid-based bomb arena party games. It does **not** require Garry's Mod and does not include Garry's Mod code, models, textures, maps, or sounds.

## Included

- Real online multiplayer using room codes (up to 8 players)
- Server-authoritative movement, bomb placement, explosions, pickups, deaths, and scoring
- Three slightly larger 17×15 arenas with a player vote before every round
- Destructible crate mazes with randomized powerups
- Chained explosions and self-elimination
- Starting blast radius of 1; each blast pickup adds exactly one tile to only the collecting player
- Speed, bomb-capacity, and special ability upgrades remain player-specific
- Passive bomb kicking that smoothly slides bombs up to four tiles, stopping at obstacles
- Mega bomb charges
- Remote-controlled bombs
- Piercing explosions
- Line bomb placement
- 65-second round timer before sudden-death closure, automatic round resets, kill counts, and round wins
- Tiny measured latency readout beside every player
- Responsive canvas renderer with original procedural artwork; no external game assets
- 45 Hz authoritative simulation and 30 Hz multiplayer snapshots
- Cached static arena rendering, immediate local movement prediction, and collision-safe reconciliation
- Dependency-free Node.js server with a small built-in WebSocket implementation
- Dockerfile, Render Blueprint, Railway config, shareable room links, and health endpoint

## Run locally

Requires Node.js 20 or newer.

```bash
npm start
```

Open:

```text
http://localhost:3000
```

To test multiplayer on one computer, open the address in two browser windows. One player creates a room and shares the five-character code with the other.

To play across a home network, other players can open the host computer's LAN address, for example:

```text
http://192.168.1.50:3000
```

Your firewall must allow inbound TCP traffic on port 3000.

Run the multiplayer integration and collision test with:

```bash
npm test
```

## Controls

| Key | Action |
|---|---|
| WASD / Arrow keys | Move |
| Space | Place a standard bomb |
| F | Spend a mega bomb charge |
| E | Place a line of bombs after collecting Line |
| Q | Detonate the oldest remote bomb after collecting Remote |
| Walk into a bomb | Smoothly kick it up to four tiles after collecting Kick |

## Internet hosting and shareable links

This is a multiplayer Node.js/WebSocket app, so uploading only `index.html` to a static host will not work. Deploy the complete folder to a web-service host that supports WebSockets.

### Render

1. Put the project folder in a GitHub repository.
2. In Render, create a **Blueprint** or **Web Service** from that repository.
3. Render will read `render.yaml`, run `npm ci`, start with `npm start`, and check `/health`.
4. Open the assigned `https://...onrender.com` URL.

### Railway

1. Put the project folder in a GitHub repository and choose **Deploy from GitHub repo** in Railway, or run `railway up` from the folder.
2. Railway reads `railway.json` and starts the server with `npm start`.
3. In **Settings → Networking**, generate a public domain.

Once deployed, create a room and click **Copy invite link**. The copied URL includes `?room=ABCDE`, so friends open the game with the room code already filled in. First-time players enter a display name and click **Join**.

The server uses the host-provided `PORT` automatically. Game state is in memory, so restarting or sleeping the service clears active rooms and scores. Keep this deployment to one running instance unless you later add shared room storage and coordinated WebSocket routing.

## Docker

```bash
docker build -t fruit-fuse-arena .
docker run --rm -p 3000:3000 fruit-fuse-arena
```

## Project layout

```text
fruit-fuse-arena/
├── server.js          # HTTP, WebSocket protocol, rooms, and authoritative game simulation
├── public/
│   ├── index.html     # Menu, lobby, canvas, and HUD
│   ├── style.css      # Responsive visual design
│   └── client.js      # Networking, controls, interpolation, and rendering
├── package.json
└── Dockerfile
```

## Production hardening ideas

The prototype already validates names, limits message size, rate-limits input/actions, and keeps gameplay authoritative. Before operating a public service, add authentication, moderation, persistent accounts, metrics, structured logs, deployment-level connection limits, and automated abuse protection.


## Version 1.1 collision and performance update

- Movement is divided into small collision substeps so delayed ticks cannot tunnel into walls or crates.
- Bomb pass-through remains active until the player’s entire collision circle clears the bomb tile, preventing wall/bomb trapping.
- Client interpolation follows collision-safe axis movement instead of cutting diagonally through wall corners.
- Server simulation increased from 30 Hz to 45 Hz and state snapshots increased from 20 Hz to 30 Hz.
- Static backgrounds, floor tiles, walls, and crates are cached instead of redrawn from scratch every frame.
- HUD updates and high-DPI canvas rendering are capped to reduce browser frame-time spikes.


## Version 1.1.1 bomb escape update

- Starting areas now carve a radius-three safe diamond, guaranteeing an L-shaped escape route around the permanent checkerboard walls.
- This fixes the common case where a newly placed starting bomb inevitably eliminated its owner when the fuse expired.
- Solo training rounds restart after 1.2 seconds instead of 3.5 seconds.
- A persistent elimination banner now explains why movement has stopped while waiting for the next round.
- Browser assets use no-store caching so patched client code loads immediately after a server restart.


## Version 1.2 gameplay and sharing update

- Standard bombs now begin with blast radius 1.
- Crate upgrade drop chance was reduced from 34% to 28%.
- Kick now launches a bomb smoothly up to four tiles and stops it at the first wall, crate, death block, or bomb.
- Bomb movement is server-authoritative and client-smoothed between network snapshots.
- Lobby hosts can copy a direct invite URL containing the room code.
- Added Render, Railway, and Procfile deployment configuration for public WebSocket hosting.
## v1.2.1 placement fix

New bombs now originate at the placing character's exact rendered position and ease into the authoritative center of the selected grid tile. This removes the slight upper-left visual offset caused by movement interpolation and network delay while preserving grid-correct collision and explosions.



## Version 1.3 movement feel update

- Local movement is predicted immediately instead of waiting for the next server snapshot, while the server remains authoritative.
- Prediction is capped to a small lead and reconciled through collision-safe axis movement to prevent visible wall clipping.
- Added server-side corner assistance: when a player only grazes a wall tip, the character is gently steered toward the corridor center and continues moving.
- Slightly reduced the collision radius for more forgiving one-tile corridors without changing the character artwork.
- Reduced the idle hover animation while moving so characters feel grounded rather than floaty.
- Rapid direction-change packets are no longer discarded, so quick turns register immediately.
- Remote-player smoothing was tightened to make other players appear more responsive.


## Version 1.4 map vote, balance, and latency update

- Arenas increased from 15×13 to 17×15.
- Added Classic Grove, Crossroads, and Open Orchard layouts.
- Every player can vote for the first map in the lobby and the next map between rounds.
- Blast-range pickups add exactly one tile and modify only the player who collects them.
- Upgrade drop chance increased slightly from 28% to 31%.
- The arena-closing timer was reduced from 90 seconds to 65 seconds.
- The server measures round-trip latency and displays a small millisecond value in the lobby and scoreboard.
