import {
  CPU_IDLE_RATIO,
  PIXEL_BUCKET,
  shouldGeneratePixel,
  smoothCpu
} from "../../src/managers/pixels";
import { assert } from "chai";

describe("搓像素判定", () => {
  const ready = {
    bucket: PIXEL_BUCKET,
    avgCpu: 5,
    limit: 20,
    underAttack: false,
    enabled: true,
    apiAvailable: true
  };

  it("全绿才搓", () => {
    assert.isTrue(shouldGeneratePixel(ready));
  });

  it("桶不满不搓", () => {
    assert.isFalse(shouldGeneratePixel({ ...ready, bucket: PIXEL_BUCKET - 1 }));
  });

  it("近期用量贴着 limit 不搓", () => {
    assert.isFalse(
      shouldGeneratePixel({ ...ready, avgCpu: ready.limit * CPU_IDLE_RATIO })
    );
  });

  it("limit 为 0 不搓", () => {
    assert.isFalse(shouldGeneratePixel({ ...ready, limit: 0, avgCpu: 0 }));
  });

  it("还没采过样不搓", () => {
    assert.isFalse(shouldGeneratePixel({ ...ready, avgCpu: undefined }));
  });

  it("有武装威胁不搓", () => {
    assert.isFalse(shouldGeneratePixel({ ...ready, underAttack: true }));
  });

  it("开关关掉不搓", () => {
    assert.isFalse(shouldGeneratePixel({ ...ready, enabled: false }));
  });

  it("没有 generatePixel API 不搓", () => {
    assert.isFalse(shouldGeneratePixel({ ...ready, apiAvailable: false }));
  });
});

describe("CPU 用量平滑", () => {
  it("第一次采样直接就是当前值", () => {
    assert.equal(smoothCpu(undefined, 12), 12);
  });

  it("之后每次只挪一小步", () => {
    const next = smoothCpu(10, 20);
    assert.isAbove(next, 10);
    assert.isBelow(next, 11);
  });
});
