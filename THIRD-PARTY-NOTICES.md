# 第三方组件与许可证

本软件（BetterThanChatbox）自己的代码以 [MIT 许可证](LICENSE) 发布。
它依赖 / 分发了下面这些第三方组件，各自的许可证如下。

## 运行时依赖（`package.json` 的 dependencies）

| 组件 | 用途 | 许可证 |
| --- | --- | --- |
| [marked](https://github.com/markedjs/marked) | 渲染 Markdown | MIT |
| [highlight.js](https://github.com/highlightjs/highlight.js) | 代码块语法高亮 | BSD-3-Clause |

## 打包分发时随附的组件

免安装版本（GitHub Releases 里的 zip）里包含 Electron 运行时，即 `app-runtime\` 目录：

| 组件 | 许可证 | 许可证全文在哪 |
| --- | --- | --- |
| [Electron](https://github.com/electron/electron) | MIT | 解压后的 `app-runtime\LICENSE` |
| [Chromium](https://www.chromium.org/) 及其第三方组件 | BSD-3-Clause 等多种 | 解压后的 `app-runtime\LICENSES.chromium.html` |

> 这两个文件是 Electron 官方发行版自带的，打包时**会原样保留**，请不要删除 ——
> Chromium 的 BSD 许可证要求二进制分发时随附其版权声明与许可证全文。

## 开发依赖（不进分发）

| 组件 | 用途 | 许可证 |
| --- | --- | --- |
| [Electron](https://github.com/electron/electron) | 桌面应用运行时 | MIT |

## 测试样本（`test-fixtures/`）

`test-fixtures/office/` 下的 `sample.docx` / `sample.xlsx` / `sample.pptx` 是测试脚本
`scripts/make-office-fixtures.py` 用 python-docx / python-pptx / openpyxl 生成的**空白内容样本**，
不含任何第三方受版权保护的内容。

（`real-template.docx` / `real-template.pptx` 是从 python-docx / python-pptx 包里复制出来的空白模板，
已在 `.gitignore` 中排除，不进仓库。）

## 应用图标（`assets/icon.ico`）

由本项目的 `scripts/make-icon.cjs` 用 Electron 离屏渲染 HTML/CSS 生成，不含任何第三方素材。
