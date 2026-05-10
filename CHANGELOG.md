# Changelog

All notable changes to `matterbridge-yzj` are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/) and [Semantic Versioning](https://semver.org/).

## [0.6.0] — 2026-05-10

### Added (架构 Phase B)

- **Profile framework — 数据驱动设备类型路由**: 之前 `buildEndpoint` 一个超长 switch case 按 `category × state` 写设备类型映射,加新型号要改 ts 代码。v0.6.0 抽出独立 profile 框架:
  - `src/profiles/types.ts` 抽象基类 `DeviceProfile`(buildEndpoint + pushState + match rule)
  - `src/profiles/router.ts` 顺序匹配,first-hit-wins
  - `src/profiles/register.ts` 集中注册 profile 数组(顺序决定优先级)
  - `src/profiles/<kind>.ts` 每类设备一个独立文件,聚焦该设备类的所有逻辑
- **air-purifier profile** 首迁 — 米家空气净化器(zhimi.airpurifier 系列)从 index.ts 主流程提取到 `src/profiles/air-purifier.ts`:
  - 自带 OnOff / FanControl-MultiSpeed (16 速 + Auto) / HepaFilterMonitoring + 3 子端点 (temp/hum/aqi)
  - 完整 cluster 初始化 + iPhone 写 attribute → yzj 命令路由 + SSE state 同步
  - 跟之前 v0.5.3 表达力等价,**行为不变**

### Changed

- **`tryRegisterDevice` 双轨**: 先 `router.match(dev)` 看 profile 命中:
  - 命中 → 走 profile.buildEndpoint,endpointMeta 标 `__profile_id`
  - 不命中 → fall-through 走旧 buildEndpoint switch case (light/cover/scene_controller/climate/lock/sensor/camera/普通 switch 暂未迁,仍硬编码)
- **`handleDeviceStateChange` 双轨**: 看 `meta.__profile_id` 命中 → profile.pushState,跳过旧 case-by-case
- 净化器之前在 index.ts 占的 ~200 行(buildEndpoint switch case + helpers + endpointMeta isAirPurifier)代码冗余可清,但本轮保留兼容,等 8 个 profile 全迁完再统一删。

### Roadmap

下一轮(v0.6.x)迁剩余 7 类:light / cover / climate / lock / sensor / scene_controller / camera-motion / switch-fallback。每个一个 PR / 一个文件。全迁完 v0.7.0 删除旧 buildEndpoint switch case。

## [0.5.2] — 2026-05-10

### Fixed

- **空气净化器现在是净化器,不再是插座/电池**: 之前 yzj `category=switch` + `state.aqi` 字段(米家空气净化器特征)被映射成 `MA_onoffpluginunit` (插座) + `PowerSource (Replaceable Battery)` cluster — iOS Apple Home 把它显示成插座 + "电池电量低"通知,语义错误,客户混淆以为设备真没电了。
- 改为正确的 Matter device-type **`MA_airPurifier (0x2d)`** + **`HepaFilterMonitoring`** cluster (Matter spec 给净化器 / 空调滤网这类耗材专门的 cluster):
  - iOS Home 显示成"空气净化器"图标(不是插座)
  - 滤芯寿命走 `condition` (0..100) + `changeIndication` (Ok / Warning / Critical) — Critical 时弹"该换 HEPA 滤芯了" 通知,语义对了
  - matterbridge 自动加 `fanControl` cluster (净化器 device-type 必带),将来可接入风速档位
- 触发条件: yzj `category=switch` + `state.aqi` 是数字 → 升级到 `airPurifier`。普通插座(无 aqi) 仍是 `onOffOutlet`。

## [0.5.1] — 2026-05-10

### Changed

- **`fullStateSync` 主动 unregister 离群端点**: 之前看到 yzj registry 里没有的本地端点只标 `reachable=false`,留位占空。改为**主动 unregisterDevice + 删 endpoints/endpointMeta map**,iPhone 家庭 app 端点真消失。
  - 触发场景:
    - yzj-host 端关 Mock adapter (`YZJ_USE_MOCK_ADAPTERS≠1`) 导致虚拟设备从 registry 消失
    - 用户从 adapter yaml 删一台设备 (例如把 knx.yaml 一行去掉)
    - adapter 真断网 (但断网应通过 `online=false` 走 SSE handleDeviceStateChange 路径标 reachable,跟本逻辑无冲突)
  - 语义: yzj registry 是 Matter 端点的真相源。
  - 实证: yzj-host 关 Mock 后,3 个 tuya 假端点(书房窗帘/电视插座/阳台空调红外)自动从 matter 端 unregistered,从 11 → 8 端点(全真设备)。

## [0.5.0] — 2026-05-10

### Added

- **L1-10 camera 分支 → Matter OccupancySensor**: yzj `category=camera` 设备(海康摄像头 PIR / VMD 运动检测)的 `state.motion` (boolean) 暴露为 Matter `MA_occupancy (0x0107)` 设备类型 + `OccupancySensing` cluster。SSE state 变化时 `setAttribute("occupancy", { occupied: motion })`。
  - **视频流 / 录像 / live view 不走 Matter** — Apple Home Matter Camera spec 1.5 还很初期,生产环境用 `homebridge-unifi-protect` 和 `homebridge-hikvision-yzj` 各自专属 plugin 跑。
  - 默认 `categoryAllowlist` 新增 `"camera"`。
  - 默认 `deviceIdBlocklist` 预填 5 台 UniFi Protect 摄像头(`unifi_protect.694cfb6c` 等)— 防止 motion 在 Matter + Homebridge 双桥重复触发自动化。yzj 用户在 dashboard 里另外管理 blocklist 即可解禁某些摄像头。
  - 海康摄像头 (`hikvision.ACHGE7065532`) 默认进 Matter 当 motion sensor;实证 endpoint 171 注册成功,SSE 推送 `OccupancySensing.occupancy { occupied: false }` 干净。

### Architecture context

v0.5.0 是 yzj 主机"双桥并行 → 单桥(Matter)+ 摄像头专桥(Homebridge)"切换的最后一块。配套 yzj-host 这边在 agent launchd plist 里设 `YZJ_DISABLE_HOMEKIT=1` 关掉 HAP-python Bridge,避免灯/Pico/净化器在 iOS 出现两次。

最终架构:

```
                   iOS Apple Home
                        ▼
    ┌───────────────────┴───────────────────┐
    │                                       │
Matter Bridge (matterbridge-yzj)      Homebridge
    setup: 4828167 + 3907             各 plugin 子桥
    11 endpoints                      ├─ UniFi Protect 5 摄像头 (live + motion)
    ├─ 3 KNX 灯                       └─ 海康 1 摄像头 (live + RTSPS HKSV 录像)
    ├─ 3 Pico keypads
    ├─ 1 Tuya 窗帘
    ├─ 1 Tuya 插座
    ├─ 1 Tuya 红外空调 (Climate)
    ├─ 1 米家空气净化器 (复合: switch + temp/hum/aqi + 滤芯电池)
    └─ 1 海康 motion (OccupancySensor)
```

## [0.4.1] — 2026-05-10

### Added

- **L1-9 Filter life → Matter PowerSource (Replaceable Battery)**: 米家净化器 / 加湿器等 switch 设备如果 state 携带 `filter_life` (0..100 剩余 %)，主端点自动挂 `PowerSource` cluster，按 `filter_life` 阈值映射 `BatChargeLevel`：
  - `> 30%` → Ok
  - `10..30%` → Warning
  - `≤ 10%` → Critical (iOS 卡片头红色电量图标)

  另外推 `batPercentRemaining` (Matter spec 是 0..200 半百分比，所以发 `filter_life * 2`) 和 `batReplacementNeeded` (`filter_life ≤ 5%` 时设 true，触发 iOS"替换电池/滤芯"通知)。语义重用：iOS 把 PowerSource 当电池处理，但 `batReplacementDescription="HEPA filter"` 显式说明它是滤芯，不是真电池。

  实证：xiaomi.357638328 当前 `filter_life=0` → `batPercentRemaining=0`、`batChargeLevel=Critical(2)`、`batReplacementNeeded=true`，iOS 弹"替换 HEPA filter"通知。

- **npm publish 支持**: `package.json` 加 `files` 白名单（dist/ + readme + license + changelog + 配置 + schema）+ `prepublishOnly` 脚本（自动 `rm -rf dist && tsc`）+ `repository` / `bugs` / `homepage` 字段。`.npmignore` 防御性兜底排除 src/ / tsconfig / .github / lock 文件等。`npm pack --dry-run` 验证 tarball ~30 KB / 10 文件，干净到位。新增 README "Publishing to npm" 一节文档化发布流程。

## [0.4.0] — 2026-05-10

### Added

- **L1-8 Composed sensors on switch devices**: 米家空气净化器 / 加湿器 / 除湿器 等 yzj `category=switch` 设备的 state 同时携带 `temperature` / `humidity` / `aqi` 字段时，主 OnOffOutlet 自动挂三个子 sensor endpoint：
  - `.temp` → `MA_tempsensor (0x0302)` + `TemperatureMeasurement` cluster
  - `.hum` → `MA_humiditysensor (0x0307)` + `RelativeHumidityMeasurement` cluster
  - `.aqi` → `MA_airQualitySensor (0x2c)` + `AirQuality` cluster (PM2.5 → 6 级 EPA AQI 桶映射)

  iOS Apple Home 一台净化器卡片下直接显示温度 / 湿度 / 空气质量读数，无需另开传感器卡片。`aqiToEnum` 阈值跟 EPA AQI sub-index 对齐（≤50 Good，≤100 Fair，≤150 Moderate，≤200 Poor，≤300 VeryPoor，>300 ExtremelyPoor）。

  实现走 Matter "composed device" 模式（addChildDeviceType），跟 Pico keypad 子按键完全同构。SSE state event 携带的 aqi/temperature/humidity 通过 `parent.getChildEndpointByName("temp"|"hum"|"aqi")` 找到对应子端点后 setAttribute。

  实证：xiaomi.357638328（米家净化器）每 30 秒 poll 一轮，AirQuality.airQuality 从 5(VeryPoor) → 4(Poor) 跟随真实 PM2.5 浓度变化。

### Changed

- `endpointMeta` 表新增 `composedTemp` / `composedHumidity` / `composedAqi` 三个布尔，handleDeviceStateChange 按 flag 决定是否要查找子 endpoint 推 measurement。

## [0.3.2] — 2026-05-10

### Fixed

- **`setAttribute cluster not found` 红色噪声日志**：`handleDeviceStateChange` 之前对每个 yzj 状态字段都调 `setAttribute`，无关 cluster 的 endpoint 会在 matterbridge `endpoint.log.error` 上打红色错误（且 helper 直接打 `endpoint.log` 而非传入的 log 参数，没法靠 try/catch 抑制）。新增 `endpointMeta` 表（device_id → category + light flags），SSE 状态分发现在按 category 门控：light 才推 OnOff/LevelControl/ColorControl，cover 才推 WindowCovering，climate 才推 Thermostat，lock 才推 DoorLock，sensor 才推测量 cluster。结果是日志里再没有红色 cluster-not-found 行，只剩 "Set endpoint X attribute Y from a to b" 的正常成功条目。

### Changed

- 接口幂等：移除每段 setAttribute 外面那层冗余 try/catch（cluster 已门控 → 不再可能走错），逻辑更直观。

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
