# Vlearn 系统代码生成提示词（可直接用于 AI 编程）

你是一名全栈工程师，请根据以下需求，使用 **Electron + React + TypeScript + SQLite** 技术栈，生成一个完整的、可运行的跨平台桌面应用程序（支持 Windows 和 macOS）。代码需结构清晰、模块化，并包含详细的注释。

## 1. 项目概述
Vlearn 是一款面向教培机构教务与财务的本地桌面管理系统。数据存储于本地 SQLite 数据库，无需联网。系统包含教务管理、考勤管理、财务管理和报表导出四大模块。教务与财务数据严格隔离，财务模块需二次密码验证。

## 2. 技术栈要求
- **桌面框架**：Electron（主进程 + 渲染进程）
- **前端**：React 18 + TypeScript + Vite
- **UI 库**：Ant Design 5（简约风格，中文界面）
- **数据库**：SQLite（使用 `better-sqlite3`，在主进程中操作）
- **进程通信**：Electron IPC（渲染进程通过 `window.api` 调用主进程暴露的方法）
- **Excel 导出**：`exceljs`（在主进程实现导出，通过 IPC 触发保存对话框）
- **密码处理**：财务模块密码使用 SHA-256 哈希存储在本地 JSON 配置文件中
- **包管理**：npm 或 pnpm

## 3. 功能需求详细说明

### 3.1 角色与权限
- 系统启动后默认进入教务端，无需登录。
- 财务模块入口需输入独立密码（初始密码为 `admin123`，可在设置中修改），验证成功后方可访问财务相关页面和字段。
- **教务角色**：可查看/编辑课程基础信息、学生基本信息、老师基本信息、考勤管理。
- **财务角色**：额外可查看/编辑课程费用、学生缴费、老师课酬支付、盈亏报表。
- 所有费用相关字段在教务端**完全不渲染**，而非置灰。

### 3.2 教务助手

#### 3.2.1 课程管理
- **课程字段**：
  - 科目（文本，如“数学”）
  - 年级（下拉选项：高一、高二、高三，可在设置中自定义）
  - 班级号（文本，如“A1班”）
  - 默认授课老师（从老师列表下拉选择）
  - 默认上课时间规则（如“每周二 15:00-17:00”，支持多个时间段，用逗号分隔）
  - 课程费用（**仅财务可见/可编辑**，教务端不显示）
- **排课方式**：
  - 固定排课：根据默认时间规则，系统自动在日历中生成未来 8 周的课程实例。
  - 单次调课：可修改某一次课程实例的日期、开始时间、结束时间、实际授课老师（用于代课场景），不影响其他周次。
- **日历视图**：提供月视图、周视图、日视图切换。每个课程实例显示科目、班级号、老师姓名（若代课则显示代课老师）。点击实例弹出详情，显示该次课的学生名单和考勤状态（教务可操作考勤）。
- **数据存储**：课程基础信息与生成的课程实例分开存储，实例包含 `base_course_id`、`date`、`start_time`、`end_time`、`actual_teacher_id`（可空，默认取课程默认老师）、状态（正常/调课/取消）。

#### 3.2.2 学生管理
- **学生字段**：姓名、学校班级（文本）、所报课程（多选，从课程列表中选择）、备注。
- 学生详情页展示其所有考勤记录汇总（按课程、按时间）。
- 缴费情况**仅财务可见**，在教务端不显示任何相关字段。

#### 3.2.3 老师管理
- **老师字段**：姓名、所教课程（多选）、备注。
- 课酬信息**仅财务可见**（包含每次课应付金额、累计应付、累计实付等）。

#### 3.2.4 考勤管理
- 在课程实例详情页中，生成该课程所有报名学生的名单列表。
- 每个学生可勾选考勤状态：**出勤**、**请假**、**缺勤**（三选一，默认未标记）。
- 考勤记录同步更新到：
  - 该课程实例的考勤汇总视图
  - 学生个人考勤历史（在学生详情页查看）
- 支持批量操作：一键全部标记为出勤。

### 3.3 财务助手

#### 3.3.1 财务模块入口
- 教务端顶部导航有“财务”入口，点击弹出密码输入框。
- 密码验证通过后，进入财务仪表盘页面；验证失败提示错误。
- 财务密码可在财务设置中修改。

#### 3.3.2 财务仪表盘
- 显示核心汇总卡片：
  - 本月学生应缴总额
  - 本月学生实缴总额
  - 本月老师应付总额
  - 本月老师实付总额
  - 本月盈亏（实缴 - 实付）
- 提供按月份筛选功能。

#### 3.3.3 课程费用设置
- 在课程列表中显示并允许编辑“课程费用”字段（金额，单位元）。
- 课程费用将用于计算学生应缴费用。

#### 3.3.4 学生缴费管理
- 学生缴费记录列表，支持新增、编辑、删除。
- 字段：学生（下拉）、关联课程（下拉，限定该学生所报课程）、应缴金额（自动根据规则计算，可手动修改）、实缴金额、缴费方式（下拉：微信、转账、现金，支持自定义选项）、缴费日期、备注。
- 支持按学生或课程筛选。
- 缴费方式选项可在系统设置中自定义。

#### 3.3.5 老师课酬管理
- 老师课酬记录列表，支持新增、编辑、删除。
- 字段：老师（下拉）、关联课程实例（下拉，显示日期+课程名+班级号）、应付金额（自动根据规则计算，可手动修改）、实付金额、支付日期、备注。
- 支持按老师或课程筛选。

#### 3.3.6 盈亏报表
- 自动生成月度盈亏报表：收入（学生实缴）、支出（老师实付）、净盈亏。
- 支持导出 Excel。

### 3.4 系统设置
- 自定义年级选项、缴费方式选项。
- 修改财务密码（需验证旧密码）。
- 数据备份与恢复（导出/导入 SQLite 数据库文件）。

### 3.5 Excel 导出
- 所有列表页面（学生、老师、课程、缴费记录、课酬记录、考勤记录、盈亏报表）均提供“导出 Excel”按钮。
- 导出文件命名规则：`Vlearn_模块名_日期.xlsx`。
- 导出内容与当前列表筛选结果一致。

## 4. 数据模型（SQLite 表结构）

```sql
-- 课程基础信息
CREATE TABLE courses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject TEXT NOT NULL,
  grade TEXT NOT NULL,
  class_name TEXT NOT NULL,
  default_teacher_id INTEGER,
  default_schedule_rule TEXT,  -- JSON 数组，如 [{"weekday":2,"start":"15:00","end":"17:00"}]
  fee REAL DEFAULT 0,          -- 课程费用，仅财务可见
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (default_teacher_id) REFERENCES teachers(id)
);

-- 老师
CREATE TABLE teachers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  note TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- 老师-课程关联（多对多）
CREATE TABLE teacher_courses (
  teacher_id INTEGER NOT NULL,
  course_id INTEGER NOT NULL,
  PRIMARY KEY (teacher_id, course_id),
  FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE CASCADE,
  FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE
);

-- 学生
CREATE TABLE students (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  school_class TEXT,
  note TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- 学生-课程关联（多对多）
CREATE TABLE student_courses (
  student_id INTEGER NOT NULL,
  course_id INTEGER NOT NULL,
  PRIMARY KEY (student_id, course_id),
  FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
  FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE
);

-- 课程实例（排课）
CREATE TABLE schedule_instances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL,
  date TEXT NOT NULL,               -- YYYY-MM-DD
  start_time TEXT NOT NULL,         -- HH:MM
  end_time TEXT NOT NULL,           -- HH:MM
  actual_teacher_id INTEGER,        -- 可空，代课老师
  status TEXT DEFAULT 'normal',     -- normal / adjusted / cancelled
  note TEXT,
  FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE,
  FOREIGN KEY (actual_teacher_id) REFERENCES teachers(id)
);

-- 考勤记录
CREATE TABLE attendances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  schedule_instance_id INTEGER NOT NULL,
  student_id INTEGER NOT NULL,
  status TEXT NOT NULL,             -- present / leave / absent
  note TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(schedule_instance_id, student_id),
  FOREIGN KEY (schedule_instance_id) REFERENCES schedule_instances(id) ON DELETE CASCADE,
  FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
);

-- 学生缴费记录
CREATE TABLE student_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL,
  course_id INTEGER NOT NULL,
  amount_due REAL NOT NULL,         -- 应缴
  amount_paid REAL NOT NULL,        -- 实缴
  payment_method TEXT NOT NULL,     -- 微信/转账/现金/自定义
  payment_date TEXT NOT NULL,       -- YYYY-MM-DD
  note TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
  FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE
);

-- 老师课酬支付记录
CREATE TABLE teacher_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  teacher_id INTEGER NOT NULL,
  schedule_instance_id INTEGER NOT NULL,
  amount_due REAL NOT NULL,         -- 应付
  amount_paid REAL NOT NULL,        -- 实付
  payment_date TEXT NOT NULL,
  note TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE CASCADE,
  FOREIGN KEY (schedule_instance_id) REFERENCES schedule_instances(id) ON DELETE CASCADE
);

-- 系统设置（键值对）
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
```

## 5. 业务规则

### 5.1 自动生成课程实例
- 当课程创建或修改默认时间规则时，自动生成未来 8 周（可配置）的课程实例。
- 生成规则：根据规则中的星期几和起止时间，在对应日期创建实例，`actual_teacher_id` 默认为 `NULL`（表示使用默认老师）。
- 已生成的实例不会因规则修改而自动更新，除非手动触发“重新生成”。

### 5.2 学生应缴费用计算
- 每名学生针对所报每门课程，应缴费用 = 该课程费用 × 该学生在该课程下的**出勤**次数。
- 请假、缺勤是否收费：**请假不收费，缺勤收费**（与出勤相同）。此规则可配置，默认缺勤收费。
- 系统在财务模块中提供“自动计算应缴”按钮，可根据考勤数据批量生成/更新学生缴费记录中的应缴金额。

### 5.3 老师应付课酬计算
- 每位老师针对每个课程实例，应付金额 = 该课程的单次课酬标准（可设置，默认0）。
- 若课程实例设置了代课老师，则课酬支付给代课老师。
- 系统在财务模块中提供“自动计算应付”按钮，可根据课程实例生成老师课酬记录。

### 5.4 盈亏计算
- 总收入 = 所有学生缴费记录中实缴金额之和。
- 总支出 = 所有老师课酬支付记录中实付金额之和。
- 净盈亏 = 总收入 - 总支出（可按月、按年统计）。

## 6. 界面与交互要求

### 6.1 主界面布局
- 顶部导航栏：Logo、菜单项（教务、财务、设置）。
- 教务菜单下包含子页面：课程日历、学生管理、老师管理。
- 财务菜单需要密码验证后进入，包含子页面：仪表盘、课程费用、学生缴费、老师课酬、盈亏报表。
- 整体风格简约，使用 Ant Design 默认主题，中文文案。

### 6.2 页面功能清单

| 页面 | 主要功能 |
|------|----------|
| 课程日历 | 月/周/日视图，点击课程实例查看详情和考勤，支持调课、取消 |
| 学生管理 | 学生列表、新增/编辑/删除、查看详情（含考勤历史） |
| 老师管理 | 老师列表、新增/编辑/删除、查看详情 |
| 财务仪表盘 | 月度汇总卡片 |
| 课程费用 | 课程列表，显示并编辑费用 |
| 学生缴费 | 缴费记录表格，支持筛选、增删改、自动计算应缴、导出 |
| 老师课酬 | 课酬记录表格，支持筛选、增删改、自动计算应付、导出 |
| 盈亏报表 | 按月展示收支和盈亏，支持导出 |
| 系统设置 | 自定义选项、修改密码、数据备份恢复 |

### 6.3 考勤操作
- 在课程实例详情弹窗中，列出该课程所有学生，每个学生旁有三个按钮或下拉选择：出勤/请假/缺勤。
- 支持一键“全部出勤”。
- 修改后立即保存。

## 7. 代码结构与模块划分

```
vlearn/
├── package.json
├── electron/
│   ├── main.ts              # Electron 主进程入口
│   ├── preload.ts           # 预加载脚本，暴露 window.api
│   ├── db.ts                # SQLite 初始化与连接
│   ├── ipcHandlers.ts       # 所有 IPC 处理函数
│   └── excelExport.ts       # Excel 导出逻辑
├── src/                     # React 渲染进程
│   ├── main.tsx
│   ├── App.tsx
│   ├── api.ts               # 封装 window.api 调用
│   ├── pages/
│   │   ├── CalendarPage.tsx
│   │   ├── StudentsPage.tsx
│   │   ├── TeachersPage.tsx
│   │   ├── FinanceDashboard.tsx
│   │   ├── CourseFeesPage.tsx
│   │   ├── StudentPaymentsPage.tsx
│   │   ├── TeacherPaymentsPage.tsx
│   │   ├── ReportsPage.tsx
│   │   └── SettingsPage.tsx
│   ├── components/          # 通用组件
│   └── types.ts             # TypeScript 类型定义
├── assets/
└── README.md
```

## 8. 关键实现要点

1. **IPC 通信**：所有数据库操作在主进程完成，渲染进程通过 `ipcRenderer.invoke` 调用。`preload.ts` 中使用 `contextBridge` 暴露方法，例如：
   ```typescript
   window.api = {
     getCourses: () => ipcRenderer.invoke('courses:getAll'),
     saveAttendance: (data) => ipcRenderer.invoke('attendance:save', data),
     // ...其他方法
   }
   ```
2. **权限控制**：前端根据当前角色（教务/财务）条件渲染费用相关字段；后端 IPC 处理函数中也要校验调用者是否具有财务权限（通过一个全局变量或 session 标记）。
3. **密码验证**：财务模块密码哈希存储在 `settings` 表中（key=`finance_password_hash`）。验证时比对哈希。
4. **自动生成排课**：使用 `date-fns` 库处理日期，解析默认规则 JSON，生成未来 8 周实例。
5. **Excel 导出**：在主进程使用 `exceljs` 创建工作簿，通过 `dialog.showSaveDialog` 让用户选择保存路径，然后写入文件。
6. **数据备份**：复制 SQLite 数据库文件到用户指定位置；恢复时替换当前数据库文件并重启应用。

## 9. 开发与运行要求

- 提供完整的 `package.json` 及依赖列表（`electron`, `react`, `antd`, `better-sqlite3`, `exceljs`, `date-fns`, `vite`, `typescript` 等）。
- 代码需包含所有必要的 TypeScript 类型定义。
- 确保在 Windows 和 macOS 上均可运行，避免平台特定 API 的使用。
- 初始数据：预置年级选项（高一、高二、高三）、缴费方式（微信、转账、现金）、财务密码 `admin123`。
- 提供 README 说明如何安装依赖、启动开发模式、打包应用。

请开始生成完整代码，确保功能齐全、可直接运行。