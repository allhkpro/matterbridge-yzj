# Changelog

All notable changes to `matterbridge-yzj` are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/) and [Semantic Versioning](https://semver.org/).

## [0.3.1] — 2026-05-10

### Fixed

- **Thermostat 初始化 int16 溢出**: `createDefaultHeatingThermostatClusterServer` 内部对入参做 `× 100` 转换为 centi-Celsius，0.3.0 误把入参当成已是 centi-Celsius 再 × 100，导致 28 °C 变成 280 000，触发 `[integer-range] Value 280000 is above the nullable int16 maximum of 32767`。改为传摄氏度原值（`currentTemp, targetTemp, 16, 30`）后，AC 注册为 `MA_thermostat (0x0301)` 成功。SSE 状态推送（`setAttribute("localTemperature", state.current_temp * 100)`）依旧用 centi-Celsius，因为那是 attribute 的写入接口而非助手。

## [0.3.0] — 2026-05-10

Matter device-type expansion + Pico multi-press discrimination + complete state-update plumbing. Light hierarchy now covers OnOff → Dimmable → ColorTemperature → ExtendedColor; Climate / Lock / Sensor / WindowCovering-with-percentage all wired end-to-end.

### Added

- **L1-2 Color light hierarchy**: yzj `light` devices auto-promote based on `state` shape — `state.rgb` (3-tuple) → `ExtendedColorLight` (full color picker on iOS), `state.color_temp` → `ColorTemperatureLight` (warm/cool slider), `state.brightness` → `DimmableLight`, else `OnOffLight`. Adds `moveToColorTemperature` and `moveToHueAndSaturation` command handlers; SSE state push for `color_temp` / `rgb` (with HSV ↔ RGB conversion helpers).
- **Climate (Thermostat)**: yzj `climate` category with `{on, mode, target_temp, current_temp}` registers as Matter `ThermostatDevice` + `HeatingThermostat` cluster. iOS Home shows current temp + target setpoint controls; `setpointRaiseLower` command handler maps 0.1 °C steps onto yzj `target_temp` (16–30 °C clamp). State push of `current_temp` / `target_temp` via Thermostat cluster `localTemperature` / `occupiedHeatingSetpoint`.
- **Lock (DoorLock)**: yzj `lock` category with `{locked, battery_pct}` registers as Matter `DoorLockDevice`. `lockDoor` / `unlockDoor` commands map to `turn_on` / `turn_off`. SSE `state.locked` boolean → `DoorLock.lockState` enum (Locked / Unlocked).
- **Sensors (Temperature / Humidity / AirQuality / Contact)**: yzj `sensor` category routes to the right Matter sensor device-type by inspecting `state.unit` — `c/celsius/°c` → `TemperatureSensor`, `%/rh/humidity` → `HumiditySensor`, `aqi/pm/co2/voc` → `AirQualitySensor` (with bucketed `AirQualityEnum` mapping 0–50 Good … >300 ExtremelyPoor), boolean `value` → `ContactSensor`. Measurement clusters (Temperature / RelativeHumidity) accept yzj `value` × 100 in the SSE handler.
- **Cover percentage control**: `WindowCovering` cluster now initialised with current lift percentage; `goToLiftPercentage` command handler accepts the iOS percent slider and forwards `position` (0–100) to yzj-agent. SSE `state.position` updates both `currentPositionLiftPercent100ths` and `targetPositionLiftPercent100ths` for accurate iOS rendering.
- **Pico Single / Double / Long discrimination**: per-(deviceId, btn) state machine in plugin. `press` arms a 500 ms long-press timer; `release` arms a 400 ms double-press window before firing `Single`. Two presses inside the window fire `Double` (and cancel pending Single). A press held > 500 ms fires `Long` (and suppresses trailing Single). Constants match yzj-host docs/15 (`DOUBLE_PRESS_WINDOW_SEC=0.4`, `LONG_PRESS_SEC=0.5`) so Apple Home and HAP-python see consistent behavior.
- **categoryAllowlist** default now includes `climate`, `lock`, `sensor` so new yzj device categories are bridged automatically.
- **MIT LICENSE.md** with 云之锦智能 (南京云之锦智能科技有限公司) copyright + upstream credit to Matterbridge / matter.js.

### Changed

- `handleDeviceStateChange` is now a single dispatch table covering OnOff, LevelControl (brightness), WindowCovering (position), ColorControl (color_temp / rgb), Thermostat (current_temp / target_temp), DoorLock (locked), TemperatureMeasurement / RelativeHumidityMeasurement / AirQuality / BooleanState (sensor `value`), Reachable (online), and Pico (`last_event`). Each branch is independently try/catch-guarded so non-applicable clusters silently skip.

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
