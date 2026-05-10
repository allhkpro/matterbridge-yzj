/**
 * profile framework — yzj 设备 → Matter 端点的路由 + 实现拆分。
 *
 * 设计 (Phase B 重构):
 *   - 每类设备 (净化器 / 灯 / 窗帘 / Pico / ...) 一个独立 profile 文件
 *   - profile 自己声明 match rule (yzj device 哪些字段满足才走它)
 *   - router 按数组顺序 match,第一条命中 → 用该 profile.buildEndpoint
 *   - state push 同样路由到对应 profile.pushState
 *
 * 加新一类:新增 src/profiles/<kind>.ts,再在 register-profiles.ts 加一行 import。
 *   不用改 index.ts 主流程,不用动其他 profile。
 *
 * 加新型号到已有类(eg. 米家新型号净化器):看 profile match rule 是否覆盖。
 *   要细化字段:profile 内部 switch by model,不溢出到 framework。
 */

import type { AnsiLogger } from "matterbridge/logger";
import type { MatterbridgeEndpoint } from "matterbridge";

export interface YzjDevice {
  device_id: string;
  name: string;
  category: string;
  adapter: string;
  location: string | null;
  online: boolean;
  state: Record<string, unknown>;
}

/** profile-specific runtime metadata — buildEndpoint 返回时填,pushState 用。
 *  框架不规定字段,profile 自己存它需要的东西。 */
export type ProfileMeta = Record<string, unknown>;

/** profile 公共上下文 — buildEndpoint / pushState 都收到这个。 */
export interface ProfileContext {
  log: AnsiLogger;
  agentUrl: string;
  /** 给 profile 调 yzj-agent 用 */
  sendCommand(deviceId: string, cmd: "turn_on" | "turn_off", body?: Record<string, unknown>): Promise<void>;
  /** 安全包装:错误吞 + log,不会冒泡 */
  handleCommandSafely(deviceId: string, cmd: "turn_on" | "turn_off", body?: Record<string, unknown>): Promise<void>;
}

/** 一条 match rule — profile 自己声明它接哪些 yzj device。 */
export interface ProfileMatch {
  /** yzj device.adapter 名(eg. "xiaomi"),不限制则不写 */
  adapter?: string;
  /** yzj device.category(eg. "switch"),不限制则不写 */
  category?: string;
  /** state 字段必须全部存在(且为 number / string / boolean,不为 null) */
  stateHasAll?: string[];
  /** state 字段任一存在即可 */
  stateHasAny?: string[];
  /** state.model 字段 glob 匹配(仅 米家 / 涂鸦 用) */
  modelMatch?: string;
  /** 一句话描述,debug 用 */
  description?: string;
}

/** profile 抽象基类 — 每个 profile 子类必须实现 buildEndpoint + pushState。 */
export abstract class DeviceProfile {
  /** profile 唯一 id (eg. "air-purifier") */
  abstract readonly id: string;

  /** 该 profile 接收的设备规则。router 按 array 顺序 + 该 match 决定。 */
  abstract readonly match: ProfileMatch;

  /** 创建 Matter endpoint。返回 endpoint(已 registerDevice 过的 caller 处理) +
   *  meta (profile 自己存的状态,pushState 时用)。 */
  abstract buildEndpoint(
    dev: YzjDevice,
    ctx: ProfileContext,
    safeId: string,
    serial: string,
    model: string,
  ): Promise<{ ep: MatterbridgeEndpoint; meta: ProfileMeta }>;

  /** SSE state 变化 → 推到 endpoint cluster attribute。 */
  abstract pushState(
    ep: MatterbridgeEndpoint,
    meta: ProfileMeta,
    state: Record<string, unknown>,
    ctx: ProfileContext,
  ): Promise<void>;
}
