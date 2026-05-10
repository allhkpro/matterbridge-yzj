# matterbridge-yzj

Matterbridge plugin that bridges **yzj-agent** devices (KNX / 米家 / 涂鸦 / Lutron RA2 / Sonos / 等) into Matter, exposing them to Apple Home / Google Home / SmartThings via the Matterbridge dynamic-platform API.

Powers the **云之锦 AI 万物互联主机** (`yzj-host`) Matter Bridge role. Architecture document: [`yzj-mac-host/docs/11-Matter桥接架构.md`](https://github.com/allhkpro/yzj-mac-host).

## Architecture

```
Apple Home / Google Home / SmartThings
         ↑ Matter cluster commands
         │
   Matterbridge 3.7+ (Node.js)
   └ matterbridge-yzj plugin (TypeScript)
         ↑ HTTP REST + SSE
         │
   yzj-agent (FastAPI :9200)
         ↑ KNX / 米家 / 涂鸦 / Lutron protocol adapters
```

The plugin maps each yzj-agent `Device` (with stable `device_id` and category) to one Matter bridged endpoint. iOS commands (turn on/off, moveToLevel, lift open/close, identify) flow through the plugin and become POST `/api/agent/devices/{id}/turn_{on,off}` calls. Physical state changes from KNX bus / 米家 cloud / 涂鸦 cloud / Pico keypad / etc. flow back via yzj-agent's `event_bus` → `/api/agent/events/stream` SSE → plugin → Matter cluster `setAttribute`, so iOS sees real-time state.

## Supported device mappings

| yzj `category` | Matter device type | Notes |
|---|---|---|
| `light` (with `state.brightness`) | DimmableLight + LevelControl | Auto-detect; iOS gets brightness slider |
| `light` (no brightness) | OnOffLight | |
| `switch` | OnOffOutlet | 米家空气净化器 / 涂鸦插座 / 红外空调 |
| `cover` | WindowCovering | open/close cmd; partial position bidirectional |
| `scene_controller` | Composed device + N MomentarySwitch children | Lutron Pico — each physical button = 1 child endpoint;press → `triggerSwitchEvent('Single')` |
| `camera` / `media` | Skipped | Matter Camera 1.5 spec too early on Apple Home; cameras stay on HomeKit (HBUP / homebridge-camera-ffmpeg) path |

## Configuration

`matterbridge-yzj.config.json` (in `~/.matterbridge/` or `~/Matterbridge/`):

```json
{
  "name": "matterbridge-yzj",
  "type": "DynamicPlatform",
  "yzjAgentUrl": "http://127.0.0.1:9200",
  "categoryAllowlist": ["light", "switch", "cover", "scene_controller"],
  "deviceIdBlocklist": ["xiaomi.979836693"],
  "debug": false,
  "unregisterOnShutdown": false
}
```

| Field | Purpose |
|---|---|
| `yzjAgentUrl` | Where yzj-agent is reachable. Default `http://127.0.0.1:9200` (same Mac mini) |
| `categoryAllowlist` | Which yzj device categories to bridge. Default covers controllable types |
| `deviceIdBlocklist` | Specific devices to skip (e.g. Mi AI Speaker — has `category=switch` but it's a music device, not a controllable switch) |
| `debug` | Verbose endpoint logging |
| `unregisterOnShutdown` | Whether to unregister all endpoints on shutdown (default false; keep iOS pairings stable across restarts) |

## Install

### Production (npm install)

```bash
npm install -g matterbridge      # if not already installed
npm install -g matterbridge-yzj  # this plugin
matterbridge -add matterbridge-yzj
```

Then start Matterbridge in bridge mode:

```bash
matterbridge -bridge
```

(or set up launchd / systemd persistence — see `~/yzj-host/Library/LaunchAgents/com.yzj.matterbridge.plist` for the macOS launchd template.)

### Development (local clone)

> ⚠️ **macOS ESM resolution gotcha**: when `node_modules/matterbridge` is the plugin's own copy (different module instance from the global Matterbridge runtime), the `instanceof MatterbridgeDynamicPlatform` check inside Matterbridge fails with `Invalid MatterbridgePlatform received`. **The plugin's `node_modules/matterbridge` MUST be a symlink to the global install** so both share one module instance.

```bash
git clone https://github.com/allhkpro/matterbridge-yzj.git
cd matterbridge-yzj
npm install --no-save matterbridge          # types-only, won't be saved to package.json
npx tsc                                       # build dist/
rm -rf node_modules/matterbridge              # remove the local copy
ln -sf /usr/local/lib/node_modules/matterbridge node_modules/matterbridge   # link to global
matterbridge -add /path/to/matterbridge-yzj  # register absolute path
launchctl kickstart -k gui/$UID/com.yzj.matterbridge  # restart launchd-managed Matterbridge
```

`matterbridge` MUST NOT appear in `package.json` (any deps section) or Matterbridge's plugin loader will refuse to load with `Found matterbridge package in the plugin devDependencies`.

## Operational behavior

### Startup retry (L2-3)

If yzj-agent isn't reachable at plugin onStart (launchd doesn't guarantee start order), plugin retries the device list fetch with exponential backoff (1s, 2s, 4s, 8s, 16s, 32s; ~1 min total). After exhausting retries it starts in "degraded" mode (0 endpoints) and the SSE reconnect loop will sync devices once yzj-agent is up.

### SSE reconnect with full state sync (L2-5)

The plugin maintains a long-poll SSE connection to `/api/agent/events/stream`. On every (re)connect, it pulls the full device list and reconciles state for already-registered endpoints, plus hot-adds new devices that appeared during the disconnect window. This guarantees no state drift across SSE flap.

Reconnect backoff: 5s for first 2 failures, 15s for next 3, then up to 60s. Logs aggregated to avoid spam.

### Hot add / remove

- **Hot add**: when SSE delivers `adapter.*.{x}_added` event, plugin fetches the device and registers it as a new Matter endpoint (no Matterbridge restart needed; iOS sees it immediately via mDNS).
- **Hot remove**: SSE `adapter.*.{x}_removed` → plugin unregisters the endpoint.
- **Disappeared without explicit remove**: marked as `BridgedDeviceBasicInformation.Reachable=false` so iOS shows "no response", but stays registered (may come back).

### Pico button events

Lutron RA2 Pico keypads register as a composed Matter device with one child `GenericSwitch` endpoint per physical button. yzj-agent emits raw press/release frames via SSE state change (`device.{pico_id}.state.last_event = {btn, action, label, ts}`). The plugin maps `action="press"` → `triggerSwitchEvent('Single')` on the matching child endpoint, which iOS sees as a Switch event usable for HomeKit automations.

(Multi-press / Long-press detection requires time-window logic; deferred — yzj-agent currently only forwards raw press/release.)

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Invalid MatterbridgePlatform received` | Plugin's `node_modules/matterbridge` is a separate module instance | Symlink to global (see Development section) |
| `Cannot find package 'matterbridge'` at runtime | Plugin's `node_modules/matterbridge` deleted and Node ESM doesn't auto-find global | Re-create the symlink to `/usr/local/lib/node_modules/matterbridge` |
| `Found matterbridge package in the plugin devDependencies` | `matterbridge` declared as a dep in `package.json` | Remove from package.json (use `--no-save` for build-time install) |
| `Constraint "minLevel to maxLevel": Value 0 is not within bounds` | Persisted `currentLevel=0` from older plugin version | Plugin no longer writes 0 to LevelControl; old entries auto-corrected on next state change |
| iOS shows "no response" for some devices | `BridgedDeviceBasicInformation.Reachable=false` (yzj-agent reports `online: false`) | Check the underlying device / adapter on yzj-agent |

## License

MIT (this fork) + ISC (matterbridge upstream by Luligu).

## Related projects

- [`matterbridge`](https://github.com/Luligu/matterbridge) — the upstream framework
- [`yzj-host`](https://github.com/allhkpro/yzj-host) — yzj-agent + adapters (private)
- [`yzj-mac-host`](https://github.com/allhkpro/yzj-mac-host) — 万物互联主机 architecture docs (private)
- [`homebridge-hikvision-yzj`](https://github.com/allhkpro/homebridge-hikvision-yzj) — sister plugin for Hikvision cameras → HomeKit (Matter Camera spec not yet supported)
