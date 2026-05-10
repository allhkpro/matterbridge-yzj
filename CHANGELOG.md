# Changelog

All notable changes to `matterbridge-yzj` are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/) and [Semantic Versioning](https://semver.org/).

## [0.2.0] — 2026-05-10

Phase 2 + Layer-1 polish complete. 15 yzj devices live-bridged into Apple Home with bidirectional sync.

### Added

- **L1-1 DimmableLight detection**: yzj `light` devices with `state.brightness` field auto-promote to Matter `DimmableLight` device type with `LevelControl` cluster + `moveToLevel` / `moveToLevelWithOnOff` command handlers. yzj brightness 0–100 ↔ Matter level 1–254 (skip 0 to satisfy `minLevel` constraint).
- **L1-3 Reachable mirror**: yzj `online: false` propagates to Matter `BridgedDeviceBasicInformation.Reachable=false` so iOS shows "no response" for offline devices.
- **L1-4 Hot-add via SSE**: `adapter.*.{x}_added` events trigger fetch + register of new endpoints without Matterbridge restart. Plus implicit hot-add: any unknown `device_id` appearing in a state event triggers register.
- **L1-5 Hot-remove via SSE**: `adapter.*.{x}_removed` events unregister endpoints cleanly.
- **L1-6 Pico composed device**: Lutron RA2 Pico keypads register as a composed Matter device with one child `GenericSwitch` (MomentarySwitch) endpoint per physical button. SSE `state.last_event` with `action="press"` fires `triggerSwitchEvent('Single')` on the matching child, usable for HomeKit automations.
- **L1-7 `deviceIdBlocklist` config**: Skip specific yzj devices by `device_id`. Default excludes Mi AI Speaker (`xiaomi.979836693`) which has `category=switch` but is not a controllable switch.
- **L2-3 yzj-agent startup retry**: Plugin onStart retries the device list fetch with exponential backoff (1/2/4/8/16/32s = ~1 min total). Tolerates launchd not guaranteeing yzj-agent ↔ Matterbridge start order.
- **L2-5 SSE reconnect full state sync**: On every (re)connect, plugin pulls full device list and reconciles state for already-registered endpoints, plus hot-adds missed devices and marks disappeared devices `Reachable=false`. Eliminates state drift across SSE flap windows.
- **Aggregated SSE failure logs**: Reconnect backoff 5s → 15s → 60s; logs only on transition and every 5th failure to avoid spam.
- **Matterbridge frontend Schema** (`matterbridge-yzj.schema.json`): Visual config UI in Matterbridge frontend (port 8283) — engineers / customers can edit `yzjAgentUrl`, `categoryAllowlist`, `deviceIdBlocklist`, etc. without hand-editing JSON.
- **GitHub Actions CI** (`.github/workflows/ci.yml`): Node 20/22/24 matrix build, type check, dist verification, and a guard against `matterbridge` appearing in `package.json` deps.
- **README**: Architecture diagram, supported device mappings, install / dev workflow including the ESM symlink gotcha, troubleshooting table.

### Changed

- **WindowCovering**: Tuya / KNX cover devices register with full position bidirectional sync. yzj `position` (0=closed, 100=open) ↔ Matter `currentPositionLiftPercent100ths` (0=open, 10000=closed).
- **OnOffOutlet vs OnOffSwitch**: switches now use `OnOffOutlet` device type (renders as plug icon in iOS Home), more accurate than the older `OnOffSwitch` rendering.
- **Manufacturer / Model / Serial mapping**: `BridgedDeviceBasicInformation` now populated from yzj `Device.name` + sanitized `device_id` for serial. Vendor ID is `0xfff1` (CSA test) until our own VID is approved.

### Fixed

- LevelControl `Constraint "minLevel to maxLevel": Value 0 is not within bounds` validation error: plugin no longer writes 0 to `currentLevel`. Off state encoded via OnOff cluster only; LevelControl retains last non-zero level so iOS shows correct slider position when light comes back on.
- ESM module instance mismatch (`Invalid MatterbridgePlatform received`): documented in README that `node_modules/matterbridge` MUST be a symlink to global, otherwise instanceof check fails.

## [0.1.0] — 2026-05-09

Initial Phase 2 release.

### Added

- Matterbridge dynamic platform plugin scaffold.
- HTTP REST + SSE client to yzj-agent FastAPI on `:9200`.
- Device category mapping: `light` → `OnOffLight`, `switch` → `OnOffOutlet`, `cover` → `WindowCovering`, `scene_controller` → `GenericSwitch`.
- 11 yzj devices bridged into iOS Apple Home with iOS commission via `MT:Y.K90AFN00044F73220` QR.
- Matterbridge launchd plist (`com.yzj.matterbridge.plist`).
- `matterbridge-yzj.config.json` with `yzjAgentUrl`, `categoryAllowlist`.
