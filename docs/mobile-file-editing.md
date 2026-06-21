# 移动端文件编辑

移动端文件编辑用于在手机上完成小范围文本/代码修改，不作为完整 IDE 使用。复杂编辑仍建议交给桌面、Agent 或终端 Vim。

## 产品边界

- 默认从文件预览或 Git Review 进入编辑；Agent 变更结果入口作为后续增强。
- 编辑器只处理当前项目已声明支持的文本类型。
- 仅支持 UTF-8 文本内容。
- 二进制文件、超大文件和未知扩展名文件保持只读。
- 保存前必须使用打开时的内容哈希做冲突检测；缺少基线哈希时禁用保存并要求重新加载，避免覆盖远端已变化的文件。

## 支持类型

可编辑扩展名由 `@omniwork/protocol-ts` 的 `SUPPORTED_TEXT_FILE_EXTENSIONS` 统一维护，App、Git 预览和 Mac Agent 共用同一套判断。当前范围包括常见源码、配置、日志、Markdown、CSV/TSV、HTML/CSS/SVG/XML/YAML/TOML/JSON 等文本文件。

## 交互模型

文件从预览态进入编辑态：

```text
文件预览 -> 编辑 -> 查看改动 / 保存 -> Git Review
```

编辑页提供：

- dirty 状态。
- CodeMirror 编辑区，包含行号、语法高亮、撤销/重做、搜索快捷键、当前行高亮和括号匹配。
- 编辑区 gutter 会标记当前已修改的行，并支持跳到上一处/下一处改动。
- 当前编辑内容相对打开内容的行级 diff；diff 只在用户点击“查看改动”时从编辑器读取最新全文并计算，避免输入时持续执行重 diff。
- 保存按钮。
- 常用代码符号工具栏，并提供撤销、重做、搜索、缩进、反缩进、上一处/下一处改动等移动端快捷动作；保存保留在顶部主按钮，避免底部工具栏重复出现高风险动作。
- 未保存返回确认。
- 远端冲突提示、复制本地修改、查看远端内容和重新加载确认。
- `.env`、配置文件、lock 文件和大量删除等高风险保存会先提示确认，并允许先查看 diff。
- 保存失败提示。

保存成功后，App 会更新文件缓存、Git 文件内容缓存，刷新 Git 状态，并重新拉取当前 Git Review diff。提交前仍应通过 Git Review 完整确认最终 diff。

## 编辑器实现

编辑器使用 CodeMirror 6：

- Web 端通过 `CodeEditorView.web.tsx` 直接挂载 CodeMirror。
- Native 端通过 `CodeEditorView.native.tsx` 使用 `react-native-webview` 承载离线 CodeMirror bundle。
- Native WebView 资产由 `app/scripts/generateCodeMirrorWebViewAssets.mjs` 生成到 `app/src/editor/codeMirrorWebViewAssets.ts`。
- `pnpm run generate:xterm-assets` 会同时生成 xterm 和 CodeMirror WebView 资产，确保现有启动、构建和类型检查脚本不用额外步骤。
- 编辑时 Native WebView 只通过 bridge 同步 dirty 状态和改动行号；保存、复制本地修改和查看 diff 时才按需读取最新全文。编辑内容不做实时远端保存，也不提供草稿恢复。

## 协议

文件写入使用 `files.write`：

```ts
{
  workspacePath: string;
  relativePath: string;
  content: string;
  encoding: "utf8";
  baseHash: string;
}
```

Mac Agent 写入前会校验：

- 工作区可用。
- 路径不越过工作区根目录。
- 文件扩展名在支持列表内。
- 当前文件仍是 UTF-8 文本。
- 内容未超过大小限制。
- `baseHash` 存在且与当前文件内容哈希一致。

响应状态：

- `saved`：保存成功。
- `conflict`：远端文件在打开后发生变化。
- `unsupported`：文件类型、编码或大小不允许编辑。

## 后续增强

- 查找替换 UI：当前已提供搜索入口；后续可补充更贴近移动端的替换、结果计数和上/下一项控制。
- Agent 结果页入口：从 Agent 变更结果直接进入预览、diff 或编辑。
