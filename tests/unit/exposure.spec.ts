import { expect, test } from '@playwright/test';
import { createExposureControl } from '../../src/core/post';

test('outer-planet exposure can adapt beyond seven stops without changing slew limits', () => {
  const control = createExposureControl({ reducedMotion: false });
  control.setFade(1);
  control.setTarget(1);
  control.jump();
  control.setTarget(512);
  let before = control.current;
  for (let i = 0; i < 900; i += 1) {
    control.update(1 / 60);
    expect(Math.log2(control.current / before)).toBeLessThanOrEqual(1.4 / 60 + 1e-12);
    before = control.current;
  }
  expect(control.current).toBeCloseTo(512, 8);
  control.setTarget(1);
  for (let i = 0; i < 300; i += 1) {
    control.update(1 / 60);
    expect(Math.log2(before / control.current)).toBeLessThanOrEqual(6 / 60 + 1e-12);
    before = control.current;
  }
  expect(control.current).toBeCloseTo(1, 8);
});
