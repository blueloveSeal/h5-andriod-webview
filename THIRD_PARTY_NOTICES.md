# 第三方软件说明

本项目原创代码采用 MIT License。以下是直接参与运行或随 Windows 发行包提供的主要第三方组件；完整依赖版本和各包声明以 `package-lock.json` 及发行包内文件为准。

| 组件 | 固定版本 | 许可 | 用途与来源 |
| --- | --- | --- | --- |
| Electron | 44.3.0 | MIT | Windows 桌面运行时，[electron/electron](https://github.com/electron/electron) |
| Vue | 3.5.42 | MIT | 工作台界面，[vuejs/core](https://github.com/vuejs/core) |
| ws | 8.21.3 | MIT | 本机 CDP WebSocket 中继，[websockets/ws](https://github.com/websockets/ws) |
| `@yume-chan/adb` | 2.6.4 | MIT | ADB 客户端，[yume-chan/ya-webadb](https://github.com/yume-chan/ya-webadb) |
| `@yume-chan/adb-server-node-tcp` | 2.5.2 | MIT | 连接本机 ADB Server，[yume-chan/ya-webadb](https://github.com/yume-chan/ya-webadb) |
| `@yume-chan/adb-scrcpy` | 2.3.2 | MIT | ADB 与 scrcpy 集成，[yume-chan/ya-webadb](https://github.com/yume-chan/ya-webadb) |
| `@yume-chan/scrcpy` | 2.3.0 | MIT | scrcpy 客户端协议，[yume-chan/ya-webadb](https://github.com/yume-chan/ya-webadb) |
| `@yume-chan/scrcpy-decoder-webcodecs` | 2.5.3 | MIT | WebCodecs 视频解码，[yume-chan/ya-webadb](https://github.com/yume-chan/ya-webadb) |
| scrcpy server | 3.3.4 | Apache-2.0 | 推送到 Android 设备的服务端，[Genymobile/scrcpy](https://github.com/Genymobile/scrcpy/tree/v3.3.4) |

仓库中的 scrcpy server 文件为 `vendor/scrcpy/scrcpy-server-v3.3.4`，SHA-256 为 `8588238c9a5a00aa542906b6ec7e6d5541d9ffb9b5d0f6e1bc0e365e2303079e`。对应 Apache-2.0 文本和 NOTICE 位于 `vendor/scrcpy/LICENSE` 与 `vendor/scrcpy/NOTICE.txt`，Windows 安装版同时复制到 `resources/licenses/`。

Electron 发行目录包含 `LICENSE.electron.txt` 和 `LICENSES.chromium.html`。npm 运行依赖保留各包中的许可文件；本说明不替代任何第三方组件自己的许可条款。

Chrome DevTools 前端资源由运行中的目标 WebView 指定固定修订号，并从 `chrome-devtools-frontend.appspot.com` 加载。本项目不在源码仓库或安装包中重新分发该前端资源。
