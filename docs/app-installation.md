# App 安装与构建说明

关联文档：

- [engineering-requirements.md](./engineering-requirements.md)
- [project-directory-structure.md](./project-directory-structure.md)

## 目标

`app/` 最终交付的是安装到 Android 和 iOS 真机上的移动 App，不是网页、PWA 或浏览器入口。当前工程采用 React Native + Expo / Expo Dev Client，打包产物明确为 Android `APK` 和 iOS `IPA`，终端区域默认由 React Native 原生组件渲染。

支持两条安装路径：

- EAS 云构建：适合团队分发和真机安装。
- 本地 prebuild/run：适合开发机本地调试。

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
EXPO_PUBLIC_DEFAULT_RELAY_URL=wss://relay.company.example/mobile
```

示例文件：[app/.env.example](../app/.env.example)

## Android APK 安装

生成 APK：

```sh
pnpm app:build:apk
```

或在 app package 内执行：

```sh
pnpm --filter @omniwork/app build:android:preview
```

产物：

- EAS 会生成 APK。
- APK 可通过下载链接安装到 Android 真机。
- `production` profile 也配置为 APK，而不是 AAB。

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
pnpm app:build:ipa
```

或在 app package 内执行：

```sh
pnpm --filter @omniwork/app build:ios:preview
```

产物：

- EAS 会生成可安装到 iOS 真机的 IPA。
- IPA 可用于内部测试、企业分发或后续 TestFlight/App Store 流程。

要求：

- Apple Developer Team。
- 已在 EAS 中配置 iOS credentials。
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

## EAS 配置

EAS 配置文件：[app/eas.json](../app/eas.json)

当前 profiles：

- `development`：Expo Dev Client，内部调试。
- `preview`：内部安装包，Android 产出 APK，iOS 产出 IPA。
- `apk`：显式 Android APK 构建。
- `ipa`：显式 iOS IPA 构建。
- `production`：生产构建，开启版本自增；当前 Android 仍配置为 APK。

## Native 权限

iOS：

- 配置了 `NSLocalNetworkUsageDescription`，用于后续本地 relay 或局域网调试。
- 设置 `ITSAppUsesNonExemptEncryption=false`，若公司安全策略要求，应在发布前复核。

Android：

- 显式声明 `INTERNET` 权限。
- `usesCleartextTraffic=false`，默认要求 Relay 使用 `wss://`。

## 安装前检查

构建前确认：

- `app/expo.config.ts` 中的 bundle id/package 符合公司命名。
- `EXPO_PUBLIC_DEFAULT_RELAY_URL` 指向公司 Relay。
- Relay 可以使用本仓库 `relay/server` MVP，或公司统一 Relay 平台；生产安装包应走 `wss://`。
- App 不使用 SSO，配对页输入 Mac Agent 当前启动生成的 32 字符临时 key。
- iOS/Android 真机可以访问 Relay。
- 交付物必须是 APK/IPA 安装包，而不是网页链接或 PWA。

## 当前环境说明

本仓库当前机器环境缺少 `npm`、`pnpm` 和 `tsc`，因此本地没有执行 Expo install、EAS build 或 TypeScript 完整编译。工程文件已补齐到可安装构建所需的结构；安装依赖后即可按上述命令继续。
