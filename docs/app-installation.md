# App 安装与构建说明

关联文档：

- [engineering-requirements.md](./engineering-requirements.md)
- [project-directory-structure.md](./project-directory-structure.md)

## 目标

`app/` 最终交付的是安装到 Android 和 iOS 真机上的移动 App，不是网页、PWA 或浏览器入口。当前工程采用 React Native CLI，打包产物明确为 Android `APK` 和 iOS `IPA`，终端区域默认由 React Native 原生组件渲染。

支持两条安装路径：

- 本地 React Native CLI 运行：适合开发机调试。
- 原生工程构建：适合团队分发和真机安装。

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
- 交付物必须是 APK/IPA 安装包，而不是网页链接或 PWA。

## 当前环境说明

本仓库当前未包含 `app/ios` 和 `app/android` 原生工程。使用 React Native CLI 生成或接入原生工程后，即可按上述命令继续本地运行和构建。
