import assert from 'node:assert/strict';
import test from 'node:test';
import { choosePageTarget, uniqueScreenCandidate } from '../src/page-follow.mjs';

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
