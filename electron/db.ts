/**
 * SQLite 数据库层：三种角色分别使用独立的物理数据库文件，实现数据隔离。
 *
 *   vlearn_academic.db   教务数据（课程/老师/学生/排课/考勤 + 教务设置）
 *   vlearn_finance.db    财务数据（学生缴费/老师课酬 + 财务设置）
 *   vlearn_assistant.db  助教数据（课程内容记录/生成短信 + 助教设置）
 *
 * 数据库文件位于 userData 目录。旧版单库（vlearn.db）会在首次启动时自动迁移：
 * 原表按域拆分复制到三个新库，成功后旧文件重命名备份（不删除）。
 */
import Database from 'better-sqlite3'
import { app } from 'electron'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** 角色标识 */
export type Role = 'academic' | 'finance' | 'assistant'

/** 各角色的数据库文件名 */
export const DB_FILES: Record<Role, string> = {
  academic: 'vlearn_academic.db',
  finance: 'vlearn_finance.db',
  assistant: 'vlearn_assistant.db'
}

/** 旧版单库文件名 */
const LEGACY_DB_FILE = 'vlearn.db'

/** 各角色初始密码 */
export const INITIAL_PASSWORDS: Record<Role, string> = {
  academic: 'admin123',
  finance: 'admin123',
  assistant: 'assistant123'
}

/** 角色数据库连接 */
const dbs: Partial<Record<Role, Database.Database>> = {}

/** 数据库目录（userData 或测试临时目录） */
let dbDir = ''

/** 迁移过程错误（供登录页展示） */
let migrationError: string | null = null

/** 获取指定角色的数据库连接 */
export function getDb(role: Role): Database.Database {
  const db = dbs[role]
  if (!db) throw new Error(`数据库未初始化：${role}`)
  return db
}

/** 获取指定角色的数据库文件路径 */
export function getDbPath(role: Role): string {
  return path.join(dbDir, DB_FILES[role])
}

/** 迁移错误（若有），供渲染层在登录页提示 */
export function getMigrationError(): string | null {
  return migrationError
}

/** SHA-256 哈希（角色密码） */
export function sha256(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * 初始化三个角色数据库（幂等）。
 * @param customDir 自定义目录（冒烟测试用临时目录），默认 userData
 */
export function initDatabases(customDir?: string): void {
  dbDir = customDir ?? app.getPath('userData')

  // 旧版单库迁移：仅在旧库存在且新库尚未建立时执行
  const legacyPath = path.join(dbDir, LEGACY_DB_FILE)
  if (fs.existsSync(legacyPath) && !fs.existsSync(getDbPath('academic'))) {
    try {
      migrateLegacyDb(legacyPath)
    } catch (err) {
      // 迁移失败：不删除旧库，记录错误；新库若已部分创建则删除，下次启动重试
      migrationError = `数据迁移失败：${(err as Error).message}。旧数据已原样保留，请勿删除，可联系技术支持。`
      closeAll()
      for (const role of Object.keys(DB_FILES) as Role[]) {
        const p = getDbPath(role)
        if (fs.existsSync(p)) {
          try {
            fs.rmSync(p)
            for (const suffix of ['-wal', '-shm']) if (fs.existsSync(p + suffix)) fs.rmSync(p + suffix)
          } catch {
            /* 忽略清理失败 */
          }
        }
      }
      return
    }
  }

  for (const role of Object.keys(DB_FILES) as Role[]) {
    openRoleDb(role)
  }
  seedRoleDefaults()
}

/** 打开（或创建）单个角色数据库并建表 */
function openRoleDb(role: Role): void {
  const filePath = getDbPath(role)
  const db = new Database(filePath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  migrateSchema(role, db)
  dbs[role] = db
}

/** 各角色数据库建表（幂等） */
function migrateSchema(role: Role, db: Database.Database): void {
  if (role === 'academic') {
    db.exec(`
      CREATE TABLE IF NOT EXISTS courses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        subject TEXT NOT NULL,
        grade TEXT NOT NULL,
        class_name TEXT NOT NULL,
        default_teacher_id INTEGER,
        default_schedule_rule TEXT,
        fee REAL DEFAULT 0,           -- 课程费用（财务可读写，其余角色不可见）
        pay_per_session REAL DEFAULT 0, -- 单次课酬标准（财务可读写）
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (default_teacher_id) REFERENCES teachers(id) ON DELETE SET NULL
      );
      CREATE TABLE IF NOT EXISTS teachers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        note TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS teacher_courses (
        teacher_id INTEGER NOT NULL,
        course_id INTEGER NOT NULL,
        PRIMARY KEY (teacher_id, course_id),
        FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE CASCADE,
        FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS students (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        school_class TEXT,
        note TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS student_courses (
        student_id INTEGER NOT NULL,
        course_id INTEGER NOT NULL,
        PRIMARY KEY (student_id, course_id),
        FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
        FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS schedule_instances (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        course_id INTEGER NOT NULL,
        date TEXT NOT NULL,
        start_time TEXT NOT NULL,
        end_time TEXT NOT NULL,
        actual_teacher_id INTEGER,
        status TEXT DEFAULT 'normal',
        note TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE,
        FOREIGN KEY (actual_teacher_id) REFERENCES teachers(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_instances_date ON schedule_instances(date);
      CREATE INDEX IF NOT EXISTS idx_instances_course ON schedule_instances(course_id);
      CREATE TABLE IF NOT EXISTS attendances (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        schedule_instance_id INTEGER NOT NULL,
        student_id INTEGER NOT NULL,
        status TEXT NOT NULL,
        note TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(schedule_instance_id, student_id),
        FOREIGN KEY (schedule_instance_id) REFERENCES schedule_instances(id) ON DELETE CASCADE,
        FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
    `)
  } else if (role === 'finance') {
    db.exec(`
      -- 财务库不再声明指向教务库的外键（SQLite 外键无法跨库），
      -- 引用完整性由主进程在跨库操作（如删除课程/学生/老师）时维护
      CREATE TABLE IF NOT EXISTS student_payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        student_id INTEGER NOT NULL,
        course_id INTEGER NOT NULL,
        amount_due REAL NOT NULL,
        amount_paid REAL NOT NULL,
        payment_method TEXT NOT NULL,
        payment_date TEXT NOT NULL,
        note TEXT,
        edits_count INTEGER DEFAULT 0,   -- 修改次数（异常交易检测用）
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_student_payments_date ON student_payments(payment_date);
      CREATE TABLE IF NOT EXISTS teacher_payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        teacher_id INTEGER NOT NULL,
        schedule_instance_id INTEGER NOT NULL,
        amount_due REAL NOT NULL,
        amount_paid REAL NOT NULL,
        payment_date TEXT NOT NULL,
        note TEXT,
        edits_count INTEGER DEFAULT 0,   -- 修改次数（异常交易检测用）
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_teacher_payments_date ON teacher_payments(payment_date);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
    `)
  } else {
    db.exec(`
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
      -- 课程内容记录（每次课后填写；schedule_instance_id 关联教务库课程实例）
      CREATE TABLE IF NOT EXISTS lesson_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        schedule_instance_id INTEGER NOT NULL,
        knowledge_points TEXT,
        class_performance TEXT,
        homework TEXT,
        summary TEXT,
        homework_grading TEXT DEFAULT '未开发，敬请期待',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
      -- 生成的微信群短信缓存
      CREATE TABLE IF NOT EXISTS generated_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        lesson_note_id INTEGER NOT NULL,
        message_content TEXT NOT NULL,
        generated_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (lesson_note_id) REFERENCES lesson_notes(id) ON DELETE CASCADE
      );
    `)
  }
}

/** 写入各角色默认设置（已存在则跳过） */
function seedRoleDefaults(): void {
  const academicDefaults: Record<string, string> = {
    password_hash: sha256(INITIAL_PASSWORDS.academic),
    grades: JSON.stringify(['高一', '高二', '高三']),
    schedule_weeks: '8',
    // 教务 Agent 配置（默认开启，未配置 API 时仅本地规则生效）
    agent_conflict_detect: '1',
    agent_attendance_alert: '1',
    agent_attendance_threshold: '3',
    agent_completeness_hint: '1',
    ai_api_url: '',
    ai_api_key: ''
  }
  const financeDefaults: Record<string, string> = {
    password_hash: sha256(INITIAL_PASSWORDS.finance),
    payment_methods: JSON.stringify(['微信', '转账', '现金']),
    charge_absent: '1',
    // 财务 Agent 配置
    agent_overdue_alert: '1',
    agent_overdue_days: '7',
    agent_anomaly_detect: '1',
    agent_anomaly_multiplier: '3',
    ai_api_url: '',
    ai_api_key: ''
  }
  const assistantDefaults: Record<string, string> = {
    password_hash: sha256(INITIAL_PASSWORDS.assistant),
    ai_api_url: '',
    ai_api_key: ''
  }
  const seeds: Record<Role, Record<string, string>> = {
    academic: academicDefaults,
    finance: financeDefaults,
    assistant: assistantDefaults
  }
  for (const role of Object.keys(seeds) as Role[]) {
    const insert = getDb(role).prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)')
    const tx = getDb(role).transaction(() => {
      for (const [k, v] of Object.entries(seeds[role])) insert.run(k, v)
    })
    tx()
  }
}

/**
 * 旧版单库迁移：把 vlearn.db 的表按域复制到三个新库。
 * 成功后旧库重命名为 vlearn.db.migrated-<时间戳>（保留备份），并写迁移日志。
 */
function migrateLegacyDb(legacyPath: string): void {
  const log: string[] = []
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  log.push(`[${new Date().toLocaleString()}] 开始迁移旧数据库：${legacyPath}`)

  const legacy = new Database(legacyPath, { readonly: true })
  try {
    const tables = (
      legacy.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all() as {
        name: string
      }[]
    ).map((r) => r.name)

    // 1) 先建好三个新库（含新表结构）
    for (const role of Object.keys(DB_FILES) as Role[]) openRoleDb(role)

    // 2) 按域复制表。目标表名一致时整表复制；不存在的目标表跳过。
    //    注意顺序：父表必须先于子表（外键约束：teachers 先于 courses，courses 先于关联/实例）
    const academicTables = ['teachers', 'courses', 'teacher_courses', 'students', 'student_courses', 'schedule_instances', 'attendances', 'settings']
    const financeTables = ['student_payments', 'teacher_payments', 'settings']
    const copy = (destRole: Role, tableNames: string[]): void => {
      const dest = getDb(destRole)
      for (const t of tableNames) {
        if (!tables.includes(t)) continue
        const destHas = dest
          .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
          .get(t)
        if (!destHas) {
          log.push(`  跳过 ${destRole}.${t}（目标库无此表）`)
          continue
        }
        const srcCount = (legacy.prepare(`SELECT COUNT(*) AS c FROM "${t}"`).get() as { c: number }).c
        if (srcCount === 0) {
          log.push(`  ${destRole}.${t}：0 行（空表，跳过）`)
          continue
        }
        // 列取交集，避免新旧结构差异导致复制失败
        const srcCols = (legacy.prepare(`PRAGMA table_info("${t}")`).all() as { name: string }[]).map((c) => c.name)
        const destCols = (dest.prepare(`PRAGMA table_info("${t}")`).all() as { name: string }[]).map((c) => c.name)
        const cols = srcCols.filter((c) => destCols.includes(c))
        if (cols.length === 0) {
          log.push(`  跳过 ${destRole}.${t}（无共同列）`)
          continue
        }
        const colList = cols.map((c) => `"${c}"`).join(', ')
        dest.prepare(`INSERT INTO "${t}" (${colList}) SELECT ${colList} FROM legacy."${t}"`).run()
        const destCount = (dest.prepare(`SELECT COUNT(*) AS c FROM "${t}"`).get() as { c: number }).c
        log.push(`  ${destRole}.${t}：${srcCount} 行 → 已复制 ${destCount} 行`)
        if (srcCount !== destCount) throw new Error(`${destRole}.${t} 复制行数不一致（${srcCount} → ${destCount}）`)
      }
    }
    // ATTACH 旧库后可直接跨库复制
    // 迁移期间临时关闭目标库外键检查（防御旧库中可能存在的孤立引用），复制完成后再恢复
    for (const role of Object.keys(dbs) as Role[]) {
      getDb(role).prepare(`ATTACH DATABASE ? AS legacy`).run(legacyPath)
      getDb(role).pragma('foreign_keys = OFF')
    }
    copy('academic', academicTables)
    copy('finance', financeTables)
    for (const role of Object.keys(dbs) as Role[]) {
      getDb(role).prepare('DETACH DATABASE legacy').run()
      getDb(role).pragma('foreign_keys = ON')
    }
  } catch (err) {
    log.push(`  ✗ 迁移失败：${(err as Error).message}`)
    writeMigrationLog(log)
    throw err
  } finally {
    legacy.close()
  }

  // 3) 角色密码：财务沿用旧密码哈希；教务/助教为初始密码（旧版无独立教务密码）
  const financeHash = getSettingValue('finance', 'finance_password_hash')
  if (financeHash) {
    getDb('finance').prepare('UPDATE settings SET value = ? WHERE key = ?').run(financeHash, 'password_hash')
  }
  // 旧 settings 已复制到 academic/finance，补充默认键由 seedRoleDefaults 兜底

  // 4) 重命名旧库备份 + 写日志
  const backupPath = path.join(dbDir, `${LEGACY_DB_FILE}.migrated-${stamp}`)
  fs.renameSync(legacyPath, backupPath)
  log.push(`  旧库已备份为：${backupPath}`)
  log.push('迁移完成 ✓')
  writeMigrationLog(log)
}

/** 读取指定角色库的 setting 原始值 */
export function getSettingValue(role: Role, key: string): string | null {
  const row = getDb(role).prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row?.value ?? null
}

/** 写入指定角色库的 setting */
export function setSettingValue(role: Role, key: string, value: string): void {
  getDb(role)
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value)
}

/** 迁移日志写文件 */
function writeMigrationLog(log: string[]): void {
  try {
    fs.writeFileSync(path.join(dbDir, 'migration.log'), log.join('\n') + '\n', 'utf8')
  } catch {
    /* 日志失败不影响迁移 */
  }
}

/** 关闭全部角色数据库 */
export function closeAll(): void {
  for (const role of Object.keys(dbs) as Role[]) {
    try {
      dbs[role]?.close()
    } catch {
      /* 忽略 */
    }
    delete dbs[role]
  }
}
