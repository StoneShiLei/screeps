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
 * 造一个够用的假 creep。默认处于孵化状态，这样 main 的循环会跳过角色逻辑，
 * 测试不需要 mock 整套游戏 API；要测角色行为时把 spawning 设为 false。
 */
export function createCreep(overrides: Record<string, any> = {}): any {
  return {
    name: "mock_creep",
    spawning: true,
    memory: { role: "harvester", room: "W1N1", working: false },
    say: () => 0,
    ...overrides
  };
}
