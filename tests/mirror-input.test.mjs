import assert from 'node:assert/strict';
import test from 'node:test';
import { keyboardControl, limitMirrorText, mapMirrorPoint } from '../src/mirror-input.mjs';

test('按 contain 后的真实画面区域映射触摸坐标', () => {
  const rect = { left: 10, top: 20, width: 200, height: 400 };
  assert.deepEqual(mapMirrorPoint(rect, 100, 200, 110, 220), { x: 50, y: 100 });
  assert.deepEqual(mapMirrorPoint(rect, 100, 200, 210, 420), { x: 99, y: 199 });
});

test('横屏留白区域不产生手机触摸事件', () => {
  const rect = { left: 0, top: 0, width: 200, height: 400 };
  assert.equal(mapMirrorPoint(rect, 400, 200, 100, 80), null);
  assert.deepEqual(mapMirrorPoint(rect, 400, 200, 100, 200), { x: 200, y: 100 });
});

test('普通字符、组合键和特殊键转换为受限控制消息', () => {
  assert.deepEqual(keyboardControl({ type: 'keydown', key: '中', code: 'Process' }), { kind: 'text', text: '中' });
  assert.equal(keyboardControl({ type: 'keyup', key: 'a', code: 'KeyA' }), null);
  assert.deepEqual(keyboardControl({ type: 'keydown', key: 'a', code: 'KeyA', ctrlKey: true }), {
    kind: 'key', phase: 'down', keyCode: 29, repeat: 0, metaState: 4096,
  });
  assert.deepEqual(keyboardControl({ type: 'keyup', key: 'Enter', code: 'Enter' }), {
    kind: 'key', phase: 'up', keyCode: 66, repeat: 0, metaState: 0,
  });
  assert.equal(keyboardControl({ type: 'keydown', key: 'v', code: 'KeyV', ctrlKey: true }), null);
  assert.equal(keyboardControl({ type: 'keydown', key: 'Process', code: 'Process', isComposing: true }), null);
});

test('发送文本按 Unicode 字符截断而不拆分代理对', () => {
  assert.equal(limitMirrorText('A😀中文', 3), 'A😀中');
});
