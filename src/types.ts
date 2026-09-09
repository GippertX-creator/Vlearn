/**
 * 全项目共享的 TypeScript 类型定义（v2：三角色架构）。
 * 本文件不依赖 DOM / React / Electron，可被主进程（electron/）与渲染进程（src/）同时引用。
 */

// ---------------------------------------------------------------------------
// 角色与登录
// ---------------------------------------------------------------------------

/** 角色：教务 / 财务 / 助教（各自独立数据库） */
export type Role = 'academic' | 'finance' | 'assistant'

/** 登录状态查询结果（渲染进程启动时判断是否跳过角色选择页） */
export interface AuthStatus {
  loggedIn: boolean
  role: Role | null
  /** 旧库数据迁移失败时返回错误信息（登录页展示，不进入系统） */
  migrationError: string | null
}

export interface LoginResult {
  success: boolean
  error?: string
}

// ---------------------------------------------------------------------------
// 考勤与排课（沿用 v1）
// ---------------------------------------------------------------------------

/** 考勤状态：出勤 / 请假 / 缺勤 */
export type AttendanceStatus = 'present' | 'leave' | 'absent'

/** 课程实例状态：正常 / 已调课 / 已取消 */
export type InstanceStatus = 'normal' | 'adjusted' | 'cancelled'

/** 上课时间规则：weekday 1=周一 … 7=周日；start/end 为 HH:MM 字符串 */
export interface ScheduleRule {
  weekday: number
  start: string
  end: string
}

/** 课程基础信息 */
export interface Course {
  id: number
  subject: string
  grade: string
  className: string
  defaultTeacherId: number | null
  defaultTeacherName?: string | null
  scheduleRule: ScheduleRule[]
  /** 课程费用（仅财务角色可见/可编辑） */
  fee: number
  /** 单次课酬标准（仅财务角色可见/可编辑） */
  payPerSession: number
  createdAt: string
  updatedAt: string
}

/** 老师 */
export interface Teacher {
  id: number
  name: string
  note: string | null
  courseIds: number[]
  courseLabels: string[]
}

/** 老师详情（含授课统计） */
export interface TeacherDetail {
  teacher: Teacher
  totalInstances: number
  upcomingInstances: number
}

/** 学生 */
export interface Student {
  id: number
  name: string
  schoolClass: string | null
  note: string | null
  courseIds: number[]
  courseLabels: string[]
}

/** 学生考勤历史条目 */
export interface StudentAttendanceRecord {
  id: number
  status: AttendanceStatus
  note: string | null
  date: string
  startTime: string
  endTime: string
  courseId: number
  subject: string
  grade: string
  className: string
  teacherName: string | null
}

/** 学生详情（基本信息 + 考勤历史 + 统计） */
export interface StudentDetail {
  student: Student
  attendances: StudentAttendanceRecord[]
  stats: { present: number; leave: number; absent: number }
}

/** 课程实例（排课生成的单次课） */
export interface ScheduleInstance {
  id: number
  courseId: number
  date: string
  startTime: string
  endTime: string
  /** 实际授课老师（代课场景），null 表示使用课程默认老师 */
  actualTeacherId: number | null
  actualTeacherName?: string | null
  status: InstanceStatus
  note: string | null
  subject?: string
  grade?: string
  className?: string
  defaultTeacherName?: string | null
}

/** 课程实例详情弹窗数据 */
export interface InstanceDetail {
  instance: ScheduleInstance
  course: Course
  students: {
    id: number
    name: string
    schoolClass: string | null
    attendanceStatus: AttendanceStatus | null
  }[]
}

// ---------------------------------------------------------------------------
// 财务（沿用 v1）
// ---------------------------------------------------------------------------

export interface StudentPayment {
  id: number
  studentId: number
  courseId: number
  amountDue: number
  amountPaid: number
  paymentMethod: string
  paymentDate: string
  note: string | null
  studentName?: string
  courseLabel?: string
}

export interface TeacherPayment {
  id: number
  teacherId: number
  scheduleInstanceId: number
  amountDue: number
  amountPaid: number
  paymentDate: string
  note: string | null
  teacherName?: string
  instanceLabel?: string
}

export interface DashboardData {
  studentDue: number
  studentPaid: number
  teacherDue: number
  teacherPaid: number
  profit: number
}

export interface MonthReportRow {
  month: string
  income: number
  expense: number
  profit: number
}

// ---------------------------------------------------------------------------
// 助教模块
// ---------------------------------------------------------------------------

/** 课程内容记录 */
export interface LessonNote {
  id: number
  scheduleInstanceId: number
  knowledgePoints: string | null
  classPerformance: string | null
  homework: string | null
  summary: string | null
  /** 预留作业批改字段（未开发） */
  homeworkGrading: string
  createdAt: string
  updatedAt: string
  // 联表冗余（来自教务库课程实例，只读）
  date?: string
  startTime?: string
  endTime?: string
  subject?: string
  grade?: string
  className?: string
  teacherName?: string | null
}

/** 生成的微信群短信缓存 */
export interface GeneratedMessage {
  id: number
  lessonNoteId: number
  messageContent: string
  generatedAt: string
  instanceLabel?: string
}

// ---------------------------------------------------------------------------
// Agent（教务 / 财务智能助手）
// ---------------------------------------------------------------------------

export type AlertType = 'warning' | 'info' | 'suggestion'

/** 侧边栏通知条目 */
export interface AgentAlert {
  id: string
  type: AlertType
  title: string
  detail: string
  createdAt: string
}

/** 排课冲突项 */
export interface ConflictItem {
  type: 'teacher' | 'student'
  /** 冲突对象（老师/学生姓名） */
  who: string
  /** 冲突的课程标签 */
  courseLabel: string
  date: string
  startTime: string
  endTime: string
  reason: string
}

/** 调课替补时间段建议 */
export interface SlotSuggestion {
  date: string
  startTime: string
  endTime: string
}

/** 对账差异项 */
export interface ReconcileItem {
  kind: 'student' | 'teacher'
  name: string
  courseLabel: string
  due: number
  paid: number
  /** 差额（paid - due，负数表示欠款） */
  diff: number
  date: string
  note: string | null
}

/** 对账检查结果 */
export interface ReconcileResult {
  items: ReconcileItem[]
  studentCount: number
  teacherCount: number
  /** 差额合计（实付/实缴 - 应付/应缴） */
  totalDiff: number
  summary: string
}

/** 异常交易检测结果 */
export interface AnomalyCheckResult {
  anomalies: { level: 'warning'; message: string }[]
}

/** 大模型/模板生成的文本内容（usedAi 标记是否真实调用大模型） */
export interface GeneratedContent {
  content: string
  usedAi: boolean
}

// ---------------------------------------------------------------------------
// 各角色设置
// ---------------------------------------------------------------------------

export interface AcademicSettings {
  role: 'academic'
  grades: string[]
  scheduleWeeks: number
  /** 排课冲突检测开关 */
  agentConflictDetect: boolean
  /** 考勤异常提醒开关 */
  agentAttendanceAlert: boolean
  /** 连续缺勤/请假提醒阈值（次） */
  agentAttendanceThreshold: number
  /** 信息补全提示开关 */
  agentCompletenessHint: boolean
  apiUrl: string
  apiKey: string
}

export interface FinanceSettings {
  role: 'finance'
  paymentMethods: string[]
  chargeAbsent: boolean
  /** 缴费逾期预警开关 */
  agentOverdueAlert: boolean
  /** 逾期预警提前天数 */
  agentOverdueDays: number
  /** 异常交易检测开关 */
  agentAnomalyDetect: boolean
  /** 异常金额倍数阈值 */
  agentAnomalyMultiplier: number
  apiUrl: string
  apiKey: string
}

export interface AssistantSettings {
  role: 'assistant'
  apiUrl: string
  apiKey: string
}

export type RoleSettings = AcademicSettings | FinanceSettings | AssistantSettings

// ---------------------------------------------------------------------------
// 多校区同步
// ---------------------------------------------------------------------------

export interface SyncHistoryEntry {
  type: 'export' | 'import'
  ts: string
  campusName: string
  counts?: string
  path?: string
}

export interface SyncStats {
  added: number
  updated: number
  deleted: number
  remapped: number
  fromCampus: string
}

export interface SyncInfo {
  campusId: string
  campusName: string
  history: SyncHistoryEntry[]
}

// ---------------------------------------------------------------------------
// 导出与备份
// ---------------------------------------------------------------------------

export interface ExcelExportPayload {
  module: string
  columns: { header: string; key: string }[]
  rows: Record<string, unknown>[]
}

export interface BackupResult {
  success: boolean
  canceled?: boolean
  path?: string
  error?: string
}

// ---------------------------------------------------------------------------
// window.api 完整接口（preload 暴露，渲染进程唯一数据通道）
// ---------------------------------------------------------------------------

export interface VlearnApi {
  // ---------- 登录与会话 ----------
  getAuthStatus(): Promise<AuthStatus>
  login(role: Role, password: string): Promise<LoginResult>
  logout(): Promise<void>
  /** 修改当前角色密码（验证旧密码） */
  changePassword(oldPassword: string, newPassword: string): Promise<{ success: boolean; error?: string }>

  // ---------- 教务只读（教务/财务/助教均可） ----------
  getCourses(): Promise<Course[]>
  getTeachers(): Promise<Teacher[]>
  getTeacherDetail(id: number): Promise<TeacherDetail>
  getStudents(): Promise<Student[]>
  getStudentDetail(id: number): Promise<StudentDetail>
  getInstances(start: string, end: string): Promise<ScheduleInstance[]>
  getInstanceDetail(id: number): Promise<InstanceDetail>

  // ---------- 教务读写（仅教务） ----------
  createCourse(data: {
    subject: string
    grade: string
    className: string
    defaultTeacherId: number | null
    scheduleRule: ScheduleRule[]
  }): Promise<Course>
  updateCourse(
    id: number,
    data: {
      subject: string
      grade: string
      className: string
      defaultTeacherId: number | null
      scheduleRule: ScheduleRule[]
    }
  ): Promise<Course>
  deleteCourse(id: number): Promise<void>
  regenerateInstances(courseId: number): Promise<number>
  createTeacher(data: { name: string; note: string | null; courseIds: number[] }): Promise<Teacher>
  updateTeacher(id: number, data: { name: string; note: string | null; courseIds: number[] }): Promise<Teacher>
  deleteTeacher(id: number): Promise<void>
  createStudent(data: {
    name: string
    schoolClass: string | null
    note: string | null
    courseIds: number[]
  }): Promise<Student>
  updateStudent(
    id: number,
    data: { name: string; schoolClass: string | null; note: string | null; courseIds: number[] }
  ): Promise<Student>
  deleteStudent(id: number): Promise<void>
  updateInstance(
    id: number,
    data: {
      date: string
      startTime: string
      endTime: string
      actualTeacherId: number | null
      note: string | null
    }
  ): Promise<ScheduleInstance>
  cancelInstance(id: number): Promise<void>
  restoreInstance(id: number): Promise<void>
  saveAttendance(data: {
    scheduleInstanceId: number
    studentId: number
    status: AttendanceStatus
    note?: string | null
  }): Promise<void>
  removeAttendance(data: { scheduleInstanceId: number; studentId: number }): Promise<void>
  markAllPresent(scheduleInstanceId: number): Promise<number>

  // ---------- 财务（仅财务角色） ----------
  getDashboard(month: string): Promise<DashboardData>
  getFinanceCourses(): Promise<Course[]>
  updateCourseFees(id: number, data: { fee: number; payPerSession: number }): Promise<Course>
  getStudentPayments(): Promise<StudentPayment[]>
  createStudentPayment(data: {
    studentId: number
    courseId: number
    amountDue: number
    amountPaid: number
    paymentMethod: string
    paymentDate: string
    note: string | null
  }): Promise<void>
  updateStudentPayment(
    id: number,
    data: {
      studentId: number
      courseId: number
      amountDue: number
      amountPaid: number
      paymentMethod: string
      paymentDate: string
      note: string | null
    }
  ): Promise<void>
  deleteStudentPayment(id: number): Promise<void>
  autoCalcStudentPayments(): Promise<number>
  getTeacherPayments(): Promise<TeacherPayment[]>
  createTeacherPayment(data: {
    teacherId: number
    scheduleInstanceId: number
    amountDue: number
    amountPaid: number
    paymentDate: string
    note: string | null
  }): Promise<void>
  updateTeacherPayment(
    id: number,
    data: {
      teacherId: number
      scheduleInstanceId: number
      amountDue: number
      amountPaid: number
      paymentDate: string
      note: string | null
    }
  ): Promise<void>
  deleteTeacherPayment(id: number): Promise<void>
  autoCalcTeacherPayments(): Promise<number>
  getMonthlyReport(year: number): Promise<MonthReportRow[]>
  getPaymentInstances(): Promise<ScheduleInstance[]>

  // ---------- 助教（仅助教角色） ----------
  getLessonNote(scheduleInstanceId: number): Promise<LessonNote | null>
  saveLessonNote(data: {
    scheduleInstanceId: number
    knowledgePoints: string | null
    classPerformance: string | null
    homework: string | null
    summary: string | null
  }): Promise<LessonNote>
  listLessonNotes(): Promise<LessonNote[]>
  /** 生成微信群短信（调用外部大模型，失败抛错；成功后自动存入历史） */
  generateSms(lessonNoteId: number): Promise<{ content: string }>
  listMessages(): Promise<GeneratedMessage[]>
  deleteMessage(id: number): Promise<void>

  // ---------- Agent（按当前角色提供对应能力） ----------
  /** 侧边栏主动提醒（教务：考勤异常/信息补全；财务：缴费逾期） */
  getAlerts(): Promise<AgentAlert[]>
  /** 排课冲突检测（新增/编辑课程时，教务） */
  checkCourseConflict(data: {
    courseId: number | null
    defaultTeacherId: number | null
    scheduleRule: ScheduleRule[]
  }): Promise<ConflictItem[]>
  /** 单次调课冲突检测（教务） */
  checkInstanceConflict(data: {
    instanceId: number
    date: string
    startTime: string
    endTime: string
    actualTeacherId: number | null
  }): Promise<ConflictItem[]>
  /** 调课替补时间段建议（教务，返回 3 个） */
  suggestSlots(instanceId: number): Promise<SlotSuggestion[]>
  /** 新增学生/老师时相似姓名检测（教务） */
  checkDuplicateName(kind: 'student' | 'teacher', name: string): Promise<{ matches: string[] }>
  /** 生成周报/月报（教务，已配大模型时由 AI 润色） */
  generateReport(kind: 'week' | 'month'): Promise<GeneratedContent>
  /** 对账检查（财务，按钮触发，本地规则） */
  reconcile(): Promise<ReconcileResult>
  /** 缴费/支付记录异常检测（财务，新增/修改时触发） */
  checkPaymentAnomaly(data: {
    kind: 'student' | 'teacher'
    id?: number
    amountPaid: number
    amountDue: number
  }): Promise<AnomalyCheckResult>
  /** 盈亏趋势分析（财务） */
  trendAnalysis(): Promise<GeneratedContent>
  /** 智能报表/凭证生成（财务，基于当前筛选结果） */
  smartReport(module: string, columns: { header: string; key: string }[], rows: Record<string, unknown>[]): Promise<GeneratedContent>

  // ---------- 多校区同步（教务/助教角色） ----------
  getSyncInfo(): Promise<SyncInfo>
  saveCampusName(name: string): Promise<void>
  /** 导出同步包（保存对话框），返回包内记录数 */
  syncExport(): Promise<{ success: boolean; canceled?: boolean; path?: string; counts?: number; error?: string }>
  /** 导入并合并同步包（打开对话框） */
  syncImport(): Promise<{ success: boolean; canceled?: boolean; stats?: SyncStats; error?: string }>

  // ---------- 设置 / 备份 / 导出 ----------
  getSettings(): Promise<RoleSettings>
  saveSettings(data: RoleSettings): Promise<void>
  getAppVersion(): Promise<string>
  backupData(): Promise<BackupResult>
  restoreData(): Promise<BackupResult>
  exportExcel(payload: ExcelExportPayload): Promise<{ success: boolean; canceled?: boolean; path?: string }>
}
