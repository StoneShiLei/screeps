/**
 * 分级日志和去重的 creep 喊话。
 *
 * 低于当前级别的直接返回，连字符串都不拼——模板字符串的求值本身也要钱。
 * announce 则是为了把"待命"这类每 tick 重复的 say 砍掉：内容没变就不喊，
 * 否则一个闲着的 hauler 每 tick 烧 0.2 CPU 的 intent。
 */

import { LOG_RANK, LogLevel, logLevel, sayEnabled } from "./settings";

const COLORS: Record<LogLevel, string> = {
  error: "#ff6666",
  warn: "#ffcc66",
  info: "#cccccc",
  debug: "#888888"
};

/**
 * 写出一条日志。message 用函数包起来，级别不够时连字符串都不拼。
 *
 * 直接传字符串也可以，只是热路径上如果拼起来很贵，用函数更划算。
 */
export function writeLog(level: LogLevel, module: string, message: string | (() => string)): void {
  if (LOG_RANK[level] > LOG_RANK[logLevel()]) return;

  const text = typeof message === "function" ? message() : message;
  const line = `<span style="color:${COLORS[level]}">[${level.toUpperCase()}][${escapeHtml(module)}] ${escapeHtml(
    text
  )}</span>`;

  // console.log 现在会在服务端把 HTML 转义掉，标签会原样显示在控制台里；
  // 想要颜色只能走 logUnsafe。老服务器上没有这个方法，退回 log 也只是丢掉颜色。
  (console.logUnsafe ?? console.log)(line);
}

/**
 * 转义日志正文里的 HTML。
 *
 * 现在拼进日志的都是自己的房间名和 creep 名，看着多此一举；但 logUnsafe
 * 是把整行原样交给客户端渲染的，哪天把敌方玩家名或者他们的 creep 名打进日志，
 * 不转义就等于把一个脚本注入口送到对方手上。
 */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export const log = {
  error: (module: string, message: string | (() => string)) => writeLog("error", module, message),
  warn: (module: string, message: string | (() => string)) => writeLog("warn", module, message),
  info: (module: string, message: string | (() => string)) => writeLog("info", module, message),
  debug: (module: string, message: string | (() => string)) => writeLog("debug", module, message)
};

/**
 * 受开关控制、带去重的 creep.say。
 *
 * 关掉 say 或者和上次说的一样就不发 intent。异常信息（无角色、无路）
 * 也走这里——关掉调试时这些喊话同样没必要占屏幕。
 */
export function announce(creep: Creep, text: string): void {
  if (!sayEnabled()) {
    // 关着的时候顺手忘掉上次说过什么。留着的话，重新打开时状态没变的 creep
    // 会被去重挡住一直不吭声，看上去像是开关没生效。
    delete creep.memory.lastSay;
    return;
  }

  if (creep.memory.lastSay === text) return;

  creep.memory.lastSay = text;
  creep.say(text);
}

/** 纯函数版级别过滤，单元测试不用碰 Memory */
export function shouldLog(current: LogLevel, message: LogLevel): boolean {
  return LOG_RANK[message] <= LOG_RANK[current];
}
