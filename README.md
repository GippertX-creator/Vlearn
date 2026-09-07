# Vlearn 教培管理系统

面向教培机构的本地桌面应用（Windows / macOS）：教务管理、考勤管理、财务管理、报表导出四大模块，数据存储于本地 SQLite，无需联网。教务与财务数据严格隔离，财务模块需二次密码验证。

> 面向普通用户的操作指南见 [使用说明书.md](./使用说明书.md)。

## 技术栈

| 层 | 技术 |
| --- | --- |
| 桌面框架 | Electron 33（主进程 + 渲染进程，contextIsolation 隔离） |
| 前端 | React 18 + TypeScript + Vite，Ant Design 5（中文界面） |
| 数据库 | SQLite（`better-sqlite3`，仅在主进程同步操作） |
| 进程通信 | Electron IPC（渲染进程仅通过 preload 暴露的 `window.api` 调用） |
| Excel 导出 | `exceljs`（主进程生成工作簿 + 保存对话框） |
| 日期处理 | `date-fns`（主进程排课计算）、`dayjs`（渲染进程，antd 5 依赖） |
| 打包 | electron-builder（dmg / nsis） |
| 构建 | electron-vite（main / preload / renderer 三段构建） |

## 目录结构

```
├── electron/                    # Electron 主进程（Node 环境）
│   ├── main.ts                  # 入口：创建窗口、初始化 DB、注册 IPC；--smoke-test / --smoke-ui
│   ├── preload.ts               # contextBridge 暴露 window.api（全部 IPC 通道）
│   ├── db.ts                    # SQLite 连接、建表、默认设置（含财务密码哈希）
│   ├── schedule.ts              # 排课生成算法（date-fns，weekday 1=周一…7=周日）
│   ├── ipcHandlers.ts           # 全部 IPC 处理器与业务逻辑（财务权限校验）
│   ├── excelExport.ts           # exceljs 工作簿构建（与保存对话框解耦，便于测试）
│   └── smoke.ts                 # 冒烟测试（逻辑 + UI，走真实 preload/IPC 链路）
├── src/                         # 渲染进程（React）
│   ├── App.tsx                  # 应用外壳：顶部导航 + 财务密码门 + 页面路由
│   ├── api.ts                   # window.api 封装、错误信息提取（getErrorMessage/tryApi）
│   ├── types.ts                 # 全项目共享类型（主/渲染进程共用，不依赖 DOM）
│   ├── global.d.ts              # window.api 类型声明
│   ├── components/              # PageToolbar、ExportExcelButton、AttendanceStatusTag、
│   │                            # InstanceDetailModal（考勤/调课）、CourseManagerModal（课程管理）
│   └── pages/                   # CalendarPage（月/周/日视图）、StudentsPage、TeachersPage、
│                                # FinanceDashboard、CourseFeesPage、StudentPaymentsPage、
│                                # TeacherPaymentsPage、ReportsPage、SettingsPage
├── scripts/rebuild-native.js    # postinstall：将 better-sqlite3 编译为 Electron 原生模块（支持镜像）
├── electron.vite.config.ts      # 三段构建入口配置（入口必须用绝对路径，见下）
├── electron-builder.yml         # 打包配置（asarUnpack better-sqlite3，npmRebuild）
├── docs/images/                 # 说明书截图（由 --smoke-ui + VLEARN_SHOT_DIR 生成）
└── index.html                   # 渲染进程 HTML（含 CSP）
```

## 环境要求与快速开始

- Node.js ≥ 20（开发时使用 24 验证通过）
- npm（或 pnpm）
- 编译 better-sqlite3 需要 C++ 工具链：macOS 安装 Xcode Command Line Tools（`xcode-select --install`）；Windows 安装 Visual Studio Build Tools（勾选 C++ 生成工具）与 Python 3

```bash
npm install        # 安装依赖，postinstall 自动将 better-sqlite3 rebuild 为 Electron ABI
npm run dev        # 开发模式（Vite HMR + Electron）
npm run smoke      # 逻辑冒烟测试（临时数据库，走真实 IPC 链路，不污染用户数据）
npm run smoke:ui   # UI 冒烟测试（验证 React 挂载、无渲染错误，可选截图）
npm run build      # 构建 out/（main + preload + renderer）
npm run dist       # 打包当前平台安装包（输出 release/）
npm run dist:mac   # 打包 macOS（dmg）
npm run dist:win   # 打包 Windows（nsis；Windows 安装包建议在 Windows 机器上构建）
```

> **国内网络**：`.npmrc` 已配置 `electron_mirror`（npmmirror），`scripts/rebuild-native.js` 会自动把镜像注入 `ELECTRON_MIRROR`。若在其他网络环境，删除 `.npmrc` 中的镜像配置即可。`electron-builder` 打包下载 AppImage/NSIS 等二进制同理走 `electron_builder_binaries_mirror`。

## 架构说明

### 进程模型与数据流

```
┌─────────────────────── 主进程 (electron/) ───────────────────────┐
│  initDb() → better-sqlite3（userData/vlearn.db）                 │
│  registerIpcHandlers()：ipcMain.handle 注册全部通道              │
│  财务会话标记 financeUnlocked：仅 verifyPassword 可置位          │
└───────────────▲──────────────────────────────────────────────────┘
                │ contextBridge / ipcRenderer.invoke
┌───────────────┴─────────── 渲染进程 (src/) ──────────────────────┐
│  window.api（preload 暴露，见 src/types.ts 的 VlearnApi）        │
│  React 页面 → api.ts 封装 → 表单/表格/日历 → ExportExcelButton   │
└──────────────────────────────────────────────────────────────────┘
```

- 渲染进程**没有 Node 能力**（`contextIsolation: true`、`nodeIntegration: false`），一切数据读写必须经 `window.api`。
- 所有数据库操作在主进程同步执行（better-sqlite3 是同步 API），IPC 用 `ipcRenderer.invoke`。
- 恢复备份会 `closeDb() → 覆盖文件 → initDb()` 重建连接，因此**所有处理器内部通过 `getDb()` 动态取连接**，切勿在注册时闭包捕获连接（见 `ipcHandlers.ts` 顶部注释）。

### IPC 通道清单

通道名与 `VlearnApi`（`src/types.ts`）一一对应，preload 中 `channel → invoke` 为机械映射：

| 分组 | 通道 |
| --- | --- |
| 课程 | `courses:getAll` `courses:create` `courses:update` `courses:delete` `courses:regenerate` |
| 老师 | `teachers:getAll` `teachers:getDetail` `teachers:create` `teachers:update` `teachers:delete` |
| 学生 | `students:getAll` `students:getDetail` `students:create` `students:update` `students:delete` |
| 排课 | `instances:getRange` `instances:getDetail` `instances:update` `instances:cancel` `instances:restore` |
| 考勤 | `attendance:save` `attendance:remove` `attendance:markAllPresent` |
| 财务会话 | `finance:verifyPassword` `finance:logout` `finance:changePassword` |
| 财务业务 | `finance:getDashboard` `finance:getCourses` `finance:updateCourseFees` `finance:getStudentPayments` `finance:createStudentPayment` `finance:updateStudentPayment` `finance:deleteStudentPayment` `finance:autoCalcStudentPayments` `finance:getTeacherPayments` `finance:createTeacherPayment` `finance:updateTeacherPayment` `finance:deleteTeacherPayment` `finance:autoCalcTeacherPayments` `finance:getPaymentInstances` `finance:getMonthlyReport` |
| 设置/备份 | `settings:get` `settings:save` `backup:create` `backup:restore` |
| 导出 | `export:excel` |

### 权限模型（双重控制）

- **前端**：财务页面（仪表盘/课程费用/学生缴费/老师课酬/盈亏报表）只有通过密码弹窗验证后才能进入；教务页面不渲染任何费用字段（课程费用、课酬、缴费均不出现，而非置灰）。
- **主进程**：所有 `finance:*` 处理器首行调用 `ensureFinance()`，未验证直接抛错 `无权访问财务数据，请先输入财务密码`。会话标记仅存于主进程内存，重启应用即失效。
- 财务密码 SHA-256 哈希存于 `settings` 表 `finance_password_hash`（初始 `admin123`）；修改密码需验证旧密码（设置页）。

### 数据库

表结构见 `electron/db.ts` 的 `migrate()`，与需求文档一致，两处增强：

- `courses.pay_per_session`：单次课酬标准（用于"自动计算应付"），默认 0。
- 两处外键声明为 `ON DELETE SET NULL`（`courses.default_teacher_id`、`schedule_instances.actual_teacher_id`），避免删除老师时因外键约束失败；删除课程/学生仍级联删除（CASCADE）。

`settings` 表键值：

| key | 含义 | 默认值 |
| --- | --- | --- |
| `grades` | 年级选项 JSON 数组 | `["高一","高二","高三"]` |
| `payment_methods` | 缴费方式 JSON 数组 | `["微信","转账","现金"]` |
| `finance_password_hash` | 财务密码 SHA-256 | `sha256("admin123")` |
| `schedule_weeks` | 自动排课周数 | `8` |
| `charge_absent` | 缺勤是否收费 | `1`（收费） |

数据库文件位置：`app.getPath('userData')/vlearn.db`（macOS 为 `~/Library/Application Support/vlearn/vlearn.db`，Windows 为 `%APPDATA%/vlearn/vlearn.db`）。

### 业务规则实现

- **自动排课**（`electron/schedule.ts`）：课程创建时按 `default_schedule_rule`（JSON：`[{weekday, start, end}]`，weekday 1=周一…7=周日）生成未来 N 周实例，同日期+时间段去重；`courses:regenerate` 删除今天及未来的实例后按当前规则重建（历史保留）。修改课程规则**不会**自动改动已生成实例（界面有"重新生成排课"按钮）。
- **学生应缴**（`finance:autoCalcStudentPayments`）：应缴 = 课程费用 × 计费出勤次数（出勤必计费，请假不收费，缺勤按 `charge_absent` 设置）；每个（学生,课程）维护一条记录，重复执行只更新 `amount_due`，不动 `amount_paid`。
- **老师应付**（`finance:autoCalcTeacherPayments`）：为每个未取消实例生成/更新一条课酬记录，应付 = 课程 `pay_per_session`；实例有代课老师（`actual_teacher_id`）时支付给代课老师。
- **盈亏**：收入 = 学生缴费 `amount_paid` 合计；支出 = 老师课酬 `amount_paid` 合计；月度统计按记录的 `payment_date` 所在月份（仪表盘右上角有口径说明）。

### 导出与备份

- `export:excel` 是通用导出通道：渲染进程把**当前筛选后的行**与列定义传给主进程，主进程弹保存对话框并用 exceljs 写 `.xlsx`，文件名 `Vlearn_{模块名}_{yyyy-MM-dd}.xlsx`。`buildWorkbook`（`electron/excelExport.ts`）与对话框解耦，可直接单测。
- 备份：`better-sqlite3` 的在线备份 API（`db.backup(dest)`），无需停库；恢复：校验文件含 `students` 表 → 关连接 → 覆盖 → 重开 → `webContents.reload()`。

## 开发约定

### 新增一个 IPC 接口的步骤

1. `src/types.ts`：在 `VlearnApi` 中声明方法签名（参数用驼峰命名）。
2. `electron/ipcHandlers.ts`：在对应分组的 `register*Handlers()` 中 `ipcMain.handle('通道名', ...)`；财务类接口首行 `ensureFinance()`。
3. `electron/preload.ts`：补一行 `通道名: (参数) => ipcRenderer.invoke('通道名', 参数)`。
4. `src/api.ts` 无需改动（`api = window.api` 直接透传）。

### 其他约定

- 行字段一律 camelCase；SQL 用别名（`class_name AS className`）或 `mapXxx()` 行映射器转换（见 `ipcHandlers.ts`）。
- 错误处理：主进程抛中文 `Error`；渲染进程用 `getErrorMessage(err)` 剥掉 Electron 包装前缀再展示；表单提交用 `tryApi()`。
- 日期一律 `YYYY-MM-DD` 字符串；金额两位小数（`Math.round(x*100)/100`）。
- 类型检查：`npm run typecheck`（node/web 两个 tsconfig 分开，`src/types.ts` 被两者共享，因此它不能依赖 DOM/React 类型）。
- **electron.vite.config.ts 的入口必须用绝对路径**：相对路径 `electron/main.ts` 会被 `externalizeDepsPlugin` 按依赖名 `electron` 误判为外部模块导致构建失败。

## 测试

```bash
npm run smoke      # 41 项断言：默认设置、排课（8 周/周几正确性）、考勤、调课/取消/恢复、
                   # 财务权限拦截、自动计算应缴/应付、仪表盘、报表、密码修改、重新排课、
                   # Excel 生成、设置保存、级联删除
npm run smoke:ui   # React 挂载、导航渲染、preload 注入、无渲染进程错误
                   # 设 VLEARN_SHOT_DIR=<dir> 可同时抓取各页面截图（用于文档）
```

冒烟测试使用 `mkdtemp` 临时数据库，不触碰用户数据；通过隐藏 BrowserWindow 加载真实 preload 后 `executeJavaScript` 调用 `window.api`，覆盖完整 IPC 链路。

## 打包分发

- 打包配置见 `electron-builder.yml`：`asarUnpack` 解包 better-sqlite3（`.node` 必须落在 asar 外），`npmRebuild: true` 保证安装包内的原生模块匹配 Electron ABI。
- macOS 输出 dmg（未签名，首次打开需右键 → 打开，或自行配置签名）；Windows 输出 nsis 安装包（支持选择安装目录）。
- 跨平台构建注意：nsis 在 macOS 上构建需要 wine；正式分发建议分别在对应系统上构建。
- 升级注意事项：`userData/vlearn.db` 独立于安装包，覆盖安装不会丢失数据；大版本升级前建议用"设置 → 备份数据"导出数据库。

## 安全说明

- 渲染进程无 Node 能力、上下文隔离开启；`index.html` 带 CSP（`script-src 'self' 'unsafe-inline'` 是为了兼容 Vite 开发模式注入的内联脚本，生产可收紧为 `'self'`）。
- 财务密码以 SHA-256 存于本地 `settings` 表；这是单机应用的访问控制手段，**不适用于多用户对抗场景**，请勿在共享机器上存放大额资金数据。
- 忘记财务密码的恢复方式：备份数据库后，由技术人员删除 `settings` 表中 `finance_password_hash` 一行并重启应用，密码即恢复为初始 `admin123`（见使用说明书 FAQ）。

## 常见问题

| 问题 | 处理 |
| --- | --- |
| `npm install` 时 Electron 下载超时 | `.npmrc` 已配 npmmirror 镜像；其他网络可删除镜像配置 |
| `node-gyp failed to rebuild better-sqlite3` | 安装 C++ 工具链（macOS: `xcode-select --install`；Windows: VS Build Tools + Python）；或手动 `npm run rebuild` |
| 开发模式白屏、控制台 CSP 报错 | 确认 `npm run dev` 由 electron-vite 启动（会注入 `ELECTRON_RENDERER_URL`） |
| 打包后打开提示"应用已损坏"（macOS） | 未签名所致：右键 → 打开，或配置 Apple 开发者签名 |
| 数据在哪里 | `userData/vlearn.db`（路径见上文）；备份/恢复在"设置 → 数据备份与恢复" |
| 如何重置财务密码 | 见"安全说明"最后一条；普通用户可见 [使用说明书.md](./使用说明书.md) |
