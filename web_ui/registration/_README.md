# Registration Mode - Batch Account Registration UI

> 注册模式 Tab 的模块划分。每个文件只做一件事，参考 any-auto-register 项目风格。

## 文件清单

| 文件 | 行数 | 职责 |
|------|------|------|
| `icons.js` | 44 | SVG 图标集中管理 |
| `utils.js` | 20 | HTML 转义等通用工具 |
| `register_state.js` | 174 | 表单数据、任务状态、日志行管理 |
| `register_api.js` | 90 | HTTP 请求封装（配置/平台/任务） |
| `register_config.js` | 193 | 平台选项、执行器选项、注册方式选项构建 |
| `tab_register.js` | 283 | 主入口（初始化/渲染/事件/提交/轮询） |
| `index.html` | 43 | HTML 骨架（静态写入，不做 JS 注入） |
| `cards/basic.js` | 29 | 基础配置卡片（平台/数量/代理） |
| `cards/identity.js` | 30 | 账号来源卡片（邮箱/OAuth 选择） |
| `cards/executor.js` | 25 | 执行通道卡片（协议/无头/有头） |
| `cards/chrome.js` | 24 | Chrome Profile 配置卡片（OAuth 时显示） |
| `cards/provider.js` | 72 | 邮件/短信 Provider 配置卡片 |
| `cards/summary.js` | 40 | 右侧摘要面板（配置摘要+开始注册按钮） |
| `cards/status.js` | 60 | 执行状态面板（状态徽章/进度/成功失败统计） |
| `cards/log.js` | 23 | 实时日志面板 |
| `css/layout.css` | 47 | 双栏布局、通用卡片样式 |
| `css/form.css` | 48 | 表单输入框、下拉框样式 |
| `css/pill.css` | 39 | 胶囊选择按钮组样式 |
| `css/section.css` | 72 | 右侧摘要/状态面板样式 |
| `css/button.css` | 77 | 提交按钮、警告条、日志面板、加载动画 |

## 模块依赖关系

```
tab_register.js (主入口)
  ├─ register_state.js
  ├─ register_api.js
  ├─ register_config.js
  ├─ RegCardBasic   ← cards/basic.js
  ├─ RegCardIdentity← cards/identity.js
  ├─ RegCardExecutor← cards/executor.js
  ├─ RegCardChrome ← cards/chrome.js
  ├─ RegCardProvider← cards/provider.js
  ├─ RegCardSummary ← cards/summary.js
  ├─ RegCardStatus  ← cards/status.js
  └─ RegCardLog     ← cards/log.js
       └─ RegUtils  ← utils.js
            └─ RegIcons ← icons.js
```

## 设计原则

- **每个文件不超过 300 行**
- HTML 骨架静态写入 `index.html`，不做 JS 注入
- CSS 拆分为 5 个小文件（layout/form/pill/section/button）
- 各卡片渲染器独立文件，职责单一
- 初始化同步渲染空状态，后台静默加载 API
