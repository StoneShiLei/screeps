/**
 * 本地工具脚本共用的 Screeps API 访问层。
 * token 从 screeps.json 读取，那个文件在 .gitignore 里，不会被提交。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";

const API = "https://screeps.com/api";

export const SHARD = "shard3";

const CACHE_DIR = ".cache";

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

export async function apiPost<T = any>(path: string, body: unknown): Promise<T> {
  const response = await request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${path}`);
  return (await response.json()) as T;
}

/**
 * 往 Memory 里写一个路径，等价于在游戏控制台里赋值。
 *
 * 用来在本地替控制台按下开关，比如给房间挂上搬运或分房的任务。写的是路径而不是
 * 整个 Memory，不会覆盖掉游戏正在维护的其它字段。
 */
export async function setMemory(path: string, value: unknown): Promise<void> {
  await apiPost("/user/memory", { path, value, shard: SHARD });
  console.log(`Memory.${path} = ${JSON.stringify(value)}`);
}

export interface RoomObject {
  type: string;
  x: number;
  y: number;
  user?: string;
  mineralType?: string;
}

/**
 * 地形一辈子不会变，所以只查一次就永久缓存在本地。
 *
 * 官方对 room-terrain 的限额是每小时 360 次，反复分析同一个房间时
 * 很容易白白烧掉配额，而这些请求返回的内容一模一样。
 */
export async function fetchTerrain(room: string): Promise<string> {
  const path = `${CACHE_DIR}/terrain-${SHARD}-${room}.txt`;
  if (existsSync(path)) return readFileSync(path, "utf8");

  const data = await apiGet<{ terrain: { terrain: string }[] }>(
    `/game/room-terrain?room=${room}&shard=${SHARD}&encoded=1`
  );
  const encoded = data.terrain[0].terrain;

  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR);
  writeFileSync(path, encoded, "utf8");

  return encoded;
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

/**
 * map-stats 的每小时配额很紧，而房间归属变化很慢，
 * 缓存到本地就能反复分析而不用重新查。
 */
export async function fetchMapStatsCached(rooms: string[], maxAgeMinutes = 120): Promise<Record<string, RoomStatus>> {
  const path = `${CACHE_DIR}/map-stats-${SHARD}.json`;

  let cache: { time: number; stats: Record<string, RoomStatus> } = { time: 0, stats: {} };
  if (existsSync(path)) {
    cache = JSON.parse(readFileSync(path, "utf8"));
  }

  const expired = Date.now() - cache.time > maxAgeMinutes * 60_000;
  const missing = expired ? rooms : rooms.filter(name => !(name in cache.stats));

  if (missing.length) {
    console.log(`  缓存缺 ${missing.length} 个房间，向官方查询`);
    const fresh = await fetchMapStats(missing);
    cache = { time: expired ? Date.now() : cache.time || Date.now(), stats: { ...cache.stats, ...fresh } };

    if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR);
    writeFileSync(path, JSON.stringify(cache), "utf8");
  } else {
    console.log(`  全部命中本地缓存（${rooms.length} 个房间）`);
  }

  return cache.stats;
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
