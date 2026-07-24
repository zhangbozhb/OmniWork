# npm 包发布

OmniWork 在 npm 的公共 scope 为 `@omni-work`。所有公开包使用同一个版本号，
内部依赖使用对应的精确版本，避免协议包与运行时包发生版本漂移。

## 发布包

- `@omni-work/protocol-ts`
- `@omni-work/relay-client`
- `@omni-work/terminal-core`
- `@omni-work/e2e-noise`
- `@omni-work/surface-hook-post`
- `@omni-work/surface-hook-record`
- `@omni-work/relay-server`
- `@omni-work/desktop-agent`
- `@omni-work/web-app`

`protocol-ts`、`relay-client`、`terminal-core`、`e2e-noise`、`relay-server`
和 `desktop-agent` 必须先编译为 `dist/*.js` 后发布。禁止把 `src/*.ts`
作为 npm 运行时入口。

仓库内开发命令会通过各消费包的 `build:deps` 脚本，按 pnpm workspace
依赖图先构建内部依赖。因此从干净 checkout 运行 App、Relay、Desktop 或共享包
的 `dev`、`build`、`typecheck`、`lint`、`test` 时，不需要手动生成依赖包的
`dist/`。

## 发布前验证

```sh
pnpm build:npm
pnpm verify:npm-packages
pnpm publish:npm:dry-run
```

`verify:npm-packages` 会完成以下检查：

1. 校验每个包的 README 和 npm 元数据。
2. 用 `npm pack` 生成实际 tarball。
3. 在临时目录安装全部 tarball。
4. 导入四个共享库。
5. 执行 `omniwork-agent --check` 和 `omniwork-relay --check`。
6. 检查 Web 包的 `dist/index.html`。

验证通过后发布：

```sh
pnpm publish:npm -- --otp <code>
```

在支持 npm trusted publishing 的 CI 中追加 `--provenance`，生成来源证明：

```sh
pnpm publish:npm -- --provenance
```

## 版本规则

npm 已发布版本不能覆盖。修复发布产物时必须提升 patch 版本，并同步更新所有
内部 `@omni-work/*` 精确依赖。发布脚本是顺序执行的，npm 不支持多包原子发布；
因此所有本地构建和 tarball 验证必须在第一个 `npm publish` 之前完成。

如果某个版本已经发布但无法使用，应在发布修复版本后标记旧版本：

```sh
npm deprecate "@omni-work/<package>@<version>" \
  "This release is not runnable from npm. Upgrade to the latest version."
```
