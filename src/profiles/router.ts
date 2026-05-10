/**
 * profile router — 按数组顺序匹配 yzj device 到具体 profile。
 *
 * 顺序很重要:具体 profile 必须排在通用 profile 前面。例如:
 *   1. air-purifier (米家 + state.aqi + state.filter_life)
 *   2. light, cover, climate, lock, sensor, scene_controller, camera (按 category)
 *   3. switch (普通插座兜底,无特殊字段)
 *
 * 加新 profile:在 register-profiles.ts 数组里塞,排好顺序。
 */

import { DeviceProfile, type YzjDevice, type ProfileMatch } from "./types.js";

export class ProfileRouter {
  constructor(private readonly profiles: DeviceProfile[]) {}

  /** 按顺序匹配,返回第一个命中的 profile。null = 没命中,plugin 兜底降级 */
  match(dev: YzjDevice): DeviceProfile | null {
    for (const p of this.profiles) {
      if (this.testMatch(p.match, dev)) return p;
    }
    return null;
  }

  /** 调试用:列所有 profile id 顺序 */
  list(): { id: string; description?: string }[] {
    return this.profiles.map(p => ({ id: p.id, description: p.match.description }));
  }

  /** id → profile (handleDeviceStateChange 拿 meta.__profile_id 反查实例) */
  profileById(id: string): DeviceProfile | undefined {
    return this.profiles.find(p => p.id === id);
  }

  private testMatch(m: ProfileMatch, dev: YzjDevice): boolean {
    if (m.adapter !== undefined && dev.adapter !== m.adapter) return false;
    if (m.category !== undefined && dev.category !== m.category) return false;

    const state = dev.state ?? {};
    if (m.stateHasAll) {
      for (const k of m.stateHasAll) {
        const v = state[k];
        // 空对象 / null / undefined 视为不存在
        if (v === undefined || v === null) return false;
      }
    }
    if (m.stateHasAny) {
      const hit = m.stateHasAny.some(k => {
        const v = state[k];
        return v !== undefined && v !== null;
      });
      if (!hit) return false;
    }

    if (m.modelMatch) {
      const model = (state.model as string | undefined) ?? "";
      // 简单 glob: * → .*, . → \.
      const re = new RegExp("^" + m.modelMatch.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$");
      if (!re.test(model)) return false;
    }

    return true;
  }
}
