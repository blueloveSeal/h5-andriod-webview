<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import type { Device } from '../electron/services/devices.mjs';

const devices = ref<Device[]>([]);
const selectedId = ref('');
const loading = ref(false);
const error = ref('');
const updatedAt = ref('');
const selected = computed(() => devices.value.find((device) => device.serial === selectedId.value));
const connected = computed(() => devices.value.filter((device) => device.state === 'device').length);
let timer: ReturnType<typeof setInterval> | undefined;

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
  } catch {
    error.value = '设备连接暂时不可用，请刷新重试。';
    devices.value = [];
    selectedId.value = '';
  } finally {
    loading.value = false;
  }
}

async function chooseAdb() {
  if (await window.workbench?.chooseAdb()) await refresh();
}

onMounted(() => {
  void refresh();
  timer = setInterval(() => void refresh(), 3000);
});
onUnmounted(() => clearInterval(timer));
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
        <div class="sidebar-note"><span class="mono eyebrow">LOCAL CONNECTION</span><p>调试连接保留在本机。<br />设备状态每 3 秒更新。</p></div>
      </aside>

      <section class="screen-pane">
        <div class="pane-heading"><span>手机画面</span><span class="subtle">{{ selected?.model || '未选择设备' }}</span></div>
        <div class="phone-stage">
          <div class="phone-outline">
            <div class="phone-camera"></div>
            <div class="phone-placeholder"><svg viewBox="0 0 48 48" aria-hidden="true"><rect x="14" y="5" width="20" height="36" rx="4"/><path d="M20 10h8M22 36h4M35 21h8m-4-4 4 4-4 4"/></svg><strong>{{ selected?.state === 'device' ? '设备已连接' : selected ? status(selected.state) : '等待连接' }}</strong><p>{{ selected?.state === 'unauthorized' ? '请在手机上允许此电脑进行 USB 调试' : '投屏功能尚未接入' }}</p></div>
            <div class="phone-bottom"></div>
          </div>
        </div>
        <div class="screen-caption"><span class="connection-dot" :class="{ online: selected?.state === 'device' }"></span>{{ selected ? status(selected.state) : '连接后显示设备状态' }}</div>
      </section>

      <section class="inspector-pane">
        <div class="pane-heading"><span>WebView 调试</span><span class="mono subtle">DEVTOOLS</span></div>
        <div class="inspector-empty">
          <span class="inspect-symbol"><svg viewBox="0 0 64 64" aria-hidden="true"><path d="M12 18h40v28H12zM12 25h40"/><path d="m25 31-6 5 6 5m14-10 6 5-6 5m-5-11-4 13"/></svg></span>
          <span class="eyebrow">ANDROID WEBVIEW</span>
          <h2>从设备开始调试</h2>
          <p>连接手机并打开 APP 中的 WebView 页面。<br />页面发现与 DevTools 连接将在下一功能点接入。</p>
          <button class="primary-button" :disabled="loading" @click="refresh">{{ loading ? '正在检查设备…' : '检查设备连接' }} <span>→</span></button>
          <div class="setup-steps"><span><b>01</b>连接 USB</span><i></i><span><b>02</b>允许调试</span><i></i><span><b>03</b>打开 APP</span></div>
        </div>
      </section>
    </main>

    <footer class="statusbar"><span><span class="connection-dot" :class="{ online: connected > 0 }"></span>{{ connected }} 台可用设备</span><span class="status-message" aria-live="polite">{{ error ? '连接需要处理' : loading ? '正在检查连接' : '设备检测已完成' }}</span><span class="mono">{{ updatedAt ? '更新于 ' + updatedAt : '等待检测' }}</span><span class="version">v0.1.0</span></footer>
  </div>
</template>
