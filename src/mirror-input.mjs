const specialKeys = Object.freeze({
  ArrowUp: 19,
  ArrowDown: 20,
  ArrowLeft: 21,
  ArrowRight: 22,
  Tab: 61,
  Enter: 66,
  Backspace: 67,
  PageUp: 92,
  PageDown: 93,
  Escape: 111,
  Delete: 112,
  Home: 122,
  End: 123,
  Insert: 124,
});

export const AndroidNavigationKey = Object.freeze({
  home: 3,
  back: 4,
  recents: 187,
});

export function mapMirrorPoint(rect, mediaWidth, mediaHeight, clientX, clientY) {
  if (!rect || rect.width <= 0 || rect.height <= 0 || mediaWidth <= 0 || mediaHeight <= 0) return null;
  const scale = Math.min(rect.width / mediaWidth, rect.height / mediaHeight);
  const renderedWidth = mediaWidth * scale;
  const renderedHeight = mediaHeight * scale;
  const left = rect.left + (rect.width - renderedWidth) / 2;
  const top = rect.top + (rect.height - renderedHeight) / 2;
  if (clientX < left || clientY < top || clientX > left + renderedWidth || clientY > top + renderedHeight) return null;
  return {
    x: Math.min(mediaWidth - 1, Math.max(0, Math.floor((clientX - left) / scale))),
    y: Math.min(mediaHeight - 1, Math.max(0, Math.floor((clientY - top) / scale))),
  };
}

function physicalKeyCode(code) {
  if (specialKeys[code] !== undefined) return specialKeys[code];
  if (/^Key[A-Z]$/.test(code)) return 29 + code.charCodeAt(3) - 65;
  if (/^Digit[0-9]$/.test(code)) return 7 + Number(code.slice(5));
  if (/^F(?:[1-9]|1[0-2])$/.test(code)) return 130 + Number(code.slice(1));
  return undefined;
}

export function keyboardControl(event) {
  if (!event || event.isComposing) return null;
  const phase = event.type === 'keyup' ? 'up' : event.type === 'keydown' ? 'down' : null;
  if (!phase) return null;
  if ((event.ctrlKey || event.metaKey) && event.code === 'KeyV') return null;
  const printable = event.key?.length === 1 && (!event.ctrlKey && !event.metaKey || event.altGraph);
  if (printable) return phase === 'down' ? { kind: 'text', text: event.key } : null;
  const keyCode = physicalKeyCode(event.code);
  if (keyCode === undefined) return null;
  const metaState = (event.shiftKey ? 1 : 0)
    | (event.altKey ? 2 : 0)
    | (event.ctrlKey ? 4096 : 0)
    | (event.metaKey ? 65536 : 0);
  return { kind: 'key', phase, keyCode, repeat: event.repeat ? 1 : 0, metaState };
}

export function limitMirrorText(value, limit = 1024) {
  return Array.from(String(value || '')).slice(0, limit).join('');
}
