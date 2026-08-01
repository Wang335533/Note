# Note 项目指令

## 定位

Note 是一个面向 Windows 与 macOS 的本地优先桌面应用：`Todo` 负责“一页今日”，`Notes` 负责长期结构化笔记。两个模块同级、可互相链接，但生命周期彼此独立。详细产品取舍以 `docs/PRODUCT.md` 为准，使用与发布说明以 `README.md` 为准。

## 运行与门禁

- Node.js：`>=22.12.0`，CI 使用 Node.js 24。
- 开发桌面版：`npm run desktop:dev`；仅浏览器预览：`npm run dev`。
- 提交前至少运行：`npm test`、`npm run build`。
- 涉及 Electron、持久化、升级或富文本时，再运行：`npm run smoke:desktop`。
- `main` 受仓库 Ruleset 保护：所有改动先走分支与 PR，`test-and-build` 通过后使用 squash 或 rebase 合并；正式版本标签只能在合并后的 `main` 上创建。
- Windows 安装包：`npm run package:installer`；macOS 通用 DMG：在 macOS 上运行 `npm run package:mac`；正式发布只由 `vX.Y.Z` 标签触发 GitHub Actions。

## 技术栈与目录

- Electron 主进程：`electron/`；React/Vite 渲染层：`src/`。
- 唯一业务 Store、schema 和跨进程共享规则：`shared/`。
- 自动化门禁：`tests/`；打包辅助与 smoke：`scripts/`。
- `shared/store.cjs` 是桌面端和浏览器预览的单一状态规则；浏览器 API 只适配 fixture、localStorage、事件与下载。
- CommonJS/ESM 同时需要的共享能力只保留一份实现；另一种模块格式必须是薄适配层，不复制业务逻辑。

## 不可破坏的数据合同

- 主进程是正式数据唯一真源；渲染层只通过受限 IPC 操作，不能直接访问文件系统。
- 数据只保存在当前系统用户的 Electron `userData/note-data`，没有远程同步端点。
- 保持 `appId=local.desktop.note`、产品名和数据目录稳定；升级安装不得创建一套新数据。
- 新版本写入迁移状态前保留且只保留一个升级前快照；迁移失败自动恢复，旧版本不得覆盖新 schema 数据。
- 每次 mutation 原子持久化；较低 revision 不能覆盖较高 revision；无效或空操作不增加 revision。
- 正式包不得包含开发 fixture、开发者状态、真实笔记、缓存或本地产物。

## 不可破坏的产品合同

- Todo 在 04:00 换日；未完成任务进入逐项复核，不自动顺延。
- 每日前三项自动进入“今日三件”；任务始终保持手动顺序。
- 时间段可选，24 小时制、15 分钟步进，可重叠和跨午夜；未设置时不显示。
- Notes 只支持“笔记本 → 一级文件夹 → 笔记”，不加入多级文件夹或标签。
- 富文本以经验证的 Tiptap/ProseMirror JSON 为编辑真源，并派生干净 Markdown 用于搜索、兼容与导出。
- 表格必须保存为可编辑的结构化节点；支持 GFM 表格粘贴、保守迁移和导出，单表上限 200 行 × 30 列，超限时保留原文。
- 段落对齐是 paragraph/heading 的结构化视觉属性；正文首行缩进固定为 2 字符且只允许出现在文档根级 paragraph，二者都不得污染 Markdown。
- Times New Roman 只占用西文字体槽；混合选区中的中文区段及其现有东亚字体标记不得被覆盖。
- 格式刷遵循 Word 的单击一次、双击连续和 `Esc` 退出范式；局部选区只复制文字格式，完整段落或光标源才复制段落格式，且不得删除链接、公式或表格结构。
- 受管图片仅限 PNG/JPEG/WebP，放在内部 attachments 目录；永久删除前不得删除正文或图片。
- Todo 与 Notes 的链接不改变双方独立的完成、删除、换日与编辑状态。

## 不可破坏的界面与运行合同

- 默认界面保持低密度；高级控制放入托盘、快捷键、设置页或紧凑弹层。
- 不对整张卡片做点击/聚焦缩放；动效必须局部、克制，并服从“减少动效”。
- 无边框窗口最小 420×660，宽高独立，允许四边/四角缩放与标准最大化，不设人为最大尺寸。
- Windows 右上角关闭按钮必须位于窗口操作区最右侧、处于 `no-drag` 区域，并复用现有保存后退出流程；macOS 使用原生红黄绿按钮，红色关闭只隐藏，Cmd+Q 复用保存后退出流程。
- Notes 在 420–639px 使用单栏导航，640px 起使用列表+编辑器；最大化时阅读列保持有界居中。
- Windows 层级切换失败时回退普通窗口并给出非阻断提示，不能留下黑框或不可交互窗口。
- 富文本命令必须作用于真实 marks/nodes，不能把 `<font>`、`<span>` 或 LaTeX 定界符作为可见正文保存。
- 任何富文本命令都必须先排除已销毁的 Tiptap 实例。

## 发布与当前状态

- 正式交付只发布 Windows NSIS、macOS Universal DMG 和包含两者的 `SHA256SUMS.txt`，不发布自解压 portable。
- 打包 smoke 必须使用显式临时 `NOTE_SMOKE_USER_DATA`，不能只改 `APPDATA`。
- 当前稳定版为 `2.7.2`；本文件不保存单次迭代流水账或已完成 TODO。
