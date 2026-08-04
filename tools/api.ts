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
