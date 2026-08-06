/**
 * 在游戏里跑一段代码，把结果读回来。
 *
 * 官方 API 能提交控制台表达式，但返回值只进控制台流，HTTP 拿不到。绕法是让表达式把
 * 结果写进 Memory.probe，再用读 Memory 的接口取回来——两步之间隔几 tick。
 *
 * 这是查"游戏里到底发生了什么"最直接的手段：本地测试能验逻辑，但验不了
 * createConstructionSite 为什么返回 -14 这类只有真实房间才有的状态。
 *
 * 表达式放在文件里而不是命令行参数上，纯粹是为了躲开 shell 的引号转义。
 *
 * 用法：npx ts-node tools/probe.ts tools/probe.expr.js
 */

import { apiGet, apiPost } from "./api";
import { readFileSync } from "fs";
import { gunzipSync } from "zlib";

const file = process.argv[2] ?? "tools/probe.expr.js";

/** Memory 大了官方会 gzip 之后再传 */
function decode(data: unknown): unknown {
  if (typeof data === "string" && data.startsWith("gz:")) {
    return JSON.parse(gunzipSync(Buffer.from(data.slice(3), "base64")).toString());
  }
  return data;
}

async function main(): Promise<void> {
  const expression = readFileSync(file, "utf8").trim();
  console.log(`提交表达式（${expression.length} 字符）...`);

  await apiPost("/user/console", { expression, shard: "shard3" });

  // 表达式在下一 tick 执行，Memory 的落盘还要再等一会
  await new Promise(resolve => setTimeout(resolve, 12_000));

  const response = await apiGet<{ data?: unknown }>("/user/memory?path=probe&shard=shard3");
  console.log(JSON.stringify(decode(response.data), null, 1));
}

void main();
