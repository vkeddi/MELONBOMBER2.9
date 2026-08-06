## Version 2.1.0 bots, presentation, and overtime update

- Avatars now keep facing their last movement direction, including while idle.
- Lobby hosts can add and remove server-authoritative bots up to the eight-player room limit.
- Bots navigate toward crates, opponents, and upgrades, plan escape routes, place bombs, collect powerups, vote for maps, and score round wins.
- The homepage now runs a lightweight AI arena match behind the menu with a dark readability scrim and high-contrast panels.
- Overtime blocks are lethal on contact, including attempted movement into their collision edge and blocks spawning against a player.
- Standard bombs now use black metal bodies, hardware caps, and fuses; mega bombs use a black shell with a red warning band.
- Powerups use small modeled objects such as boots, remotes, drills, canisters, and miniature bombs instead of generic crystals.

## Version 2.0.4 version display update

- Added a small version number that remains visible on the menu, lobby, and game screens.
- The displayed version, health endpoint, startup log, and package metadata all use the same centralized package version.

## Version 2.0.1 round-start fix

- Fixed the blank/inactive arena that could appear when a round began in browsers using WebGL2.
- Added separate GLSL shader variants for WebGL1 and WebGL2.
- Added a renderer error guard so a graphics failure no longer silently stops the client animation loop.
- Added a first-frame renderer test that exercises both WebGL versions before the multiplayer regression suite.

## Version 2.0 graphics overhaul

The game now uses a locally bundled, dependency-free WebGL renderer with a fixed overhead 3D camera. The arena, walls, crates, players, bombs, powerups, flames, shockwaves, and surrounding orchard scenery are rendered as lit 3D geometry. Multiplayer rules and server-authoritative collision remain unchanged.

Highlights:

- True perspective 3D overhead battlefield
- Low-poly fruit characters with animated movement and directional facing
- Lit stone walls, wooden crates, glowing pickups, and modeled bombs
- Explosion shockwaves, debris particles, flame volumes, and death effects
- Redesigned game HUD and in-world player labels
- Procedural visuals with no external image or model downloads
- Automatic resolution scaling for smoother performance on high-DPI screens

# Fruit Fuse Arena 3D

A standalone, original browser game inspired by classic grid-based bomb arena party games. It does **not** require Garry's Mod and does not include Garry's Mod code, models, textures, maps, or sounds.

## Included

- Real online multiplayer using room codes (up to 8 human players and host-added bots combined)
- Server-authoritative movement, bomb placement, explosions, pickups, deaths, and scoring
- Three original-size 15×13 arenas with a player vote before every round and true wall-layout previews
- Destructible crate mazes with randomized, physically modeled powerups
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
- Quiet per-bomb explosion sounds, a round-end cue, and winner-only confetti
- Responsive canvas renderer with original procedural artwork and synthesized sound effects; no external game assets
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

Run the WebGL renderer compatibility test and multiplayer regression suite with:

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
│   ├── menu-demo.js   # Homepage AI background match
│   ├── renderer3d.js  # Overhead WebGL renderer
│   └── client.js      # Networking, controls, interpolation, and compatibility rendering
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


## Version 1.5 map preview, audio, and celebration update

- Restored every arena from 17×15 to the original 15×13 dimensions.
- Map-voting cards now render each map's actual permanent-wall layout and possible spawn points before voting.
- Destructible crates remain randomized and are labeled accordingly in the preview.
- Added a short, low-volume synthesized sound for every bomb explosion, including chained explosions.
- Added a synthesized round-end sound without requiring external audio files.
- The round winner receives a local confetti celebration visible only on their screen.

## Display recovery in 2.0.4

Some browsers can keep the multiplayer simulation and audio running while silently failing to present a WebGL frame. Version 2.0.4 prefers the broadly compatible WebGL 1 path, checks that the first gameplay frames contain visible pixels, detects WebGL context loss/errors, and automatically switches to a full 2D compatibility view if the 3D canvas remains blank. Gameplay and networking continue without restarting the round.


## Graphics modes

Version 2.0.4 uses the overhead 3D renderer by default. Add `?renderer=stable` to the game URL to force the software renderer on restricted graphics hardware.


### 2.0.4 display fix

The game root and gameplay screen now explicitly fill the browser viewport. This prevents the active 3D canvas from collapsing to zero height when a round begins.
