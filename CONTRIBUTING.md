# 参与贡献

感谢你帮助改进 WebView 工作台。提交改动前，请先确认问题能在自有 APP 或获授权的测试环境中复现，不要在 Issue、日志或截图中公开设备序列号、本机 CDP 地址、业务账号或其他敏感数据。

## 开发环境

- Windows x64
- Node.js 22.12.0 或更高版本
- Android SDK Platform-Tools
- 一台已授权 USB 调试的 Android 真机，用于涉及投屏、输入或 WebView 的改动

```powershell
npm ci
npm test
npm run build
```

界面与真机流程可运行：

```powershell
npm run smoke -- --webview
```

安装版流程可运行：

```powershell
npm run pack:win
npm run smoke:pack
npm run dist:win
```

## 提交改动

- 每个提交只解决一个明确问题，保持差异小且可审查。
- 不提交 `release/`、`output/`、日志、测试 profile、设备数据、密钥或业务页面内容。
- 新增运行依赖时固定版本，说明选择原因，并补充需要随发行包提供的许可证或 NOTICE。
- 涉及 ADB、CDP、投屏或输入时，保留参数数组、输入上限、本机监听和退出清理等安全边界。
- 测试应覆盖有行为风险的逻辑，不为静态配置重复实现代码本身。

Pull Request 请说明触发场景、修改后的行为、验证命令和真实设备范围。无法完成真机验证时，请明确列出未验证部分。

## 报告问题

Issue 至少包含：

- Windows、Android 和系统 WebView 版本；
- 是否使用 PATH 中的 ADB 或手动选择的 `adb.exe`；
- APP 是否已开放 WebView 调试；
- 页面数量、自动跟随或手动锁定状态；
- “复制诊断”得到的已脱敏版本信息；
- 最短复现步骤和预期行为。

请先删除日志或截图中仍可能存在的账号、URL 参数和业务数据。
