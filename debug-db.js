const { app } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
app.whenReady().then(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vlearn-dbg-'))
  const { initDatabases, getDb } = require('./out/main/index.js')
  initDatabases(dir)
  for (const r of ['academic', 'assistant']) {
    const rows = getDb(r).prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all()
    console.log(r, 'tables:', rows.map((x) => x.name).filter((n) => n.includes('sync')).join(',') || '（无 sync 表）')
    try {
      const cols = getDb('academic').prepare(`PRAGMA table_info(students)`).all().map((c) => c.name)
      console.log('students 列:', cols.join(', '))
    } catch (e) { console.log('err', e.message) }
  }
  app.exit(0)
})
