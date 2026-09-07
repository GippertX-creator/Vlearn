/**
 * 预加载脚本：通过 contextBridge 向渲染进程暴露 window.api。
 * 渲染进程没有 Node 能力，所有数据库/文件操作必须经由此处声明的 IPC 通道。
 */
import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppSettings,
  AttendanceStatus,
  ExcelExportPayload,
  ScheduleRule,
  VlearnApi
} from '../src/types'

const api: VlearnApi = {
  // ---------- 课程 ----------
  getCourses: () => ipcRenderer.invoke('courses:getAll'),
  createCourse: (data: {
    subject: string
    grade: string
    className: string
    defaultTeacherId: number | null
    scheduleRule: ScheduleRule[]
  }) => ipcRenderer.invoke('courses:create', data),
  updateCourse: (
    id: number,
    data: {
      subject: string
      grade: string
      className: string
      defaultTeacherId: number | null
      scheduleRule: ScheduleRule[]
    }
  ) => ipcRenderer.invoke('courses:update', id, data),
  deleteCourse: (id: number) => ipcRenderer.invoke('courses:delete', id),
  regenerateInstances: (courseId: number) => ipcRenderer.invoke('courses:regenerate', courseId),

  // ---------- 老师 ----------
  getTeachers: () => ipcRenderer.invoke('teachers:getAll'),
  getTeacherDetail: (id: number) => ipcRenderer.invoke('teachers:getDetail', id),
  createTeacher: (data: { name: string; note: string | null; courseIds: number[] }) =>
    ipcRenderer.invoke('teachers:create', data),
  updateTeacher: (id: number, data: { name: string; note: string | null; courseIds: number[] }) =>
    ipcRenderer.invoke('teachers:update', id, data),
  deleteTeacher: (id: number) => ipcRenderer.invoke('teachers:delete', id),

  // ---------- 学生 ----------
  getStudents: () => ipcRenderer.invoke('students:getAll'),
  getStudentDetail: (id: number) => ipcRenderer.invoke('students:getDetail', id),
  createStudent: (data: {
    name: string
    schoolClass: string | null
    note: string | null
    courseIds: number[]
  }) => ipcRenderer.invoke('students:create', data),
  updateStudent: (
    id: number,
    data: { name: string; schoolClass: string | null; note: string | null; courseIds: number[] }
  ) => ipcRenderer.invoke('students:update', id, data),
  deleteStudent: (id: number) => ipcRenderer.invoke('students:delete', id),

  // ---------- 课程实例（排课） ----------
  getInstances: (start: string, end: string) => ipcRenderer.invoke('instances:getRange', start, end),
  getInstanceDetail: (id: number) => ipcRenderer.invoke('instances:getDetail', id),
  updateInstance: (
    id: number,
    data: { date: string; startTime: string; endTime: string; actualTeacherId: number | null; note: string | null }
  ) => ipcRenderer.invoke('instances:update', id, data),
  cancelInstance: (id: number) => ipcRenderer.invoke('instances:cancel', id),
  restoreInstance: (id: number) => ipcRenderer.invoke('instances:restore', id),

  // ---------- 考勤 ----------
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
  verifyFinancePassword: (password: string) => ipcRenderer.invoke('finance:verifyPassword', password),
  logoutFinance: () => ipcRenderer.invoke('finance:logout'),
  changeFinancePassword: (oldPassword: string, newPassword: string) =>
    ipcRenderer.invoke('finance:changePassword', oldPassword, newPassword),
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

  // ---------- 设置 ----------
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (data: AppSettings) => ipcRenderer.invoke('settings:save', data),
  backupData: () => ipcRenderer.invoke('backup:create'),
  restoreData: () => ipcRenderer.invoke('backup:restore'),

  // ---------- Excel 导出 ----------
  exportExcel: (payload: ExcelExportPayload) => ipcRenderer.invoke('export:excel', payload)
}

contextBridge.exposeInMainWorld('api', api)
