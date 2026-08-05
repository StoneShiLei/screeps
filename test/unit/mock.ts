export const Game: {
  creeps: { [name: string]: any };
  rooms: { [name: string]: any };
  spawns: any;
  time: any;
  getObjectById: (id: string) => any;
} = {
  creeps: {},
  rooms: {},
  spawns: {},
  time: 12345,
  getObjectById: () => null
};

export const Memory: {
  creeps: { [name: string]: any };
} = {
  creeps: {}
};

/**
 * 游戏常量在真实环境里是运行时注入的全局量，Node 里没有。
 *
 * 假的 find 根本不看参数，这些值填多少都能跑；但还是照抄引擎里的真实数值，
 * 免得哪天有人对着测试文件里的数字当真。
 */
const FIND_CONSTANTS: Record<string, number> = {
  FIND_CREEPS: 101,
  FIND_MY_CREEPS: 102,
  FIND_HOSTILE_CREEPS: 103,
  FIND_SOURCES: 105,
  FIND_DROPPED_RESOURCES: 106,
  FIND_STRUCTURES: 107,
  FIND_MY_STRUCTURES: 108,
  FIND_FLAGS: 110,
  FIND_MY_SPAWNS: 112,
  FIND_MY_CONSTRUCTION_SITES: 114,
  FIND_TOMBSTONES: 118,
  FIND_RUINS: 123
};

export function installGameConstants(): void {
  for (const [name, value] of Object.entries(FIND_CONSTANTS)) {
    (global as any)[name] = value;
  }
}

/**
 * 造一个够用的假 creep。默认处于孵化状态，这样 main 的循环会跳过角色逻辑，
 * 测试不需要 mock 整套游戏 API；要测角色行为时把 spawning 设为 false。
 */
export function createCreep(overrides: Record<string, any> = {}): any {
  return {
    name: "mock_creep",
    spawning: true,
    memory: { role: "harvester", room: "W1N1", working: false },
    // 真实的 creep 一定属于某个房间，主循环在分发角色前会先问房间里有没有敌人
    room: { name: "W1N1", find: () => [] },
    say: () => 0,
    ...overrides
  };
}
