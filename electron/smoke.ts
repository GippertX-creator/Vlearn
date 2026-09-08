/**
 * 冒烟测试（v2 三角色架构）：
 * - --smoke-test：在隐藏窗口中加载真实 preload，通过 window.api 走完整 IPC 链路，
 *   验证：三角色登录/密码、教务流程（排课/考勤/冲突/建议/报告）、越权拦截、
 *   财务流程（自动计算/对账/异常检测/趋势）、助教流程（记录/短信）、
 *   旧版单库自动迁移。
 * - --smoke-ui：加载真实渲染进程，验证登录页渲染、各角色登录后主界面渲染与无运行时错误，
 *   设 VLEARN_SHOT_DIR 时顺带抓取文档截图。
 */
import { BrowserWindow } from 'electron'
import { join } from 'node:path'
import { getISODay, parseISO } from 'date-fns'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { buildWorkbook } from './excelExport'
import { getDb, getMigrationError, initDatabases, INITIAL_PASSWORDS, Role } from './db'

const failures: string[] = []

function assert(cond: boolean, label: string): void {
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}`)
  if (!cond) failures.push(label)
}

const sha256 = (s: string): string => crypto.createHash('sha256').update(s, 'utf8').digest('hex')

// ---------------------------------------------------------------------------
// 旧库迁移测试（直接调用主进程模块，在独立临时目录进行）
// ---------------------------------------------------------------------------

function testMigration(mainDir: string): void {
  console.log('\n[0] 旧版单库自动迁移')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vlearn-migrate-'))
  const legacyPath = path.join(dir, 'vlearn.db')

  // 构造 v1 结构的旧库与数据
  const legacy = new Database(legacyPath)
  legacy.exec(`
    CREATE TABLE courses (id INTEGER PRIMARY KEY AUTOINCREMENT, subject TEXT NOT NULL, grade TEXT NOT NULL,
      class_name TEXT NOT NULL, default_teacher_id INTEGER, default_schedule_rule TEXT, fee REAL DEFAULT 0,
      pay_per_session REAL DEFAULT 0, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE teachers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, note TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE teacher_courses (teacher_id INTEGER NOT NULL, course_id INTEGER NOT NULL, PRIMARY KEY (teacher_id, course_id));
    CREATE TABLE students (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, school_class TEXT, note TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE student_courses (student_id INTEGER NOT NULL, course_id INTEGER NOT NULL, PRIMARY KEY (student_id, course_id));
    CREATE TABLE schedule_instances (id INTEGER PRIMARY KEY AUTOINCREMENT, course_id INTEGER NOT NULL, date TEXT NOT NULL,
      start_time TEXT NOT NULL, end_time TEXT NOT NULL, actual_teacher_id INTEGER, status TEXT DEFAULT 'normal',
      note TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE attendances (id INTEGER PRIMARY KEY AUTOINCREMENT, schedule_instance_id INTEGER NOT NULL,
      student_id INTEGER NOT NULL, status TEXT NOT NULL, note TEXT, created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(schedule_instance_id, student_id));
    CREATE TABLE student_payments (id INTEGER PRIMARY KEY AUTOINCREMENT, student_id INTEGER NOT NULL, course_id INTEGER NOT NULL,
      amount_due REAL NOT NULL, amount_paid REAL NOT NULL, payment_method TEXT NOT NULL, payment_date TEXT NOT NULL,
      note TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE teacher_payments (id INTEGER PRIMARY KEY AUTOINCREMENT, teacher_id INTEGER NOT NULL, schedule_instance_id INTEGER NOT NULL,
      amount_due REAL NOT NULL, amount_paid REAL NOT NULL, payment_date TEXT NOT NULL, note TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
  `)
  legacy.prepare(`INSERT INTO teachers (name) VALUES ('旧老师')`).run()
  legacy
    .prepare(`INSERT INTO courses (subject, grade, class_name, default_teacher_id, fee) VALUES ('数学', '高一', 'A1班', 1, 150)`)
    .run()
  legacy.prepare(`INSERT INTO students (name, school_class) VALUES ('旧学生', '高一3班')`).run()
  legacy.prepare(`INSERT INTO student_courses (student_id, course_id) VALUES (1, 1)`).run()
  legacy
    .prepare(`INSERT INTO schedule_instances (course_id, date, start_time, end_time) VALUES (1, '2026-09-08', '15:00', '17:00')`)
    .run()
  legacy.prepare(`INSERT INTO attendances (schedule_instance_id, student_id, status) VALUES (1, 1, 'present')`).run()
  legacy
    .prepare(`INSERT INTO student_payments (student_id, course_id, amount_due, amount_paid, payment_method, payment_date) VALUES (1, 1, 300, 300, '微信', '2026-09-01')`)
    .run()
  legacy.prepare(`INSERT INTO teacher_payments (teacher_id, schedule_instance_id, amount_due, amount_paid, payment_date) VALUES (1, 1, 100, 100, '2026-09-01')`).run()
  legacy.prepare(`INSERT INTO settings (key, value) VALUES ('finance_password_hash', ?)`).run(sha256('admin123'))
  legacy.prepare(`INSERT INTO settings (key, value) VALUES ('grades', '["高一","高二","高三"]')`).run()
  legacy.close()

  // 执行迁移
  initDatabases(dir)
  if (getMigrationError()) {
    console.log('  迁移错误详情：', getMigrationError())
  }

  assert((getDb('academic').prepare('SELECT COUNT(*) AS c FROM courses').get() as { c: number }).c === 1, '教务库：课程已迁移')
  assert((getDb('academic').prepare('SELECT COUNT(*) AS c FROM students').get() as { c: number }).c === 1, '教务库：学生已迁移')
  assert((getDb('academic').prepare('SELECT COUNT(*) AS c FROM attendances').get() as { c: number }).c === 1, '教务库：考勤已迁移')
  assert((getDb('finance').prepare('SELECT COUNT(*) AS c FROM student_payments').get() as { c: number }).c === 1, '财务库：缴费已迁移')
  assert((getDb('finance').prepare('SELECT COUNT(*) AS c FROM teacher_payments').get() as { c: number }).c === 1, '财务库：课酬已迁移')
  const finHash = (getDb('finance').prepare(`SELECT value FROM settings WHERE key = 'password_hash'`).get() as { value: string }).value
  assert(finHash === sha256('admin123'), '财务密码沿用旧哈希（admin123）')
  const acaHash = (getDb('academic').prepare(`SELECT value FROM settings WHERE key = 'password_hash'`).get() as { value: string }).value
  assert(acaHash === sha256('admin123'), '教务初始密码 admin123')
  const astHash = (getDb('assistant').prepare(`SELECT value FROM settings WHERE key = 'password_hash'`).get() as { value: string }).value
  assert(astHash === sha256('assistant123'), '助教初始密码 assistant123')
  assert(fs.existsSync(path.join(dir, 'migration.log')), '迁移日志已生成')
  assert(!fs.existsSync(legacyPath), '旧库已重命名备份')
  const bak = fs.readdirSync(dir).filter((f) => f.startsWith('vlearn.db.migrated-'))
  assert(bak.length === 1, '旧库备份文件存在')

  // 迁移测试结束：切回主测试数据目录（全新三库），避免污染后续 IPC 测试
  initDatabases(mainDir)
}

// ---------------------------------------------------------------------------
// IPC 冒烟测试（真实 preload + window.api）
// ---------------------------------------------------------------------------

export async function runSmokeTest(mainDir: string): Promise<void> {
  console.log('Vlearn 冒烟测试开始…')
  testMigration(mainDir)

  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: false
    }
  })
  await win.loadURL('about:blank')
  const call = <T>(expr: string): Promise<T> => win.webContents.executeJavaScript(expr) as Promise<T>
  /** 断言 IPC 调用被拒绝（越权拦截） */
  const assertRejected = async (expr: string, label: string): Promise<void> => {
    const result = await call<string>(`${expr}.then(() => 'NOT-REJECTED').catch((e) => 'rejected: ' + String(e.message))`)
    assert(result.startsWith('rejected'), label)
  }

  // ---------- 登录 ----------
  console.log('\n[1] 角色登录')
  let status = await call<{ loggedIn: boolean; role: string | null }>(`window.api.getAuthStatus()`)
  assert(status.loggedIn === false, '初始未登录')
  assert((await call<{ success: boolean }>(`window.api.login('academic', '错误密码')`)).success === false, '教务错误密码被拒绝')
  assert((await call<{ success: boolean }>(`window.api.login('academic', 'admin123')`)).success === true, '教务 admin123 登录成功')

  // ---------- 教务流程 ----------
  console.log('\n[2] 教务：排课 / 考勤 / Agent')
  const teacher = await call<{ id: number }>(`window.api.createTeacher({ name: '张老师', note: null, courseIds: [] })`)
  const course = await call<{ id: number }>(
    `window.api.createCourse({ subject: '数学', grade: '高一', className: 'A1班', defaultTeacherId: ${teacher.id}, scheduleRule: [{ weekday: 2, start: '15:00', end: '17:00' }] })`
  )
  assert(course.id > 0, '创建课程')
  const today = new Date().toISOString().slice(0, 10)
  const future = new Date(Date.now() + 70 * 86400000).toISOString().slice(0, 10)
  const instances = await call<{ id: number; date: string }[]>(`window.api.getInstances('${today}', '${future}')`)
  assert(instances.length === 8 && instances.every((i) => getISODay(parseISO(i.date)) === 2), '自动生成 8 周周二课程实例')
  const instanceId = instances[0].id

  // 冲突检测：同一老师同一时间段再建课程
  const conflicts = await call<{ length: number }[]>(
    `window.api.checkCourseConflict({ courseId: null, defaultTeacherId: ${teacher.id}, scheduleRule: [{ weekday: 2, start: '16:00', end: '17:30' }] })`
  )
  assert(conflicts.length > 0, '排课冲突检测（老师时间重叠）')

  const student = await call<{ id: number }>(
    `window.api.createStudent({ name: '小明', schoolClass: '高一3班', note: null, courseIds: [${course.id}] })`
  )
  await call(`window.api.markAllPresent(${instanceId})`)
  let detail = await call<{ students: { attendanceStatus: string | null }[] }>(`window.api.getInstanceDetail(${instanceId})`)
  assert(detail.students[0].attendanceStatus === 'present', '一键全部出勤')

  // 相似姓名检测
  const dup = await call<{ matches: string[] }>(`window.api.checkDuplicateName('student', '小 明')`)
  assert(dup.matches.includes('小明'), '相似姓名检测（"小 明" → 小明）')

  // 调课冲突检测 + 建议
  const iConflict = await call<{ length: number }[]>(
    `window.api.checkInstanceConflict({ instanceId: ${instanceId}, date: '${today}', startTime: '15:30', endTime: '17:30', actualTeacherId: ${teacher.id} })`
  )
  // 老师其他周次不冲突（不同日期），学生没有其他课 → 0 冲突
  assert(iConflict.length === 0, '调课冲突检测（无冲突场景）')
  const slots = await call<{ length: number }[]>(`window.api.suggestSlots(${instanceId})`)
  assert(slots.length >= 1, '智能推荐时间段')

  // 考勤异常：连续 3 次请假
  await call(`window.api.saveAttendance({ scheduleInstanceId: ${instances[1].id}, studentId: ${student.id}, status: 'leave' })`)
  await call(`window.api.saveAttendance({ scheduleInstanceId: ${instances[2].id}, studentId: ${student.id}, status: 'leave' })`)
  await call(`window.api.saveAttendance({ scheduleInstanceId: ${instances[3].id}, studentId: ${student.id}, status: 'absent' })`)
  const alerts = await call<{ title: string }[]>(`window.api.getAlerts()`)
  assert(alerts.some((a) => a.title.includes('小明')), '考勤异常提醒（连续 3 次缺勤/请假）')

  // 周报（未配置大模型 → 模板）
  const report = await call<{ content: string; usedAi: boolean }>(`window.api.generateReport('week')`)
  assert(report.content.includes('教务周报') && report.usedAi === false, '周报生成（模板回退）')

  // ---------- 越权拦截（教务身份） ----------
  console.log('\n[3] 越权拦截（教务身份尝试访问他人数据）')
  await assertRejected(`window.api.getDashboard('${today.slice(0, 7)}')`, '教务访问财务仪表盘被拒绝')
  await assertRejected(`window.api.listMessages()`, '教务访问助教数据被拒绝')
  await assertRejected(`window.api.saveLessonNote({ scheduleInstanceId: ${instanceId}, knowledgePoints: 'x', classPerformance: null, homework: null, summary: null })`, '教务写助教数据被拒绝')
  const academicCourses = await call<{ fee: number }[]>(`window.api.getCourses()`)
  assert(academicCourses.every((c) => c.fee === 0), '教务端课程费用字段被清零（不可见）')

  // 登出
  await call(`window.api.logout()`)
  status = await call<{ loggedIn: boolean; role: string | null }>(`window.api.getAuthStatus()`)
  assert(status.loggedIn === false, '退出登录生效')
  await assertRejected(`window.api.getCourses()`, '未登录访问被拒绝')

  // ---------- 财务流程 ----------
  console.log('\n[4] 财务：自动计算 / 对账 / 异常检测 / 趋势')
  assert((await call<{ success: boolean }>(`window.api.login('finance', 'admin123')`)).success === true, '财务 admin123 登录')
  await assertRejected(`window.api.createStudent({ name: 'x', schoolClass: null, note: null, courseIds: [] })`, '财务写教务数据被拒绝')
  await assertRejected(`window.api.saveAttendance({ scheduleInstanceId: ${instanceId}, studentId: ${student.id}, status: 'absent' })`, '财务写考勤被拒绝')

  await call(`window.api.updateCourseFees(${course.id}, { fee: 100, payPerSession: 80 })`)
  const feeCourses = await call<{ id: number; fee: number }[]>(`window.api.getFinanceCourses()`)
  assert(feeCourses.some((c) => c.id === course.id && c.fee === 100), '财务读写课程费用（跨库只读+两列写权限）')
  assert((await call<number>(`window.api.autoCalcStudentPayments()`)) === 1, '自动计算应缴（读取教务考勤）')
  const payments = await call<{ amountDue: number; amountPaid: number }[]>(`window.api.getStudentPayments()`)
  assert(payments.length === 1 && payments[0].amountDue === 200 && payments[0].amountPaid === 0, '应缴 = 费用 ×（出勤1 + 缺勤1）= 200')
  assert((await call<number>(`window.api.autoCalcTeacherPayments()`)) >= 8, '自动计算应付')

  const recon = await call<{ items: { length: number }; summary: string }>(`window.api.reconcile()`)
  assert(recon.items.length >= 2 && recon.summary.includes('差异'), '对账检查发现未缴/未付差异')
  const anomaly = await call<{ anomalies: { length: number } }>(
    `window.api.checkPaymentAnomaly({ kind: 'student', amountPaid: 99999, amountDue: 200 })`
  )
  assert(anomaly.anomalies.length >= 1, '异常交易检测（金额远超均值）')
  const trend = await call<{ content: string; usedAi: boolean }>(`window.api.trendAnalysis()`)
  assert(trend.content.includes('盈亏趋势分析') && trend.usedAi === false, '趋势分析（模板回退）')
  const smart = await call<{ content: string }>(
    `window.api.smartReport('学生缴费', [{ header: '学生', key: '学生' }], [{ 学生: '小明' }])`
  )
  assert(smart.content.includes('【学生缴费】'), '智能报表生成')
  const alertsF = await call<{ title: string }[]>(`window.api.getAlerts()`)
  assert(alertsF.some((a) => a.title.includes('小明')), '缴费逾期预警（未缴且有未来课程）')
  await call(`window.api.logout()`)

  // ---------- 助教流程 ----------
  console.log('\n[5] 助教：只读 / 课程记录 / 短信')
  assert((await call<{ success: boolean }>(`window.api.login('assistant', 'assistant123')`)).success === true, '助教 assistant123 登录')
  const astCourses = await call<{ fee: number }[]>(`window.api.getCourses()`)
  assert(astCourses.every((c) => c.fee === 0), '助教端课程费用字段不可见')
  await assertRejected(`window.api.markAllPresent(${instanceId})`, '助教写考勤被拒绝（只读）')
  await assertRejected(`window.api.getDashboard('${today.slice(0, 7)}')`, '助教访问财务数据被拒绝')

  const note = await call<{ id: number }>(
    `window.api.saveLessonNote({ scheduleInstanceId: ${instanceId}, knowledgePoints: '函数单调性,导数应用', classPerformance: '整体良好', homework: '练习册P45-46', summary: '完成新课讲解' })`
  )
  assert(note.id > 0, '保存课程内容记录')
  const noteBack = await call<{ knowledgePoints: string }>(`window.api.getLessonNote(${instanceId})`)
  assert(noteBack.knowledgePoints === '函数单调性,导数应用', '读取课程内容记录')
  const notes = await call<{ length: number }[]>(`window.api.listLessonNotes()`)
  assert(notes.length === 1, '课程记录列表')

  // 未配置大模型：短信生成报错且不保存
  const smsErr = await call<string>(
    `window.api.generateSms(${note.id}).then(() => 'OK').catch((e) => 'err: ' + String(e.message))`
  )
  assert(smsErr.startsWith('err') && smsErr.includes('未配置大模型'), '未配置 API 时短信生成报错')
  assert((await call<unknown[]>(`window.api.listMessages()`)).length === 0, '生成失败不写入历史')

  // 保存助教 API 配置后：请求必然失败（假地址），验证错误链路与不保存
  await call(
    `window.api.saveSettings({ role: 'assistant', apiUrl: 'http://127.0.0.1:9/v1', apiKey: 'test-key' })`
  )
  const smsNetErr = await call<string>(
    `window.api.generateSms(${note.id}).then(() => 'OK').catch((e) => 'err: ' + String(e.message))`
  )
  assert(smsNetErr.startsWith('err'), 'API 请求失败时抛出错误')
  assert((await call<unknown[]>(`window.api.listMessages()`)).length === 0, '失败不写入历史')

  // ---------- 设置与密码 ----------
  console.log('\n[6] 设置 / 密码修改 / Excel / 备份文件')
  const change = await call<{ success: boolean }>(`window.api.changePassword('assistant123', 'test123456')`)
  assert(change.success, '助教修改密码')
  assert((await call<{ success: boolean }>(`window.api.login('assistant', 'assistant123')`)).success === false, '旧密码失效')
  assert((await call<{ success: boolean }>(`window.api.login('assistant', 'test123456')`)).success === true, '新密码生效')
  await call(`window.api.changePassword('test123456', '${INITIAL_PASSWORDS.assistant}')`)

  const wb = await buildWorkbook('考勤记录', [{ header: '姓名', key: 'name' }], [{ name: '小明' }])
  const tmpXlsx = path.join(os.tmpdir(), 'vlearn-smoke-export.xlsx')
  await wb.xlsx.writeFile(tmpXlsx)
  assert(fs.existsSync(tmpXlsx), 'Excel 工作簿生成')
  fs.rmSync(tmpXlsx, { force: true })

  // 版本号
  const version = await call<string>(`window.api.getAppVersion()`)
  assert(!!version && version !== '0.0.0', '应用版本号可读')

  win.destroy()

  console.log('\n----------------------------------------')
  if (failures.length > 0) {
    console.log(`冒烟测试失败 ${failures.length} 项：`)
    failures.forEach((f) => console.log(`  - ${f}`))
    throw new Error(`冒烟测试失败：${failures.length} 项`)
  }
  console.log('冒烟测试全部通过 ✓')
}

// ---------------------------------------------------------------------------
// UI 冒烟测试
// ---------------------------------------------------------------------------

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
    if (level >= 2) consoleErrors.push(message)
  })
  await win.loadFile(join(__dirname, '../renderer/index.html'))
  await new Promise((resolve) => setTimeout(resolve, 2500))

  const shotDir = process.env.VLEARN_SHOT_DIR
  const shot = async (name: string): Promise<void> => {
    if (!shotDir) return
    fs.mkdirSync(shotDir, { recursive: true })
    win.show()
    await new Promise((resolve) => setTimeout(resolve, 900))
    const img = await win.webContents.capturePage()
    fs.writeFileSync(path.join(shotDir, name), img.toPNG())
    console.log(`  已截图：${name}`)
  }
  const wait = (ms = 1200): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

  // 1) 登录页
  const loginCheck = await win.webContents.executeJavaScript(
    `({ hasAcademic: document.body.innerText.includes('教务登录'), hasFinance: document.body.innerText.includes('财务登录'), hasAssistant: document.body.innerText.includes('助教登录') })`
  )
  assert(loginCheck.hasAcademic && loginCheck.hasFinance && loginCheck.hasAssistant, '角色选择页渲染（教务/财务/助教三入口）')
  await shot('01-角色登录页.png')

  /** 以某角色登录并重新加载渲染进程 */
  const loginAs = async (role: Role): Promise<void> => {
    await win.webContents.executeJavaScript(`window.api.login('${role}', '${INITIAL_PASSWORDS[role]}')`)
    win.webContents.reload()
    await wait(2500)
  }
  /** 点击左侧菜单项 */
  const clickMenu = async (label: string): Promise<void> => {
    await win.webContents.executeJavaScript(
      `document.querySelectorAll('.ant-menu-item').forEach((el) => { if (el.textContent.trim().includes('${label}')) el.click() })`
    )
    await wait(1200)
  }

  // 2) 教务主界面
  await loginAs('academic')
  const acaCheck = await win.webContents.executeJavaScript(
    `({ hasMenu: document.body.innerText.includes('课程日历') && document.body.innerText.includes('报告中心'), hasRole: document.body.innerText.includes('教务端'), hasAgent: document.body.innerText.includes('教务助手') })`
  )
  assert(acaCheck.hasMenu && acaCheck.hasRole && acaCheck.hasAgent, '教务主界面（菜单 + 角色标识 + 助手面板）')
  await shot('02-教务-课程日历.png')
  await clickMenu('学生管理')
  await shot('03-教务-学生管理.png')
  await clickMenu('系统设置')
  await shot('04-教务-系统设置.png')

  // 3) 财务主界面
  await loginAs('finance')
  const finCheck = await win.webContents.executeJavaScript(
    `({ hasMenu: document.body.innerText.includes('仪表盘') && document.body.innerText.includes('盈亏报表'), hasRole: document.body.innerText.includes('财务端') })`
  )
  assert(finCheck.hasMenu && finCheck.hasRole, '财务主界面（菜单 + 角色标识）')
  await shot('05-财务-仪表盘.png')

  // 4) 助教主界面
  await loginAs('assistant')
  const astCheck = await win.webContents.executeJavaScript(
    `({ hasMenu: document.body.innerText.includes('课程内容记录') && document.body.innerText.includes('历史消息'), hasRole: document.body.innerText.includes('助教端') })`
  )
  assert(astCheck.hasMenu && astCheck.hasRole, '助教主界面（菜单 + 角色标识）')
  await clickMenu('课程内容记录')
  await shot('06-助教-课程内容记录.png')

  const realErrors = consoleErrors.filter((m) => !m.includes('DevTools'))
  assert(realErrors.length === 0, `无渲染进程错误${realErrors.length > 0 ? '：' + realErrors.join(' | ') : ''}`)
  win.destroy()

  console.log('\n----------------------------------------')
  if (failures.length > 0) {
    console.log(`UI 冒烟测试失败 ${failures.length} 项`)
    failures.forEach((f) => console.log(`  - ${f}`))
    throw new Error(`UI 冒烟测试失败：${failures.length} 项`)
  }
  console.log('UI 冒烟测试全部通过 ✓')
}
