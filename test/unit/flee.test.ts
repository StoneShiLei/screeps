import { assert } from "chai";
import { shouldKeepFleeing, walkRangeFromSearch } from "../../src/roles/defender";

describe("逃命滞回", () => {
  it("进入触发圈就开始逃", () => {
    assert.isTrue(shouldKeepFleeing(8, false));
    assert.isTrue(shouldKeepFleeing(3, false));
  });

  it("刚出触发圈但未到安全距离时，若已在逃则继续逃", () => {
    assert.isTrue(shouldKeepFleeing(9, true));
    assert.isTrue(shouldKeepFleeing(13, true));
  });

  it("撤到安全距离以外才停逃", () => {
    assert.isFalse(shouldKeepFleeing(14, true));
    assert.isFalse(shouldKeepFleeing(20, true));
  });

  it("从未开逃时，触发圈外不逃", () => {
    assert.isFalse(shouldKeepFleeing(9, false));
    assert.isFalse(shouldKeepFleeing(14, false));
  });

  it("寻路走不到（隔墙）当作无限远，不触发逃命", () => {
    assert.equal(walkRangeFromSearch(5, 0, true), Infinity);
    assert.isFalse(shouldKeepFleeing(Infinity, false));
  });

  it("开阔地寻路格数与直线口径一致", () => {
    // 直线 5、走到邻格要 4 步 → 折合距离 5
    assert.equal(walkRangeFromSearch(5, 4, false), 5);
    assert.isTrue(shouldKeepFleeing(5, false));
  });
});
