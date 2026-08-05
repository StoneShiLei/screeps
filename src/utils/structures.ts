/** 按坐标查建筑的小工具，规划模块存的是坐标，用的时候得换回对象 */

export function containerAt(room: Room, x: number, y: number): StructureContainer | undefined {
  const position = room.getPositionAt(x, y);
  if (!position) return undefined;

  return position
    .lookFor(LOOK_STRUCTURES)
    .find(structure => structure.structureType === STRUCTURE_CONTAINER) as StructureContainer | undefined;
}
