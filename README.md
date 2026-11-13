# @fanfan4589/dsh-md-live-edit

在侧边栏预览里**直接编辑** Markdown 文件：点击渲染出的任意文本块就地编辑，全文自动写回磁盘，无需切换到代码模式。

> **定位｜克制的小功能补丁。** 只做这一件事，不改 DSH 主体：不替换内置槽位与布局、不改内核行为、不碰其他插件的数据。升级 DSH 一般无需跟着改；关掉或卸载即回到官方状态。

## 它解决什么

DSH 的侧边栏 Markdown 预览是只读的（见 `dsh-client-ui-sidebar-documentpreview` 的 “Preview, not editing” 限制）。本插件注册一个同扩展名（`md`/`markdown`）的 `extension`-band 预览实现，优先级高于内置只读版，默认选中；下拉菜单里随时可切回内置的 “Markdown” 只读渲染。

## 使用

1. 在右侧边栏打开任意 `.md` 文件（文件树点它，或 `Mod+P` 走 files 页）。
2. 文档以渲染形态呈现。点击任意文本块 → 该块原地变为编辑框，显示该块的 Markdown 源码。
3. `⌘/Ctrl + Enter` 或移开焦点即保存；`Esc` 取消。
4. 编辑工具条还支持：上方/下方插入块、删除块；文档末尾有 “添加块” 入口；空块保存即删除。
5. 保存状态显示在顶部：保存中… / 已保存 / 保存失败（可重试）。
6. 文件若在别处被修改，顶部出现冲突提示：放弃本地修改重新加载，或保留本地编辑。

frontmatter（`---` 块）同样可点编辑。

## 结构

- `index.js` — Host 半：注册认证 HTTP 端点 `POST /dsh-md-live-edit/api/write`。接收 `{ sessionId, path, content }`，按 workspace-files 相同的规则解析 Session 工作区根（live header → 持久化 header → sandbox 根），经组合 `fs.writeText` 写盘（保留沙箱策略，如 `FS_SANDBOX_DENIED` 会原样回报给 UI）。
- `client.js` — Client 半：注册 `documentPreviews` 元数据 + `sidebar.right.tab.document` body。自带一个块级 Markdown 解析/渲染器（ATX/Setext 标题、围栏代码、GFM 表格、列表、引用、分割线、frontmatter；行内：粗斜体、删除线、行内代码、链接、图片）。每个块保留精确源码行，单块编辑后全文逐字节重建写回；外部内容变化不会打断正在进行的编辑（冲突提示）。

## 已知边界

- 列表渲染为单级（嵌套项按 continuation 文本处理，源码无损）。
- 不渲染数学公式与嵌套引用样式；这些块照常可编辑、源码不丢。
- 写文件权限沿用 Harness 的 sandbox policy：`read-only` 模式下保存会失败并在 UI 显示原因。
