/**
 * 空气净化器 profile (米家 zhimi.airpurifier 系列 + 兼容)
 *
 * 触发条件: yzj category=switch 且 state 同时含 aqi + filter_life 字段
 *   (米家空气净化器特征,跟普通插座 / Mi 音箱 区分开)
 *
 * Matter device-type: airPurifier (0x002D)
 *
 * 端点结构:
 *   parent xiaomi_357638328:130   MA_airPurifier
 *     OnOff cluster                 (主电源)
 *     FanControl cluster (MultiSpeed + Auto + Step)
 *       - speedMax = 16             (米家 favorite_level 上限)
 *       - percentSetting / fanMode  (iPhone 滑块 / 模式选择)
 *     HepaFilterMonitoring cluster
 *       - condition (滤芯剩余 %)
 *       - changeIndication (Ok/Warning/Critical)
 *
 *   ├─ child .temp                  MA_tempsensor    (state.temperature)
 *   ├─ child .hum                   MA_humiditysensor (state.humidity)
 *   └─ child .aqi                   MA_airQualitySensor (state.aqi → enum 桶)
 *
 * iPhone 操作 → yzj 米家命令:
 *   OnOff.on / off                  → POST turn_on / turn_off
 *   FanControl.percentSetting       → POST turn_on { mode: favorite, favorite_level: round(pct/100*16) }
 *   FanControl.fanMode (Off/Low/Med/High/Auto/Smart)
 *                                    → POST turn_on { mode: silent / favorite / auto }
 *
 * SSE 状态推送 → matter cluster:
 *   state.on                        → OnOff.onOff
 *   state.favorite_level            → FanControl.percentSetting / percentCurrent
 *   state.mode                      → FanControl.fanMode
 *   state.filter_life               → HepaFilterMonitoring.condition + changeIndication
 *   state.temperature/humidity/aqi  → child sensor measuredValue / airQuality
 */

import {
  airPurifier,
  airQualitySensor,
  bridgedNode,
  humiditySensor,
  MatterbridgeEndpoint,
  onOffOutlet,
  temperatureSensor,
} from "matterbridge";
import {
  AirQuality,
  BridgedDeviceBasicInformation,
  FanControl,
  HepaFilterMonitoring,
  OnOff,
  RelativeHumidityMeasurement,
  ResourceMonitoring,
  TemperatureMeasurement,
} from "matterbridge/matter/clusters";

import {
  DeviceProfile,
  type ProfileContext,
  type ProfileMatch,
  type ProfileMeta,
  type YzjDevice,
} from "./types.js";

const VID = 0xfff1;
const MANUFACTURER = "YZJ";

/** profile 私有 meta 形状 */
interface AirPurifierMeta extends ProfileMeta {
  hasFilterLife: boolean;
  hasTemp: boolean;
  hasHumidity: boolean;
  hasAqi: boolean;
  /** 米家附加功能开关 — 跟 hb 米家插件等价的子端点。 */
  hasChildLock: boolean;
  hasBuzzer: boolean;
  hasLed: boolean;
}

export class AirPurifierProfile extends DeviceProfile {
  readonly id = "air-purifier";

  readonly match: ProfileMatch = {
    category: "switch",
    stateHasAll: ["aqi", "filter_life"],
    description: "空气净化器(米家 zhimi.airpurifier / 加湿器复合机型 / 等)",
  };

  async buildEndpoint(
    dev: YzjDevice,
    ctx: ProfileContext,
    safeId: string,
    serial: string,
    model: string,
  ): Promise<{ ep: MatterbridgeEndpoint; meta: ProfileMeta }> {
    const ep = new MatterbridgeEndpoint([airPurifier, bridgedNode], { id: safeId });

    ep.createDefaultIdentifyClusterServer()
      .createDefaultBridgedDeviceBasicInformationClusterServer(dev.name, serial, VID, MANUFACTURER, model)
      .createDefaultGroupsClusterServer()
      .createDefaultOnOffClusterServer(this.deriveOn(dev.state));

    // FanControl MultiSpeed:speed_max=16 (米家 favorite_level)
    const initFavLevel = (dev.state?.favorite_level as number | undefined) ?? 0;
    const initPct = Math.max(0, Math.min(100, Math.round((initFavLevel / 16) * 100)));
    const initFm = this.yzjModeToMatterFanMode(
      dev.state?.mode as string | undefined,
      initFavLevel,
    );
    ep.createMultiSpeedFanControlClusterServer(
      initFm,
      FanControl.FanModeSequence.OffLowMedHighAuto,
      initPct,
      initPct,
      16,
      initFavLevel,
      initFavLevel,
    );

    // HEPA 滤芯监控
    const hasFilterLife = typeof dev.state?.filter_life === "number";
    if (hasFilterLife) {
      const flLife = Math.max(0, Math.min(100, dev.state.filter_life as number));
      ep.createDefaultHepaFilterMonitoringClusterServer(
        flLife,
        this.filterLifeToChangeIndication(flLife),
        true,                  // inPlaceIndicator
        null,                  // lastChangedTime
        [],                    // replacementProductList
      );
    }

    // 复合子端点(温/湿/AQI 三个测量传感器)
    const hasTemp = typeof dev.state?.temperature === "number";
    if (hasTemp) {
      const child = ep.addChildDeviceType("temp", [temperatureSensor], {});
      child.createDefaultIdentifyClusterServer()
        .createDefaultTemperatureMeasurementClusterServer(Math.round((dev.state.temperature as number) * 100));
    }
    const hasHumidity = typeof dev.state?.humidity === "number";
    if (hasHumidity) {
      const child = ep.addChildDeviceType("hum", [humiditySensor], {});
      child.createDefaultIdentifyClusterServer()
        .createDefaultRelativeHumidityMeasurementClusterServer(Math.round((dev.state.humidity as number) * 100));
    }
    const hasAqi = typeof dev.state?.aqi === "number";
    if (hasAqi) {
      const child = ep.addChildDeviceType("aqi", [airQualitySensor], {});
      child.createDefaultIdentifyClusterServer()
        .createDefaultAirQualityClusterServer(this.aqiToEnum(dev.state.aqi as number));
    }

    // 米家附加功能子开关(对齐 hb-mi-air-purifier 的 SwitchService):
    //   .lock   童锁(防儿童误碰按键)
    //   .buzzer 蜂鸣器静音(关掉后米家本身按键操作不再叮叮叫)
    //   .led    LED 屏(关掉后净化器顶部圆盘屏熄灭,深夜不刺眼)
    // 都用 onOffOutlet device-type — Matter 没有原生 child-lock cluster,onOffOutlet
    // 渲染成 iOS 家庭里的"开关"配件,语义上等价 boolean toggle。
    const hasChildLock = typeof dev.state?.child_lock === "boolean";
    if (hasChildLock) {
      const child = ep.addChildDeviceType("lock", [onOffOutlet], {});
      child.createDefaultIdentifyClusterServer()
        .createDefaultGroupsClusterServer()
        .createDefaultOnOffClusterServer(dev.state.child_lock as boolean);
      child.addCommandHandler("on", async () => {
        await ctx.handleCommandSafely(dev.device_id, "turn_on", { child_lock: true });
      });
      child.addCommandHandler("off", async () => {
        await ctx.handleCommandSafely(dev.device_id, "turn_on", { child_lock: false });
      });
    }
    const hasBuzzer = typeof dev.state?.buzzer === "boolean";
    if (hasBuzzer) {
      const child = ep.addChildDeviceType("buzzer", [onOffOutlet], {});
      child.createDefaultIdentifyClusterServer()
        .createDefaultGroupsClusterServer()
        .createDefaultOnOffClusterServer(dev.state.buzzer as boolean);
      child.addCommandHandler("on", async () => {
        await ctx.handleCommandSafely(dev.device_id, "turn_on", { buzzer: true });
      });
      child.addCommandHandler("off", async () => {
        await ctx.handleCommandSafely(dev.device_id, "turn_on", { buzzer: false });
      });
    }
    const hasLed = typeof dev.state?.led === "boolean";
    if (hasLed) {
      const child = ep.addChildDeviceType("led", [onOffOutlet], {});
      child.createDefaultIdentifyClusterServer()
        .createDefaultGroupsClusterServer()
        .createDefaultOnOffClusterServer(dev.state.led as boolean);
      child.addCommandHandler("on", async () => {
        await ctx.handleCommandSafely(dev.device_id, "turn_on", { led: true });
      });
      child.addCommandHandler("off", async () => {
        await ctx.handleCommandSafely(dev.device_id, "turn_on", { led: false });
      });
    }

    ep.addRequiredClusterServers();

    // OnOff command handlers
    ep.addCommandHandler("on", async () => {
      await ctx.handleCommandSafely(dev.device_id, "turn_on", {});
    });
    ep.addCommandHandler("off", async () => {
      await ctx.handleCommandSafely(dev.device_id, "turn_off", {});
    });

    // FanControl attribute write listener
    ep.subscribeAttribute(
      "fanControl",
      "percentSetting",
      async (newVal: number, oldVal: number) => {
        if (typeof newVal !== "number" || newVal === oldVal) return;
        if (newVal === 0) return; // 0% 走 OnOff.off
        const level = Math.max(1, Math.min(16, Math.round((newVal / 100) * 16)));
        await ctx.handleCommandSafely(dev.device_id, "turn_on", {
          mode: "favorite",
          favorite_level: level,
        });
      },
      ctx.log,
    );
    ep.subscribeAttribute(
      "fanControl",
      "fanMode",
      async (newVal: FanControl.FanMode, oldVal: FanControl.FanMode) => {
        if (newVal === oldVal) return;
        const yzjMode = this.matterFanModeToYzjMode(newVal);
        if (!yzjMode) return;
        await ctx.handleCommandSafely(dev.device_id, "turn_on", { mode: yzjMode });
      },
      ctx.log,
    );

    const meta: AirPurifierMeta = {
      hasFilterLife, hasTemp, hasHumidity, hasAqi,
      hasChildLock, hasBuzzer, hasLed,
    };
    return { ep, meta };
  }

  async pushState(
    ep: MatterbridgeEndpoint,
    metaIn: ProfileMeta,
    state: Record<string, unknown>,
    ctx: ProfileContext,
  ): Promise<void> {
    const meta = metaIn as AirPurifierMeta;

    // Reachable mirror
    if (typeof state.online === "boolean") {
      try {
        await ep.setAttribute(BridgedDeviceBasicInformation.Cluster.id, "reachable", state.online, ctx.log);
      } catch { /* ignore */ }
    }

    // OnOff
    const onOff = this.deriveOn(state);
    await ep.setAttribute(OnOff.Cluster.id, "onOff", onOff, ctx.log);

    // FanControl 同步(物理面板/米家 App 改了状态后回推 iPhone)
    if (typeof state.favorite_level === "number") {
      const level = Math.max(0, Math.min(16, state.favorite_level));
      const pct = Math.round((level / 16) * 100);
      await ep.setAttribute("fanControl", "percentSetting", pct, ctx.log);
      await ep.setAttribute("fanControl", "percentCurrent", pct, ctx.log);
    }
    if (typeof state.mode === "string") {
      const fm = this.yzjModeToMatterFanMode(state.mode, state.favorite_level as number | undefined);
      await ep.setAttribute("fanControl", "fanMode", fm, ctx.log);
    }

    // 滤芯
    if (meta.hasFilterLife && typeof state.filter_life === "number") {
      const flLife = Math.max(0, Math.min(100, state.filter_life));
      await ep.setAttribute(HepaFilterMonitoring.Cluster.id, "condition", flLife, ctx.log);
      await ep.setAttribute(
        HepaFilterMonitoring.Cluster.id,
        "changeIndication",
        this.filterLifeToChangeIndication(flLife),
        ctx.log,
      );
    }

    // 子端点
    if (meta.hasTemp && typeof state.temperature === "number") {
      const child = ep.getChildEndpointByName("temp");
      if (child) {
        await child.setAttribute(TemperatureMeasurement.Cluster.id, "measuredValue", Math.round(state.temperature * 100), ctx.log);
      }
    }
    if (meta.hasHumidity && typeof state.humidity === "number") {
      const child = ep.getChildEndpointByName("hum");
      if (child) {
        await child.setAttribute(RelativeHumidityMeasurement.Cluster.id, "measuredValue", Math.round(state.humidity * 100), ctx.log);
      }
    }
    if (meta.hasAqi && typeof state.aqi === "number") {
      const child = ep.getChildEndpointByName("aqi");
      if (child) {
        await child.setAttribute(AirQuality.Cluster.id, "airQuality", this.aqiToEnum(state.aqi), ctx.log);
      }
    }

    // 米家附加 boolean 子开关状态同步(物理面板 / 米家 App 改 → iPhone 反映)
    if (meta.hasChildLock && typeof state.child_lock === "boolean") {
      const child = ep.getChildEndpointByName("lock");
      if (child) await child.setAttribute(OnOff.Cluster.id, "onOff", state.child_lock, ctx.log);
    }
    if (meta.hasBuzzer && typeof state.buzzer === "boolean") {
      const child = ep.getChildEndpointByName("buzzer");
      if (child) await child.setAttribute(OnOff.Cluster.id, "onOff", state.buzzer, ctx.log);
    }
    if (meta.hasLed && typeof state.led === "boolean") {
      const child = ep.getChildEndpointByName("led");
      if (child) await child.setAttribute(OnOff.Cluster.id, "onOff", state.led, ctx.log);
    }
  }

  // ─── helpers ───

  private deriveOn(state: Record<string, unknown>): boolean {
    if (typeof state.on === "boolean") return state.on;
    if (typeof state.power === "string") return state.power.toLowerCase() === "on";
    return false;
  }

  private filterLifeToChangeIndication(life: number): ResourceMonitoring.ChangeIndication {
    if (life > 30) return ResourceMonitoring.ChangeIndication.Ok;
    if (life > 10) return ResourceMonitoring.ChangeIndication.Warning;
    return ResourceMonitoring.ChangeIndication.Critical;
  }

  private aqiToEnum(aqi: number): AirQuality.AirQualityEnum {
    if (aqi <= 50)  return AirQuality.AirQualityEnum.Good;
    if (aqi <= 100) return AirQuality.AirQualityEnum.Fair;
    if (aqi <= 150) return AirQuality.AirQualityEnum.Moderate;
    if (aqi <= 200) return AirQuality.AirQualityEnum.Poor;
    if (aqi <= 300) return AirQuality.AirQualityEnum.VeryPoor;
    return AirQuality.AirQualityEnum.ExtremelyPoor;
  }

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
}
