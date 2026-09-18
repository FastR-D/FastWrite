import { expect, test } from 'bun:test';
import { NavigationController } from './navigationController';

test('slow navigation cannot supersede a later request or manual selection', () => {
  const controller = new NavigationController();
  const a = controller.begin('p', 'a', 100);
  const b = controller.begin('p', 'b', 2);
  expect(controller.isCurrent(a)).toBe(false);
  expect(controller.isCurrent(b)).toBe(true);
  controller.cancel();
  expect(controller.isCurrent(b)).toBe(false);
});

test('repeated same-line requests have distinct identities', () => {
  const controller = new NavigationController();
  const a = controller.begin('p', 'a', 100);
  const b = controller.begin('p', 'a', 100);
  expect(a.requestId).not.toBe(b.requestId);
  expect(controller.isCurrent(b)).toBe(true);
});
