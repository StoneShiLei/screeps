/**
 * 发版提示：global 重置（含代码上传）后控制台打一行，确认新包已加载。
 */

import { log } from "./logger";

/** 本 IVM 生命周期内是否已经提示过 */
let booted = false;

/** 每个全局循环开头调用；同一次加载只提示一次 */
export function announceDeploy(): void {
  if (booted) return;
  booted = true;
  log.info("系统", "代码已加载");
}
