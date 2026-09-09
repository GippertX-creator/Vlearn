/**
 * 预加载脚本：通过 contextBridge 向渲染进程暴露 window.api（v2 三角色架构）。
 * 渲染进程没有 Node 能力，所有数据库/文件操作必须经由此处声明的 IPC 通道，
 * 通道在主进程侧均有严格的角色权限校验。
 */
import { contextBridge, ipcRenderer } from 'electron'
import type {
  AttendanceStatus,
  ExcelExportPayload,
  Role,
  RoleSettings,
  ScheduleRule,
  VlearnApi
} from '../src/types'

const api: VlearnApi = {
  // ---------- 登录与会话 ----------
  getAuthStatus: () => ipcRenderer.invoke('auth:getStatus'),
  login: (role: Role, password: string) => ipcRenderer.invoke('auth:login', role, password),
  logout: () => ipcRenderer.invoke('auth:logout'),
  changePassword: (oldPassword: string, newPassword: string) =>
    ipcRenderer.invoke('auth:changePassword', oldPassword, newPassword),

  // ---------- 教务只读 ----------
  getCourses: () => ipcRenderer.invoke('courses:getAll'),
  getTeachers: () => ipcRenderer.invoke('teachers:getAll'),
  getTeacherDetail: (id: number) => ipcRenderer.invoke('teachers:getDetail', id),
  getStudents: () => ipcRenderer.invoke('students:getAll'),
  getStudentDetail: (id: number) => ipcRenderer.invoke('students:getDetail', id),
  getInstances: (start: string, end: string) => ipcRenderer.invoke('instances:getRange', start, end),
  getInstanceDetail: (id: number) => ipcRenderer.invoke('instances:getDetail', id),

  // ---------- 教务读写 ----------
  createCourse: (data: {
    subject: string
    grade: string
    className: string
    defaultTeacherId: number | null
    scheduleRule: ScheduleRule[]
  }) => ipcRenderer.invoke('courses:create', data),
  updateCourse: (
    id: number,
    data: { subject: string; grade: string; className: string; defaultTeacherId: number | null; scheduleRule: ScheduleRule[] }
  ) => ipcRenderer.invoke('courses:update', id, data),
  deleteCourse: (id: number) => ipcRenderer.invoke('courses:delete', id),
  regenerateInstances: (courseId: number) => ipcRenderer.invoke('courses:regenerate', courseId),
  createTeacher: (data: { name: string; note: string | null; courseIds: number[] }) =>
    ipcRenderer.invoke('teachers:create', data),
  updateTeacher: (id: number, data: { name: string; note: string | null; courseIds: number[] }) =>
    ipcRenderer.invoke('teachers:update', id, data),
  deleteTeacher: (id: number) => ipcRenderer.invoke('teachers:delete', id),
  createStudent: (data: { name: string; schoolClass: string | null; note: string | null; courseIds: number[] }) =>
    ipcRenderer.invoke('students:create', data),
  updateStudent: (
    id: number,
    data: { name: string; schoolClass: string | null; note: string | null; courseIds: number[] }
  ) => ipcRenderer.invoke('students:update', id, data),
  deleteStudent: (id: number) => ipcRenderer.invoke('students:delete', id),
  updateInstance: (
    id: number,
    data: { date: string; startTime: string; endTime: string; actualTeacherId: number | null; note: string | null }
  ) => ipcRenderer.invoke('instances:update', id, data),
  cancelInstance: (id: number) => ipcRenderer.invoke('instances:cancel', id),
  restoreInstance: (id: number) => ipcRenderer.invoke('instances:restore', id),
  saveAttendance: (data: {
    scheduleInstanceId: number
    studentId: number
    status: AttendanceStatus
    note?: string | null
  }) => ipcRenderer.invoke('attendance:save', data),
  removeAttendance: (data: { scheduleInstanceId: number; studentId: number }) =>
    ipcRenderer.invoke('attendance:remove', data),
  markAllPresent: (scheduleInstanceId: number) => ipcRenderer.invoke('attendance:markAllPresent', scheduleInstanceId),

  // ---------- 财务 ----------
  getDashboard: (month: string) => ipcRenderer.invoke('finance:getDashboard', month),
  getFinanceCourses: () => ipcRenderer.invoke('finance:getCourses'),
  updateCourseFees: (id: number, data: { fee: number; payPerSession: number }) =>
    ipcRenderer.invoke('finance:updateCourseFees', id, data),
  getStudentPayments: () => ipcRenderer.invoke('finance:getStudentPayments'),
  createStudentPayment: (data: {
    studentId: number
    courseId: number
    amountDue: number
    amountPaid: number
    paymentMethod: string
    paymentDate: string
    note: string | null
  }) => ipcRenderer.invoke('finance:createStudentPayment', data),
  updateStudentPayment: (
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
  ) => ipcRenderer.invoke('finance:updateStudentPayment', id, data),
  deleteStudentPayment: (id: number) => ipcRenderer.invoke('finance:deleteStudentPayment', id),
  autoCalcStudentPayments: () => ipcRenderer.invoke('finance:autoCalcStudentPayments'),
  getTeacherPayments: () => ipcRenderer.invoke('finance:getTeacherPayments'),
  createTeacherPayment: (data: {
    teacherId: number
    scheduleInstanceId: number
    amountDue: number
    amountPaid: number
    paymentDate: string
    note: string | null
  }) => ipcRenderer.invoke('finance:createTeacherPayment', data),
  updateTeacherPayment: (
    id: number,
    data: {
      teacherId: number
      scheduleInstanceId: number
      amountDue: number
      amountPaid: number
      paymentDate: string
      note: string | null
    }
  ) => ipcRenderer.invoke('finance:updateTeacherPayment', id, data),
  deleteTeacherPayment: (id: number) => ipcRenderer.invoke('finance:deleteTeacherPayment', id),
  autoCalcTeacherPayments: () => ipcRenderer.invoke('finance:autoCalcTeacherPayments'),
  getMonthlyReport: (year: number) => ipcRenderer.invoke('finance:getMonthlyReport', year),
  getPaymentInstances: () => ipcRenderer.invoke('finance:getPaymentInstances'),

  // ---------- 助教 ----------
  getLessonNote: (scheduleInstanceId: number) => ipcRenderer.invoke('assistant:getLessonNote', scheduleInstanceId),
  saveLessonNote: (data: {
    scheduleInstanceId: number
    knowledgePoints: string | null
    classPerformance: string | null
    homework: string | null
    summary: string | null
  }) => ipcRenderer.invoke('assistant:saveLessonNote', data),
  listLessonNotes: () => ipcRenderer.invoke('assistant:listLessonNotes'),
  generateSms: (lessonNoteId: number) => ipcRenderer.invoke('assistant:generateSms', lessonNoteId),
  listMessages: () => ipcRenderer.invoke('assistant:listMessages'),
  deleteMessage: (id: number) => ipcRenderer.invoke('assistant:deleteMessage', id),

  // ---------- Agent ----------
  getAlerts: () => ipcRenderer.invoke('agent:getAlerts'),
  checkCourseConflict: (data: { courseId: number | null; defaultTeacherId: number | null; scheduleRule: ScheduleRule[] }) =>
    ipcRenderer.invoke('agent:checkCourseConflict', data),
  checkInstanceConflict: (data: {
    instanceId: number
    date: string
    startTime: string
    endTime: string
    actualTeacherId: number | null
  }) => ipcRenderer.invoke('agent:checkInstanceConflict', data),
  suggestSlots: (instanceId: number) => ipcRenderer.invoke('agent:suggestSlots', instanceId),
  checkDuplicateName: (kind: 'student' | 'teacher', name: string) =>
    ipcRenderer.invoke('agent:checkDuplicateName', kind, name),
  generateReport: (kind: 'week' | 'month') => ipcRenderer.invoke('agent:generateReport', kind),
  reconcile: () => ipcRenderer.invoke('agent:reconcile'),
  checkPaymentAnomaly: (data: { kind: 'student' | 'teacher'; id?: number; amountPaid: number; amountDue: number }) =>
    ipcRenderer.invoke('agent:checkPaymentAnomaly', data),
  trendAnalysis: () => ipcRenderer.invoke('agent:trendAnalysis'),
  smartReport: (module: string, columns: { header: string; key: string }[], rows: Record<string, unknown>[]) =>
    ipcRenderer.invoke('agent:smartReport', module, columns, rows),

  // ---------- 多校区同步 ----------
  getSyncInfo: () => ipcRenderer.invoke('sync:getInfo'),
  saveCampusName: (name: string) => ipcRenderer.invoke('sync:saveCampusName', name),
  syncExport: () => ipcRenderer.invoke('sync:exportPackage'),
  syncImport: () => ipcRenderer.invoke('sync:importPackage'),

  // ---------- 设置 / 备份 / 导出 ----------
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (data: RoleSettings) => ipcRenderer.invoke('settings:save', data),
  getAppVersion: () => ipcRenderer.invoke('app:getVersion'),
  backupData: () => ipcRenderer.invoke('backup:create'),
  restoreData: () => ipcRenderer.invoke('backup:restore'),
  exportExcel: (payload: ExcelExportPayload) => ipcRenderer.invoke('export:excel', payload)
}

contextBridge.exposeInMainWorld('api', api)
