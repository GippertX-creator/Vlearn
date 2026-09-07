/**
 * 冒烟测试：
 * - --smoke-test：在隐藏窗口中加载真实 preload，通过 window.api 走完整 IPC 链路，
 *   验证核心业务逻辑（排课、考勤、缴费、课酬、权限）。
 * - --smoke-ui：加载真实渲染进程（React 页面），验证页面挂载且无运行时错误。
 * 输出 ✓/✗ 结果；全部通过退出码 0，任一失败退出码 1。
 */
import { BrowserWindow } from 'electron'
import { join } from 'node:path'
import { getISODay, parseISO } from 'date-fns'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildWorkbook } from './excelExport'

const failures: string[] = []

function assert(cond: boolean, label: string): void {
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}`)
  if (!cond) failures.push(label)
}

/**
 * UI 冒烟测试：加载打包后的渲染进程，检查 React 挂载与运行时错误。
 */
export async function runUiSmokeTest(): Promise<void> {
  console.log('Vlearn UI 冒烟测试开始…')
  const consoleErrors: string[] = []
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: false
    }
  })
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) consoleErrors.push(message) // 2=warning 3=error
  })
  await win.loadFile(join(__dirname, '../renderer/index.html'))
  // 等待 React 渲染完成
  await new Promise((resolve) => setTimeout(resolve, 3000))
  const result = await win.webContents.executeJavaScript(`
    (() => {
      const root = document.getElementById('root')
      return {
        childCount: root ? root.children.length : -1,
        hasMenu: document.body.innerText.includes('课程日历'),
        hasApi: typeof window.api === 'object' && window.api !== null
      }
    })()
  `)
  assert(result.childCount > 0, `React 已挂载（root 子节点 ${result.childCount}）`)
  assert(result.hasMenu, '顶部导航渲染出「课程日历」等菜单')
  assert(result.hasApi, 'window.api 已注入（preload 正常）')
  const realErrors = consoleErrors.filter((m) => !m.includes('DevTools'))
  assert(realErrors.length === 0, `无渲染进程错误${realErrors.length > 0 ? '：' + realErrors.join(' | ') : ''}`)

  // 可选：设置 VLEARN_SHOT_DIR 时，抓取各页面截图（用于生成用户文档）
  const shotDir = process.env.VLEARN_SHOT_DIR
  if (shotDir) {
    fs.mkdirSync(shotDir, { recursive: true })
    win.show() // macOS 下隐藏窗口截图可能为空白
    await new Promise((resolve) => setTimeout(resolve, 800))
    const shot = async (name: string): Promise<void> => {
      const img = await win.webContents.capturePage()
      fs.writeFileSync(path.join(shotDir, name), img.toPNG())
      console.log(`  已截图：${name}`)
    }
    const clickMenu = async (label: string): Promise<void> => {
      await win.webContents.executeJavaScript(
        `document.querySelectorAll('.ant-menu-item').forEach((el) => { if (el.textContent.trim() === '${label}') el.click() })`
      )
      await new Promise((resolve) => setTimeout(resolve, 1500))
    }
    await shot('01-课程日历.png')
    await clickMenu('学生管理')
    await shot('02-学生管理.png')
    await clickMenu('老师管理')
    await shot('03-老师管理.png')
    await clickMenu('财务')
    await shot('04-财务密码验证.png')
    await clickMenu('设置')
    await shot('05-系统设置.png')
  }

  win.destroy()

  console.log('\n----------------------------------------')
  if (failures.length > 0) {
    console.log(`UI 冒烟测试失败 ${failures.length} 项`)
    failures.forEach((f) => console.log(`  - ${f}`))
    throw new Error(`UI 冒烟测试失败：${failures.length} 项`)
  }
  console.log('UI 冒烟测试全部通过 ✓')
}

export async function runSmokeTest(): Promise<void> {
  console.log('Vlearn 冒烟测试开始…')
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: false
    }
  })
  await win.loadURL('about:blank')

  // 在渲染上下文执行 window.api 调用（executeJavaScript 会等待 Promise 完成）
  const call = <T>(expr: string): Promise<T> => win.webContents.executeJavaScript(expr) as Promise<T>

  // ---------- 设置与默认值 ----------
  console.log('\n[1] 系统设置')
  const settings = await call<{ grades: string[]; scheduleWeeks: number; chargeAbsent: boolean }>(
    `window.api.getSettings()`
  )
  assert(settings.grades.includes('高一') && settings.grades.length === 3, '默认年级：高一/高二/高三')
  assert(settings.scheduleWeeks === 8, '默认排课周数：8')
  assert(settings.chargeAbsent === true, '默认缺勤收费：开')

  // ---------- 课程 / 老师 / 排课 ----------
  console.log('\n[2] 课程与自动排课')
  const teacher = await call<{ id: number; name: string }>(
    `window.api.createTeacher({ name: '张老师', note: '测试', courseIds: [] })`
  )
  assert(teacher.id > 0, '创建老师')
  const course = await call<{ id: number; subject: string; scheduleRule: { weekday: number }[] }>(
    `window.api.createCourse({
      subject: '数学', grade: '高一', className: 'A1班', defaultTeacherId: ${teacher.id},
      scheduleRule: [{ weekday: 2, start: '15:00', end: '17:00' }]
    })`
  )
  assert(course.id > 0, '创建课程（含默认时间规则）')
  const today = new Date().toISOString().slice(0, 10)
  const future = new Date(Date.now() + 70 * 86400000).toISOString().slice(0, 10)
  const instances = await call<{ id: number; date: string; status: string }[]>(
    `window.api.getInstances('${today}', '${future}')`
  )
  assert(instances.length === 8, `自动生成 8 周课程实例（实际 ${instances.length}）`)
  assert(
    instances.every((i) => getISODay(parseISO(i.date)) === 2),
    '实例日期均为周二'
  )
  const instanceId = instances[0].id

  // ---------- 学生与考勤 ----------
  console.log('\n[3] 学生与考勤')
  const student = await call<{ id: number }>(
    `window.api.createStudent({ name: '小明', schoolClass: '高一3班', note: null, courseIds: [${course.id}] })`
  )
  assert(student.id > 0, '创建学生并报课')
  let detail = await call<{ students: { attendanceStatus: string | null }[] }>(
    `window.api.getInstanceDetail(${instanceId})`
  )
  assert(detail.students.length === 1, '实例详情自动带出报名学生名单')
  assert(detail.students[0].attendanceStatus === null, '初始考勤状态：未标记')
  await call(`window.api.saveAttendance({ scheduleInstanceId: ${instanceId}, studentId: ${student.id}, status: 'present' })`)
  detail = await call(`window.api.getInstanceDetail(${instanceId})`)
  assert(detail.students[0].attendanceStatus === 'present', '单个学生标记出勤')
  await call(`window.api.removeAttendance({ scheduleInstanceId: ${instanceId}, studentId: ${student.id} })`)
  const marked = await call<number>(`window.api.markAllPresent(${instanceId})`)
  assert(marked === 1, '一键全部出勤')
  const studentDetail = await call<{ stats: { present: number; leave: number; absent: number } }>(
    `window.api.getStudentDetail(${student.id})`
  )
  assert(studentDetail.stats.present === 1, '学生考勤历史同步')

  // ---------- 调课 / 取消 ----------
  console.log('\n[4] 单次调课与取消')
  const updated = await call<{ status: string; actualTeacherId: number }>(
    `window.api.updateInstance(${instanceId}, {
      date: '${today}', startTime: '18:00', endTime: '20:00', actualTeacherId: ${teacher.id}, note: '代课'
    })`
  )
  assert(updated.status === 'adjusted', '调课后实例状态为 adjusted')
  await call(`window.api.cancelInstance(${instanceId})`)
  let st = await call<{ instance: { status: string } }>(`window.api.getInstanceDetail(${instanceId})`).then((d) => d.instance)
  assert(st.status === 'cancelled', '取消课程实例')
  await call(`window.api.restoreInstance(${instanceId})`)
  st = await call<{ instance: { status: string } }>(`window.api.getInstanceDetail(${instanceId})`).then((d) => d.instance)
  assert(st.status === 'normal', '恢复课程实例')

  // ---------- 财务权限 ----------
  console.log('\n[5] 财务权限')
  assert(await call<boolean>(`window.api.verifyFinancePassword('admin123')`), '初始密码 admin123 验证成功')
  assert(!(await call<boolean>(`window.api.verifyFinancePassword('错误密码')`)), '错误密码被拒绝')
  const guarded = await call<string>(
    `window.api.logoutFinance().then(() => window.api.getDashboard('2026-09')).then(() => '未拦截').catch((e) => '已拦截: ' + String(e.message))`
  )
  assert(guarded.startsWith('已拦截'), '退出财务后访问财务数据被主进程拒绝')
  await call(`window.api.verifyFinancePassword('admin123')`)

  // ---------- 财务业务 ----------
  console.log('\n[6] 课程费用 / 学生缴费 / 老师课酬')
  await call(`window.api.updateCourseFees(${course.id}, { fee: 100, payPerSession: 80 })`)
  assert(await call<number>(`window.api.autoCalcStudentPayments()`) === 1, '自动计算应缴（1 名学生 1 门课）')
  const payments = await call<{ amountDue: number; amountPaid: number }[]>(`window.api.getStudentPayments()`)
  assert(payments.length === 1 && payments[0].amountDue === 100, '应缴 = 费用 × 出勤次数（100）')
  assert(await call<number>(`window.api.autoCalcTeacherPayments()`) >= 8, '自动计算应付（按课程实例）')
  const teacherPayments = await call<{ amountDue: number; teacherId: number }[]>(`window.api.getTeacherPayments()`)
  assert(
    teacherPayments.length >= 8 && teacherPayments.every((p) => p.amountDue === 80 && p.teacherId === teacher.id),
    '应付金额取单次课酬标准（80）且支付给代课/默认老师'
  )

  const month = today.slice(0, 7)
  const dashboard = await call<{ studentDue: number; studentPaid: number; teacherDue: number; teacherPaid: number; profit: number }>(
    `window.api.getDashboard('${month}')`
  )
  assert(typeof dashboard.studentDue === 'number' && dashboard.profit === dashboard.studentPaid - dashboard.teacherPaid, '仪表盘汇总计算正确')

  const report = await call<{ month: string; income: number; expense: number }[]>(`window.api.getMonthlyReport(2026)`)
  assert(report.length === 13 && report[12].month === '合计', '年度报表含 12 个月 + 合计行')

  console.log('\n[7] 缴费/课酬记录增删改')
  await call(
    `window.api.createStudentPayment({ studentId: ${student.id}, courseId: ${course.id}, amountDue: 200, amountPaid: 150, paymentMethod: '微信', paymentDate: '${today}', note: '测试' })`
  )
  let sp = await call<{ id: number; amountPaid: number }[]>(`window.api.getStudentPayments()`)
  assert(sp.length === 2 && sp.some((p) => p.amountPaid === 150), '新增学生缴费记录')
  await call(`window.api.updateStudentPayment(${sp[sp.length - 1].id}, { studentId: ${student.id}, courseId: ${course.id}, amountDue: 200, amountPaid: 200, paymentMethod: '微信', paymentDate: '${today}', note: '补缴' })`)
  sp = await call(`window.api.getStudentPayments()`)
  assert(sp.some((p) => p.amountPaid === 200), '编辑学生缴费记录')
  await call(`window.api.deleteStudentPayment(${sp[sp.length - 1].id})`)
  assert((await call<unknown[]>(`window.api.getStudentPayments()`)).length === 1, '删除学生缴费记录')

  // ---------- 密码修改与备份 ----------
  console.log('\n[8] 密码修改 / 重新排课 / Excel 导出 / 详情统计')
  const changeRes = await call<{ success: boolean; error?: string }>(
    `window.api.changeFinancePassword('admin123', 'test123456')`
  )
  assert(changeRes.success, '修改财务密码（验证旧密码）')
  assert(await call<boolean>(`window.api.verifyFinancePassword('test123456')`), '新密码生效')
  await call(`window.api.changeFinancePassword('test123456', 'admin123')`)

  const regen = await call<number>(`window.api.regenerateInstances(${course.id})`)
  assert(regen === 8, '手动重新生成排课（未来 8 周）')

  const teacherDetail = await call<{ totalInstances: number }>(`window.api.getTeacherDetail(${teacher.id})`)
  assert(teacherDetail.totalInstances >= 8, '老师详情含授课统计')

  const wb = await buildWorkbook('考勤记录', [{ header: '姓名', key: 'name' }], [{ name: '小明' }])
  const tmpXlsx = path.join(os.tmpdir(), 'vlearn-smoke-export.xlsx')
  await wb.xlsx.writeFile(tmpXlsx)
  assert(fs.existsSync(tmpXlsx), 'Excel 工作簿生成')
  fs.rmSync(tmpXlsx, { force: true })

  // ---------- 设置保存与级联删除 ----------
  console.log('\n[9] 设置保存与级联删除')
  await call(
    `window.api.saveSettings({ grades: ['高一', '高二', '高三', '复读'], paymentMethods: ['微信', '转账', '现金', '刷卡'], scheduleWeeks: 8, chargeAbsent: false })`
  )
  const saved = await call<{ grades: string[]; paymentMethods: string[]; chargeAbsent: boolean }>(`window.api.getSettings()`)
  assert(saved.grades.length === 4 && saved.paymentMethods.length === 4 && saved.chargeAbsent === false, '自定义年级/缴费方式/缺勤收费规则')
  await call(`window.api.saveSettings({ grades: ['高一', '高二', '高三'], paymentMethods: ['微信', '转账', '现金'], scheduleWeeks: 8, chargeAbsent: true })`)

  await call(`window.api.deleteCourse(${course.id})`)
  assert((await call<unknown[]>(`window.api.getCourses()`)).length === 0, '删除课程（级联清理实例/考勤/缴费）')

  win.destroy()

  console.log('\n----------------------------------------')
  if (failures.length > 0) {
    console.log(`冒烟测试失败 ${failures.length} 项：`)
    failures.forEach((f) => console.log(`  - ${f}`))
    throw new Error(`冒烟测试失败：${failures.length} 项`)
  }
  console.log('冒烟测试全部通过 ✓')
}
