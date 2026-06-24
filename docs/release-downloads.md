# 发布与下载清单

本文档定义 OmniWork 对外下载资源的命名、校验和下载页清单更新方式。目标是让 GitHub Releases、`checksums.txt` 与 Public Web 下载页保持一致。

## Release 资产命名

每个版本的 GitHub Release 使用相同的 tag 与文件版本号，例如 `v0.1.0`。

必需资产：

| 平台 | 文件名 | 说明 |
| --- | --- | --- |
| Android | `omniwork-android-v0.1.0.apk` | Android APK，通过 GitHub Release 分发 |
| 桌面端 Agent | `omniwork-desktop-agent-v0.1.0-linux-x64.tgz` | 由 `pnpm deploy --prod` 生成的 Node 部署包，通过 GitHub Release 分发 |
| 校验文件 | `checksums.txt` | 由发布脚本生成，随 Release 上传 |

可选资产：

| 平台 | 文件名 | 说明 |
| --- | --- | --- |
| iOS | `omniwork-ios-v0.1.0.ipa` | 已签名 IPA，仅作为特殊分发备用；普通用户优先使用 App Store |

## 下载入口职责

- iOS 主入口始终是 App Store。
- iOS IPA 只在确有签名分发需求时上传到 GitHub Release，并在下载页标注为备用。
- Android APK 与桌面端 Agent Node 部署包使用 GitHub Release asset。
- Web App 不作为 Release asset 分发，固定访问 `/app/`。

## 生成下载清单

发布资产准备完成后，将它们放入 `dist/release/`：

```text
dist/release/
|-- omniwork-android-v0.1.0.apk
|-- omniwork-desktop-agent-v0.1.0-linux-x64.tgz
|-- omniwork-ios-v0.1.0.ipa              # 可选
```

执行：

```bash
pnpm release:downloads -- --version v0.1.0
```

脚本会完成：

- 计算 Android APK、桌面端 Agent Node 部署包、可选 IPA 的 SHA256。
- 在 `dist/release/checksums.txt` 写入校验文件。
- 更新 `site/public/downloads.json`，使下载页指向对应 GitHub Release asset。
- 在 `downloads.json` 中写入当前版本、发布时间、Release 链接、历史版本入口和校验文件入口。

桌面端 Agent 当前阶段采用 Node 部署包，而不是源码 Zip。该包包含运行所需的生产依赖，下载后解压即可从目录内运行：

```bash
tar -xzf omniwork-desktop-agent-v0.1.0-linux-x64.tgz
cd omniwork-desktop-agent-v0.1.0-linux-x64
node --experimental-strip-types src/main.ts
```

后续当内部 workspace 包具备 npm registry 发布条件后，再切换为标准 `npm pack` / `npm publish` 流程；再往后才进入独立二进制或系统安装包阶段。

注意：桌面端 Agent 依赖 native WebRTC 模块，带 `node_modules` 的部署包必须按平台区分。当前 GitHub workflow 默认产出 `linux-x64` 包；扩展到 macOS / Windows 时，应新增对应 runner 矩阵并使用平台后缀区分资产。

`pnpm deploy --prod` 会临时调整当前 workspace 的依赖安装状态。本地执行后如果还需要继续开发或构建站点，先运行一次 `pnpm install` 恢复完整依赖；GitHub workflow 已在站点构建前自动执行该恢复步骤。

常用参数：

```bash
pnpm release:downloads -- \
  --version v0.1.0 \
  --released-at 2026-06-23 \
  --repo zhangbozhb/OmniWork \
  --assets-dir dist/release \
  --desktop-platform linux-x64 \
  --app-store-url https://apps.apple.com/app/<app-id>
```

如果本次发布必须包含签名 IPA：

```bash
pnpm release:downloads -- --version v0.1.0 --require-ipa true
```

也可以通过环境变量传入：

| 环境变量 | 说明 |
| --- | --- |
| `OMNIWORK_RELEASE_VERSION` | 发布版本，支持 `0.1.0` 或 `v0.1.0` |
| `OMNIWORK_RELEASED_AT` | 发布日期，格式 `YYYY-MM-DD` |
| `OMNIWORK_RELEASE_REPO` | GitHub 仓库，例如 `zhangbozhb/OmniWork` |
| `OMNIWORK_RELEASE_ASSETS_DIR` | 本地 Release 资产目录 |
| `OMNIWORK_RELEASE_DESKTOP_PLATFORM` | 桌面端 Node 部署包平台，例如 `linux-x64` |
| `OMNIWORK_IOS_APP_STORE_URL` | iOS App Store 链接 |
| `OMNIWORK_RELEASE_REQUIRE_IPA` | 设为 `1` 时要求 IPA 必须存在 |

## 发布检查

上传 Release 前检查：

- `dist/release/checksums.txt` 已生成并随 Release 上传。
- `site/public/downloads.json` 中没有 `<sha256>`、`<app-id>` 等占位符。
- Android APK 与桌面端 Agent 的 SHA256 与 `checksums.txt` 一致。
- iOS App Store 链接是正式链接；如果没有 IPA，不应在下载页展示 IPA 入口。
- 执行 `pnpm site:build`，确认下载页可以正常构建。

## CI 接入建议

仓库已提供 `.github/workflows/release.yml`，支持两种触发方式：

- 手动触发：在 GitHub Actions 中运行 `Release` workflow，输入 `version`，例如 `v0.1.0`。
- Tag 触发：推送 `v*` tag，例如 `git tag v0.1.0 && git push origin v0.1.0`。

当前 workflow 会执行：

- 安装依赖。
- 构建 Android APK，并重命名为 `omniwork-android-<version>.apk`。
- 通过 `pnpm deploy --prod` 打包桌面端 Agent，并生成 `omniwork-desktop-agent-<version>-linux-x64.tgz`。
- 执行 `pnpm release:downloads`，生成 `checksums.txt` 并更新 `site/public/downloads.json`。
- 执行 `pnpm site:build` 验证下载页可构建。
- 创建 GitHub Release，并上传 `dist/release/*`。
- 将更新后的 `site/public/downloads.json` 作为 workflow artifact 上传，便于同步回站点发布分支。

如果需要手动在 CI 或本地复用发布步骤，可以在产物打包完成后执行：

```bash
pnpm release:downloads -- --version "$GITHUB_REF_NAME"
pnpm site:build
```

随后将 `dist/release/*` 上传到 GitHub Release，并将更新后的 `site/public/downloads.json` 纳入发布分支或自动提交。

## GitHub Secrets

Android Release 默认在未提供签名密钥时使用 debug keystore 产出冒烟包。正式分发前，应在 GitHub Secrets 中配置：

| Secret | 说明 |
| --- | --- |
| `OMNIWORK_RELEASE_KEYSTORE_BASE64` | Android release keystore 的 base64 内容 |
| `OMNIWORK_RELEASE_KEYSTORE_PASSWORD` | keystore 密码 |
| `OMNIWORK_RELEASE_KEY_ALIAS` | release key alias |
| `OMNIWORK_RELEASE_KEY_PASSWORD` | release key 密码 |

当前 workflow 先打通 GitHub Release 发布链路。接入正式 Android 签名时，可在 workflow 中把 `OMNIWORK_RELEASE_KEYSTORE_BASE64` 解码为文件，并将对应环境变量传给 `pnpm app:build:android:apk`。

iOS IPA 需要 Apple 证书、Provisioning Profile 与签名身份。由于普通用户主入口是 App Store，GitHub Release 中的 IPA 仍保持可选；证书链路就绪后再把 `pnpm app:build:ios` 接入独立的 macOS job。
