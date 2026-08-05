/**
 * 跨房间的距离计算。
 *
 * RoomPosition.getRangeTo 只在同一个房间里有意义：目标在别的房间时它不报错，
 * 而是直接返回 Infinity。拿它去比较跨房距离，所有判断都会静悄悄地变成
 * "无穷远"——距离上限一律超标、排序全是 NaN，而且一行日志都不会有。
 */

/**
 * 两个位置之间的直线距离，跨不跨房间都算得出来。
 *
 * 用切比雪夫距离（取 dx、dy 的较大者）而不是欧氏或曼哈顿，因为 creep 走对角线
 * 也只花一步，这个数才对得上真实步数——同房间时它和 getRangeTo 完全一致。
 *
 * 房间名认不出来时返回 Infinity。宁可当它无穷远也不能当它很近：认不出来的
 * 只有 sim 之类的特殊房间，让它们悄悄挤进外矿候选名单更糟。
 */
export function worldRange(from: RoomPosition, to: RoomPosition): number {
  const a = worldCoords(from);
  const b = worldCoords(to);
  if (!a || !b) return Infinity;

  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

const ROOM_NAME = /^([WE])(\d+)([NS])(\d+)$/;

/**
 * 房间内坐标换成全地图坐标。
 *
 * W0 和 N0 是紧贴原点的那一列和那一行，也就是说 W 侧和 N 侧的编号从 -1 开始，
 * 而不是 0——E0 和 W0 之间没有第 0 号房间。
 */
function worldCoords(pos: RoomPosition): { x: number; y: number } | undefined {
  const match = ROOM_NAME.exec(pos.roomName);
  if (!match) return undefined;

  const [, horizontal, column, vertical, row] = match;
  const roomX = horizontal === "W" ? -Number(column) - 1 : Number(column);
  const roomY = vertical === "N" ? -Number(row) - 1 : Number(row);

  return { x: roomX * 50 + pos.x, y: roomY * 50 + pos.y };
}
