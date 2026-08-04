/**
 * 本地工具脚本共用的 Screeps API 访问层。
 * token 从 screeps.json 读取，那个文件在 .gitignore 里，不会被提交。
 */

import { readFileSync } from "fs";

const API = "https://screeps.com/api";

export const SHARD = "shard3";

let cachedToken: string | undefined;

function token(): string {
  if (!cachedToken) {
    const config = JSON.parse(readFileSync("screeps.json", "utf8"));
    cachedToken = config.main.token as string;
  }
  return cachedToken;
}

/**
 * 官方 API 有速率限制，超了会返回 429。响应头里带着配额重置时间，
 * 按它等待再重试，比盲目 sleep 靠谱。
 */
async function request(path: string, init?: RequestInit, attempt = 0): Promise<Response> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { "X-Token": token(), ...(init?.headers ?? {}) }
  });

  if (response.status !== 429 || attempt >= 3) return response;

  const reset = Number(response.headers.get("x-ratelimit-reset"));
  const waitMs = reset ? Math.max(reset * 1000 - Date.now(), 0) + 2000 : 60_000;
  console.log(`  触发限流，等待 ${Math.ceil(waitMs / 1000)} 秒后重试...`);
  await new Promise(resolve => setTimeout(resolve, waitMs));

  return request(path, init, attempt + 1);
}

export async function apiGet<T = any>(path: string): Promise<T> {
  const response = await request(path);
  if (!response.ok) throw new Error(`HTTP ${response.status} ${path}`);
  return (await response.json()) as T;
}

export interface RoomObject {
  type: string;
  x: number;
  y: number;
  user?: string;
  mineralType?: string;
}

export async function fetchTerrain(room: string): Promise<string> {
  const data = await apiGet<{ terrain: { terrain: string }[] }>(
    `/game/room-terrain?room=${room}&shard=${SHARD}&encoded=1`
  );
  return data.terrain[0].terrain;
}

export async function fetchObjects(room: string): Promise<RoomObject[]> {
  const data = await apiGet<{ objects?: RoomObject[] }>(`/game/room-objects?room=${room}&shard=${SHARD}`);
  return data.objects ?? [];
}

export interface RoomStatus {
  /** normal 才是能正常玩的房间，地图边界外会返回别的值 */
  status?: string;
  own?: { user: string; level: number };
  /** 新手保护区的到期时间戳，早已过期的说明这片区域开放很久了 */
  novice?: number;
  respawnArea?: number;
}

/** 一次查一批房间的归属，比逐个拉房间对象快得多 */
export async function fetchMapStats(rooms: string[]): Promise<Record<string, RoomStatus>> {
  const result: Record<string, RoomStatus> = {};

  // 一次塞满一点，map-stats 的每小时配额比 GET 接口紧张得多
  for (let i = 0; i < rooms.length; i += 500) {
    const batch = rooms.slice(i, i + 500);
    const response = await request("/game/map-stats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rooms: batch, statName: "owner0", shard: SHARD })
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} map-stats`);

    const data = (await response.json()) as { stats?: Record<string, RoomStatus> };
    Object.assign(result, data.stats ?? {});
  }

  return result;
}

const usernameCache = new Map<string, string>();

export async function fetchUsername(userId: string): Promise<string> {
  const cached = usernameCache.get(userId);
  if (cached) return cached;

  const data = await apiGet<{ user?: { username: string } }>(`/user/find?id=${userId}`);
  const name = data.user?.username ?? userId;
  usernameCache.set(userId, name);
  return name;
}
