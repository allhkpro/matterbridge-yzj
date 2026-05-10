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
  onOffLight,
  onOffOutlet,
  temperatureSensor,
  thermostatDevice,
  type PlatformConfig,
  type PlatformMatterbridge,
} from "matterbridge";

import { type AnsiLogger } from "matterbridge/logger";
import {
  AirQuality,
  BooleanState,
  BridgedDeviceBasicInformation,
  DoorLock,
  LevelControl,
  OnOff,
  RelativeHumidityMeasurement,
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

  /** device_id → { ep, category, light flags } so handleDeviceStateChange can
   *  gate setAttribute calls per device-type and avoid spamming "cluster not
   *  found" errors when a sensor SSE event hits a thermostat endpoint. */
  private endpoints = new Map<string, MatterbridgeEndpoint>();
  private endpointMeta = new Map<string, {
    category: string;
    hasLevelControl: boolean;
    hasColorTemp: boolean;
    hasRgb: boolean;
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
    ]);

    this.deviceIdBlocklist = new Set((config.deviceIdBlocklist as string[] | undefined) ?? [
      "xiaomi.979836693",  // Mi AI Speaker Play (音箱不是开关)
    ]);

    this.log.info(
      `yzj-platform init. agentUrl=${this.agentUrl} ` +
      `categories=[${[...this.allowedCategories].join(",")}] ` +
      `blocklist=[${[...this.deviceIdBlocklist].join(",")}]`,
    );
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

    try {
      const ep = await this.buildEndpoint(dev);
      if (ep) {
        this.endpoints.set(dev.device_id, ep);
        const hasRgb = Array.isArray(dev.state?.rgb) && (dev.state.rgb as unknown[]).length === 3;
        const hasColorTemp = typeof dev.state?.color_temp === "number";
        const hasLevelControl = dev.category === "light" && (
          hasRgb || hasColorTemp || typeof dev.state?.brightness === "number"
        );
        this.endpointMeta.set(dev.device_id, {
          category: dev.category,
          hasLevelControl,
          hasColorTemp,
          hasRgb,
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
        ep = new MatterbridgeEndpoint([onOffOutlet, bridgedNode], { id: safeId }, debug);
        ep.createDefaultIdentifyClusterServer()
          .createDefaultBridgedDeviceBasicInformationClusterServer(dev.name, serial, VID, MANUFACTURER, model)
          .createDefaultGroupsClusterServer()
          .createDefaultOnOffClusterServer(this.deriveOnOff(dev))
          .addRequiredClusterServers();

        ep.addCommandHandler("on", async () => {
          await this.handleCommandSafely(dev.device_id, "turn_on", {});
        });
        ep.addCommandHandler("off", async () => {
          await this.handleCommandSafely(dev.device_id, "turn_off", {});
        });
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

    // Mark devices that disappeared as Reachable=false (don't unregister —
    // they may come back; full unregister happens on adapter.*.removed event).
    for (const [deviceId, ep] of this.endpoints) {
      if (!seen.has(deviceId)) {
        try {
          await ep.setAttribute(BridgedDeviceBasicInformation.Cluster.id, "reachable", false, this.log);
        } catch { /* not all endpoints have this cluster */ }
      }
    }

    if (added > 0 || this.endpoints.size > 0) {
      this.log.info(`fullStateSync: synced=${synced} added=${added} (total=${this.endpoints.size})`);
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
