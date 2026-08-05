/**
 * 读游戏里的 Memory，用来核对规划结果是不是真的存进去了。
 *
 * 用法：npx ts-node tools/show-memory.ts rooms.E28S36
 * 不给路径就打印整个 Memory 的顶层键。
 */

import { gunzipSync } from "zlib";
import { SHARD, apiGet } from "./api";

const path = process.argv[2] ?? "";

async function main(): Promise<void> {
  const response = await apiGet<{ data?: string | object }>(`/user/memory?path=${path}&shard=${SHARD}`);

  let value = response.data;
  // 大块内存官方会 gzip 之后再 base64，前缀是 gz:
  if (typeof value === "string" && value.startsWith("gz:")) {
    value = JSON.parse(gunzipSync(Buffer.from(value.slice(3), "base64")).toString("utf8"));
  }

  console.log(`\nMemory.${path || "(根)"}\n`);
  console.log(JSON.stringify(value, null, 2));
}

void main();
