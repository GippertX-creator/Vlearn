# Vlearn 系统第三次更新提示词（增量开发，基于第二版已实现功能）

> 当前系统已实现：三角色物理隔离（教务/财务/助教独立数据库）、助教模块（课程记录+大模型短信生成）、教务/财务 Agent（冲突检测、对账提醒等）、基础财务功能（课程费用、学生缴费、老师课酬、盈亏报表）。  
> **本次更新目标**：  
> 1. 支持**学生-课程维度的个性化费用**（不同学生同一课程可有不同单价、折扣、赠送课时）。  
> 2. 升级**应缴金额自动计算规则**，支持赠送课时和个性化单价。  
> 3. 支持**老师课酬差异化**（不同老师可设不同默认课酬，课程实例可覆盖）。  
> 4. 新增**退费、转课、暂停/冻结**等学生课程状态管理。  
> 5. 增加**费用调整的操作日志与二次确认**，保障财务安全。  
> 6. 优化**报表展示**，体现折扣、赠送、实际单价等信息。  
> 所有新功能均集成到现有角色权限体系中，保持数据隔离不变。

---

## 1. 学生个性化课程费用管理

### 1.1 数据模型新增
在财务数据库（`vlearn_finance.db`）中新增表 `student_course_fees`：

```sql
CREATE TABLE student_course_fees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL,
  course_id INTEGER NOT NULL,
  unit_price REAL NOT NULL DEFAULT 0,          -- 该学生此课程的单价（元/次）
  discount_type TEXT NOT NULL DEFAULT 'none',  -- 折扣类型：none(无折扣), old_student(老生优惠), group_buy(团报优惠), gift(赠送), other(其他)
  free_lessons INTEGER NOT NULL DEFAULT 0,     -- 赠送课时数（免费次数）
  note TEXT,                                   -- 备注说明
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(student_id, course_id),
  FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
  FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE
);
```

**说明**：
- `unit_price` 为该学生上该课程时，每次课的实际收费单价。若未设置，则默认使用课程表 `courses.fee` 作为单价。
- `discount_type` 用于标记费用调整的类型，便于报表分类。
- `free_lessons` 表示赠送的免费课时，在计算应缴金额时先扣除。
- 该表仅财务可见、可编辑；教务和助教完全不可见（不渲染、不提供 IPC）。

### 1.2 界面与交互
在**财务角色**的“学生缴费”页面中，新增一个功能入口：“个性化费用设置”。
- 列表展示所有学生及所报课程，每行显示当前个性化单价、折扣类型、赠送课时、备注。
- 财务可点击编辑，修改以上字段。
- 编辑时需**二次确认弹窗**：“确认修改张三在数学A1班的费用吗？原单价 X 元/次，新单价 Y 元/次”。
- 所有修改操作记录操作日志（见第5节）。

### 1.3 权限控制
- 教务、助教的前端界面不显示任何与 `student_course_fees` 相关的字段或按钮。
- 主进程 IPC 仅允许财务角色调用 `studentCourseFees:*` 系列接口。

---

## 2. 升级应缴金额自动计算规则

### 2.1 计算规则
对于某学生某课程的应缴金额：
```
应缴金额 = max(0, (出勤次数 - 赠送课时数)) × 个性化单价
```
- 出勤次数：统计该学生在该课程下所有课程实例中考勤状态为“出勤”的次数。
- 请假不收费（不产生费用），缺勤收费（计入出勤次数，即需要付费），该规则可在系统设置中配置（缺勤是否收费，默认收费）。
- 若学生未设置个性化单价，则使用课程表 `courses.fee`。
- 若赠送课时数大于等于出勤次数，则应缴为0。

### 2.2 财务操作
在“学生缴费”页面提供“自动计算应缴”按钮。
- 点击后，系统遍历所有学生-课程对，根据最新考勤数据和个性化费用，批量生成或更新**未锁定**的学生缴费记录（`student_payments` 表中的 `amount_due`）。
- 已锁定（已确认或已部分缴费）的记录默认不自动更新，需财务手动修改。
- 生成结果以列表展示，财务可查看每条计算明细，支持手动微调后保存。

### 2.3 历史缴费记录锁定策略
在 `student_payments` 表中新增字段：
```sql
ALTER TABLE student_payments ADD COLUMN is_locked INTEGER DEFAULT 0;
```
- `is_locked = 1` 表示该缴费记录已确认或已发生实际缴费，禁止自动重算，只能手动编辑。
- 系统在以下情况下自动锁定记录：
  - 该记录的 `amount_paid > 0`（已有实缴金额）。
  - 财务手动点击“锁定”按钮。
- 财务可以手动解锁，解锁后允许自动重算。

---

## 3. 老师课酬差异化支持

### 3.1 数据模型调整
在教务数据库（`vlearn_academic.db`）的 `teachers` 表中新增字段：
```sql
ALTER TABLE teachers ADD COLUMN default_rate_per_lesson REAL DEFAULT 0;
```
- 表示该老师默认每上一次课（一个课程实例）的课酬标准，单位元。
- 若为0，则回退使用课程费用或课程实例的覆盖值。

在教务数据库的 `schedule_instances` 表中新增字段：
```sql
ALTER TABLE schedule_instances ADD COLUMN actual_rate REAL;
```
- 表示该课程实例的实际课酬标准，可覆盖老师默认值。若为 NULL，则取老师默认课酬，再取课程费用。
- 主要用于代课场景：代课老师可能有不同的课酬。

### 3.2 财务生成应付时自动取值
在财务角色生成老师课酬（`teacher_payments`）时，应付金额自动按以下优先级确定：
1. 课程实例 `actual_rate`（若设置）
2. 老师的 `default_rate_per_lesson`（若大于0）
3. 课程费用 `courses.fee`

财务仍可手动修改应付金额，修改后不影响其他数据。

### 3.3 界面调整
- 在教务的“老师管理”页面（教务可编辑老师基本信息）中，**课酬字段不可见**（该字段仅财务可见），但教务可以正常编辑姓名、所教课程等。
- 在财务的“老师课酬”页面，增加一列显示课酬标准来源，并可点击查看详情。
- 财务可在“老师课酬”页面为每个老师设置默认课酬（需要二次确认，并记录日志）。

---

## 4. 学生课程状态管理（退费、转课、暂停）

### 4.1 状态定义
在 `student_courses` 关联表中新增字段：
```sql
ALTER TABLE student_courses ADD COLUMN status TEXT DEFAULT 'active';
```
- 状态值：`active`（在读）、`paused`（暂停）、`refunded`（退费）、`completed`（结课）、`transferred`（已转课）。
- 该字段在教务和财务可见（助教只读），财务可修改状态。

### 4.2 退费操作
- 在财务的“学生缴费”或“学生管理”页面中，可对某个学生-课程执行“退费”操作。
- 执行退费时，系统自动计算剩余应退金额：
  - 剩余退费 = 已缴总额 - 已消耗课程费用
  - 已消耗课程费用 = (已出勤次数 - 赠送课时数) × 个性化单价（若结果小于0则取0）
- 财务确认后，系统生成一条退费记录（可记录在 `student_payments` 表中，金额为负数，或单独退费表），并将学生该课程状态改为 `refunded`。
- 退费操作需二次确认，并记录日志。

### 4.3 转课操作
- 财务可将学生从原课程转到新课程：
  - 原课程状态改为 `transferred`，并结清费用（按退费逻辑处理剩余费用，可退可补）。
  - 新课程自动建立关联，状态为 `active`，费用重新按新课程规则计算。
- 转课操作需二次确认，并记录日志。

### 4.4 暂停/冻结
- 财务可将学生某课程状态改为 `paused`，暂停期间该学生不参与考勤统计，不计费。
- 恢复时状态改回 `active`。
- 教务在打考勤时，对状态为 `paused` 的学生显示为“暂停中”，不可操作考勤。

---

## 5. 费用调整的权限与操作日志

### 5.1 二次确认
- 所有涉及费用修改的操作（包括个性化费用设置、老师课酬修改、退费、转课、手动修改应缴/实缴金额）均需**二次确认弹窗**，显示修改前后的对比。
- 确认后才可提交。

### 5.2 操作日志表
在财务数据库中新增表 `finance_audit_logs`：
```sql
CREATE TABLE finance_audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operator TEXT NOT NULL,          -- 操作者（财务登录标识，可存储固定值如 'finance'）
  action TEXT NOT NULL,            -- 操作类型：update_student_fee, update_teacher_rate, refund, transfer, update_payment, etc.
  target_type TEXT NOT NULL,       -- 目标类型：student_course, teacher, schedule_instance, payment, etc.
  target_id INTEGER NOT NULL,      -- 目标记录ID
  old_value TEXT,                  -- 修改前的值（JSON）
  new_value TEXT,                  -- 修改后的值（JSON）
  created_at TEXT DEFAULT (datetime('now'))
);
```
- 每次费用修改操作成功后，自动写入日志。
- 财务可在“系统设置”中查看操作日志，支持按时间、操作类型筛选。

---

## 6. 报表优化

### 6.1 学生缴费明细报表
- 在学生缴费列表中增加列：原价（课程标准费用）、折扣类型、实际单价、赠送课时、出勤次数、应缴、实缴、欠费。
- 导出 Excel 时包含这些列。

### 6.2 盈亏报表
- 收入部分可细分：正常收入、折扣优惠金额（原价与实际单价差额×次数）、赠送课时抵扣金额。
- 支出部分显示老师课酬及课酬标准来源。
- 导出 Excel 时体现这些细分。

### 6.3 老师课酬报表
- 增加列：课程名称、课程实例日期、实际授课老师、课酬标准来源（老师默认/实例覆盖/课程费用）、应付、实付。

---

## 7. 技术实现要点

### 7.1 数据库迁移
- 在财务数据库中执行新增表和字段的迁移脚本。
- 在教务数据库中为 `teachers` 和 `schedule_instances` 表添加新字段。
- 为 `student_courses` 表添加 `status` 字段，默认 `active`。
- 为 `student_payments` 表添加 `is_locked` 字段，默认 0。
- 迁移过程需在应用启动时自动检测并执行，失败回滚。

### 7.2 IPC 接口新增
- `studentCourseFees:getAll`、`studentCourseFees:update`、`studentCourseFees:delete`
- `studentCourseStatus:update`（退费、转课、暂停等）
- `financeAuditLogs:getAll`
- `teacherRate:update`（老师默认课酬）
- `scheduleInstanceRate:update`（实例覆盖课酬）
- 所有接口在主进程校验角色为财务，否则拒绝。

### 7.3 前端调整
- 在财务角色的“学生缴费”页面增加个性化费用设置入口、状态操作按钮、锁定/解锁按钮。
- 在财务角色的“老师课酬”页面增加课酬标准编辑和显示。
- 增加操作日志页面（可放在财务设置下）。
- 报表组件更新以展示新列。

### 7.4 与 Agent 的集成
- 财务 Agent 的“自动对账提醒”需识别因个性化费用导致的差异（如实际单价变化），并给出提醒。
- 盈亏趋势分析 Agent 可考虑折扣、赠送等因素。
- 教务 Agent 不受影响。

---

## 8. 验收标准

1. 财务可为每个学生每门课程设置独立单价、折扣类型、赠送课时，修改需二次确认并记录日志。
2. 自动计算应缴时，正确使用个性化单价和赠送课时，请假不收费，缺勤收费（可配置），且不修改锁定记录。
3. 历史缴费记录默认锁定，实缴大于0的记录不可自动更新，财务可手动解锁。
4. 老师课酬支持默认值、实例覆盖值，生成应付时正确取值。
5. 退费、转课、暂停功能正常，自动计算退费金额，操作需二次确认并记录日志。
6. 所有费用修改操作均有审计日志，财务可查看。
7. 报表正确展示折扣、赠送、实际单价、课酬来源等信息。
8. 教务和助教完全不可见任何新增财务字段和操作，权限隔离不破坏。
9. 数据迁移成功，旧数据兼容，新字段有默认值，不报错。
10. 系统在 Windows 和 macOS 上运行正常。

---

请根据以上需求，在现有代码基础上进行第三次迭代开发。保持技术栈不变，代码结构清晰，注释完整。