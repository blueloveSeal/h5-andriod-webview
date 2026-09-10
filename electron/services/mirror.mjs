import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { AdbServerClient } from '@yume-chan/adb';
import { AdbServerNodeTcpConnector } from '@yume-chan/adb-server-node-tcp';
import { AdbScrcpyClient, AdbScrcpyOptions3_3_3 } from '@yume-chan/adb-scrcpy';
import {
  AndroidKeyEventAction,
  AndroidMotionEventAction,
  AndroidMotionEventButton,
  DefaultServerPath,
  ScrcpyInstanceId,
  ScrcpyPointerId,
  ScrcpyVideoCodecNameMap,
} from '@yume-chan/scrcpy';

export const SCRCPY_SERVER_VERSION = '3.3.4';
export const SCRCPY_SERVER_FILENAME = 'scrcpy-server-v' + SCRCPY_SERVER_VERSION;
export const SCRCPY_SERVER_SHA256 = '8588238c9a5a00aa542906b6ec7e6d5541d9ffb9b5d0f6e1bc0e365e2303079e';

let cachedServer;

async function loadServer(serverPath) {
  if (cachedServer) return cachedServer;
  const bytes = new Uint8Array(await readFile(serverPath));
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== SCRCPY_SERVER_SHA256) throw new Error('scrcpy 服务端文件校验失败');
  cachedServer = bytes;
  return bytes;
}

function readableBytes(bytes) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

class DeviceMirrorSession {
  constructor(adb, client, video) {
    this.adb = adb;
    this.client = client;
    this.video = video;
    this.reader = video.stream.getReader();
    this.outputReader = client.output.getReader();
    this.closed = false;
    this.clipboardSequence = 0n;
    this.outputTask = this.drainOutput();
  }

  get metadata() {
    return {
      codec: this.video.metadata.codec,
      codecName: ScrcpyVideoCodecNameMap.get(this.video.metadata.codec) || 'Unknown',
      deviceName: this.video.metadata.deviceName || '',
      width: this.video.width || this.video.metadata.width || 0,
      height: this.video.height || this.video.metadata.height || 0,
    };
  }

  async drainOutput() {
    try {
      while (!(await this.outputReader.read()).done) {}
    } catch {
      // 会话关闭时输出流也会结束，无需向界面重复报告。
    }
  }

  read() {
    return this.reader.read();
  }

  async control(message) {
    const controller = this.client.controller;
    if (!controller || !message || typeof message !== 'object') throw new Error('控制通道不可用');
    if (message.kind === 'touch') {
      const action = {
        down: AndroidMotionEventAction.Down,
        move: AndroidMotionEventAction.Move,
        up: AndroidMotionEventAction.Up,
        cancel: AndroidMotionEventAction.Cancel,
      }[message.phase];
      const width = this.video.width;
      const height = this.video.height;
      if (action === undefined || !Number.isInteger(message.x) || !Number.isInteger(message.y)
        || message.x < 0 || message.y < 0 || message.x >= width || message.y >= height) {
        throw new Error('触摸坐标无效');
      }
      const touching = action === AndroidMotionEventAction.Down || action === AndroidMotionEventAction.Move;
      await controller.injectTouch({
        action,
        pointerId: ScrcpyPointerId.Finger,
        pointerX: message.x,
        pointerY: message.y,
        videoWidth: width,
        videoHeight: height,
        pressure: touching ? 1 : 0,
        actionButton: AndroidMotionEventButton.None,
        buttons: AndroidMotionEventButton.None,
      });
      return;
    }
    if (message.kind === 'key') {
      const action = message.phase === 'down' ? AndroidKeyEventAction.Down
        : message.phase === 'up' ? AndroidKeyEventAction.Up : undefined;
      if (action === undefined || !Number.isInteger(message.keyCode) || message.keyCode < 0 || message.keyCode > 300
        || !Number.isInteger(message.repeat) || message.repeat < 0 || message.repeat > 100
        || !Number.isInteger(message.metaState) || message.metaState < 0 || message.metaState > 0x7fffffff) {
        throw new Error('键盘参数无效');
      }
      await controller.injectKeyCode({
        action,
        keyCode: message.keyCode,
        repeat: message.repeat,
        metaState: message.metaState,
      });
      return;
    }
    if (message.kind === 'text') {
      if (typeof message.text !== 'string' || !message.text || Array.from(message.text).length > 1024) {
        throw new Error('输入文本无效');
      }
      await controller.injectText(message.text);
      return;
    }
    if (message.kind === 'paste') {
      if (typeof message.text !== 'string' || !message.text || Array.from(message.text).length > 1024) {
        throw new Error('粘贴文本无效');
      }
      await controller.setClipboard({ sequence: ++this.clipboardSequence, paste: true, content: message.text });
      return;
    }
    throw new Error('控制消息无效');
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.reader.cancel().catch(() => {});
    await this.client.close().catch(() => {});
    await this.outputReader.cancel().catch(() => {});
    await this.outputTask.catch(() => {});
    await this.adb.close().catch(() => {});
  }
}

export async function startDeviceMirror({ serial, serverPath }) {
  if (typeof serial !== 'string' || !serial || serial.length > 255) throw new Error('设备参数无效');
  const adbServer = new AdbServerClient(new AdbServerNodeTcpConnector({ host: '127.0.0.1', port: 5037 }));
  const device = (await adbServer.getDevices()).find((entry) => entry.serial === serial && entry.state === 'device');
  if (!device) throw new Error('设备未连接或尚未授权');
  const server = await loadServer(serverPath);
  let adb;
  let client;
  try {
    adb = await adbServer.createAdb({ serial });
    await AdbScrcpyClient.pushServer(adb, readableBytes(server), DefaultServerPath);
    const options = new AdbScrcpyOptions3_3_3({
      video: true,
      audio: false,
      control: true,
      maxSize: 1280,
      maxFps: 30,
      videoBitRate: 4_000_000,
      tunnelForward: true,
      scid: ScrcpyInstanceId.random(),
      clipboardAutosync: false,
      logLevel: 'warn',
    }, { version: SCRCPY_SERVER_VERSION });
    client = await AdbScrcpyClient.start(adb, DefaultServerPath, options);
    const video = await client.videoStream;
    return new DeviceMirrorSession(adb, client, video);
  } catch (error) {
    await client?.close().catch(() => {});
    await adb?.close().catch(() => {});
    throw error;
  }
}
