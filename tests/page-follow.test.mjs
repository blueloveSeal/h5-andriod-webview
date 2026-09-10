import assert from 'node:assert/strict';
import test from 'node:test';
import { choosePageTarget, nextInspectorRetry, uniqueScreenCandidate } from '../src/page-follow.mjs';

const pages = [
  { id: 'background', candidate: false },
  { id: 'current', candidate: true },
];

test('自动跟随选择唯一屏幕内候选', () => {
  assert.equal(uniqueScreenCandidate(pages)?.id, 'current');
  assert.equal(choosePageTarget(pages, 'background', true), 'current');
});

test('锁定模式保留仍存在的手动目标', () => {
  assert.equal(choosePageTarget(pages, 'background', false), 'background');
});

test('候选不唯一时不抢占当前选择', () => {
  const ambiguous = pages.map((page) => ({ ...page, candidate: true }));
  assert.equal(uniqueScreenCandidate(ambiguous), undefined);
  assert.equal(choosePageTarget(ambiguous, 'background', true), 'background');
});

test('目标销毁后选择现有候选或首个页面', () => {
  assert.equal(choosePageTarget(pages, 'gone', true), 'current');
  assert.equal(choosePageTarget([{ id: 'fallback', candidate: false }], 'gone', true), 'fallback');
  assert.equal(choosePageTarget([], 'gone', true), '');
});

test('DevTools 自动重连最多三次并采用有上限退避', () => {
  assert.deepEqual(nextInspectorRetry(0), { attempt: 1, delay: 1000 });
  assert.deepEqual(nextInspectorRetry(1), { attempt: 2, delay: 2000 });
  assert.deepEqual(nextInspectorRetry(2), { attempt: 3, delay: 4000 });
  assert.equal(nextInspectorRetry(3), null);
});
