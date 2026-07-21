# Note

[![CI](https://github.com/Wang335533/Note/actions/workflows/ci.yml/badge.svg)](https://github.com/Wang335533/Note/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/Wang335533/Note?label=latest)](https://github.com/Wang335533/Note/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-6f6258.svg)](LICENSE)

一个嵌在 Windows 桌面上的本地 Note 框架：`Todo` 保留“一页今日”的直接感，`Notes` 提供独立、长期、结构化的富文本笔记库。两者是同一应用中的同级模块，内容可以互相链接，但生命周期彼此独立。

2.2.2 延续暖白、炭黑、浅灰与陶土橙的克制视觉，并把 Notes 正文升级为支持数学公式的结构化富文本。本次修复了字体或字号跨越换行时被误判为无效格式、导致保存失败的问题。窗口仍可从四边和四角自由缩放，限制在 420×660 到 760×1050；Notes 在窄窗中使用列表/编辑器导航，在宽窗中自动切换为双栏主从布局。

## 下载

[下载最新 Windows 安装版](https://github.com/Wang335533/Note/releases/latest)。在 Release 页面选择 `Note-x.y.z-setup.exe`；`SHA256SUMS.txt` 可用于核对下载文件是否完整。

Note 当前未使用商业代码签名证书，因此 Windows 首次运行时可能显示“未知发布者”或 SmartScreen 提示。安装包由本仓库的 GitHub Actions 从对应版本源码自动构建。

安装新版本时直接覆盖旧版本即可。Todo、笔记正文、图片和设置保存在 Windows 用户数据目录，不在安装目录中；升级不会创建一套全新的 Note。升级前仍会保留最近一个兼容性快照，便于异常时恢复。

## 已实现

- 头部始终提供可点击的 `Todo | Notes` 模块切换，并分别保留两边的选择、滚动与编辑上下文
- 笔记本优先的单层结构：全部笔记、未分类、普通笔记本与废纸篓；首版不加入标签和嵌套笔记本
- 正文采用真正的所见即所得富文本；标题、字体、字号、加粗、斜体、下划线、删除线、列表、清单、引用、代码、链接和格式刷都直接作用于文字，不显示 Markdown 或 HTML 标签
- 富文本以结构化 JSON 原子保存，同时生成干净的 Markdown 兼容文本；导出保留标题、列表、加粗等标准语义，不把字体和字号私有标签写进文件
- 行内和独立公式由 KaTeX 在本地渲染；支持 `$…$`、`\(…\)`、`$$…$$` 与 `\[…\]` 输入/粘贴，点击公式可重新编辑源码，普通金额与代码不会误转换
- 新建笔记立即打开空白编辑器；标题可以暂时为空，正文第一条有效内容只作为可选标题建议
- 笔记置顶后独立成组，其余默认按最近更新排序，也可临时改为标题或创建时间
- 删除笔记或非空笔记本先进入不会自动过期的废纸篓；支持整本恢复、单篇恢复、明确永久删除与清空
- 可导入一个或多个 Markdown 文件并选择目标笔记本；旧 Markdown 在首次打开时安全转换为富文本，桌面端会明确询问是否复制可解析的 PNG、JPEG、WebP 本地图片
- 整库导出按笔记本生成 Markdown 文件夹，并复制受管图片、重写相对引用
- `Ctrl + K` 统一搜索笔记标题、富文本正文和所有工作日的 Todo；历史任务只读回看，不会切换 `activeDay`
- Todo 可打开关联笔记；笔记中选中文字可新建带反向链接的 Todo，双方完成、删除、换日和编辑不会暗改另一方内容
- 前三项自动进入“今日三件”，其余进入“今天”
- 任务文字直接编辑、拖动排序、分区移动、删除与撤销
- 每条任务可选精确起止时间：24 小时制、15 分钟步进、允许跨午夜与时间重叠；不设置时不显示时间
- 时间可在创建前选择，也可在任务上修改或清除；成功添加后自动恢复为空，避免下一条误用
- 完成任务时文字由左向右划掉，时间标签只轻柔淡出；开启“减少动效”后自动停用动画
- 勾选反馈、折叠完成项、清空完成项与撤销
- 快速输入支持回车、可点击加号和失焦提交；未提交文字会明确显示为草稿并在重开后恢复
- 任务编辑采用 420ms 防抖保存，退出前会等待最后一次编辑真正落盘
- 每次修改原子写入本地 JSON，并保留一个备份文件
- 快速连续操作时拒绝较旧状态覆盖较新状态，避免任务短暂消失或界面回跳
- 桌面端和浏览器预览共用唯一的数据规则、换日逻辑与 Markdown 导出实现，不再维护镜像 reducer
- 空任务和无效设置不会增加版本号，也不会触发磁盘写入
- 凌晨 04:00 换日；未完成任务第二天逐项选择是否移入今天
- 默认作为无任务栏的桌面底层窗口，并可切换普通窗口或常驻最前；支持鼠标穿透锁定与托盘菜单
- Windows 窗口层级切换失败时自动恢复普通窗口，并在设置页显示不打断操作的提示
- 本地故障日志只记录技术错误，限制为 512 KB，并最多保留一个旧日志
- 快捷记录会临时来到前台，失去焦点后自动回到普通层级
- `Ctrl + Alt + N` 显示或隐藏；`Ctrl + Alt + Space` 切回 Todo 并聚焦快速输入；`Ctrl + Alt + Shift + N` 新建空白笔记；`Ctrl + Alt + L` 锁定或解锁
- 开机启动、减少动效、提高不透明度、干净 Markdown 导出
- 无边框窗口支持四边与四角自由缩放，限制为 420×660 到 760×1050；自动记住完整位置和尺寸，并在多显示器工作区内校正

## 安装与直接使用

正式交付只生成 NSIS 安装包，不生成需要先自解压的 portable 版本。普通用户直接从 [Releases](https://github.com/Wang335533/Note/releases) 下载 `Note-x.y.z-setup.exe` 安装。

每次安装都是独立的本地应用，不存在共享内容库。A 电脑的 Todo、笔记正文和图片不会写到 B 电脑，也不会进入项目目录或安装包；跨电脑迁移只能由用户主动整库导出、再导入。

系统关闭命令（例如 Alt+F4）会真正保存并退出 Note；托盘菜单中的“隐藏 Note”和显示/隐藏快捷键只负责临时隐藏。

## 本地开发

需要 Node.js 22.12 或更高版本，推荐使用当前的 Node.js 24 LTS。

```powershell
npm install
npm run desktop:dev
```

只预览界面：

```powershell
npm run dev
```

测试、构建和打包：

```powershell
npm test
npm run build
npm run package:win
npm run package:installer
npm run package:fast
```

## 发布新版本

GitHub Actions 会在每次推送或拉取请求时运行测试和生产构建。正式版本采用语义化标签发布：

1. 更新 `package.json` 与 `package-lock.json` 中的版本号，并完成测试。
2. 提交代码并创建同版本标签，例如 `v2.2.2`。
3. 推送提交和标签；Release 工作流会在 Windows 环境重新安装锁定依赖、运行测试、构建 NSIS 安装包、生成 SHA-256 校验文件并发布正式 GitHub Release。

```powershell
npm version patch --no-git-tag-version
npm test
git add package.json package-lock.json
git commit -m "release: v2.2.2"
git tag v2.2.2
git push origin main
git push origin v2.2.2
```

只有 `v主版本.次版本.修订号` 标签会触发正式发布。`release/` 始终保持在 Git 忽略列表中，安装包只作为 GitHub Release 附件保存。

## 数据位置

正式运行时，数据保存在 Electron 的用户数据目录下：

```text
%APPDATA%/desktop-note/note-data/state.json
```

旁边的 `state.json.bak` 是上一次成功写入前的备份。可以从托盘菜单或设置页直接打开实际数据文件夹。

受管图片位于同一台电脑、同一 Windows 用户目录下的 `note-data/attachments/`。应用没有远程同步端点，不会把 Todo、Notes 或图片上传到开发者电脑；浏览器参考数据只用于本地开发预览，生产构建会自动检查并拒绝把参考样例或持久化状态打进桌面包。

同一目录中的 `note-error.log` 与可选的 `note-error.log.old` 只用于记录保存、恢复、窗口层级和进程故障等技术信息，不包含任务文字；当前日志超过 512 KB 时只轮换一次。

开发模式使用独立的 `%APPDATA%/desktop-note-dev/`，不会改动正式版清单。启动时会同时检查主文件、临时文件和备份，并选取结构有效且版本最新的一份恢复。

## Windows 桌面层说明

Electron 的透明窗口在部分 Windows 显卡合成路径下可能变成黑色，因此 Note 继续使用暖白不透明表面。当前版本延续 Windows 11 系统圆角与 Windows 10 的 10px 小圆角兼容裁切，减少高 DPI 下的边缘台阶。桌面模式不显示任务栏、不开启常驻最前，普通应用会自然盖住 Note；`Ctrl + Alt + Space` 快速记录时临时显示在前台，失去焦点后恢复普通层级。设置中仍可切换为“普通”或“置顶”。若系统拒绝层级切换，Note 会自动改回普通窗口，避免留下黑框或不可交互窗口。

原先的点击闪动来自 `:focus-within`：任意子控件获得焦点都会触发整张 Note 的缩放动画。当前版本只保留很浅的内部暖光反馈，不再改变整张纸张的尺寸或位置。

## 目录

```text
electron/   主进程、持久化与安全 IPC
shared/     Todo/Notes 共用 Store、schema 迁移与笔记库文件规则
src/        React 应用外壳、Todo、Notes、富文本编辑器与浏览器薄适配层
tests/      Store、持久化边界、导入导出与发布规则测试
assets/     来自 Phosphor 图标库的应用图标
release/    Windows 快速版与安装版
```
