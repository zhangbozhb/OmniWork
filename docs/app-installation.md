# App 安装与构建说明

关联文档：

- [engineering-requirements.md](./engineering-requirements.md)
- [project-directory-structure.md](./project-directory-structure.md)

## 目标

`app/` 优先交付安装到 Android 和 iOS 真机上的移动 App，同时提供一个保持同一技术栈的 Web 单页面程序。当前工程采用 React Native CLI，移动端打包产物为 Android `APK` 和 iOS `IPA`；Web 端通过 `react-native-web` 构建静态 SPA，不另起一套 DOM UI。

支持两条安装路径：

- 本地 React Native CLI 运行：适合开发机调试。
- 原生工程构建：适合团队分发和真机安装。
- Web SPA 构建：适合浏览器入口，不支持扫码，使用手动或 URL 配对。

## 包名配置

默认配置：

```text
iOS bundle id: com.omniwork.mobile
Android package: com.omniwork.mobile
```

可通过环境变量覆盖：

```text
OMNIWORK_IOS_BUNDLE_ID=com.company.omniwork
OMNIWORK_ANDROID_PACKAGE=com.company.omniwork
OMNIWORK_APP_VERSION=0.1.0
OMNIWORK_DEFAULT_RELAY_URL=wss://relay.company.example/mobile
```

示例文件：[app/.env.example](../app/.env.example)

## Android APK 安装

生成 APK：

```sh
pnpm app:build:android
```

或在 app package 内执行：

```sh
pnpm --filter @omniwork/app build:android
```

产物：

- Gradle 会生成 APK。
- APK 可安装到 Android 真机。

本地调试：

```sh
pnpm --filter @omniwork/app android
```

要求：

- 已安装 Android Studio。
- 已配置 Android SDK。
- 真机开启 USB 调试或有可用模拟器。

## iOS IPA 安装

生成 IPA：

```sh
pnpm app:build:ios
```

或在 app package 内执行：

```sh
pnpm --filter @omniwork/app build:ios
```

产物：

- Xcode archive 可导出可安装到 iOS 真机的 IPA。
- IPA 可用于内部测试、企业分发或后续 TestFlight/App Store 流程。

要求：

- Apple Developer Team。
- 已在 Xcode 中配置 signing、certificate 和 provisioning profile。
- 真机 UDID 需要加入 provisioning profile，或使用企业分发/TestFlight。

本地调试：

```sh
pnpm --filter @omniwork/app ios
```

要求：

- macOS。
- Xcode。
- Apple 开发者账号。
- iPhone 连接到本机或有可用模拟器。

## React Native CLI 配置

当前移动端不再使用 Expo 或 EAS。运行和构建入口由 [app/package.json](../app/package.json) 中的 `react-native` 脚本提供。

## Web SPA 运行与构建

Web 端复用 React Native 页面和业务逻辑，通过 [app/webpack.config.js](../app/webpack.config.js) 将 `react-native` alias 到 `react-native-web`。

本地运行：

```sh
pnpm dev:web
```

或在 app package 内执行：

```sh
pnpm --filter @omniwork/app web:dev
```

生产构建：

```sh
pnpm app:build:web
```

产物：

- 静态文件输出到 `app/dist/web`。
- 部署时需要将所有路由回退到 `index.html`。
- Web 端不启用摄像头扫码，只支持粘贴配对信息或 URL 导入。

Web 配对 URL 支持：

```text
https://example.com/?pairing=omniwork%3A%2F%2Fpair%3F...
https://example.com/?relay_url=wss%3A%2F%2Frelay.example%2Fmobile&device_id=mac&key=...
```

## 三端验证

提交涉及 `app/` 的跨端改动前，建议执行：

```sh
pnpm verify:app:targets
```

该命令会依次执行：

- TypeScript 类型检查。
- iOS Metro bundle 解析。
- Android Metro bundle 解析。
- Web 生产构建。

如只验证单个平台：

```sh
pnpm verify:app:bundle:ios
pnpm verify:app:bundle:android
pnpm verify:app:web
```

## Native 权限

iOS：

- 配置了 `NSLocalNetworkUsageDescription`，用于后续本地 relay 或局域网调试。
- 设置 `ITSAppUsesNonExemptEncryption=false`，若公司安全策略要求，应在发布前复核。

Android：

- 显式声明 `INTERNET` 权限。
- `usesCleartextTraffic=false`，默认要求 Relay 使用 `wss://`。

## 安装前检查

构建前确认：

- 原生 `ios/` 和 `android/` 工程中的 bundle id/package 符合公司命名。
- `OMNIWORK_DEFAULT_RELAY_URL` 指向公司 Relay。
- Relay 可以使用本仓库 `relay/server` MVP，或公司统一 Relay 平台；生产安装包应走 `wss://`。
- App 不使用 SSO，配对页输入 Mac Agent 当前启动生成的 32 字符临时 key。
- iOS/Android 真机可以访问 Relay。
- 移动端交付物是 APK/IPA 安装包；Web 端交付物是静态 SPA，不作为 PWA 或扫码入口。

## 当前环境说明

本仓库已包含 `app/ios`、`app/android` 原生工程，以及 Web SPA 入口。移动端、Web 端都应继续复用 `app/src` 下的 React Native 业务代码；平台差异优先放到 `app/src/platform` 或局部 `.native/.web` 文件。
