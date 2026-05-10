/**
 * matterbridge-yzj — Matterbridge plugin that bridges yzj-agent devices into Matter.
 *
 * Architecture:
 *   yzj-agent (Python, FastAPI :9200)
 *     ├─ GET  /api/agent/devices                 enumerate all devices
 *     ├─ GET  /api/agent/devices/{id}            single device
 *     ├─ POST /api/agent/devices/{id}/turn_on    on / open / level=on
 *     ├─ POST /api/agent/devices/{id}/turn_off   off / close
 *     └─ GET  /api/agent/events/stream           SSE: device.{id}.state changes
 *           ↑ HTTP + SSE
 *           │
 *   matterbridge-yzj plugin
 *     · onStart:   pull device list, register one Matter endpoint per yzj Device
 *     · onConfigure:  subscribe SSE → forward state into Matter cluster attributes
 *     · Matter cmd (on/off/moveToLevel/lift/etc.) → POST to yzj agent
 *     · Pico buttons:  composed device with one child momentary switch per button;
 *                      SSE state change with last_event.btn → triggerSwitchEvent
 *
 * Coverage of L1 (Phase 3 polish):
 *   L1-1  Light with state.brightness → DimmableLight + LevelControl + moveToLevel cmd
 *   L1-3  Reachable=false on offline (mirrors yzj Device.online)
 *   L1-4  SSE-driven hot-add: unknown device_id in state event → fetch + register
 *   L1-5  Hot-remove: tracked via removeBridgedEndpoint
 *   L1-6  Pico composed device: one child per button, SSE press → triggerSwitchEvent
 *   L1-7  deviceIdBlocklist config option (e.g. ["xiaomi.979836693"] for Mi AI Speaker)
 */

import {
  airPurifier,
  airQualitySensor,
  bridgedNode,
  colorTemperatureLight,
  contactSensor,
  coverDevice,
  dimmableLight,
  doorLockDevice,
  extendedColorLight,
  genericSwitch,
  humiditySensor,
  MatterbridgeDynamicPlatform,
  MatterbridgeEndpoint,
  occupancySensor,
  onOffLight,
  onOffOutlet,
  temperatureSensor,
  thermostatDevice,
  type PlatformConfig,
  type PlatformMatterbridge,
} from "matterbridge";

import { type AnsiLogger } from "matterbridge/logger";

import { ProfileRouter } from "./profiles/router.js";
import { buildRouter } from "./profiles/register.js";
import type { ProfileContext } from "./profiles/types.js";
import {
  AirQuality,
  BooleanState,
  BridgedDeviceBasicInformation,
  DoorLock,
  FanControl,
  HepaFilterMonitoring,
  LevelControl,
  OccupancySensing,
  OnOff,
  RelativeHumidityMeasurement,
  ResourceMonitoring,
  TemperatureMeasurement,
  Thermostat,
  WindowCovering,
} from "matterbridge/matter/clusters";

// ─────────────────────────────────────────────────────────────────────────────
// yzj-agent IPC types
// ─────────────────────────────────────────────────────────────────────────────

interface YzjDevice {
  device_id: string;
  name: string;
  category: string;
  adapter: string;
  location: string | null;
  online: boolean;
  state: Record<string, unknown>;
}

interface YzjDevicesResponse {
  count: number;
  devices: YzjDevice[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Plugin entrypoint
// ─────────────────────────────────────────────────────────────────────────────

export default function initializePlugin(
  matterbridge: PlatformMatterbridge,
  log: AnsiLogger,
  config: PlatformConfig,
): YzjPlatform {
  return new YzjPlatform(matterbridge, log, config);
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const VID = 0xfff1;            // CSA test VID until our own is approved
const MANUFACTURER = "YZJ";
const MODEL_PREFIX = "YZJ-Bridge";

// Map Matter level (1-254; 0 not valid by spec) ↔ yzj brightness (0-100).
// When light is OFF, OnOff cluster carries on=false and LevelControl.currentLevel
// stays at the last non-zero level (Matter convention). We never write 0.
const matterLevelToYzjBrightness = (level: number): number =>
  Math.max(0, Math.min(100, Math.round((level / 254) * 100)));
const yzjBrightnessToMatterLevel = (b: number): number =>
  Math.max(1, Math.min(254, Math.round((b / 100) * 254)));

// Pico multi-press time windows. Match yzj-host docs/15 (DOUBLE_PRESS_WINDOW_SEC=0.4,
// LONG_PRESS_SEC=0.5) so end-user behavior is consistent across HAP and Matter paths.
const PICO_DOUBLE_WINDOW_MS = 400;
const PICO_LONG_PRESS_MS = 500;

// HSV → RGB. h ∈ [0,360), s/v ∈ [0,1]. Returns [r,g,b] ∈ [0,255].
// Used to translate Matter ColorControl moveToHueAndSaturation requests
// into yzj agent rgb tuples.
function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const c = v * s;
  const hh = (h % 360) / 60;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hh < 1)      [r, g, b] = [c, x, 0];
  else if (hh < 2) [r, g, b] = [x, c, 0];
  else if (hh < 3) [r, g, b] = [0, c, x];
  else if (hh < 4) [r, g, b] = [0, x, c];
  else if (hh < 5) [r, g, b] = [x, 0, c];
  else             [r, g, b] = [c, 0, x];
  const m = v - c;
  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255),
  ];
}

// RGB → Hue/Saturation. Inputs 0-255. Returns [hue 0-360, sat 0-1].
// Used to push yzj rgb state into Matter ColorControl currentHue/currentSaturation.
function rgbToHs(r: number, g: number, b: number): [number, number] {
  const rf = r / 255, gf = g / 255, bf = b / 255;
  const max = Math.max(rf, gf, bf);
  const min = Math.min(rf, gf, bf);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rf) h = ((gf - bf) / d + (gf < bf ? 6 : 0)) * 60;
    else if (max === gf) h = ((bf - rf) / d + 2) * 60;
    else h = ((rf - gf) / d + 4) * 60;
  }
  const s = max === 0 ? 0 : d / max;
  return [h, s];
}

// ─────────────────────────────────────────────────────────────────────────────
// Platform
// ─────────────────────────────────────────────────────────────────────────────

export class YzjPlatform extends MatterbridgeDynamicPlatform {

  /** device_id → { ep, category, light flags, composed sensor flags } so
   *  handleDeviceStateChange can gate setAttribute calls per device-type and
   *  avoid spamming "cluster not found" errors when a sensor SSE event hits
   *  a thermostat endpoint. */
  private endpoints = new Map<string, MatterbridgeEndpoint>();
  private endpointMeta = new Map<string, {
    category: string;
    hasLevelControl: boolean;
    hasColorTemp: boolean;
    hasRgb: boolean;
    /** L1-8 composed sensors: switch-type devices (净化器/加湿器/除湿器) that
     *  also expose temperature/humidity/aqi in their state get child sensor
     *  endpoints alongside the main OnOff. iOS Home renders the parent as
     *  power switch, but a long-press/详情 surfaces the child sensor readings. */
    composedTemp: boolean;
    composedHumidity: boolean;
    composedAqi: boolean;
    /** v0.5.2 起: 滤芯走 HepaFilterMonitoring cluster (条件 0..100 + Ok/Warning/Critical),
     *  不再用 PowerSource Replaceable Battery 假装电池。yzj state.filter_life 0..100。 */
    composedFilterLife: boolean;
    /** v0.5.3: 净化器特征(state.aqi 是数字)→ device-type 升级到 airPurifier,
     *  自带 fanControl cluster。SSE state 同步 percentSetting + fanMode 到 iPhone。 */
    isAirPurifier: boolean;
    /** v0.6.0+: 走 profile framework 时,这两个字段标识哪个 profile 接管,
     *  handleDeviceStateChange 看到 __profile_id 优先调 profile.pushState。
     *  旧 case-by-case 推送逻辑跳过。 */
    __profile_id?: string;
    __profile_meta?: unknown;
  }>();
  private allowedCategories: Set<string>;
  private deviceIdBlocklist: Set<string>;
  private sseAbort: AbortController | null = null;

  /** Per-(deviceId,btn) state machine for Pico multi-press detection.
   *  Key: "deviceId:btn"。Phase 3 — distinguishes Single / Double / Long
   *  from yzj raw press/release stream. */
  private picoState = new Map<string, {
    pressTs: number;          // last press timestamp (0 = idle)
    pendingSingleTimer: NodeJS.Timeout | null;  // fires Single after DOUBLE_WINDOW
    longTimer: NodeJS.Timeout | null;           // fires Long if held > LONG_PRESS_MS
    longFired: boolean;       // track to suppress trailing Single
    lastReleaseTs: number;    // for double-press detection
  }>();

  constructor(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: PlatformConfig) {
    super(matterbridge, log, config);

    this.allowedCategories = new Set((config.categoryAllowlist as string[] | undefined) ?? [
      "light",
      "switch",
      "cover",
      "scene_controller",
      "climate",
      "lock",
      "sensor",
      "camera",  // 暴露 motion 为 OccupancySensor (视频流走 Homebridge 不在 Matter)
    ]);

    this.deviceIdBlocklist = new Set((config.deviceIdBlocklist as string[] | undefined) ?? [
      "xiaomi.979836693",  // Mi AI Speaker Play (音箱不是开关)
      // UniFi Protect 5 摄像头由 homebridge-unifi-protect 暴露 motion,
      // 不在 Matter 重复曝光(双桥会让 iOS 自动化重复触发)。
      "unifi_protect.694cfb6c",  // G5 Turret Ultra
      "unifi_protect.694bf4b0",  // G4 Doorbell Pro PoE
      "unifi_protect.694cf248",  // G5 Bullet
      "unifi_protect.694d22cc",  // G3 Flex
      "unifi_protect.69fee5d8",  // Camera-69fee5d8
    ]);

    // v0.6.0: profile-driven router。具体 profile 命中走新 framework,
    // 没命中(eg. 灯/窗帘/Pico/普通插座/温感等还没迁的)走 index.ts 旧 buildEndpoint switch case。
    this.router = buildRouter();
    this.log.info(
      `yzj-platform init. agentUrl=${this.agentUrl} ` +
      `categories=[${[...this.allowedCategories].join(",")}] ` +
      `blocklist=[${[...this.deviceIdBlocklist].join(",")}] ` +
      `profiles=[${this.router.list().map(p => p.id).join(",")}]`,
    );
  }

  private readonly router: ProfileRouter;

  /** 给 profile 调 yzj-agent / log 用 */
  private profileContext(): ProfileContext {
    return {
      log: this.log,
      agentUrl: this.agentUrl,
      sendCommand: (id, cmd, body) => this.sendCommand(id, cmd, body ?? {}),
      handleCommandSafely: (id, cmd, body) => this.handleCommandSafely(id, cmd, body ?? {}),
    };
  }

  private get agentUrl(): string {
    return (this.config.yzjAgentUrl as string | undefined) ?? "http://127.0.0.1:9200";
  }

  // ─── Lifecycle: onStart ────────────────────────────────────────────────────

  override async onStart(reason?: string): Promise<void> {
    this.log.info(`onStart reason=${reason ?? "none"}`);
    await this.ready;
    await this.clearSelect();

    // L2-3: yzj-agent may not be up yet (launchd doesn't guarantee start order).
    // Retry with backoff until reachable, then proceed. We never block forever —
    // after maxAttempts we register 0 endpoints and rely on SSE reconnect path
    // to discover devices once agent is up.
    const devices = await this.fetchDevicesWithRetry();
    if (devices === null) {
      this.log.warn(
        `yzj-agent at ${this.agentUrl} unreachable after retries; ` +
        `starting with 0 endpoints. SSE reconnect loop will pick up devices when agent is up.`,
      );
      return;
    }

    this.log.info(`yzj-agent returned ${devices.length} device(s)`);

    let registered = 0;
    for (const dev of devices) {
      if (await this.tryRegisterDevice(dev)) registered++;
    }

    this.log.info(`Registered ${registered} yzj device(s) as Matter bridged endpoints`);
  }

  /** Retry yzj-agent /api/agent/devices with exponential backoff. Returns null
   *  after maxAttempts so plugin can start in degraded mode (SSE will recover). */
  private async fetchDevicesWithRetry(maxAttempts = 6): Promise<YzjDevice[] | null> {
    let delay = 1000;  // 1s, 2s, 4s, 8s, 16s, 32s = ~1 min total
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.fetchDevices();
      } catch (err) {
        this.log.warn(
          `Fetch yzj-agent devices attempt ${attempt}/${maxAttempts} failed: ${(err as Error).message}` +
            (attempt < maxAttempts ? `; retry in ${delay / 1000}s` : ""),
        );
        if (attempt >= maxAttempts) return null;
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, 30_000);
      }
    }
    return null;
  }

  // ─── Lifecycle: onConfigure (subscribe SSE) ────────────────────────────────

  override async onConfigure(): Promise<void> {
    await super.onConfigure();
    this.log.info("onConfigure — starting SSE subscription to yzj-agent");
    this.startSseSubscription();
  }

  // ─── Lifecycle: onShutdown ─────────────────────────────────────────────────

  override async onShutdown(reason?: string): Promise<void> {
    await super.onShutdown(reason);
    this.log.info(`onShutdown reason=${reason ?? "none"}`);
    this.sseAbort?.abort();
    this.sseAbort = null;

    if (this.config.unregisterOnShutdown === true) {
      await this.unregisterAllDevices(500);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // yzj-agent HTTP client
  // ─────────────────────────────────────────────────────────────────────────────

  private async fetchDevices(): Promise<YzjDevice[]> {
    const res = await fetch(`${this.agentUrl}/api/agent/devices`);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return ((await res.json()) as YzjDevicesResponse).devices ?? [];
  }

  private async fetchDevice(deviceId: string): Promise<YzjDevice | null> {
    const url = `${this.agentUrl}/api/agent/devices/${encodeURIComponent(deviceId)}`;
    const res = await fetch(url);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as YzjDevice;
  }

  private async sendCommand(
    deviceId: string,
    command: "turn_on" | "turn_off",
    body: Record<string, unknown> = {},
  ): Promise<void> {
    const url = `${this.agentUrl}/api/agent/devices/${encodeURIComponent(deviceId)}/${command}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`yzj-agent ${command} ${deviceId} failed: HTTP ${res.status} ${text.slice(0, 200)}`);
    }
  }

  private async handleCommandSafely(
    deviceId: string,
    command: "turn_on" | "turn_off",
    body: Record<string, unknown> = {},
  ): Promise<void> {
    try {
      await this.sendCommand(deviceId, command, body);
      this.log.info(`${deviceId} ← ${command} ${JSON.stringify(body)}`);
    } catch (err) {
      this.log.error(`${deviceId} ${command} failed: ${(err as Error).message}`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Build Matter endpoints
  // ─────────────────────────────────────────────────────────────────────────────

  private async tryRegisterDevice(dev: YzjDevice): Promise<boolean> {
    if (this.deviceIdBlocklist.has(dev.device_id)) {
      this.log.debug(`Skip ${dev.device_id} (in blocklist)`);
      return false;
    }
    if (!this.allowedCategories.has(dev.category)) {
      this.log.debug(`Skip ${dev.device_id} (category=${dev.category} not in allowlist)`);
      return false;
    }
    if (this.endpoints.has(dev.device_id)) {
      this.log.debug(`Skip ${dev.device_id} (already registered)`);
      return false;
    }

    // v0.6.0: profile router 优先 — 命中具体 profile 就走 framework 路径,
    // 不命中(还没迁的设备类)走下面旧 buildEndpoint switch case 兜底。
    const profile = this.router.match(dev);
    if (profile) {
      try {
        const safeId = dev.device_id.replace(/[^A-Za-z0-9_-]/g, "_");
        const serial = `YZJ-${safeId}`.slice(0, 32);
        const model = `${MODEL_PREFIX}-${dev.category}`;
        const { ep, meta } = await profile.buildEndpoint(dev, this.profileContext(), safeId, serial, model);
        await this.registerDevice(ep);
        this.endpoints.set(dev.device_id, ep);
        // profile 路径 endpointMeta 有 __profile_id,handleDeviceStateChange 看它分流。
        // 同时填一些旧字段兼容,但旧 push 路径在 cat==="switch" 时用 isAirPurifier
        // 等 flag 现在都是 false,自然不命中,所以新 profile 接管不会重复推送。
        this.endpointMeta.set(dev.device_id, {
          category: dev.category,
          hasLevelControl: false,
          hasColorTemp: false,
          hasRgb: false,
          composedTemp: false,
          composedHumidity: false,
          composedAqi: false,
          composedFilterLife: false,
          isAirPurifier: false,
          // profile 标记 — handleDeviceStateChange 拿这个反查路由
          __profile_id: profile.id,
          __profile_meta: meta,
        });
        this.log.info(`Profile route: ${dev.device_id} → ${profile.id}`);
        return true;
      } catch (err) {
        this.log.error(`Profile ${profile.id} failed for ${dev.device_id}: ${(err as Error).message}; falling back to legacy buildEndpoint`);
        // fall through 走旧 buildEndpoint
      }
    }

    try {
      const ep = await this.buildEndpoint(dev);
      if (ep) {
        this.endpoints.set(dev.device_id, ep);
        const hasRgb = Array.isArray(dev.state?.rgb) && (dev.state.rgb as unknown[]).length === 3;
        const hasColorTemp = typeof dev.state?.color_temp === "number";
        const hasLevelControl = dev.category === "light" && (
          hasRgb || hasColorTemp || typeof dev.state?.brightness === "number"
        );
        // L1-8: composed sensors only meaningful on switch devices that carry
        // env readings in their state (米家净化器 / 加湿器 / 除湿器 etc.).
        const composedTemp = dev.category === "switch" && typeof dev.state?.temperature === "number";
        const composedHumidity = dev.category === "switch" && typeof dev.state?.humidity === "number";
        const composedAqi = dev.category === "switch" && typeof dev.state?.aqi === "number";
        const composedFilterLife = dev.category === "switch" && typeof dev.state?.filter_life === "number";
        const isAirPurifier = dev.category === "switch" && typeof dev.state?.aqi === "number";
        this.endpointMeta.set(dev.device_id, {
          category: dev.category,
          hasLevelControl,
          hasColorTemp,
          hasRgb,
          composedTemp,
          composedHumidity,
          composedAqi,
          composedFilterLife,
          isAirPurifier,
        });
        return true;
      }
    } catch (err) {
      this.log.error(`Failed to register ${dev.device_id}: ${(err as Error).message}`);
    }
    return false;
  }

  private async buildEndpoint(dev: YzjDevice): Promise<MatterbridgeEndpoint | null> {
    const safeId = dev.device_id.replace(/[^A-Za-z0-9_-]/g, "_");
    const serial = `YZJ-${safeId}`.slice(0, 32);
    const model = `${MODEL_PREFIX}-${dev.category}`;
    const debug = this.config.debug as boolean | undefined;

    let ep: MatterbridgeEndpoint;

    switch (dev.category) {

      case "light": {
        // L1-1 + L1-2: detect color/RGB capability and choose richest cluster.
        // yzj convention (per agent/core/devices.py Light schema):
        //   state: { on, brightness, color_temp?(mired), rgb?[r,g,b] }
        // Priority:
        //   - state.rgb (3-tuple) → ExtendedColorLight (full color picker on iOS)
        //   - state.color_temp present → ColorTemperatureLight (warm/cool slider)
        //   - state.brightness → DimmableLight (brightness slider)
        //   - else → OnOffLight
        const hasRgb = Array.isArray(dev.state?.rgb) && (dev.state.rgb as unknown[]).length === 3;
        const hasColorTemp = typeof dev.state?.color_temp === "number";
        const dimmable = typeof dev.state?.brightness === "number";

        const lightType = hasRgb ? extendedColorLight
                        : hasColorTemp ? colorTemperatureLight
                        : dimmable ? dimmableLight
                        : onOffLight;

        ep = new MatterbridgeEndpoint([lightType, bridgedNode], { id: safeId }, debug);
        ep.createDefaultIdentifyClusterServer()
          .createDefaultBridgedDeviceBasicInformationClusterServer(dev.name, serial, VID, MANUFACTURER, model)
          .createDefaultGroupsClusterServer()
          .createDefaultOnOffClusterServer(this.deriveOnOff(dev));

        if (dimmable || hasColorTemp || hasRgb) {
          const initialLevel = yzjBrightnessToMatterLevel((dev.state.brightness as number) || 0);
          ep.createDefaultLevelControlClusterServer(initialLevel);
        }

        ep.addRequiredClusterServers();

        ep.addCommandHandler("on", async () => {
          await this.handleCommandSafely(dev.device_id, "turn_on", {});
        });
        ep.addCommandHandler("off", async () => {
          await this.handleCommandSafely(dev.device_id, "turn_off", {});
        });

        if (dimmable || hasColorTemp || hasRgb) {
          ep.addCommandHandler("moveToLevel", async ({ request: { level } }: { request: { level: number } }) => {
            const brightness = matterLevelToYzjBrightness(level);
            await this.handleCommandSafely(dev.device_id, "turn_on", { brightness });
          });
          ep.addCommandHandler("moveToLevelWithOnOff", async ({ request: { level } }: { request: { level: number } }) => {
            const brightness = matterLevelToYzjBrightness(level);
            if (brightness === 0) {
              await this.handleCommandSafely(dev.device_id, "turn_off", {});
            } else {
              await this.handleCommandSafely(dev.device_id, "turn_on", { brightness });
            }
          });
        }

        if (hasColorTemp) {
          // Matter mireds (153-500 = 6500K-2000K) ↔ yzj mired same
          ep.addCommandHandler("moveToColorTemperature", async ({ request: { colorTemperatureMireds } }: { request: { colorTemperatureMireds: number } }) => {
            await this.handleCommandSafely(dev.device_id, "turn_on", { color_temp: colorTemperatureMireds });
          });
        }

        if (hasRgb) {
          // Matter HSV (hue 0-254, sat 0-254) → yzj rgb [r,g,b] 0-255
          ep.addCommandHandler("moveToHueAndSaturation", async ({ request: { hue, saturation } }: { request: { hue: number; saturation: number } }) => {
            const rgb = hsvToRgb(hue / 254 * 360, saturation / 254, 1);
            await this.handleCommandSafely(dev.device_id, "turn_on", { rgb });
          });
        }
        break;
      }

      case "climate": {
        // yzj Climate state: { on, mode, target_temp, current_temp }
        // 红外空调 / 地暖 / 米家 AC. Map to Matter Thermostat with cooling+heating
        // setpoints. iOS Home shows temperature controls + mode picker.
        // 注意:matterbridge createDefaultHeatingThermostatClusterServer 助手内部
        // 对入参做 ×100,所以这里传摄氏度原值(不是 centi-℃),否则会溢出 int16。
        const targetTemp = (dev.state?.target_temp as number) ?? 26;
        const currentTemp = (dev.state?.current_temp as number) ?? 25;

        ep = new MatterbridgeEndpoint([thermostatDevice, bridgedNode], { id: safeId }, debug);
        ep.createDefaultIdentifyClusterServer()
          .createDefaultBridgedDeviceBasicInformationClusterServer(dev.name, serial, VID, MANUFACTURER, model)
          .createDefaultGroupsClusterServer();
        ep.createDefaultHeatingThermostatClusterServer(currentTemp, targetTemp, 16, 30);
        ep.addRequiredClusterServers();

        // SetpointRaiseLower: amount is signed int8 in 0.1°C steps. We turn into
        // an absolute target_temp by reading current and adding amount/10.
        ep.addCommandHandler("setpointRaiseLower", async ({ request }: { request: { mode: number; amount: number } }) => {
          const cur = (dev.state?.target_temp as number) ?? 26;
          const newTarget = Math.max(16, Math.min(30, cur + request.amount / 10));
          await this.handleCommandSafely(dev.device_id, "turn_on", { target_temp: newTarget });
        });
        break;
      }

      case "lock": {
        // yzj Lock state: { locked: bool, battery_pct: int }
        ep = new MatterbridgeEndpoint([doorLockDevice, bridgedNode], { id: safeId }, debug);
        const initialLocked = dev.state?.locked === true;
        ep.createDefaultIdentifyClusterServer()
          .createDefaultBridgedDeviceBasicInformationClusterServer(dev.name, serial, VID, MANUFACTURER, model)
          .createDefaultDoorLockClusterServer(
            initialLocked ? DoorLock.LockState.Locked : DoorLock.LockState.Unlocked,
            DoorLock.LockType.DeadBolt,
          )
          .addRequiredClusterServers();

        ep.addCommandHandler("lockDoor", async () => {
          await this.handleCommandSafely(dev.device_id, "turn_on", {}); // turn_on = lock
        });
        ep.addCommandHandler("unlockDoor", async () => {
          await this.handleCommandSafely(dev.device_id, "turn_off", {}); // turn_off = unlock
        });
        break;
      }

      case "sensor": {
        // yzj Sensor state: { value: any, unit: str }
        // Choose Matter cluster by unit string (extensible — fall back to contact sensor).
        const unit = (dev.state?.unit as string | undefined)?.toLowerCase() ?? "";
        const value = dev.state?.value;
        const isTemp = ["c", "°c", "celsius", "f", "fahrenheit"].some(u => unit.includes(u));
        const isHumidity = ["%", "rh", "humidity"].some(u => unit.includes(u));
        const isAir = ["aqi", "pm", "co2", "voc"].some(u => unit.includes(u));

        const sensorType = isTemp ? temperatureSensor : isHumidity ? humiditySensor : isAir ? airQualitySensor : contactSensor;
        ep = new MatterbridgeEndpoint([sensorType, bridgedNode], { id: safeId }, debug);
        ep.createDefaultIdentifyClusterServer()
          .createDefaultBridgedDeviceBasicInformationClusterServer(dev.name, serial, VID, MANUFACTURER, model);

        if (isTemp && typeof value === "number") {
          ep.createDefaultTemperatureMeasurementClusterServer(Math.round(value * 100));
        } else if (isHumidity && typeof value === "number") {
          ep.createDefaultRelativeHumidityMeasurementClusterServer(Math.round(value * 100));
        } else if (isAir) {
          ep.createDefaultAirQualityClusterServer();
        } else {
          ep.createDefaultBooleanStateClusterServer(true);
        }
        ep.addRequiredClusterServers();
        break;
      }

      case "switch": {
        // L1-8 / v0.5.2: 净化器特征探测 — yzj category=switch + state 含 aqi 字段 →
        // 用 Matter 真正的 airPurifier device-type (MA_airPurifier 0x002D),
        // 不再用 onOffOutlet。iOS Apple Home 18+ 识别 air purifier,出独立的"净化器"
        // 卡片图标(不是插座)。滤芯走 HepaFilterMonitoring cluster(不再用
        // PowerSource Replaceable Battery 假装电池 — 那种用法语义错,iOS 显示
        // "电池电量低" 误导客户以为真没电了。
        const isAirPurifier = typeof dev.state?.aqi === "number";

        if (isAirPurifier) {
          ep = new MatterbridgeEndpoint([airPurifier, bridgedNode], { id: safeId }, debug);
          ep.createDefaultIdentifyClusterServer()
            .createDefaultBridgedDeviceBasicInformationClusterServer(dev.name, serial, VID, MANUFACTURER, model)
            .createDefaultGroupsClusterServer()
            .createDefaultOnOffClusterServer(this.deriveOnOff(dev));

          // FanControl cluster — 用 MultiSpeed 版,因为米家净化器 favorite_level 是 0..16
          // 多档位,正好匹配 Matter MultiSpeed feature。同时 Auto feature 让 iOS 显示
          // "Auto" 模式选项,匹配米家 mode=auto。
          const initFm = this.yzjModeToMatterFanMode(
            dev.state?.mode as string | undefined,
            dev.state?.favorite_level as number | undefined,
          );
          const initFavLevel = (dev.state?.favorite_level as number | undefined) ?? 0;
          const initPct = Math.max(0, Math.min(100, Math.round((initFavLevel / 16) * 100)));
          ep.createMultiSpeedFanControlClusterServer(
            initFm,
            FanControl.FanModeSequence.OffLowMedHighAuto,
            initPct,                 // percentSetting (iPhone 滑块写这个 0..100)
            initPct,                 // percentCurrent (read-only echo)
            16,                      // speedMax (米家 favorite_level 上限)
            initFavLevel,            // speedSetting (iPhone 档位写这个 0..speedMax)
            initFavLevel,            // speedCurrent (read-only echo)
          );

          // HepaFilterMonitoring cluster: 滤芯 condition (0..100) + Ok/Warning/Critical
          if (typeof dev.state?.filter_life === "number") {
            const flLife = Math.max(0, Math.min(100, dev.state.filter_life as number));
            ep.createDefaultHepaFilterMonitoringClusterServer(
              flLife,
              this.filterLifeToChangeIndication(flLife),
              true,                  // inPlaceIndicator: 滤芯安装着
              null,                  // lastChangedTime 不知道
              [],                    // replacementProductList: HEPA 部件号清单(暂空)
            );
          }
        } else {
          // 普通插座 / 单路开关 (无 aqi 字段) → onOffOutlet
          ep = new MatterbridgeEndpoint([onOffOutlet, bridgedNode], { id: safeId }, debug);
          ep.createDefaultIdentifyClusterServer()
            .createDefaultBridgedDeviceBasicInformationClusterServer(dev.name, serial, VID, MANUFACTURER, model)
            .createDefaultGroupsClusterServer()
            .createDefaultOnOffClusterServer(this.deriveOnOff(dev));
        }
        ep.addRequiredClusterServers();

        ep.addCommandHandler("on", async () => {
          await this.handleCommandSafely(dev.device_id, "turn_on", {});
        });
        ep.addCommandHandler("off", async () => {
          await this.handleCommandSafely(dev.device_id, "turn_off", {});
        });

        // v0.5.3: airPurifier fanControl attribute write listener。
        // iPhone Apple Home 拉风速滑块 / 选风速档 → matter.js 写 percentSetting / fanMode,
        // subscribeAttribute 触发 listener 路由到 yzj-agent 米家命令(set_favorite_level + set_mode)。
        if (isAirPurifier) {
          // 风速百分比 → 米家 favorite_level (0-16)
          ep.subscribeAttribute(
            "fanControl",
            "percentSetting",
            async (newVal: number, oldVal: number) => {
              if (typeof newVal !== "number" || newVal === oldVal) return;
              if (newVal === 0) return; // 0% 走 OnOff cluster off,这边不重复发
              const level = Math.max(1, Math.min(16, Math.round((newVal / 100) * 16)));
              await this.handleCommandSafely(dev.device_id, "turn_on", {
                mode: "favorite",
                favorite_level: level,
              });
            },
            this.log,
          );

          // 风速模式枚举 → 米家 mode
          ep.subscribeAttribute(
            "fanControl",
            "fanMode",
            async (newVal: FanControl.FanMode, oldVal: FanControl.FanMode) => {
              if (newVal === oldVal) return;
              const yzjMode = this.matterFanModeToYzjMode(newVal);
              if (!yzjMode) return; // Off 走 OnOff,不在这处理
              await this.handleCommandSafely(dev.device_id, "turn_on", { mode: yzjMode });
            },
            this.log,
          );
        }

        // 复合子 sensor: 净化器 / 加湿器 等同时携带 temperature / humidity / aqi 时挂上,
        // iOS 卡片下方显示读数。
        if (typeof dev.state?.temperature === "number") {
          const tempChild = ep.addChildDeviceType("temp", [temperatureSensor], {});
          tempChild
            .createDefaultIdentifyClusterServer()
            .createDefaultTemperatureMeasurementClusterServer(Math.round((dev.state.temperature as number) * 100));
        }
        if (typeof dev.state?.humidity === "number") {
          const humChild = ep.addChildDeviceType("hum", [humiditySensor], {});
          humChild
            .createDefaultIdentifyClusterServer()
            .createDefaultRelativeHumidityMeasurementClusterServer(Math.round((dev.state.humidity as number) * 100));
        }
        if (typeof dev.state?.aqi === "number") {
          const aqChild = ep.addChildDeviceType("aqi", [airQualitySensor], {});
          aqChild
            .createDefaultIdentifyClusterServer()
            .createDefaultAirQualityClusterServer(this.aqiToEnum(dev.state.aqi as number));
        }
        break;
      }

      case "cover": {
        // yzj Cover state: { position: 0..100 (0=closed,100=open), moving: bool }
        // Matter currentPositionLiftPercent100ths: 0..10000, 0=open, 10000=closed.
        const yzjPosition = (dev.state?.position as number | undefined) ?? 0;
        const initialLiftPct = Math.max(0, Math.min(10000, Math.round((100 - yzjPosition) * 100)));

        ep = new MatterbridgeEndpoint([coverDevice, bridgedNode], { id: safeId }, debug);
        ep.createDefaultIdentifyClusterServer()
          .createDefaultBridgedDeviceBasicInformationClusterServer(dev.name, serial, VID, MANUFACTURER, model)
          .createDefaultGroupsClusterServer()
          .createDefaultWindowCoveringClusterServer(initialLiftPct);
        ep.addRequiredClusterServers();

        ep.addCommandHandler("upOrOpen", async () => {
          await this.handleCommandSafely(dev.device_id, "turn_on", {});
        });
        ep.addCommandHandler("downOrClose", async () => {
          await this.handleCommandSafely(dev.device_id, "turn_off", {});
        });
        ep.addCommandHandler("stopMotion", async () => {
          // yzj 目前没暴露 stop;退化:发一次 turn_on 让本地控制器 hold 当前位置(米家窗帘行为)。
          this.log.debug(`cover ${dev.device_id} stopMotion: not natively supported by yzj-agent`);
        });
        // L1-2 percentage: iOS 拖动百分比时发 goToLiftPercentage(liftPercent100thsValue 0-10000)。
        // Matter 0=open, 10000=closed → yzj position = 100 - pct/100。
        ep.addCommandHandler(
          "goToLiftPercentage",
          async ({ request: { liftPercent100thsValue } }: { request: { liftPercent100thsValue: number } }) => {
            const yzjPos = Math.max(0, Math.min(100, Math.round(100 - liftPercent100thsValue / 100)));
            // yzj 自定义协议:position 通过 turn_on body.position 字段传(adapters 自行解释)。
            await this.handleCommandSafely(dev.device_id, "turn_on", { position: yzjPos });
          },
        );
        break;
      }

      case "camera": {
        // L1-10: 仅把摄像头的 motion (PIR / VMD 运动检测) 暴露成 Matter OccupancySensor。
        //   - 视频流 / 录像 / live view 不走 Matter (Apple Home 1.5 spec 仅初步支持
        //     Matter Camera, 远未稳定),那边走 homebridge-unifi-protect /
        //     homebridge-hikvision-yzj 各自专属 plugin。
        //   - yzj-agent 海康 adapter 在 state.motion (boolean) 维护实时 PIR 状态,
        //     SSE 推 state.last_event = {type:"VMD", state:"active|inactive"} 时同步翻
        //     state.motion。本 plugin SSE handler 把这个翻给 OccupancySensing.occupied。
        //
        // categoryAllowlist 配置侧:把 "camera" 加进 allowlist,但 plugin 配置可
        // 通过 deviceIdBlocklist 排除"我不想暴露 motion"的摄像头(eg. UniFi
        // 5 台 Protect 已经有 hb-unifi-protect 在跑 motion sensor,加进 blocklist 防双桥)。
        const initialMotion = dev.state?.motion === true;
        ep = new MatterbridgeEndpoint([occupancySensor, bridgedNode], { id: safeId }, debug);
        ep.createDefaultIdentifyClusterServer()
          .createDefaultBridgedDeviceBasicInformationClusterServer(dev.name, serial, VID, MANUFACTURER, model)
          .createDefaultOccupancySensingClusterServer(initialMotion);
        ep.addRequiredClusterServers();
        // 摄像头 motion 是只读传感器,无 command handler。
        break;
      }

      case "scene_controller": {
        // L1-6: Pico = composed device with one child per physical button.
        // Each child is a MomentarySwitch. SSE state change → triggerSwitchEvent.
        const buttons = (dev.state?.buttons as number[] | undefined) ?? [];
        const labels = (dev.state?.btn_labels as Record<string, string> | undefined) ?? {};

        ep = new MatterbridgeEndpoint([bridgedNode], { id: safeId }, debug);
        ep.createDefaultBridgedDeviceBasicInformationClusterServer(dev.name, serial, VID, MANUFACTURER, model);
        ep.addFixedLabel("composed", "Pico keypad");

        for (const btn of buttons) {
          const btnLabel = labels[String(btn)] ?? `Button ${btn}`;
          const child = ep.addChildDeviceType(
            `btn-${btn}`,
            [genericSwitch],
            {},
          );
          child
            .createDefaultIdentifyClusterServer()
            .createDefaultMomentarySwitchClusterServer();
        }

        // No on/off command handler — Pico is read-only (we only push events).
        break;
      }

      default:
        this.log.warn(`Unsupported category '${dev.category}' for ${dev.device_id}`);
        return null;
    }

    await this.registerDevice(ep);
    return ep;
  }

  /** filter_life (0..100 剩余 %) → ResourceMonitoring.ChangeIndication 三档。
   *  iOS Apple Home 在 Warning/Critical 时弹"该换 HEPA 滤芯了"通知。
   *  注:不再用 PowerSource.BatChargeLevel(那种用法 iOS 显示成"电池电量低",
   *  误导客户以为电源出问题)。HepaFilterMonitoring cluster 是 Matter spec
   *  专门给净化器 / 空调滤网 / 加湿器水槽这类耗材设计的。 */
  private filterLifeToChangeIndication(life: number): ResourceMonitoring.ChangeIndication {
    if (life > 30) return ResourceMonitoring.ChangeIndication.Ok;
    if (life > 10) return ResourceMonitoring.ChangeIndication.Warning;
    return ResourceMonitoring.ChangeIndication.Critical;
  }

  /** Matter FanControl.FanMode → 米家空气净化器 mode 字符串。
   *  米家枚举 (从 yzj xiaomi adapter OperationMode):
   *    auto / silent / favorite / idle
   *  Apple Home iOS 卡片显示 fanMode 选择器,我们映射:
   *    Off    → null   (走 OnOff cluster,不在这管)
   *    Low    → silent
   *    Medium / High / On → favorite (favorite_level 由 percentSetting 一起决定)
   *    Auto / Smart → auto
   */
  private matterFanModeToYzjMode(fm: FanControl.FanMode): string | null {
    switch (fm) {
      case FanControl.FanMode.Off:    return null;
      case FanControl.FanMode.Low:    return "silent";
      case FanControl.FanMode.Medium: return "favorite";
      case FanControl.FanMode.High:   return "favorite";
      case FanControl.FanMode.On:     return "favorite";
      case FanControl.FanMode.Auto:   return "auto";
      case FanControl.FanMode.Smart:  return "auto";
      default: return null;
    }
  }

  /** 反向: yzj 米家 mode + favorite_level → Matter FanMode。
   *  在 buildEndpoint 初始化时给 fanControl 设默认值用,
   *  以及 SSE 状态推送回 iPhone 时更新 fanMode attribute。 */
  private yzjModeToMatterFanMode(yzjMode: string | undefined, favLevel: number | undefined): FanControl.FanMode {
    switch ((yzjMode || "").toLowerCase()) {
      case "auto":     return FanControl.FanMode.Auto;
      case "silent":   return FanControl.FanMode.Low;
      case "favorite":
        if (typeof favLevel === "number") {
          if (favLevel <= 5)  return FanControl.FanMode.Low;
          if (favLevel <= 11) return FanControl.FanMode.Medium;
          return FanControl.FanMode.High;
        }
        return FanControl.FanMode.Medium;
      case "idle":     return FanControl.FanMode.Off;
      default:         return FanControl.FanMode.Auto;
    }
  }

  /** AQI (PM2.5 μg/m³) → Matter AirQualityEnum 6 级桶。
   *  阈值参考 EPA AQI 表 (PM2.5 sub-index):
   *    Good 0..50  Fair 51..100  Moderate 101..150  Poor 151..200
   *    VeryPoor 201..300  ExtremelyPoor 300+
   *  净化器场景 aqi 是直接 PM2.5 浓度,跟 EPA AQI 数轴近似。 */
  private aqiToEnum(aqi: number): AirQuality.AirQualityEnum {
    if (aqi <= 50)  return AirQuality.AirQualityEnum.Good;
    if (aqi <= 100) return AirQuality.AirQualityEnum.Fair;
    if (aqi <= 150) return AirQuality.AirQualityEnum.Moderate;
    if (aqi <= 200) return AirQuality.AirQualityEnum.Poor;
    if (aqi <= 300) return AirQuality.AirQualityEnum.VeryPoor;
    return AirQuality.AirQualityEnum.ExtremelyPoor;
  }

  /** yzj device.state varies per adapter for on/off representation. */
  private deriveOnOff(dev: YzjDevice): boolean {
    const s = dev.state ?? {};
    if (typeof s.on === "boolean") return s.on;
    if (typeof s.power === "string") return s.power.toLowerCase() === "on";
    if (typeof s.value === "boolean") return s.value;
    if (typeof s.brightness === "number") return s.brightness > 0;
    if (typeof s.switch === "boolean") return s.switch;
    return false;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SSE: state changes + hot add/remove
  // ─────────────────────────────────────────────────────────────────────────────

  private startSseSubscription(): void {
    this.sseAbort = new AbortController();
    const abort = this.sseAbort;
    let consecutiveFailures = 0;

    void (async () => {
      while (!abort.signal.aborted) {
        try {
          // L2-5: on (re)connect, do a full state sync so we don't miss state
          // changes that happened during the disconnect window. First-connect
          // sync is a no-op if onStart already pulled devices; we still re-fetch
          // current state to catch any updates between onStart and onConfigure.
          await this.fullStateSync();

          consecutiveFailures = 0;
          await this.runSseLoop(abort.signal);
        } catch (err) {
          if (abort.signal.aborted) return;

          consecutiveFailures++;
          // Backoff: 5s for first few, then 15s, 30s, capped at 60s.
          const delay = consecutiveFailures <= 2 ? 5000 : consecutiveFailures <= 5 ? 15_000 : Math.min(60_000, consecutiveFailures * 10_000);
          // Aggregate repeat errors: log only on transitions and every 5th retry.
          if (consecutiveFailures <= 3 || consecutiveFailures % 5 === 0) {
            this.log.warn(`SSE disconnected (${(err as Error).message}); failure #${consecutiveFailures}, retry in ${delay / 1000}s`);
          }
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    })();
  }

  /** Pull current device list and reconcile state for already-registered
   *  endpoints. Hot-add for new devices that appeared while we were
   *  disconnected. Hot-remove handled lazily — devices that have disappeared
   *  in yzj-agent stay registered as Reachable=false until next plugin restart. */
  private async fullStateSync(): Promise<void> {
    let devices: YzjDevice[];
    try {
      devices = await this.fetchDevices();
    } catch (err) {
      throw new Error(`fullStateSync fetch failed: ${(err as Error).message}`);
    }

    const seen = new Set<string>();
    let added = 0;
    let synced = 0;
    let removed = 0;

    for (const dev of devices) {
      seen.add(dev.device_id);

      if (this.endpoints.has(dev.device_id)) {
        // Already registered — just push state change (covers state drift
        // during disconnect).
        await this.handleDeviceStateChange(dev.device_id, { ...dev.state, online: dev.online });
        synced++;
      } else if (await this.tryRegisterDevice(dev)) {
        added++;
      }
    }

    // Devices that disappeared from yzj registry → unregister Matter endpoint。
    // 之前的策略是只标 Reachable=false 给设备短暂掉线缓冲,但实战发现:
    //   - Mock adapter 关掉(YZJ_USE_MOCK_ADAPTERS≠1) → 假设备应该从 iOS 家庭 app
    //     彻底消失,不能停留 "Reachable=false" 占着位置
    //   - Adapter yaml 删了一台设备 → 该端点应该一并清掉
    //   - Adapter 真断网了短暂消失 → 短暂设个 reachable=false 也无伤,但 plugin
    //     重启 SSE 重连必触发 fullStateSync,真断网用 yzj-agent 自己的 online=false
    //     字段 (handleDeviceStateChange 那边继续 mirror 到 reachable),走 SSE 路径。
    // 所以 fullStateSync 的语义是 "yzj registry 是真相",从 registry 消失的端点
    // 一律 unregister。
    for (const [deviceId, ep] of this.endpoints) {
      if (!seen.has(deviceId)) {
        try {
          await this.unregisterDevice(ep);
          this.endpoints.delete(deviceId);
          this.endpointMeta.delete(deviceId);
          removed++;
          this.log.info(`fullStateSync: removed ${deviceId} (no longer in yzj registry)`);
        } catch (err) {
          this.log.error(`fullStateSync: unregister ${deviceId} failed: ${(err as Error).message}`);
        }
      }
    }

    if (added > 0 || removed > 0 || this.endpoints.size > 0) {
      this.log.info(
        `fullStateSync: synced=${synced} added=${added} removed=${removed} (total=${this.endpoints.size})`,
      );
    }
  }

  private async runSseLoop(abort: AbortSignal): Promise<void> {
    const res = await fetch(`${this.agentUrl}/api/agent/events/stream`, {
      headers: { Accept: "text/event-stream" },
      signal: abort,
    });

    if (!res.ok || res.body === null) throw new Error(`SSE HTTP ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (!abort.aborted) {
      const { value, done } = await reader.read();
      if (done) throw new Error("SSE stream ended");
      buffer += decoder.decode(value, { stream: true });

      let idx;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        void this.handleSseBlock(block);
      }
    }
  }

  private async handleSseBlock(block: string): Promise<void> {
    const dataLines = block
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim());

    if (dataLines.length === 0) return;

    let payload: { topic?: string; payload?: Record<string, unknown> };
    try {
      payload = JSON.parse(dataLines.join("\n"));
    } catch {
      return;
    }

    const topic = payload.topic;
    if (!topic) return;

    // device.{device_id}.state — main path: state changes
    const stateMatch = /^device\.(.+)\.state$/.exec(topic);
    if (stateMatch) {
      const deviceId = stateMatch[1];
      const state = (payload.payload ?? {}) as Record<string, unknown>;
      await this.handleDeviceStateChange(deviceId, state);
      return;
    }

    // adapter.*.{thing}_added — hot add (Phase 3 feature; yzj currently only
    // emits this for hikvision but pattern generalizes).
    if (/^adapter\.[^.]+\.[^.]*added/.test(topic)) {
      const newDeviceId = (payload.payload as { device_id?: string } | undefined)?.device_id;
      if (newDeviceId) {
        await this.handleHotAdd(newDeviceId);
      }
      return;
    }

    // adapter.*.{thing}_removed — hot remove
    if (/^adapter\.[^.]+\.[^.]*removed/.test(topic)) {
      const removedId = (payload.payload as { device_id?: string } | undefined)?.device_id;
      if (removedId) {
        await this.handleHotRemove(removedId);
      }
      return;
    }
  }

  private async handleDeviceStateChange(deviceId: string, state: Record<string, unknown>): Promise<void> {
    let ep = this.endpoints.get(deviceId);

    // L1-4: hot-add — first state event for unknown device → register on the fly
    if (!ep) {
      this.log.debug(`Unknown device ${deviceId} in state event; attempting hot register`);
      const dev = await this.fetchDevice(deviceId).catch(() => null);
      if (!dev) return;
      const ok = await this.tryRegisterDevice(dev);
      if (!ok) return;
      ep = this.endpoints.get(deviceId)!;
    }

    const meta = this.endpointMeta.get(deviceId);
    const cat = meta?.category ?? "";

    // v0.6.0: profile router 命中过的端点 → 走 profile.pushState 完整状态推送,
    // 跳过下面的旧 case-by-case 分发。
    if (meta?.__profile_id) {
      const profile = this.router.profileById(meta.__profile_id);
      if (profile) {
        try {
          await profile.pushState(ep, meta.__profile_meta as Record<string, unknown>, state, this.profileContext());
        } catch (err) {
          this.log.error(`Profile ${profile.id} pushState failed for ${deviceId}: ${(err as Error).message}`);
        }
        return;
      }
    }

    // L1-3: Reachable mirror — yzj.online → BridgedDeviceBasicInformation.Reachable
    // (every bridged endpoint has BridgedDeviceBasicInformation by definition).
    if (typeof state.online === "boolean") {
      try {
        await ep.setAttribute(BridgedDeviceBasicInformation.Cluster.id, "reachable", state.online, this.log);
      } catch { /* shouldn't happen */ }
    }

    // OnOff state push — only for categories that have OnOff cluster:
    // light / switch / cover (cover has it via WindowCovering? actually no — skip cover).
    if (cat === "light" || cat === "switch") {
      const onOff = this.deriveOnOff({ state } as YzjDevice);
      await ep.setAttribute(OnOff.Cluster.id, "onOff", onOff, this.log);
    }

    // L1-8 composed sensors push (switch parent → child sensor endpoints).
    // Use getChildEndpointByName to grab the matching child created at build time.
    if (cat === "switch") {
      if (meta?.composedTemp && typeof state.temperature === "number") {
        const child = ep.getChildEndpointByName("temp");
        if (child) {
          await child.setAttribute(TemperatureMeasurement.Cluster.id, "measuredValue", Math.round(state.temperature * 100), this.log);
        }
      }
      if (meta?.composedHumidity && typeof state.humidity === "number") {
        const child = ep.getChildEndpointByName("hum");
        if (child) {
          await child.setAttribute(RelativeHumidityMeasurement.Cluster.id, "measuredValue", Math.round(state.humidity * 100), this.log);
        }
      }
      if (meta?.composedAqi && typeof state.aqi === "number") {
        const child = ep.getChildEndpointByName("aqi");
        if (child) {
          await child.setAttribute(AirQuality.Cluster.id, "airQuality", this.aqiToEnum(state.aqi), this.log);
        }
      }
      // v0.5.2: filter_life → HepaFilterMonitoring cluster (parent endpoint)。
      // 改用 ResourceMonitoring (HepaFilter sub-cluster) 代替之前的 PowerSource 假电池,
      // iOS 不再误认为"电池电量低"。HepaFilterMonitoring 才是 Matter spec 给净化器
      // 滤芯设计的正确语义。
      if (meta?.composedFilterLife && typeof state.filter_life === "number") {
        const flLife = Math.max(0, Math.min(100, state.filter_life));
        await ep.setAttribute(HepaFilterMonitoring.Cluster.id, "condition", flLife, this.log);
        await ep.setAttribute(
          HepaFilterMonitoring.Cluster.id,
          "changeIndication",
          this.filterLifeToChangeIndication(flLife),
          this.log,
        );
      }

      // v0.5.3: 净化器 fanControl 状态回传 — 米家端(物理面板 / 米家 App / yzj 手机端)
      // 改了 favorite_level / mode 时,SSE 推过来,我们把 percentSetting + fanMode 也
      // 同步到 Matter cluster,iPhone Apple 家庭 app 跟着刷新风速档。
      // 注意:写 percentSetting 会触发 subscribeAttribute listener 回头 POST yzj
      // (newVal === oldVal 短路),但我们刚从 yzj 收到的就是这值,这条短路命中,
      // 不会形成回环。
      if (meta?.isAirPurifier) {
        if (typeof state.favorite_level === "number") {
          const level = Math.max(0, Math.min(16, state.favorite_level));
          const pct = Math.round((level / 16) * 100);
          await ep.setAttribute("fanControl", "percentSetting", pct, this.log);
          await ep.setAttribute("fanControl", "percentCurrent", pct, this.log);
        }
        if (typeof state.mode === "string") {
          const fm = this.yzjModeToMatterFanMode(state.mode, state.favorite_level as number | undefined);
          await ep.setAttribute("fanControl", "fanMode", fm, this.log);
        }
      }
    }

    // Brightness → LevelControl (light only, and only if light advertised dimming).
    if (cat === "light" && meta?.hasLevelControl &&
        typeof state.brightness === "number" && state.brightness > 0) {
      const matterLevel = yzjBrightnessToMatterLevel(state.brightness);
      await ep.setAttribute(LevelControl.Cluster.id, "currentLevel", matterLevel, this.log);
    }

    // Position → WindowCovering (cover only).
    if (cat === "cover" && typeof state.position === "number") {
      const pct100ths = Math.max(0, Math.min(10000, Math.round((100 - state.position) * 100)));
      await ep.setAttribute(WindowCovering.Cluster.id, "currentPositionLiftPercent100ths", pct100ths, this.log);
      await ep.setAttribute(WindowCovering.Cluster.id, "targetPositionLiftPercent100ths", pct100ths, this.log);
    }

    // Color temperature → ColorControl.colorTemperatureMireds (light with CT only).
    if (cat === "light" && meta?.hasColorTemp && typeof state.color_temp === "number") {
      await ep.setAttribute(
        "colorControl",
        "colorTemperatureMireds",
        Math.max(153, Math.min(500, Math.round(state.color_temp))),
        this.log,
      );
    }

    // RGB → ColorControl.currentHue/currentSaturation (light with RGB only).
    if (cat === "light" && meta?.hasRgb &&
        Array.isArray(state.rgb) && (state.rgb as unknown[]).length === 3) {
      const [r, g, b] = (state.rgb as number[]).map((v) => Math.max(0, Math.min(255, v)));
      const [h, s] = rgbToHs(r, g, b);
      await ep.setAttribute("colorControl", "currentHue", Math.round((h / 360) * 254), this.log);
      await ep.setAttribute("colorControl", "currentSaturation", Math.round(s * 254), this.log);
    }

    // Climate state push → Thermostat cluster (climate only).
    if (cat === "climate") {
      if (typeof state.current_temp === "number") {
        await ep.setAttribute(Thermostat.Cluster.id, "localTemperature", Math.round(state.current_temp * 100), this.log);
      }
      if (typeof state.target_temp === "number") {
        await ep.setAttribute(Thermostat.Cluster.id, "occupiedHeatingSetpoint", Math.round(state.target_temp * 100), this.log);
      }
    }

    // Lock state push → DoorLock cluster (lock only).
    if (cat === "lock" && typeof state.locked === "boolean") {
      await ep.setAttribute(
        DoorLock.Cluster.id,
        "lockState",
        state.locked ? DoorLock.LockState.Locked : DoorLock.LockState.Unlocked,
        this.log,
      );
    }

    // Sensor value push (sensor category only). Pick measurement cluster by unit.
    if (cat === "sensor") {
      if (typeof state.value === "number" && typeof state.unit === "string") {
        const unit = state.unit.toLowerCase();
        if (unit.includes("c") || unit.includes("celsius") || unit === "°c") {
          await ep.setAttribute(TemperatureMeasurement.Cluster.id, "measuredValue", Math.round(state.value * 100), this.log);
        } else if (unit.includes("rh") || unit.includes("%") || unit.includes("humidity")) {
          await ep.setAttribute(RelativeHumidityMeasurement.Cluster.id, "measuredValue", Math.round(state.value * 100), this.log);
        } else if (unit.includes("aqi") || unit.includes("pm") || unit.includes("co2") || unit.includes("voc")) {
          const aqi = state.value;
          const enumVal: AirQuality.AirQualityEnum =
            aqi <= 50 ? AirQuality.AirQualityEnum.Good
            : aqi <= 100 ? AirQuality.AirQualityEnum.Fair
            : aqi <= 150 ? AirQuality.AirQualityEnum.Moderate
            : aqi <= 200 ? AirQuality.AirQualityEnum.Poor
            : aqi <= 300 ? AirQuality.AirQualityEnum.VeryPoor
            : AirQuality.AirQualityEnum.ExtremelyPoor;
          await ep.setAttribute(AirQuality.Cluster.id, "airQuality", enumVal, this.log);
        }
      } else if (typeof state.value === "boolean") {
        // Contact sensor: BooleanState.stateValue (true = closed/contact).
        await ep.setAttribute(BooleanState.Cluster.id, "stateValue", state.value, this.log);
      }
    }

    // L1-6: Pico button events (scene_controller only).
    if (cat === "scene_controller" && state.last_event && typeof state.last_event === "object") {
      await this.handlePicoEvent(deviceId, ep, state.last_event as Record<string, unknown>);
    }

    // L1-10: camera motion → OccupancySensing.occupied (camera only).
    // yzj-agent 海康 adapter VMD 事件 active/inactive 翻成 state.motion bool,SSE 推这条。
    // OccupancySensing.occupancy 是 bitmap 但 spec 把 occupied 当 occupancy.occupied 用,
    // matterbridge setAttribute("occupancy", {occupied: bool}) 直接写 attribute。
    if (cat === "camera" && typeof state.motion === "boolean") {
      await ep.setAttribute(
        OccupancySensing.Cluster.id,
        "occupancy",
        { occupied: state.motion },
        this.log,
      );
    }
  }

  private async handlePicoEvent(
    deviceId: string,
    parent: MatterbridgeEndpoint,
    lastEvent: Record<string, unknown>,
  ): Promise<void> {
    const btn = lastEvent.btn;
    const action = lastEvent.action;

    if (typeof btn !== "number" || typeof action !== "string") return;
    if (action !== "press" && action !== "release") return;

    const child = parent.getChildEndpointByName(`btn-${btn}`);
    if (!child) {
      this.log.debug(`Pico ${deviceId} btn=${btn} ${action} but no child endpoint`);
      return;
    }

    const key = `${deviceId}:${btn}`;
    let st = this.picoState.get(key);
    if (!st) {
      st = { pressTs: 0, pendingSingleTimer: null, longTimer: null, longFired: false, lastReleaseTs: 0 };
      this.picoState.set(key, st);
    }

    const now = Date.now();
    const fire = async (kind: "Single" | "Double" | "Long"): Promise<void> => {
      try {
        await child.triggerSwitchEvent(kind, this.log);
        this.log.info(`Pico ${deviceId} btn=${btn} → Matter ${kind}`);
      } catch (err) {
        this.log.error(`Pico triggerSwitchEvent ${kind} failed: ${(err as Error).message}`);
      }
    };

    if (action === "press") {
      st.pressTs = now;

      // 检测 Double:近 DOUBLE_WINDOW_MS 内已有一次 release(完整一个 click 周期)
      if (st.pendingSingleTimer && (now - st.lastReleaseTs) < PICO_DOUBLE_WINDOW_MS) {
        // 取消 pending Single,直接 fire Double
        clearTimeout(st.pendingSingleTimer);
        st.pendingSingleTimer = null;
        await fire("Double");
        // 清状态(双击周期结束)
        st.pressTs = 0;
        st.lastReleaseTs = 0;
        st.longFired = false;
        return;
      }

      // 起 long 计时:如 LONG_PRESS_MS 内不 release,fire Long
      st.longFired = false;
      if (st.longTimer) clearTimeout(st.longTimer);
      st.longTimer = setTimeout(() => {
        if (st!.pressTs > 0) {  // 仍按住
          st!.longFired = true;
          void fire("Long");
        }
      }, PICO_LONG_PRESS_MS);
    } else { // release
      st.lastReleaseTs = now;
      const heldMs = now - st.pressTs;
      st.pressTs = 0;
      if (st.longTimer) {
        clearTimeout(st.longTimer);
        st.longTimer = null;
      }

      // 已 fire Long → 不再 fire Single
      if (st.longFired) {
        st.longFired = false;
        return;
      }

      // 普通短按:延迟 DOUBLE_WINDOW_MS 等是否有第二次 press(变 Double)
      // 没有则 fire Single
      if (heldMs >= 0) {
        if (st.pendingSingleTimer) clearTimeout(st.pendingSingleTimer);
        st.pendingSingleTimer = setTimeout(() => {
          void fire("Single");
          st!.pendingSingleTimer = null;
          st!.lastReleaseTs = 0;
        }, PICO_DOUBLE_WINDOW_MS);
      }
    }
  }

  private async handleHotAdd(deviceId: string): Promise<void> {
    if (this.endpoints.has(deviceId)) return;
    const dev = await this.fetchDevice(deviceId).catch(() => null);
    if (!dev) return;
    const ok = await this.tryRegisterDevice(dev);
    if (ok) this.log.info(`Hot-added ${deviceId} as Matter bridged endpoint`);
  }

  private async handleHotRemove(deviceId: string): Promise<void> {
    const ep = this.endpoints.get(deviceId);
    if (!ep) return;
    try {
      await this.unregisterDevice(ep);
      this.endpoints.delete(deviceId);
      this.endpointMeta.delete(deviceId);
      this.log.info(`Hot-removed ${deviceId} from Matter bridge`);
    } catch (err) {
      this.log.error(`Hot-remove ${deviceId} failed: ${(err as Error).message}`);
    }
  }
}
