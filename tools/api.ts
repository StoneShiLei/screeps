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

export async function apiGet<T = any>(path: string): Promise<T> {
  const response = await fetch(`${API}${path}`, { headers: { "X-Token": token() } });
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

  for (let i = 0; i < rooms.length; i += 200) {
    const batch = rooms.slice(i, i + 200);
    const response = await fetch(`${API}/game/map-stats`, {
      method: "POST",
      headers: { "X-Token": token(), "Content-Type": "application/json" },
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
