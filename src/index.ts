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
  bridgedNode,
  coverDevice,
  dimmableLight,
  genericSwitch,
  MatterbridgeDynamicPlatform,
  MatterbridgeEndpoint,
  onOffLight,
  onOffOutlet,
  type PlatformConfig,
  type PlatformMatterbridge,
} from "matterbridge";

import { type AnsiLogger } from "matterbridge/logger";
import { BridgedDeviceBasicInformation, LevelControl, OnOff, WindowCovering } from "matterbridge/matter/clusters";

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

// ─────────────────────────────────────────────────────────────────────────────
// Platform
// ─────────────────────────────────────────────────────────────────────────────

export class YzjPlatform extends MatterbridgeDynamicPlatform {

  private endpoints = new Map<string, MatterbridgeEndpoint>();
  private allowedCategories: Set<string>;
  private deviceIdBlocklist: Set<string>;
  private sseAbort: AbortController | null = null;

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
        // L1-1: detect dimming. yzj convention: state.brightness (0-100) present
        // → DimmableLight (LevelControl + moveToLevel cmd). Otherwise OnOffLight.
        const dimmable = typeof dev.state?.brightness === "number";

        ep = new MatterbridgeEndpoint(
          [dimmable ? dimmableLight : onOffLight, bridgedNode],
          { id: safeId },
          debug,
        );
        ep.createDefaultIdentifyClusterServer()
          .createDefaultBridgedDeviceBasicInformationClusterServer(dev.name, serial, VID, MANUFACTURER, model)
          .createDefaultGroupsClusterServer()
          .createDefaultOnOffClusterServer(this.deriveOnOff(dev));

        if (dimmable) {
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

        if (dimmable) {
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
        ep = new MatterbridgeEndpoint([coverDevice, bridgedNode], { id: safeId }, debug);
        ep.createDefaultIdentifyClusterServer()
          .createDefaultBridgedDeviceBasicInformationClusterServer(dev.name, serial, VID, MANUFACTURER, model)
          .createDefaultGroupsClusterServer()
          .addRequiredClusterServers();

        ep.addCommandHandler("upOrOpen", async () => {
          await this.handleCommandSafely(dev.device_id, "turn_on", {});
        });
        ep.addCommandHandler("downOrClose", async () => {
          await this.handleCommandSafely(dev.device_id, "turn_off", {});
        });
        ep.addCommandHandler("stopMotion", async () => {
          this.log.warn(`cover ${dev.device_id} stopMotion not yet supported by yzj-agent`);
        });
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

    // L1-3: Reachable mirror — yzj.online → BridgedDeviceBasicInformation.Reachable
    if (typeof state.online === "boolean") {
      try {
        await ep.setAttribute(BridgedDeviceBasicInformation.Cluster.id, "reachable", state.online, this.log);
      } catch { /* cluster may not have it on all device types */ }
    }

    // OnOff state push.
    const onOff = this.deriveOnOff({ state } as YzjDevice);
    try {
      await ep.setAttribute(OnOff.Cluster.id, "onOff", onOff, this.log);
    } catch { /* device lacks OnOff cluster, skip */ }

    // Brightness → LevelControl (light dimming). Skip when brightness=0 — Matter
    // LevelControl currentLevel must be >= minLevel (1 by spec); 0 means "off"
    // which is encoded via OnOff cluster, and we keep last non-zero level so
    // iOS shows the slider position when light goes back on.
    if (typeof state.brightness === "number" && state.brightness > 0) {
      try {
        const matterLevel = yzjBrightnessToMatterLevel(state.brightness);
        await ep.setAttribute(LevelControl.Cluster.id, "currentLevel", matterLevel, this.log);
      } catch { /* not dimmable */ }
    }

    // Position → WindowCovering (cover devices). yzj 0=closed, 100=open;
    // Matter currentPositionLiftPercent100ths uses 0=open, 10000=closed.
    if (typeof state.position === "number") {
      try {
        const pct100ths = Math.max(0, Math.min(10000, Math.round((100 - state.position) * 100)));
        await ep.setAttribute(WindowCovering.Cluster.id, "currentPositionLiftPercent100ths", pct100ths, this.log);
      } catch { /* not a cover */ }
    }

    // L1-6: Pico button events.
    if (state.last_event && typeof state.last_event === "object") {
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

    // We only fire on "press" (not "release"). yzj raw stream gives both;
    // Matter's "Single" press maps cleanly to user intent.
    if (action !== "press") return;

    const child = parent.getChildEndpointByName(`btn-${btn}`);
    if (!child) {
      this.log.debug(`Pico ${deviceId} btn=${btn} press but no child endpoint`);
      return;
    }

    try {
      await child.triggerSwitchEvent("Single", this.log);
      this.log.info(`Pico ${deviceId} btn=${btn} → Matter Single press`);
    } catch (err) {
      this.log.error(`Pico triggerSwitchEvent failed: ${(err as Error).message}`);
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
      this.log.info(`Hot-removed ${deviceId} from Matter bridge`);
    } catch (err) {
      this.log.error(`Hot-remove ${deviceId} failed: ${(err as Error).message}`);
    }
  }
}
