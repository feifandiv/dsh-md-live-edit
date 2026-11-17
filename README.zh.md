# @fanfan4589/dsh-md-live-edit

[![npm](https://img.shields.io/npm/v/@fanfan4589/dsh-md-live-edit)](https://www.npmjs.com/package/@fanfan4589/dsh-md-live-edit)
[![license](https://img.shields.io/npm/l/@fanfan4589/dsh-md-live-edit)](./LICENSE)
[![tests](https://img.shields.io/badge/tests-34%20passing-brightgreen)](./test)

[English](README.md) | 中文

在侧边栏预览里**直接编辑** Markdown 文件：点击渲染出的任意区块，就地编辑这一块的
Markdown 源码，整篇文档自动写回磁盘。不需要切代码模式，也不需要另开编辑器。

![三步：点击区块 → 就地编辑 → ⌘↩ 保存](./docs/how-it-works.zh.svg)

> **定位：克制的小功能补丁。** 只新增一个预览实现和一条写盘路由；不替换内置槽位与
> 布局，不改内核行为，不碰其他插件的数据。关掉或卸载即回到官方只读预览。

## 它解决什么

内置侧边栏预览是只读的（`dsh-client-ui-sidebar-documentpreview` 明确写着
“Preview, not editing”）。想改一个字，就得离开渲染视图、另找编辑器，还会失去上下文。

本插件注册一个 `extension` 档位的 Markdown 预览实现，扩展名相同（`md`、`markdown`），
优先级高于内置只读版，默认选中；渲染器下拉里随时可以切回内置的 **Markdown**、
**代码**、**纯文本** 只读视图。

## 怎么用

1. 在右侧边栏打开任意 `.md` 文件（文件树点开，或 `Mod+P` 走 files 页）。
2. 文档以渲染态呈现：标题栏显示 **Markdown 可编辑**，正文顶部有绿色 **可编辑** 标签。
3. **点击任意区块** → 该块原地变成一个小编辑器，里面是这一块**精确的 Markdown 源码**，
   其余部分保持渲染。
4. 按 `⌘/Ctrl + Enter`（或点 **保存**）写回整篇文档；`Esc` / **取消** 放弃这一块的修改。
5. 工具条还能：**上方插入**、**下方插入**、**删除**（内容清空保存即删除，删除时会顺带
   收掉多余空行）。文档末尾有 **+ 添加块** 入口。
6. 顶部会显示保存状态：保存中 / 已保存 / 保存失败（可重试）。若文件在别处被修改，
   会出现冲突提示：放弃本地修改重新加载，或保留本地编辑。

frontmatter（`---` 块）同样可以点开编辑。

### 改表格

表格块打开就是这张表的 Markdown 写法，加一行就是加一行数据：

```markdown
| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 就地编辑 | ✅ | 点任意区块 |
| 保存 | ✅ | ⌘↩ |
```

保存后渲染出的表格立即更新。

## 优势

- **不离开渲染视图**：没有模式切换，也不用看整篇源码。
- **源码保真**：每个块保留精确源码行，改一块只会替换这一段，其余格式、frontmatter、
  空行逐字节不变。
- **整篇安全**：大文件会先把剩余分页读完再允许编辑，保存不可能只写回第一页。
- **尊重沙箱**：写盘走组合 `fs`，带上当前会话策略（`sandboxPolicy.resolve({ session })`）；
  `只读` 会话会被拒绝，而不是被放宽。
- **路由有准入**：写盘路由先问 `connection.requestRejection`（Host/Origin 围栏 + 浏览器
  会话），被拒时既不读请求体也不碰文件系统。
- **与宿主一致**：只用主题 token；中英双语，跟随 `ctx.locale` 实时切换。

## 劣势（如实）

- **是块级源码编辑，不是富文本**：编辑的是这一块的 Markdown 源码（表格打开就是表格
  源码），没有 Word/Excel 式的直接输入，也没有单元格级编辑。
- **不能新建/重命名文件**：只编辑当前打开的文件，新建与重命名仍走文件面板。
- **渲染是有意为之的子集**：ATX/Setext 标题、围栏代码、GFM 表格、列表、引用、分割线、
  frontmatter；行内粗体/斜体/删除线/行内代码/链接/图片。列表只渲染一级，数学公式与
  嵌套引用样式不渲染——但源码完整、照样可编辑。
- **整文件写回**：一次保存重写整个文件；编辑期间的外部修改会作为冲突提示，但没有
  逐行 patch 传输。
- **版本下限**：需要 DSH `>=0.2.2-rc.1`（`connection` 服务提供 `requestRejection`
  的版本线）。更老的 Host 上路由按 `401` 关闭，而不是开放无守卫的写入口。
- **保存受会话模式约束**：`只读` 会话里预览可点开，但保存会被沙箱拒绝并显示原因。

## 能力矩阵

| 项目 | 支持情况 |
| --- | --- |
| 文件类型 | `.md`、`.markdown` |
| 块编辑 | 标题、段落、列表、引用、围栏代码、表格、分割线、frontmatter |
| 行内渲染 | 粗体、斜体、删除线、行内代码、链接、图片 |
| 块操作 | 编辑、删除、上方插入、下方插入、末尾追加 |
| 保存 | `⌘/Ctrl+Enter` 或按钮；整篇写回 |
| 冲突处理 | 外部修改提示，可重载或保留 |
| 渲染器 | 默认选中；下拉可切回内置 Markdown / 代码 / 纯文本 |
| 语言 | 英文、中文 |

## 安装

### 本地目录

```bash
git clone https://github.com/feifandiv/dsh-md-live-edit.git
```

然后在 DSH 里把它作为 bundle 添加（设置 → 插件 → 添加/克隆该目录，或用
`plugin_manager` 的 `install_bundle` 指向插件绝对路径）。bundle 行名为 `md-live-edit`。

### 从 npm

```bash
npm pack @fanfan4589/dsh-md-live-edit
tar -xzf fanfan4589-dsh-md-live-edit-*.tgz
# 把解压后的包目录作为 bundle 添加到 DSH
```

## 开发

```bash
npm test        # node --test test/*.test.mjs —— 34 个用例
```

| 路径 | 职责 |
| --- | --- |
| `index.js` | Host 半：带准入的 `POST /dsh-md-live-edit/api/write` |
| `client.js` | Client 半：预览元数据、keyed 文档 body、块解析与就地编辑 |
| `test/gate.test.mjs` | 路由准入、被拒时不读 body/不碰 fs、沙箱策略 |
| `test/client.test.mjs` | 模块标识、注册元数据、解析往返、文本变换 |
| `test/render.test.mjs` | 端到端渲染 body（VM 超时保护） |
| `test/inline.test.mjs` | 行内渲染终止性（子进程看门狗） |
| `test/labels.test.mjs` | 本地化标签，UI 不出现原始 key |

另见 [CONTRIBUTING.md](CONTRIBUTING.md) 与 [RELEASING.md](RELEASING.md)。

## 许可证

[MIT](LICENSE) © feifandiv
