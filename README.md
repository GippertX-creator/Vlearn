# Vlearn 教培管理系统

面向教培机构的本地桌面应用（Windows / macOS）：教务管理、考勤管理、财务管理、助教协作、报表导出五大模块，数据存储于本地 SQLite，无需联网。

**v2 特性**：教务 / 财务 / 助教三种角色，各自使用**独立的物理数据库**（数据隔离），内置教务 Agent 与财务 Agent（排课冲突检测、考勤异常提醒、对账检查、异常交易检测、AI 报告等），助教模块支持课程内容记录与基于外部大模型的微信群短信生成。

**v3 特性**：Agent 提示词集中管理与调优（微信群短信语言优化 + 下次上课预告）；**多校区信息同步**（人工同步包：全量快照 + 删除墓碑 + 跨校区 id 冲突自动重映射，财务数据与密钥不参与同步）。

> 面向普通用户的操作指南见 [使用说明书.md](./使用说明书.md)。

## 技术栈

| 层 | 技术 |
| --- | --- |
| 桌面框架 | Electron 33（主进程 + 渲染进程，contextIsolation 隔离） |
| 前端 | React 18 + TypeScript + Vite，Ant Design 5（中文界面） |
| 数据库 | SQLite（`better-sqlite3`，仅在主进程操作；三个角色三个库文件） |
| 进程通信 | Electron IPC（渲染进程仅通过 preload 暴露的 `window.api` 调用） |
| Excel 导出 | `exceljs`（主进程生成工作簿 + 保存对话框） |
| 大模型接入 | 主进程 `fetch` 调用 OpenAI 兼容 API（DeepSeek/通义/GPT 等，配置于各角色设置） |
| 日期处理 | `date-fns`（主进程）、`dayjs`（渲染进程） |
| 打包 / 构建 | electron-builder（dmg / nsis）/ electron-vite |

## 目录结构

```
├── electron/                    # Electron 主进程
│   ├── main.ts                  # 入口：初始化三库+认证、注册 IPC；--smoke-test / --smoke-ui
│   ├── db.ts                    # 三库管理（vlearn_academic/finance/assistant.db）、旧库自动迁移
│   ├── auth.ts                  # 角色会话（登录/登出/密码），auth.json 持久化，requireRole 权限校验
│   ├── ai.ts                    # OpenAI 兼容大模型客户端（30s 超时、错误归一化）
│   ├── prompts.ts               # 全部生成文本的系统提示词（集中调优）
│   ├── sync.ts                  # 多校区同步引擎（快照导出/合并导入/墓碑/重映射）
│   ├── agent.ts                 # 教务/财务 Agent 逻辑（本地规则检测 + 可选 LLM 文本生成）
│   ├── schedule.ts              # 排课生成算法
│   ├── ipcHandlers.ts           # 全部 IPC 处理器（每个通道严格角色校验 + 跨库只读/清理）
│   ├── excelExport.ts           # exceljs 工作簿构建
│   ├── preload.ts               # contextBridge 暴露 window.api
│   └── smoke.ts                 # 冒烟测试（逻辑 + UI）
├── src/                         # 渲染进程
│   ├── App.tsx                  # 外壳：登录门 + 角色菜单（Sider）+ 右侧 Agent 助手面板
│   ├── roleContext.ts           # useRole() 当前角色上下文
│   ├── api.ts / types.ts / global.d.ts
│   ├── pages/                   # LoginPage、CalendarPage、Students/TeachersPage、
│   │                            # ReportsCenterPage（教务报告）、SettingsPage（按角色分节）、
│   │                            # FinanceDashboard、CourseFees、Student/TeacherPayments、Reports、
│   │                            # LessonNotesPage、HistoryMessagesPage（助教）、
│   │                            # SyncPage（多校区同步）
│   └── components/              # AgentSidebar、LessonNoteEditorModal、InstanceDetailModal、
│                                # CourseManagerModal、PageToolbar、ExportExcelButton 等
├── scripts/rebuild-native.js    # postinstall：better-sqlite3 → Electron ABI（支持镜像）
└── .github/workflows/           # 云端构建（GitHub Actions：Windows + macOS 安装包）
```

## 环境要求与快速开始

```bash
npm install        # 安装依赖，postinstall 自动将 better-sqlite3 rebuild 为 Electron ABI
npm run dev        # 开发模式（Vite HMR + Electron）
npm run smoke      # 逻辑冒烟测试（临时数据目录，走真实 IPC 链路）
npm run smoke:ui   # UI 冒烟测试（登录页/三角色界面渲染；VLEARN_SHOT_DIR=dir 可截图）
npm run typecheck  # 主进程 + 渲染进程类型检查
npm run build      # 构建 out/
npm run dist       # 打包当前平台安装包（release/）
```

- Node.js ≥ 20（20/22/24 均验证可用）；编译 better-sqlite3 需要 C++ 工具链（macOS：Xcode CLT；Windows：VS Build Tools + Python，或直接双击根目录 `build-windows.bat` 一键构建）。
- **国内网络**：`.npmrc` 已配 npmmirror 镜像，postinstall 自动注入 `ELECTRON_MIRROR`。
- **云端构建**：推送到 GitHub 后，Actions → “构建安装包（Windows + macOS）” → Run workflow，产物在 Artifacts（30 天有效）。

## 架构说明

### 角色与物理数据隔离

| | 教务 academic | 财务 finance | 助教 assistant |
| --- | --- | --- | --- |
| 数据库文件 | `vlearn_academic.db` | `vlearn_finance.db` | `vlearn_assistant.db` |
| 初始密码 | `admin123` | `admin123` | `assistant123` |
| 教务数据（课程/学生/老师/考勤） | 读/写 | 只读 | 只读 |
| 课程费用（fee/pay_per_session 两列） | 不可见（IPC 边界清零） | 读/写 | 不可见 |
| 财务数据（缴费/课酬/报表） | 不可见 | 读/写 | 不可见 |
| 助教数据（课程记录/短信） | 不可见 | 不可见 | 读/写 |

- 登录：应用启动显示角色选择页 → 密码验证（SHA-256 存各自库 `settings.password_hash`）→ 会话持久化到 `auth.json`，下次启动自动进入，直至"退出登录"。
- 主进程每个 IPC 处理器首行 `requireRole([...])` 校验会话角色；财务/助教对教务库的访问只经过**只读 SQL**；跨库外键（如财务库的 `course_id`）无法在 SQLite 声明，由主进程在教务删除课程/学生/老师时**同步清理**财务库关联记录。
- 旧版单库升级：首次启动检测 `vlearn.db` → 按域复制到三个新库（行数校验）→ 财务密码沿用旧哈希，教务/助教写入初始密码 → 旧库重命名备份（`vlearn.db.migrated-*`）并写 `migration.log`；失败时保留旧库并在登录页提示，新库清空后下次重试。

### 进程模型与数据流

```
┌──────────────────────── 主进程 (electron/) ────────────────────────┐
│  initDatabases()：三库连接 + 建表 + 种子设置 + 旧库迁移            │
│  initAuth()：会话（auth.json）→ requireRole() 统一权限闸门        │
│  Agent：本地规则（冲突/考勤/对账/逾期/异常）+ callLLM 文本生成      │
└───────────────▲────────────────────────────────────────────────────┘
                │ contextBridge / ipcRenderer.invoke
┌───────────────┴──────────── 渲染进程 (src/) ───────────────────────┐
│  LoginPage → 角色主界面（Sider 菜单 + 内容区 + AgentSidebar）       │
│  页面通过 window.api 调用；useRole() 感知角色条件渲染               │
└────────────────────────────────────────────────────────────────────┘
```

### IPC 通道清单（v2）

| 分组 | 通道 | 权限 |
| --- | --- | --- |
| 登录 | `auth:getStatus` `auth:login` `auth:logout` `auth:changePassword` | 登录无需会话，改密需会话 |
| 教务读 | `courses:getAll` `teachers:getAll` `teachers:getDetail` `students:getAll` `students:getDetail` `instances:getRange` `instances:getDetail` | 三角色 |
| 教务写 | `courses:create/update/delete/regenerate` `teachers:create/update/delete` `students:create/update/delete` `instances:update/cancel/restore` `attendance:save/remove/markAllPresent` | 仅教务 |
| 财务 | `finance:getDashboard` `finance:getCourses` `finance:updateCourseFees` `finance:getStudentPayments` `finance:createStudentPayment` `finance:updateStudentPayment` `finance:deleteStudentPayment` `finance:autoCalcStudentPayments` `finance:getTeacherPayments` `finance:createTeacherPayment` `finance:updateTeacherPayment` `finance:deleteTeacherPayment` `finance:autoCalcTeacherPayments` `finance:getPaymentInstances` `finance:getMonthlyReport` | 仅财务 |
| 助教 | `assistant:getLessonNote` `assistant:saveLessonNote` `assistant:listLessonNotes` `assistant:generateSms` `assistant:listMessages` `assistant:deleteMessage` | 仅助教 |
| Agent | `agent:getAlerts`（教务/财务）`agent:checkCourseConflict` `agent:checkInstanceConflict` `agent:suggestSlots` `agent:checkDuplicateName` `agent:generateReport`（教务）`agent:reconcile` `agent:checkPaymentAnomaly` `agent:trendAnalysis` `agent:smartReport`（财务） | 按角色 |
| 设置/备份/导出 | `settings:get` `settings:save`（按角色分节）`app:getVersion` `backup:create` `backup:restore` `export:excel` | 任意已登录角色 |
| 多校区同步 | `sync:getInfo` `sync:saveCampusName` `sync:exportPackage` `sync:importPackage` | 教务/助教 |

### 多校区同步（v3）

- **模型**：人工同步包——导出 JSON 文件 → 微信/邮件发送 → 对方导入；每次导出都是**全量快照 + 删除墓碑**，导入幂等、顺序无关、丢包自愈。
- **范围**：教务库（课程/老师/学生/排课/考勤/设置）+ 助教库（lesson_notes）；财务库、`password_hash`、`ai_api_key` 永不入包。
- **合并规则**（`electron/sync.ts`）：同来源同行为 LWW（`updated_at` 大者胜）；两校区同 id 不同行（以 `sync_origin` 区分）自动为新行分配新 id 并重建外键引用（`sync_remote_id` 记录来源 id）；墓碑在来源一致且晚于本地修改时级联删除并继续传播。
- 同步元数据列（`updated_at`/`sync_origin`/`sync_remote_id`）通过幂等 ALTER 追加，旧库升级无损；所有写路径维护时间戳与墓碑。

### Agent 设计原则

- **检测类能力全部本地确定性规则**（离线可用、毫秒级）：排课冲突（老师/学生时间重叠）、考勤异常（连续缺勤/请假 ≥ 阈值）、信息补全、相似姓名、对账差异、缴费逾期、异常交易（金额超均值 N 倍 / 频繁修改 / 实缴远大于应缴）。
- **文本生成类能力优先大模型、未配置时回退系统模板**：微信群短信（未配置则报错，助教必配）、教务周报/月报、盈亏趋势分析、智能报表（`GeneratedContent.usedAi` 标记来源）。模型名/温度/提示词由开发者预设（`electron/ai.ts`），用户仅填 API URL + Key（OpenAI 兼容，如 `https://api.deepseek.com/v1`）。
- 侧边栏提醒由渲染进程触发刷新（登录后 / 每 4 小时 / 页面动作派发 `vlearn:refresh-alerts` 事件），计算在主进程。

### 业务规则

- **排课**：课程创建按 `default_schedule_rule` 自动生成未来 N 周实例；修改规则不自动更新已有实例，可"重新生成排课"（仅重建今天及未来，历史保留）。
- **应缴** = 课程费用 × 计费出勤次数（出勤必计费、请假免费、缺勤按财务设置 `charge_absent`）；**应付** = 单次课酬标准（代课付给代课老师）。
- **盈亏** = 学生实缴 − 老师实付，按月统计（`payment_date` 所在月份）。

### 各角色库 `settings` 表关键键

- 通用：`password_hash`；教务：`grades` `schedule_weeks` `agent_conflict_detect` `agent_attendance_alert` `agent_attendance_threshold` `agent_completeness_hint` `ai_api_url` `ai_api_key`；财务：`payment_methods` `charge_absent` `agent_overdue_alert` `agent_overdue_days` `agent_anomaly_detect` `agent_anomaly_multiplier` `ai_api_url` `ai_api_key`；助教：`ai_api_url` `ai_api_key`。
- `ai_model` 可被技术人员直接写入各库覆盖默认模型名（界面不开放）。

## 开发约定

新增 IPC 接口：`src/types.ts`（VlearnApi 签名）→ `electron/ipcHandlers.ts`（处理器，首行 requireRole）→ `electron/preload.ts`（通道映射）。行字段 camelCase（SQL 别名或 `mapXxx()` 映射）；错误用中文 `Error` 抛出、渲染层 `getErrorMessage()` 展示；日期 `YYYY-MM-DD` 字符串；金额两位小数。

**electron.vite.config.ts 的入口必须用绝对路径**（相对路径 `electron/main.ts` 会被 externalizeDepsPlugin 误判为依赖名 `electron`）。

## 测试

```bash
npm run smoke      # 迁移验证 + 三角色登录/越权拦截 + 全流程 + Agent + 多校区同步（73 项断言）
npm run smoke:ui   # 登录页渲染、三个角色登录后主界面渲染、无渲染进程错误
```

冒烟测试使用 `mkdtemp` 临时目录（含独立迁移测试），不触碰用户数据；经隐藏 BrowserWindow 加载真实 preload 后 `executeJavaScript` 调用 `window.api`，覆盖完整 IPC 链路。

## 打包分发

- `electron-builder.yml`：`publish: null`（CI 中不自动发布）、`asarUnpack` better-sqlite3、`npmRebuild: true`。
- macOS 输出 dmg（未签名，首次打开需右键 → 打开）；Windows 输出 nsis 安装包。
- Windows 安装包可在任意 Windows 电脑上双击 `build-windows.bat` 一键构建，或走 GitHub Actions 云端构建；详细分发流程见 [分发说明.md](./分发说明.md)。
- 升级注意事项：覆盖安装不触碰 `userData` 下的数据库文件；v1 → v2 首次启动自动迁移（旧库保留备份）。

## 安全说明

- 渲染进程无 Node 能力、上下文隔离开启；`index.html` 带 CSP。
- 三角色密码 SHA-256 存各自数据库；会话持久化为本地 `auth.json` 标记文件——这是**单机应用的访问控制**（配合三库物理隔离），不适用于多用户对抗场景。
- 大模型 API Key 以明文存于本地数据库（本地单机应用限制），请勿在共享机器上使用个人付费密钥。
- 忘记角色密码：备份后由技术人员删除对应库 `settings.password_hash` 一行并重启，密码恢复为初始值（教务/财务 `admin123`、助教 `assistant123`）。

## 常见问题

| 问题 | 处理 |
| --- | --- |
| Electron/better-sqlite3 下载或编译失败 | `.npmrc` 已配镜像；C++ 工具链缺失时按平台安装后 `npm run rebuild` |
| v1 升级后旧数据在哪 | 自动迁移进三个新库；旧库备份为 `userData/vlearn.db.migrated-*` |
| 忘记角色密码 | 见"安全说明"最后一条 |
| 助教"生成微信群短信"报错 | 未配置 API 或网络不通：助教设置 → 大模型 API 配置 |
| 报告显示"系统模板" | 未配置大模型 API 时的正常回退，配置后自动变为 AI 润色 |
| 多校区怎么共享数据 | 菜单"多校区同步"→ 导出同步包 → 微信发对方 → 对方导入（财务数据不参与同步） |
