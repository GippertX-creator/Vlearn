/**
 * 全项目共享的 TypeScript 类型定义。
 * 本文件不依赖 DOM / React / Electron，可被主进程（electron/）与渲染进程（src/）同时引用。
 */

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
  /** 默认上课时间规则（JSON 数组字符串序列化而来，主进程返回时已解析） */
  scheduleRule: ScheduleRule[]
  /** 课程费用（仅财务可见/可编辑） */
  fee: number
  /** 单次课酬标准（仅财务可见/可编辑） */
  payPerSession: number
  createdAt: string
  updatedAt: string
}

/** 老师 */
export interface Teacher {
  id: number
  name: string
  note: string | null
  /** 所教课程 id 列表 */
  courseIds: number[]
  /** 所教课程文本标签，如 "数学 高一 A1班" */
  courseLabels: string[]
}

/** 老师详情（含授课统计） */
export interface TeacherDetail {
  teacher: Teacher
  /** 累计授课次数（含代课） */
  totalInstances: number
  /** 未来待上课程实例数 */
  upcomingInstances: number
}

/** 学生 */
export interface Student {
  id: number
  name: string
  schoolClass: string | null
  note: string | null
  /** 所报课程 id 列表 */
  courseIds: number[]
  /** 所报课程文本标签 */
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
  stats: {
    present: number
    leave: number
    absent: number
  }
}

/** 课程实例（排课生成的单次课） */
export interface ScheduleInstance {
  id: number
  courseId: number
  date: string // YYYY-MM-DD
  startTime: string // HH:MM
  endTime: string // HH:MM
  /** 实际授课老师（代课场景），null 表示使用课程默认老师 */
  actualTeacherId: number | null
  actualTeacherName?: string | null
  status: InstanceStatus
  note: string | null
  // 以下为联表冗余字段，便于日历展示
  subject?: string
  grade?: string
  className?: string
  defaultTeacherName?: string | null
}

/** 课程实例详情弹窗数据 */
export interface InstanceDetail {
  instance: ScheduleInstance
  course: Course
  /** 报名该课程的学生名单（含各自考勤状态，null 表示未标记） */
  students: {
    id: number
    name: string
    schoolClass: string | null
    attendanceStatus: AttendanceStatus | null
  }[]
}

/** 学生缴费记录 */
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

/** 老师课酬支付记录 */
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

/** 财务仪表盘汇总数据 */
export interface DashboardData {
  /** 本月学生应缴总额 */
  studentDue: number
  /** 本月学生实缴总额 */
  studentPaid: number
  /** 本月老师应付总额 */
  teacherDue: number
  /** 本月老师实付总额 */
  teacherPaid: number
  /** 本月盈亏 = 实缴 - 实付 */
  profit: number
}

/** 月度盈亏报表行 */
export interface MonthReportRow {
  month: string // YYYY-MM
  income: number
  expense: number
  profit: number
}

/** 系统设置（渲染进程可见部分，不含财务密码） */
export interface AppSettings {
  /** 年级选项 */
  grades: string[]
  /** 缴费方式选项 */
  paymentMethods: string[]
  /** 自动排课周数 */
  scheduleWeeks: number
  /** 缺勤是否收费（true = 缺勤与出勤同样收费） */
  chargeAbsent: boolean
}

/** 通用 Excel 导出参数 */
export interface ExcelExportPayload {
  /** 模块名，用于文件名：Vlearn_{模块名}_{日期}.xlsx */
  module: string
  columns: { header: string; key: string }[]
  rows: Record<string, unknown>[]
}

/** 备份/恢复操作结果 */
export interface BackupResult {
  success: boolean
  canceled?: boolean
  path?: string
  error?: string
}

/** preload 暴露的 window.api 完整接口（渲染进程唯一的数据通道） */
export interface VlearnApi {
  // ---------- 课程 ----------
  getCourses(): Promise<Course[]>
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
  /** 删除未来课程实例并按当前规则重新生成，返回生成数量 */
  regenerateInstances(courseId: number): Promise<number>

  // ---------- 老师 ----------
  getTeachers(): Promise<Teacher[]>
  getTeacherDetail(id: number): Promise<TeacherDetail>
  createTeacher(data: { name: string; note: string | null; courseIds: number[] }): Promise<Teacher>
  updateTeacher(
    id: number,
    data: { name: string; note: string | null; courseIds: number[] }
  ): Promise<Teacher>
  deleteTeacher(id: number): Promise<void>

  // ---------- 学生 ----------
  getStudents(): Promise<Student[]>
  getStudentDetail(id: number): Promise<StudentDetail>
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

  // ---------- 课程实例（排课） ----------
  getInstances(start: string, end: string): Promise<ScheduleInstance[]>
  getInstanceDetail(id: number): Promise<InstanceDetail>
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

  // ---------- 考勤 ----------
  saveAttendance(data: {
    scheduleInstanceId: number
    studentId: number
    status: AttendanceStatus
    note?: string | null
  }): Promise<void>
  removeAttendance(data: { scheduleInstanceId: number; studentId: number }): Promise<void>
  /** 一键将该课程实例所有报名学生标记为出勤，返回标记人数 */
  markAllPresent(scheduleInstanceId: number): Promise<number>

  // ---------- 财务（以下所有方法在主进程校验财务会话） ----------
  verifyFinancePassword(password: string): Promise<boolean>
  logoutFinance(): Promise<void>
  changeFinancePassword(oldPassword: string, newPassword: string): Promise<{
    success: boolean
    error?: string
  }>
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
  /** 根据考勤自动计算学生应缴金额，返回处理的（学生,课程）组合数 */
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
  /** 根据课程实例自动生成/更新老师课酬记录，返回处理数量 */
  autoCalcTeacherPayments(): Promise<number>
  /** 按年份查询月度盈亏报表（含"合计"行，month 为 '合计'） */
  getMonthlyReport(year: number): Promise<MonthReportRow[]>
  /** 供课酬表单选择课程实例（含单次课酬标准），仅财务可用 */
  getPaymentInstances(): Promise<ScheduleInstance[]>

  // ---------- 设置 ----------
  getSettings(): Promise<AppSettings>
  saveSettings(data: AppSettings): Promise<void>
  backupData(): Promise<BackupResult>
  restoreData(): Promise<BackupResult>

  // ---------- Excel 导出 ----------
  exportExcel(payload: ExcelExportPayload): Promise<{ success: boolean; canceled?: boolean; path?: string }>
}
