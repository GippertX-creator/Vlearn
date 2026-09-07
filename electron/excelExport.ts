/**
 * Excel 导出：在主进程使用 exceljs 生成工作簿。
 * 文件保存对话框与写文件在 IPC 处理器中完成，此处只负责构建工作簿，便于复用与测试。
 */
import ExcelJS from 'exceljs'

/** 导出模块名与日期拼接文件名：Vlearn_{模块名}_{yyyy-MM-dd}.xlsx */
export function exportFileName(module: string, date: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const d = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  return `Vlearn_${module}_${d}.xlsx`
}

/**
 * 构建一个包含表头样式与数据的工作簿。
 * @param module 模块名（用作工作表名）
 * @param columns 列定义（header 表头，key 取值字段）
 * @param rows 数据行
 */
export async function buildWorkbook(
  module: string,
  columns: { header: string; key: string }[],
  rows: Record<string, unknown>[]
): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'Vlearn'
  const sheet = workbook.addWorksheet(module.slice(0, 30) || 'Sheet1')

  // 设置列：表头 + 列宽（按内容长度自适应，限制在 12~32 字符）
  sheet.columns = columns.map((col) => {
    const contentMax = rows.reduce((max, row) => {
      const text = row[col.key] === null || row[col.key] === undefined ? '' : String(row[col.key])
      return Math.max(max, text.length)
    }, col.header.length)
    const width = Math.min(32, Math.max(12, contentMax * 2 + 4))
    return { header: col.header, key: col.key, width }
  })

  // 表头样式
  const headerRow = sheet.getRow(1)
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } }
  headerRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF4472C4' }
  }
  headerRow.alignment = { horizontal: 'center', vertical: 'middle' }
  headerRow.height = 22

  // 数据行
  for (const row of rows) {
    sheet.addRow(columns.map((col) => row[col.key] ?? ''))
  }
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: Math.max(1, sheet.rowCount), column: columns.length }
  }

  return workbook
}
