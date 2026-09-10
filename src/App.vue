<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import type { ScrcpyMediaStreamPacket, ScrcpyVideoCodecId } from '@yume-chan/scrcpy';
import { BitmapVideoFrameRenderer, WebCodecsVideoDecoder, WebGLVideoFrameRenderer } from '@yume-chan/scrcpy-decoder-webcodecs';
import type { Device } from '../electron/services/devices.mjs';
import type { WebViewPage } from '../electron/services/webviews.mjs';
import { AndroidNavigationKey, keyboardControl, limitMirrorText, mapMirrorPoint } from './mirror-input.mjs';

const devices = ref<Device[]>([]);
const selectedId = ref('');
const loading = ref(false);
const error = ref('');
const updatedAt = ref('');
const pages = ref<WebViewPage[]>([]);
const selectedPageId = ref('');
const pageError = ref('');
const pagesLoading = ref(false);
const selectedPage = computed(() => pages.value.find((page) => page.id === selectedPageId.value));
const inspectorHost = ref<HTMLElement>();
const inspectorOpen = ref(false);
const inspectorLoading = ref(false);
const inspectorError = ref('');
const mirrorCanvas = ref<HTMLCanvasElement>();
const mirrorState = ref<'idle' | 'connecting' | 'streaming' | 'live' | 'error'>('idle');
const mirrorMessage = ref('连接设备后自动显示实时画面');
const mirrorFrames = ref(0);
const mirrorSize = ref('');
const mirrorControlAcks = ref(0);
const mirrorControlError = ref('');
const mirrorText = ref('');
const selected = computed(() => devices.value.find((device) => device.serial === selectedId.value));
const connected = computed(() => devices.value.filter((device) => device.state === 'device').length);
let timer: ReturnType<typeof setInterval> | undefined;
let inspectorObserver: ResizeObserver | undefined;
let mirrorPort: MessagePort | undefined;
let mirrorDecoder: WebCodecsVideoDecoder | undefined;
let mirrorWriter: ReturnType<WebCodecsVideoDecoder['writable']['getWriter']> | undefined;
let mirrorSizeListener: (() => void) | undefined;
let mirrorFrameTimer: ReturnType<typeof setInterval> | undefined;
let mirrorRequest = 0;
let mirrorControlId = 0;
let activePointer: number | undefined;
let lastPointerPoint: { x: number; y: number } | undefined;
let pendingPointerPoint: { x: number; y: number } | undefined;
let pointerFrame = 0;

interface MirrorMetadata {
  serial: string;
  codec: ScrcpyVideoCodecId;
  codecName: string;
  deviceName: string;
  width: number;
  height: number;
}

function status(state: string) {
  if (state === 'device') return '已连接';
  if (state === 'unauthorized') return '等待手机授权';
  if (state === 'offline') return '设备离线';
  return '连接不可用';
}

async function refresh() {
  if (loading.value) return;
  if (!window.workbench) {
    error.value = '桌面连接不可用，请使用 npm start 打开工作台。';
    return;
  }
  loading.value = true;
  try {
    const result = await window.workbench.devices();
    devices.value = result.devices;
    error.value = result.error || '';
    if (!result.devices.some((device) => device.serial === selectedId.value)) {
      selectedId.value = result.devices.find((device) => device.state === 'device')?.serial || result.devices[0]?.serial || '';
    }
    updatedAt.value = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    await refreshPages();
  } catch {
    error.value = '设备连接暂时不可用，请刷新重试。';
    devices.value = [];
    selectedId.value = '';
  } finally {
    loading.value = false;
  }
}

async function refreshPages() {
  if (pagesLoading.value || !window.workbench) return;
  const serial = selected.value?.state === 'device' ? selectedId.value : '';
  pagesLoading.value = true;
  try {
    const result = await window.workbench.pages(serial);
    if (serial !== (selected.value?.state === 'device' ? selectedId.value : '')) return;
    pages.value = result.pages;
    pageError.value = result.error || '';
    if (!result.pages.some((page) => page.id === selectedPageId.value)) {
      selectedPageId.value = result.pages[0]?.id || '';
    }
  } catch {
    pages.value = [];
    selectedPageId.value = '';
    pageError.value = '页面发现暂时不可用，请检查 USB 连接。';
  } finally {
    pagesLoading.value = false;
    if (serial !== (selected.value?.state === 'device' ? selectedId.value : '')) void refreshPages();
  }
}

function disposeLocalMirror() {
  cancelAnimationFrame(pointerFrame);
  pointerFrame = 0;
  activePointer = undefined;
  lastPointerPoint = undefined;
  pendingPointerPoint = undefined;
  clearInterval(mirrorFrameTimer);
  mirrorFrameTimer = undefined;
  mirrorSizeListener?.();
  mirrorSizeListener = undefined;
  try { mirrorWriter?.releaseLock(); } catch {}
  mirrorWriter = undefined;
  mirrorDecoder?.dispose();
  mirrorDecoder = undefined;
  if (mirrorPort) {
    mirrorPort.postMessage({ type: 'stop' });
    mirrorPort.close();
  }
  mirrorPort = undefined;
  mirrorFrames.value = 0;
  mirrorSize.value = '';
  mirrorControlAcks.value = 0;
  mirrorControlError.value = '';
}

function sendMirrorControl(control: object) {
  if (!mirrorPort || mirrorState.value === 'idle' || mirrorState.value === 'error') return;
  mirrorControlError.value = '';
  mirrorPort.postMessage({ type: 'control', id: ++mirrorControlId, control });
}

function mirrorPoint(event: PointerEvent) {
  const canvas = mirrorCanvas.value;
  const decoder = mirrorDecoder;
  if (!canvas || !decoder) return null;
  return mapMirrorPoint(canvas.getBoundingClientRect(), decoder.width, decoder.height, event.clientX, event.clientY);
}

function pointerDown(event: PointerEvent) {
  if (event.button !== 0 || activePointer !== undefined) return;
  const point = mirrorPoint(event);
  if (!point) return;
  event.preventDefault();
  mirrorCanvas.value?.focus();
  activePointer = event.pointerId;
  lastPointerPoint = point;
  try { mirrorCanvas.value?.setPointerCapture(event.pointerId); } catch {}
  sendMirrorControl({ kind: 'touch', phase: 'down', ...point });
}

function pointerMove(event: PointerEvent) {
  if (event.pointerId !== activePointer) return;
  const point = mirrorPoint(event);
  if (!point) return;
  event.preventDefault();
  lastPointerPoint = point;
  pendingPointerPoint = point;
  if (pointerFrame) return;
  pointerFrame = requestAnimationFrame(() => {
    pointerFrame = 0;
    if (!pendingPointerPoint) return;
    sendMirrorControl({ kind: 'touch', phase: 'move', ...pendingPointerPoint });
    pendingPointerPoint = undefined;
  });
}

function pointerEnd(event: PointerEvent, phase: 'up' | 'cancel') {
  if (event.pointerId !== activePointer) return;
  event.preventDefault();
  cancelAnimationFrame(pointerFrame);
  pointerFrame = 0;
  const point = mirrorPoint(event) || lastPointerPoint;
  if (pendingPointerPoint && phase === 'up') sendMirrorControl({ kind: 'touch', phase: 'move', ...pendingPointerPoint });
  pendingPointerPoint = undefined;
  if (point) sendMirrorControl({ kind: 'touch', phase, ...point });
  try { mirrorCanvas.value?.releasePointerCapture(event.pointerId); } catch {}
  activePointer = undefined;
  lastPointerPoint = undefined;
}

function handleMirrorKeyboard(event: KeyboardEvent) {
  const control = keyboardControl({
    type: event.type,
    key: event.key,
    code: event.code,
    repeat: event.repeat,
    shiftKey: event.shiftKey,
    altKey: event.altKey,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    altGraph: event.getModifierState('AltGraph'),
    isComposing: event.isComposing,
  });
  if (!control) return;
  event.preventDefault();
  sendMirrorControl(control);
}

function pasteMirrorText(event: ClipboardEvent) {
  const text = limitMirrorText(event.clipboardData?.getData('text/plain'));
  if (!text) return;
  event.preventDefault();
  sendMirrorControl({ kind: 'paste', text });
}

function sendMirrorText() {
  const text = limitMirrorText(mirrorText.value);
  if (!text) return;
  sendMirrorControl({ kind: 'paste', text });
  mirrorText.value = '';
}

function handleMirrorTextKey(event: KeyboardEvent) {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  sendMirrorText();
}

function sendNavigation(keyCode: number) {
  sendMirrorControl({ kind: 'key', phase: 'down', keyCode, repeat: 0, metaState: 0 });
  sendMirrorControl({ kind: 'key', phase: 'up', keyCode, repeat: 0, metaState: 0 });
  mirrorCanvas.value?.focus();
}

async function consumeMirrorMessage(port: MessagePort, message: { type?: string; packet?: ScrcpyMediaStreamPacket; error?: string }) {
  if (port !== mirrorPort) return;
  if (message.type === 'packet' && message.packet && mirrorWriter && mirrorDecoder) {
    try {
      const packet = { ...message.packet, data: new Uint8Array(message.packet.data) } as ScrcpyMediaStreamPacket;
      await mirrorWriter.write(packet);
      if (port === mirrorPort) port.postMessage({ type: 'ready' });
    } catch {
      mirrorState.value = 'error';
      mirrorMessage.value = '视频解码失败，请重新连接画面。';
      disposeLocalMirror();
    }
    return;
  }
  if (message.type === 'control-ack') {
    mirrorControlAcks.value += 1;
    return;
  }
  if (message.type === 'control-error') {
    mirrorControlError.value = message.error || '输入控制失败。';
    return;
  }
  if (message.type === 'error' || message.type === 'ended') {
    mirrorState.value = 'error';
    mirrorMessage.value = message.error ? '画面连接已中断：' + message.error : '画面连接已结束，请重新连接。';
    disposeLocalMirror();
  }
}

function acceptMirrorPort(event: MessageEvent) {
  if (event.source !== window || event.data?.type !== 'workbench:mirror-stream') return;
  const metadata = event.data.metadata as MirrorMetadata | undefined;
  const port = event.ports[0];
  if (!metadata || metadata.serial !== selectedId.value || !port || !mirrorCanvas.value) {
    port?.close();
    return;
  }
  disposeLocalMirror();
  try {
    if (!WebCodecsVideoDecoder.isSupported) throw new Error('当前 Chromium 不支持 WebCodecs');
    const renderer = WebGLVideoFrameRenderer.isSupported
      ? new WebGLVideoFrameRenderer(mirrorCanvas.value)
      : new BitmapVideoFrameRenderer(mirrorCanvas.value);
    const decoder = new WebCodecsVideoDecoder({ codec: metadata.codec, renderer });
    mirrorPort = port;
    mirrorDecoder = decoder;
    mirrorWriter = decoder.writable.getWriter();
    mirrorState.value = 'streaming';
    mirrorMessage.value = '正在接收实时画面…';
    if (metadata.width && metadata.height) mirrorSize.value = metadata.width + ' × ' + metadata.height;
    mirrorSizeListener = decoder.sizeChanged(({ width, height }) => {
      mirrorSize.value = width + ' × ' + height;
    });
    mirrorFrameTimer = setInterval(() => {
      if (decoder !== mirrorDecoder) return;
      mirrorFrames.value = decoder.framesRendered;
      if (decoder.framesRendered > 0) {
        mirrorState.value = 'live';
        mirrorMessage.value = metadata.codecName + ' · ' + mirrorSize.value;
      }
    }, 200);
    port.onmessage = (message) => void consumeMirrorMessage(port, message.data);
    port.start();
    port.postMessage({ type: 'ready' });
  } catch (error) {
    port.close();
    mirrorState.value = 'error';
    mirrorMessage.value = error instanceof Error ? error.message : '无法初始化视频解码器。';
  }
}

async function restartMirror() {
  const request = ++mirrorRequest;
  disposeLocalMirror();
  await window.workbench?.mirror.stop();
  if (request !== mirrorRequest) return;
  const serial = selected.value?.state === 'device' ? selectedId.value : '';
  if (!serial || !window.workbench) {
    mirrorState.value = 'idle';
    mirrorMessage.value = selected.value?.state === 'unauthorized'
      ? '请在手机上允许此电脑进行 USB 调试'
      : '连接设备后自动显示实时画面';
    return;
  }
  mirrorState.value = 'connecting';
  mirrorMessage.value = '正在启动实时画面…';
  try {
    const result = await window.workbench.mirror.start(serial);
    if (request !== mirrorRequest) {
      await window.workbench.mirror.stop();
      return;
    }
    if (!result.ok) {
      mirrorState.value = 'error';
      mirrorMessage.value = result.error || '手机画面启动失败。';
    }
  } catch {
    mirrorState.value = 'error';
    mirrorMessage.value = '手机画面连接暂时不可用。';
  }
}

function inspectorRect() {
  const rect = inspectorHost.value?.getBoundingClientRect();
  return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null;
}

function syncInspectorBounds() {
  const rect = inspectorRect();
  if (inspectorOpen.value && rect) void window.workbench?.inspector.bounds(rect);
}

async function closeInspector() {
  inspectorOpen.value = false;
  inspectorLoading.value = false;
  await window.workbench?.inspector.close();
}

async function openInspector() {
  if (!selectedPage.value || inspectorLoading.value || !window.workbench) return;
  inspectorLoading.value = true;
  inspectorError.value = '';
  await nextTick();
  const rect = inspectorRect();
  if (!rect) {
    inspectorError.value = '无法确定调试区域，请调整窗口后重试。';
    inspectorLoading.value = false;
    return;
  }
  try {
    const result = await window.workbench.inspector.open(selectedPage.value.id, rect);
    inspectorOpen.value = result.ok;
    inspectorError.value = result.error || '';
  } catch {
    inspectorError.value = 'DevTools 启动失败，请刷新页面后重试。';
  } finally {
    inspectorLoading.value = false;
  }
}

watch([selectedId, () => selected.value?.state], () => {
  void closeInspector();
  pages.value = [];
  selectedPageId.value = '';
  pageError.value = '';
  void refreshPages();
  void restartMirror();
});

watch(selectedPageId, (value, previous) => {
  if (value !== previous && inspectorOpen.value) void closeInspector();
  inspectorError.value = '';
});

async function chooseAdb() {
  if (await window.workbench?.chooseAdb()) await refresh();
}

onMounted(() => {
  window.addEventListener('message', acceptMirrorPort);
  void refresh();
  timer = setInterval(() => void refresh(), 3000);
  inspectorObserver = new ResizeObserver(syncInspectorBounds);
  if (inspectorHost.value) inspectorObserver.observe(inspectorHost.value);
});
onUnmounted(() => {
  window.removeEventListener('message', acceptMirrorPort);
  mirrorRequest += 1;
  clearInterval(timer);
  inspectorObserver?.disconnect();
  disposeLocalMirror();
  void window.workbench?.mirror.stop();
  void closeInspector();
});
</script>

<template>
  <div class="workbench">
    <header class="topbar">
      <div class="brand"><span class="brand-mark">W<span>·</span></span><div>WebView <span class="brand-sub">工作台</span></div></div>
      <div class="topbar-context"><span class="connection-dot" :class="{ online: connected > 0 }"></span>{{ connected ? 'USB 设备已就绪' : '等待 USB 连接' }}</div>
      <button class="quiet-button settings-button" @click="chooseAdb">配置 ADB</button>
    </header>

    <main class="workspace">
      <aside class="sidebar">
        <div class="section-title"><h1>设备</h1><span class="count">{{ devices.length }}</span><button class="icon-button refresh-button" :class="{ spinning: loading }" :disabled="loading" aria-label="刷新设备" @click="refresh">↻</button></div>
        <div v-if="error" class="inline-error" role="alert">{{ error }}</div>
        <div v-if="!devices.length" class="device-empty"><span class="small-device"></span><p>连接 Android 手机</p><span>使用 USB 数据线，并在手机上允许 USB 调试。</span></div>
        <div class="device-list" aria-label="设备列表">
          <button v-for="device in devices" :key="device.serial" class="device-item" :class="{ selected: selectedId === device.serial }" :aria-pressed="selectedId === device.serial" @click="selectedId = device.serial">
            <span class="device-glyph"></span><span class="device-copy"><strong>{{ device.model }}</strong><span>{{ status(device.state) }}</span></span><span class="connection-dot" :class="{ online: device.state === 'device' }"></span>
          </button>
        </div>
        <div class="section-title page-section-title"><h2>WebView 页面</h2><span class="count">{{ pages.length }}</span><span v-if="pagesLoading" class="subtle">扫描中</span></div>
        <div v-if="pageError" class="inline-error" role="alert">{{ pageError }}</div>
        <div v-if="!pages.length" class="page-empty">{{ selected?.state === 'device' ? '打开 APP 中已启用调试的 WebView，页面会自动出现在这里。' : '连接并授权设备后发现页面。' }}</div>
        <div class="page-list" aria-label="WebView 页面列表">
          <button v-for="page in pages" :key="page.id" class="page-item" :class="{ selected: selectedPageId === page.id }" :aria-pressed="selectedPageId === page.id" @click="selectedPageId = page.id">
            <span class="page-package">{{ page.packageName }}</span>
            <strong>{{ page.title }}</strong>
            <span class="page-url" :title="page.url">{{ page.url }}</span>
            <span class="page-badge">{{ page.candidate ? '屏幕内候选' : page.visible ? '后台或位置未确认' : '隐藏或状态未知' }}</span>
          </button>
        </div>
        <div class="sidebar-note"><span class="mono eyebrow">LOCAL CONNECTION</span><p>调试连接保留在本机。<br />设备状态每 3 秒更新。</p></div>
      </aside>

      <section class="screen-pane">
        <div class="pane-heading"><span>手机画面</span><span class="subtle">{{ selected?.model || '未选择设备' }}</span></div>
        <div class="phone-stage">
          <div class="phone-outline">
            <div class="phone-camera"></div>
            <canvas ref="mirrorCanvas" class="phone-video" :class="{ visible: mirrorFrames > 0 }" :data-frames="mirrorFrames" :data-control-acks="mirrorControlAcks" tabindex="0" aria-label="手机实时画面" @pointerdown="pointerDown" @pointermove="pointerMove" @pointerup="pointerEnd($event, 'up')" @pointercancel="pointerEnd($event, 'cancel')" @keydown="handleMirrorKeyboard" @keyup="handleMirrorKeyboard" @paste="pasteMirrorText" @contextmenu.prevent></canvas>
            <div v-if="mirrorFrames === 0" class="phone-placeholder"><svg viewBox="0 0 48 48" aria-hidden="true"><rect x="14" y="5" width="20" height="36" rx="4"/><path d="M20 10h8M22 36h4M35 21h8m-4-4 4 4-4 4"/></svg><strong>{{ mirrorState === 'connecting' || mirrorState === 'streaming' ? '正在连接画面' : selected?.state === 'device' ? '设备已连接' : selected ? status(selected.state) : '等待连接' }}</strong><p>{{ mirrorMessage }}</p><button v-if="selected?.state === 'device' && mirrorState === 'error'" class="quiet-button mirror-retry" @click="restartMirror">重新连接</button></div>
            <div class="phone-bottom"></div>
          </div>
        </div>
        <div v-if="mirrorState === 'live'" class="mirror-controls">
          <div class="navigation-controls" aria-label="Android 导航键">
            <button class="control-button" aria-label="返回" title="返回" @click="sendNavigation(AndroidNavigationKey.back)">‹</button>
            <button class="control-button" aria-label="主页" title="主页" @click="sendNavigation(AndroidNavigationKey.home)">○</button>
            <button class="control-button" aria-label="最近任务" title="最近任务" @click="sendNavigation(AndroidNavigationKey.recents)">□</button>
          </div>
          <div class="text-controls">
            <input v-model="mirrorText" maxlength="1024" aria-label="发送文本到手机" placeholder="输入或粘贴文本" @keydown="handleMirrorTextKey" />
            <button class="quiet-button" :disabled="!mirrorText" @click="sendMirrorText">发送</button>
          </div>
          <p v-if="mirrorControlError" class="control-error" role="alert">{{ mirrorControlError }}</p>
        </div>
        <div class="screen-caption"><span class="connection-dot" :class="{ online: mirrorState === 'live' }"></span>{{ mirrorState === 'live' ? '实时画面 · ' + mirrorSize : selected ? mirrorMessage : '连接后显示设备状态' }}</div>
      </section>

      <section class="inspector-pane">
        <div class="pane-heading">
          <span>WebView 调试</span>
          <button v-if="inspectorOpen" class="quiet-button inspector-close" @click="closeInspector">关闭面板</button>
          <span v-else class="mono subtle">DEVTOOLS</span>
        </div>
        <div ref="inspectorHost" class="inspector-surface">
        <div v-if="!inspectorOpen" class="inspector-empty">
          <span class="inspect-symbol"><svg viewBox="0 0 64 64" aria-hidden="true"><path d="M12 18h40v28H12zM12 25h40"/><path d="m25 31-6 5 6 5m14-10 6 5-6 5m-5-11-4 13"/></svg></span>
          <span class="eyebrow">ANDROID WEBVIEW</span>
          <h2>{{ selectedPage ? selectedPage.title : '从设备开始调试' }}</h2>
          <p v-if="selectedPage" class="selected-page-details">{{ selectedPage.packageName }}<br />{{ selectedPage.url }}<br />{{ selectedPage.browser }}</p>
          <p v-else>连接手机并打开 APP 中的 WebView 页面。<br />可调试页面会出现在左侧列表中。</p>
          <div v-if="inspectorError" class="inspector-error" role="alert">{{ inspectorError }}</div>
          <button v-if="selectedPage" class="primary-button open-inspector" :disabled="inspectorLoading" @click="openInspector">{{ inspectorLoading ? '正在连接…' : '打开 DevTools' }} <span>→</span></button>
          <button v-else class="primary-button" :disabled="loading" @click="refresh">{{ loading ? '正在检查设备…' : '检查设备连接' }} <span>→</span></button>
          <div class="setup-steps"><span><b>01</b>连接 USB</span><i></i><span><b>02</b>允许调试</span><i></i><span><b>03</b>打开 APP</span></div>
        </div>
        </div>
      </section>
    </main>

    <footer class="statusbar"><span><span class="connection-dot" :class="{ online: connected > 0 }"></span>{{ connected }} 台可用设备</span><span class="status-message" aria-live="polite">{{ error ? '连接需要处理' : loading ? '正在检查连接' : '设备检测已完成' }}</span><span class="mono">{{ updatedAt ? '更新于 ' + updatedAt : '等待检测' }}</span><span class="version">v0.1.0</span></footer>
  </div>
</template>
