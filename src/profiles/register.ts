/**
 * profile 注册表 — 顺序很重要(具体的排前面,通用的排后面)。
 *
 * 加新 profile:在这里 import + 加进 array,放合适位置。
 * 把它从兜底(后面)往前挪意味着会优先匹配,反之亦然。
 */

import { ProfileRouter } from "./router.js";
import { AirPurifierProfile } from "./air-purifier.js";

export function buildRouter(): ProfileRouter {
  return new ProfileRouter([
    // 1. 米家空气净化器 (state 含 aqi + filter_life,优先级最高,把这类设备从普通 switch 拣出来)
    new AirPurifierProfile(),

    // 2. 后续: light / climate / lock / sensor / cover / scene_controller / camera / switch
    //    暂未迁移,index.ts 会在 router.match 返回 null 时走旧 switch case 兜底。
  ]);
}
