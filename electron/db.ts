/**
 * SQLite 数据库初始化与管理。
 * 使用 better-sqlite3 在主进程中同步操作数据库，所有读写经 IPC 暴露给渲染进程。
 */
import Database from 'better-sqlite3'
import { app } from 'electron'
import crypto from 'node:crypto'
import path from 'node:path'

let db: Database.Database | null = null

/** 当前数据库文件路径（未初始化时返回 null） */
let dbFilePath: string | null = null

/** 获取数据库连接（必须先调用 initDb） */
export function getDb(): Database.Database {
  if (!db) throw new Error('数据库尚未初始化')
  return db
}

/** 获取数据库文件路径 */
export function getDbPath(): string {
  if (!dbFilePath) throw new Error('数据库尚未初始化')
  return dbFilePath
}

/** SHA-256 哈希（用于财务密码） */
export function sha256(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * 初始化数据库：建表 + 写入默认设置。
 * @param customPath 可选，冒烟测试时指向临时文件；默认位于 userData/vlearn.db
 */
export function initDb(customPath?: string): void {
  const filePath = customPath ?? path.join(app.getPath('userData'), 'vlearn.db')
  dbFilePath = filePath
  db = new Database(filePath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  migrate(db)
  seedDefaults(db)
}

/** 关闭数据库连接（恢复备份前需要） */
export function closeDb(): void {
  if (db) {
    db.close()
    db = null
  }
}

/** 建表（幂等） */
function migrate(database: Database.Database): void {
  database.exec(`
    -- 课程基础信息
    CREATE TABLE IF NOT EXISTS courses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject TEXT NOT NULL,
      grade TEXT NOT NULL,
      class_name TEXT NOT NULL,
      default_teacher_id INTEGER,
      default_schedule_rule TEXT,   -- JSON 数组，如 [{"weekday":2,"start":"15:00","end":"17:00"}]
      fee REAL DEFAULT 0,           -- 课程费用，仅财务可见
      pay_per_session REAL DEFAULT 0, -- 单次课酬标准，仅财务可见
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (default_teacher_id) REFERENCES teachers(id) ON DELETE SET NULL
    );

    -- 老师
    CREATE TABLE IF NOT EXISTS teachers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      note TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- 老师-课程关联（多对多）
    CREATE TABLE IF NOT EXISTS teacher_courses (
      teacher_id INTEGER NOT NULL,
      course_id INTEGER NOT NULL,
      PRIMARY KEY (teacher_id, course_id),
      FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE CASCADE,
      FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE
    );

    -- 学生
    CREATE TABLE IF NOT EXISTS students (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      school_class TEXT,
      note TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- 学生-课程关联（多对多）
    CREATE TABLE IF NOT EXISTS student_courses (
      student_id INTEGER NOT NULL,
      course_id INTEGER NOT NULL,
      PRIMARY KEY (student_id, course_id),
      FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
      FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE
    );

    -- 课程实例（排课）
    CREATE TABLE IF NOT EXISTS schedule_instances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      course_id INTEGER NOT NULL,
      date TEXT NOT NULL,            -- YYYY-MM-DD
      start_time TEXT NOT NULL,      -- HH:MM
      end_time TEXT NOT NULL,        -- HH:MM
      actual_teacher_id INTEGER,     -- 可空，代课老师
      status TEXT DEFAULT 'normal',  -- normal / adjusted / cancelled
      note TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE,
      FOREIGN KEY (actual_teacher_id) REFERENCES teachers(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_instances_date ON schedule_instances(date);
    CREATE INDEX IF NOT EXISTS idx_instances_course ON schedule_instances(course_id);

    -- 考勤记录
    CREATE TABLE IF NOT EXISTS attendances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      schedule_instance_id INTEGER NOT NULL,
      student_id INTEGER NOT NULL,
      status TEXT NOT NULL,          -- present / leave / absent
      note TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(schedule_instance_id, student_id),
      FOREIGN KEY (schedule_instance_id) REFERENCES schedule_instances(id) ON DELETE CASCADE,
      FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
    );

    -- 学生缴费记录
    CREATE TABLE IF NOT EXISTS student_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER NOT NULL,
      course_id INTEGER NOT NULL,
      amount_due REAL NOT NULL,      -- 应缴
      amount_paid REAL NOT NULL,     -- 实缴
      payment_method TEXT NOT NULL,  -- 微信/转账/现金/自定义
      payment_date TEXT NOT NULL,    -- YYYY-MM-DD
      note TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
      FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_student_payments_date ON student_payments(payment_date);

    -- 老师课酬支付记录
    CREATE TABLE IF NOT EXISTS teacher_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      teacher_id INTEGER NOT NULL,
      schedule_instance_id INTEGER NOT NULL,
      amount_due REAL NOT NULL,      -- 应付
      amount_paid REAL NOT NULL,     -- 实付
      payment_date TEXT NOT NULL,
      note TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE CASCADE,
      FOREIGN KEY (schedule_instance_id) REFERENCES schedule_instances(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_teacher_payments_date ON teacher_payments(payment_date);

    -- 系统设置（键值对）
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `)
}

/** 默认设置：年级、缴费方式、财务密码（admin123）、排课周数、缺勤收费规则 */
function seedDefaults(database: Database.Database): void {
  const defaults: Record<string, string> = {
    grades: JSON.stringify(['高一', '高二', '高三']),
    payment_methods: JSON.stringify(['微信', '转账', '现金']),
    finance_password_hash: sha256('admin123'),
    schedule_weeks: '8',
    charge_absent: '1'
  }
  const insert = database.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)')
  const tx = database.transaction(() => {
    for (const [key, value] of Object.entries(defaults)) insert.run(key, value)
  })
  tx()
}

/** 读取一个设置项，返回原始字符串；不存在返回 null */
export function getSetting(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row?.value ?? null
}

/** 写入设置项 */
export function setSetting(key: string, value: string): void {
  getDb()
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value)
}
