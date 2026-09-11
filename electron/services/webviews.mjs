import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';

const execute = promisify(execFile);

/** @typedef {{ id: string, title: string, url: string, packageName: string, browser: string, protocolVersion: string, webkitVersion: string, frontendRevision: string, visible: boolean, candidate: boolean, width: number, height: number }} WebViewPage */
/** @typedef {{ pages: WebViewPage[], error: string | null }} PageList */

// 参数始终作为数组传入；转发只绑定 ADB 分配的本机端口。
export async function executeAdb(file, args) {
  const { stdout } = await execute(file, args, {
    encoding: 'utf8', timeout: 8000, maxBuffer: 1024 * 1024, windowsHide: true, shell: false,
  });
  return stdout;
}

export function readJson(port, pathname) {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port, path: pathname, agent: false }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error('调试服务响应失败'));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > 1024 * 1024) request.destroy(new Error('调试响应过大'));
        else chunks.push(chunk);
      });
      response.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new Error('调试服务返回无效 JSON')); }
      });
      response.on('error', reject);
    });
    // 使用总时限，持续发送少量数据也不能无限延长请求。
    const timer = setTimeout(() => request.destroy(new Error('调试服务超时')), 3000);
    request.on('close', () => clearTimeout(timer));
    request.on('error', reject);
  });
}

export function socketNames(output) {
  return [...new Set([...output.matchAll(/@webview_devtools_remote(?:_[0-9]+)?(?=\s|$)/g)].map((match) => match[0].slice(1)))];
}

export function screenSize(output) {
  const values = [...output.matchAll(/(?:Physical|Override) size:\s*(\d+)x(\d+)/g)];
  const last = values.at(-1);
  return last ? { width: Number(last[1]), height: Number(last[2]) } : null;
}

export function foregroundPackage(output) {
  const match = output.match(/(?:topResumedActivity|mResumedActivity|ResumedActivity)\s*[:=].*?\s([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+)\/[A-Za-z0-9_.$]+/);
  return match?.[1] || '';
}

export function pageGeometry(description, screen) {
  let rect;
  try { rect = JSON.parse(description); } catch { rect = {}; }
  if (!rect || typeof rect !== 'object') rect = {};
  const width = Number.isFinite(rect.width) ? rect.width : 0;
  const height = Number.isFinite(rect.height) ? rect.height : 0;
  const visible = rect.visible === true && rect.attached !== false && rect.empty !== true;
  const hasPosition = Number.isFinite(rect.screenX) && Number.isFinite(rect.screenY);
  // 这里只标记候选；重叠、旋转及原生遮挡需在自动跟随阶段进一步判断。
  const candidate = Boolean(visible && screen && hasPosition && width > 0 && height > 0 &&
    rect.screenX < screen.width && rect.screenY < screen.height &&
    rect.screenX + width > 0 && rect.screenY + height > 0);
  return { visible, candidate, width, height };
}

export function frontendEntry(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'chrome-devtools-frontend.appspot.com' &&
      !url.port && !url.username && !url.password &&
      /^\/serve_rev\/@[0-9a-f]{40}\/inspector\.html$/.test(url.pathname)
      ? url.origin + url.pathname : null;
  } catch {
    return null;
  }
}

export function frontendRevision(value) {
  const entry = frontendEntry(value);
  return entry?.match(/\/serve_rev\/@([0-9a-f]{40})\//)?.[1] || '';
}

const text = (value, limit = 4096) => typeof value === 'string' ? value.slice(0, limit) : '';

export class WebViewDiscovery {
  /** @param {{ adb?: () => string, run?: typeof executeAdb, json?: typeof readJson }} [options] */
  constructor({ adb = () => 'adb', run = executeAdb, json = readJson } = {}) {
    this.adb = adb;
    this.run = run;
    this.json = json;
    this.forwards = new Map();
    this.targets = new Map();
    this.queue = Promise.resolve();
    this.closed = false;
  }

  /** @returns {Promise<PageList>} */
  scan(serial) {
    const task = this.queue.then(() => this.scanNow(serial));
    this.queue = task.catch(() => {});
    return task;
  }

  async removeForward(key) {
    const item = this.forwards.get(key);
    if (!item) return;
    try {
      const listing = await this.run(item.adb, ['forward', '--list']);
      const owned = listing.split(/\r?\n/).some((line) => {
        const [serial, local, remote] = line.trim().split(/\s+/);
        return serial === item.serial && local === 'tcp:' + item.port && remote === 'localabstract:' + item.socket;
      });
      if (owned) await this.run(item.adb, ['-s', item.serial, 'forward', '--remove', 'tcp:' + item.port]);
      this.forwards.delete(key);
    } catch {
      // 保留所有权记录，下一次扫描或退出时再次尝试清理。
    }
  }

  async scanNow(serial) {
    const nextTargets = new Map();
    if (this.closed) {
      this.targets = nextTargets;
      return { pages: [], error: '工作台正在关闭。' };
    }
    const adb = this.adb();
    for (const [key, item] of this.forwards) {
      if (item.serial !== serial || item.adb !== adb) await this.removeForward(key);
    }
    if (!serial) {
      this.targets = nextTargets;
      return { pages: [], error: null };
    }
    let sockets;
    let screen = null;
    let foreground = '';
    try {
      sockets = socketNames(await this.run(adb, ['-s', serial, 'shell', 'cat', '/proc/net/unix']));
      if (sockets.length) {
        const [sizeResult, foregroundResult] = await Promise.allSettled([
          this.run(adb, ['-s', serial, 'shell', 'wm', 'size']),
          this.run(adb, ['-s', serial, 'shell', 'dumpsys', 'activity', 'activities']),
        ]);
        if (sizeResult.status === 'fulfilled') screen = screenSize(sizeResult.value);
        if (foregroundResult.status === 'fulfilled') foreground = foregroundPackage(foregroundResult.value);
      }
    } catch {
      for (const key of this.forwards.keys()) await this.removeForward(key);
      this.targets = nextTargets;
      return { pages: [], error: '无法读取 WebView，请检查手机授权和 USB 连接。' };
    }
    for (const [key, item] of this.forwards) {
      if (item.serial === serial && !sockets.includes(item.socket)) await this.removeForward(key);
    }
    const pages = [];
    let failures = 0;
    for (const socket of sockets) {
      const key = serial + '/' + socket;
      try {
        let forward = this.forwards.get(key);
        if (!forward) {
          const value = (await this.run(adb, ['-s', serial, 'forward', 'tcp:0', 'localabstract:' + socket])).trim();
          if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) throw new Error('转发端口无效');
          forward = { serial, socket, port: Number(value), adb };
          this.forwards.set(key, forward);
        }
        const [list, version] = await Promise.all([this.json(forward.port, '/json/list'), this.json(forward.port, '/json/version')]);
        if (!Array.isArray(list)) throw new Error('页面列表无效');
        for (const target of list) {
          if (target?.type !== 'page' || typeof target.id !== 'string' || !target.id) continue;
          let endpoint;
          try { endpoint = new URL(target.webSocketDebuggerUrl); } catch { continue; }
          // 仅使用已拥有转发的 localhost 端口，忽略手机响应中的主机名。
          if (endpoint.protocol !== 'ws:' || !endpoint.pathname.startsWith('/devtools/page/') || endpoint.search || endpoint.hash) continue;
          const id = JSON.stringify([serial, socket, target.id]);
          const packageName = text(version?.['Android-Package'], 256) || '未知 APP';
          const geometry = pageGeometry(target.description, screen);
          const page = {
            id, title: text(target.title, 512) || '未命名页面', url: text(target.url), packageName,
            browser: text(version?.Browser, 128), protocolVersion: text(version?.['Protocol-Version'], 32),
            webkitVersion: text(version?.['WebKit-Version'], 128),
            frontendRevision: frontendRevision(target.devtoolsFrontendUrl), ...geometry,
            candidate: geometry.candidate && packageName === foreground,
          };
          pages.push(page);
          nextTargets.set(id, {
            ...page, serial, socket,
            endpoint: 'ws://127.0.0.1:' + forward.port + endpoint.pathname,
            frontend: frontendEntry(target.devtoolsFrontendUrl),
          });
        }
      } catch {
        failures++;
        // 调试连接占用期间，HTTP 列表可能短暂不可读；保留上一轮目标和端口，避免切断已打开的 DevTools。
        for (const [id, previous] of this.targets) {
          if (previous.serial !== serial || previous.socket !== socket) continue;
          const preserved = { ...previous, candidate: previous.candidate && previous.packageName === foreground };
          const { endpoint, frontend, serial: _serial, socket: _socket, ...page } = preserved;
          pages.push(page);
          nextTargets.set(id, preserved);
        }
      }
    }
    pages.sort((a, b) => Number(b.candidate) - Number(a.candidate) || a.packageName.localeCompare(b.packageName));
    this.targets = nextTargets;
    return { pages, error: failures ? '部分 WebView 暂时无法读取，将自动重试。' : null };
  }

  target(id) { return this.targets.get(id); }

  async close() {
    this.closed = true;
    await this.queue;
    this.targets.clear();
    for (const key of this.forwards.keys()) await this.removeForward(key);
  }
}
