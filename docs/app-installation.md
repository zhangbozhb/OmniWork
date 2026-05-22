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
OMNIWORK_IOS_BUILD_NUMBER=1
OMNIWORK_ANDROID_VERSION_CODE=1
OMNIWORK_DEFAULT_RELAY_URL=wss://relay.company.example/mobile
```

iOS Release 签名（CI 注入；本地冒烟可走 `pnpm app:build:ios:dev` 跳过签名）：

```text
OMNIWORK_IOS_DEVELOPMENT_TEAM=ABCDE12345
OMNIWORK_IOS_PROVISIONING_PROFILE=OmniWork Distribution
OMNIWORK_IOS_CODE_SIGN_STYLE=Manual
OMNIWORK_IOS_CODE_SIGN_IDENTITY=Apple Distribution
```

Android Release 签名（CI 注入；缺失任一变量会回退到 debug 签名并打印告警，不应分发）：

```text
OMNIWORK_RELEASE_KEYSTORE=/path/to/omniwork-release.keystore
OMNIWORK_RELEASE_KEYSTORE_PASSWORD=
OMNIWORK_RELEASE_KEY_ALIAS=omniwork-release
OMNIWORK_RELEASE_KEY_PASSWORD=
```

> 当前 [app/android/app/src/main/AndroidManifest.xml](../app/android/app/src/main/AndroidManifest.xml) 中
> `android:usesCleartextTraffic="true"`，目的是方便扫码连公网 IP 形态的 `ws://` Relay。
> 上线分发前请改回 `"false"`，并把 Relay 切到 `wss://`（caddy/nginx + Let's Encrypt）。

示例文件：[app/.env.example](../app/.env.example)

## Android APK 安装

生成 APK：

```sh
pnpm app:build:android:apk
```

生成 AAB（Play Store / 公司 MDM 分发）：

```sh
pnpm app:build:android:aab
```

或在 app package 内执行：

```sh
pnpm --filter @omniwork/app build:android:apk
pnpm --filter @omniwork/app build:android:aab
```

产物：

- Gradle 会读取 `OMNIWORK_APP_VERSION` / `OMNIWORK_ANDROID_VERSION_CODE` / `OMNIWORK_ANDROID_PACKAGE` 环境变量注入 versionName / versionCode / applicationId。
- 当同时提供 `OMNIWORK_RELEASE_KEYSTORE`、`OMNIWORK_RELEASE_KEYSTORE_PASSWORD`、`OMNIWORK_RELEASE_KEY_ALIAS`、`OMNIWORK_RELEASE_KEY_PASSWORD` 时使用 release 签名；否则回退到 debug 签名（仅供 CI 冒烟产物，不可分发）。
- 默认 release 允许明文 `ws://` 流量（manifest 硬编码 `usesCleartextTraffic="true"`），方便扫码连公网 IP 形态的 Relay；上线分发前需手动改回 `"false"` 并切到 `wss://`。

本地调试：

```sh
pnpm --filter @omniwork/app android
```

要求：

- 已安装 Android Studio。
- 已配置 Android SDK。
- 真机开启 USB 调试或有可用模拟器。

## iOS IPA 安装

生成已签名 Release IPA：

```sh
pnpm app:build:ios
```

或在 app package 内执行：

```sh
pnpm --filter @omniwork/app build:ios
```

该入口对应 `app/scripts/buildIosRelease.mjs`：会先 `pod install`，再调用 `react-native build-ios`，并校验 `OMNIWORK_IOS_DEVELOPMENT_TEAM`、`OMNIWORK_IOS_PROVISIONING_PROFILE` 必填，缺失时直接退出避免静默产出无签名 IPA。`OMNIWORK_IOS_CODE_SIGN_STYLE`（默认 `Manual`）、`OMNIWORK_IOS_CODE_SIGN_IDENTITY`（默认 `Apple Distribution`）、`OMNIWORK_IOS_BUNDLE_ID`、`OMNIWORK_APP_VERSION`、`OMNIWORK_IOS_BUILD_NUMBER` 会以 xcconfig 形式透传给 Xcode。

无签名冒烟构建（仅用于本地或 CI 编译可达性自检）：

```sh
pnpm app:build:ios:dev
```

产物：

- Release：Xcode archive 可导出可安装到 iOS 真机的 IPA，并已经过 CI 注入的签名身份签署。
- Dev：以 `CODE_SIGNING_ALLOWED=NO` 编译，仅产出未签名构件，不能用于真机分发或 TestFlight。

要求：

- Apple Developer Team。
- 已在 Xcode 中配置 signing、certificate 和 provisioning profile，并通过环境变量注入。
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

Web 配对 URL 支持（**仅由 Web SPA 自身解析**，浏览器中不会自动唤起 Native App）：

```text
https://example.com/?pairing=omniwork%3A%2F%2Fpair%3F...
https://example.com/?relay_url=wss%3A%2F%2Frelay.example%2Fmobile&device_id=mac&key=...
```

> Native App（iOS / Android）唤起只支持 `omniwork://pair?...` custom scheme（见 [app/ios/OmniWork/Info.plist](../app/ios/OmniWork/Info.plist) `CFBundleURLTypes` 与 [app/android/app/src/main/AndroidManifest.xml](../app/android/app/src/main/AndroidManifest.xml) 的 intent-filter）。当前**未配置 iOS Universal Links / Android App Links**，即使把上面 https URL 通过短信、邮件、IM 发给已安装 App 的设备，系统也只会用浏览器打开（由 Web SPA 把参数转换并写到 SPA localStorage）。如需"一键唤起 App"，需要后续补 iOS `com.apple.developer.associated-domains` entitlement + AASA 文件，以及 Android https intent-filter + `assetlinks.json` + `android:autoVerify="true"`。

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
- 配置了 `NSCameraUsageDescription`，用于配对二维码扫码。
- 设置 `ITSAppUsesNonExemptEncryption=false`，若公司安全策略要求，应在发布前复核。

Android：

- 显式声明 `INTERNET`、`CAMERA` 权限。
- 当前 `usesCleartextTraffic="true"`（联调用），上线分发前请改回 `"false"` 并切到 `wss://`。

## P2P 升级（WebRTC）

App 通过 `react-native-webrtc`（见 [app/package.json](../app/package.json) 与 `app/src/lib/transport/webRtcPeerAdapter.native.ts`）参与 P2P 升级；详细路径切换与降级行为以 [relay-architecture.md](./relay-architecture.md) 为准。

平台支持：

- iOS：`pod install` 会落地 `react-native-webrtc`，使用系统 WebRTC 框架，无需额外权限（不录音不录像）。
- Android：`react-native-webrtc` 自带 native module，已包含的 `INTERNET` 权限即可满足 ICE/DTLS 通讯。
- Web：`peerFactory` 返回 null，永远停留在 relay path，不需要额外构建配置。

可观测：

- 设置 `OMNIWORK_LOG_TRANSPORT=1` 启动时，App 会打印 transport 详细事件（path_change / upgrade_proposed / upgrade_committed / downgrade 等），便于排查升级失败原因。

## 安装前检查

构建前确认：

- 原生 `ios/` 和 `android/` 工程中的 bundle id/package 符合公司命名。
- `OMNIWORK_DEFAULT_RELAY_URL` 指向公司 Relay。
- Relay 可以使用本仓库 `relay/server` MVP，或公司统一 Relay 平台；生产安装包应走 `wss://`。
- App 不使用 SSO，配对页输入 Mac Agent 当前启动生成的 32 字符临时 key。
- iOS/Android 真机可以访问 Relay。
- 移动端交付物是 APK/IPA 安装包；Web 端交付物是静态 SPA，不作为 PWA 或扫码入口。

### Relay URL 环境变量约定

Mac Agent 与 App 各自读取独立的 Relay URL，分别指向 Relay 的 `/agent` 与 `/mobile` 两个 pool；二者不可混用：

| 变量名 | 使用方 | Relay 路径 | 默认/示例 |
| --- | --- | --- | --- |
| `OMNIWORK_RELAY_URL` | Mac Agent 自连 | `/agent` | `wss://relay.company.example/agent` |
| `OMNIWORK_DEFAULT_RELAY_URL` | App（native + web）默认值 | `/mobile` | `wss://relay.company.example/mobile` |

> 配对二维码中的 `relay_url` 由 Agent 端基于 `OMNIWORK_RELAY_URL` 推导（自动改写为兄弟路径 `/mobile`），手机扫码后会覆盖 App 的默认值。


## 当前环境说明

本仓库已包含 `app/ios`、`app/android` 原生工程，以及 Web SPA 入口。移动端、Web 端都应继续复用 `app/src` 下的 React Native 业务代码；平台差异优先放到 `app/src/platform` 或局部 `.native/.web` 文件。
