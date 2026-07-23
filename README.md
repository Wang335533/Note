# Note

[![CI](https://github.com/Wang335533/Note/actions/workflows/ci.yml/badge.svg)](https://github.com/Wang335533/Note/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/Wang335533/Note?label=latest)](https://github.com/Wang335533/Note/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-6f6258.svg)](LICENSE)

一个嵌在 Windows 桌面上的本地 Note 框架：`Todo` 保留“一页今日”的直接感，`Notes` 提供独立、长期、结构化的富文本笔记库。两者是同一应用中的同级模块，内容可以互相链接，但生命周期彼此独立。

## 下载

[下载最新 Windows 安装版](https://github.com/Wang335533/Note/releases/latest)。在 Release 页面选择 `Note-x.y.z-setup.exe`；`SHA256SUMS.txt` 可用于核对下载文件是否完整。

Note 当前未使用商业代码签名证书，因此 Windows 首次运行时可能显示“未知发布者”或 SmartScreen 提示。安装包由本仓库的 GitHub Actions 从对应版本源码自动构建。

安装新版本时直接覆盖旧版本即可。Todo、笔记正文、图片和设置保存在 Windows 用户数据目录，不在安装目录中；升级不会创建一套全新的 Note。升级前仍会保留最近一个兼容性快照，便于异常时恢复。

## 已实现

- `Todo | Notes` 是同一窗口中的两个同级模块，并分别记住选择、滚动和编辑上下文。
- Todo 的前三项自动进入“今日三件”；任务可直接编辑、拖动排序、完成、撤销，并在凌晨 04:00 逐项复核未完成内容。
- 每条任务可选 24 小时制起止时间：15 分钟步进、允许重叠与跨午夜，不设置时不显示且永不改变手动顺序。
- Notes 提供全部笔记、未分类、笔记本、一级文件夹和废纸篓；笔记可在这些位置之间移动，不加入多级目录或标签。
- 富文本支持标题、固定字体/字号、行距、常见内联与段落格式、格式刷，以及 `Ctrl + [` / `Ctrl + ]` 逐级调整字号。
- 行内与独立公式由本地 KaTeX 渲染；结构化正文同时派生干净 Markdown 和纯文本，不向用户显示 HTML/Markdown 标记。
- 支持 Markdown 导入、整库导出及内部管理的 PNG/JPEG/WebP 图片；永久删除前不会清除正文或图片。
- `Ctrl + K` 统一搜索全部笔记与历史 Todo；Todo 和笔记可以互相链接，但不会暗改对方状态。
- 每次变更原子保存到本地 JSON，并拒绝旧 revision 覆盖新状态；升级保留最近一个兼容性快照。
- 默认作为桌面底层窗口，也可切换普通或置顶模式；支持托盘、全局快捷键、鼠标穿透锁定和故障回退。
- 无边框窗口最小 420×660，可从四边/四角缩放并标准最大化；Notes 根据宽度自动切换单栏和双栏。
- 应用没有账户或同步服务，正式安装包不会包含开发 fixture、开发者状态或任何用户内容。

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
npm run smoke:desktop
npm run package:installer
```

## 发布新版本

GitHub Actions 会在每次推送或拉取请求时运行测试和生产构建。正式版本采用语义化标签发布：

1. 更新 `package.json` 与 `package-lock.json` 中的版本号，并完成测试、构建与桌面 smoke。
2. 提交代码并创建同版本标签，例如 `vX.Y.Z`。
3. 推送提交和标签；Release 工作流会在 Windows 环境重新安装锁定依赖、运行测试、构建 NSIS 安装包、生成 SHA-256 校验文件并发布正式 GitHub Release。

```powershell
npm version <next-version> --no-git-tag-version
npm test
npm run build
npm run smoke:desktop
git add .
git commit -m "release: v<next-version>"
git tag v<next-version>
git push origin main
git push origin v<next-version>
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
shared/     Todo/Notes 共用 Store、schema 迁移与跨进程规则
src/        React 应用外壳、Todo、Notes、富文本编辑器与浏览器薄适配层
tests/      Store、持久化边界、导入导出与发布规则测试
scripts/    图标、构建校验与隔离桌面 smoke
docs/       稳定产品与架构取舍
assets/     应用图标源文件
release/    本地打包输出（已忽略；正式安装包在 GitHub Releases）
```
