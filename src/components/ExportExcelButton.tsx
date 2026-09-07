/**
 * 通用"导出 Excel"按钮：调用主进程导出（保存对话框 + exceljs 写入）。
 * 导出内容由调用方传入（与当前列表筛选结果一致），文件名规则 Vlearn_{模块名}_{日期}.xlsx。
 */
import { DownloadOutlined } from '@ant-design/icons'
import { Button, App } from 'antd'
import { api, getErrorMessage } from '../api'

interface ExportExcelButtonProps {
  /** 模块名，用于文件命名，如 "学生管理" */
  module: string
  columns: { header: string; key: string }[]
  /** 导出数据行（调用方已按当前筛选结果准备好） */
  rows: Record<string, unknown>[]
  /** 禁用（如无数据时） */
  disabled?: boolean
}

export default function ExportExcelButton({ module, columns, rows, disabled }: ExportExcelButtonProps): JSX.Element {
  const { message } = App.useApp()

  const handleExport = async (): Promise<void> => {
    try {
      const result = await api.exportExcel({ module, columns, rows })
      if (result.canceled) return
      if (result.success) {
        message.success(`已导出：${result.path}`)
      } else {
        message.error('导出失败')
      }
    } catch (err) {
      message.error(`导出失败：${getErrorMessage(err)}`)
    }
  }

  return (
    <Button icon={<DownloadOutlined />} onClick={handleExport} disabled={disabled}>
      导出 Excel
    </Button>
  )
}
