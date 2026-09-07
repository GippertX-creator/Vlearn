/**
 * 盈亏报表（仅财务可见页面）：
 * - 按年份展示月度收支：收入（学生实缴） / 支出（老师实付） / 净盈亏
 * - 净盈亏 >= 0 显示绿色（+ 前缀），< 0 显示红色；"合计"行整行加粗
 * - 支持导出 Excel（module="盈亏报表"，含"合计"行）
 */
import { App as AntdApp, DatePicker, Table, Typography } from 'antd'
import dayjs, { Dayjs } from 'dayjs'
import { useCallback, useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import { api, getErrorMessage } from '../api'
import ExportExcelButton from '../components/ExportExcelButton'
import PageToolbar from '../components/PageToolbar'
import type { MonthReportRow } from '../types'

/** 金额展示：四舍五入到分后以 ¥ 前缀展示 */
const fmtMoney = (v: number): string => `¥${(Math.round(v * 100) / 100).toFixed(2)}`

/** 净盈亏带正负号展示：+¥100.00 / ¥-100.00 */
const fmtSigned = (v: number): string => `${v >= 0 ? '+' : ''}${fmtMoney(v)}`

/** 合计行的行样式：整行加粗 */
const totalRowStyle: CSSProperties = { fontWeight: 600 }

export default function ReportsPage(): JSX.Element {
  const { message } = AntdApp.useApp()
  const [year, setYear] = useState<Dayjs>(() => dayjs())
  const [rows, setRows] = useState<MonthReportRow[]>([])
  const [loading, setLoading] = useState(false)

  const load = useCallback(
    async (yearNum: number): Promise<void> => {
      setLoading(true)
      try {
        const data = await api.getMonthlyReport(yearNum)
        setRows(data)
      } catch (err) {
        message.error(getErrorMessage(err))
      } finally {
        setLoading(false)
      }
    },
    [message]
  )

  useEffect(() => {
    void load(year.year())
  }, [load, year])

  const handleYearChange = (y: Dayjs | null): void => {
    if (!y) return
    setYear(y)
  }

  const columns = [
    {
      title: '月份',
      dataIndex: 'month',
      key: 'month',
      width: 180,
      render: (v: string) => (v === '合计' ? <Typography.Text strong>合计</Typography.Text> : v),
      onCell: (row: MonthReportRow) => ({ style: row.month === '合计' ? totalRowStyle : undefined })
    },
    {
      title: '收入（实缴）',
      dataIndex: 'income',
      key: 'income',
      width: 180,
      align: 'right' as const,
      render: (v: number, row: MonthReportRow) => (
        <span style={row.month === '合计' ? totalRowStyle : undefined}>{fmtMoney(v)}</span>
      )
    },
    {
      title: '支出（实付）',
      dataIndex: 'expense',
      key: 'expense',
      width: 180,
      align: 'right' as const,
      render: (v: number, row: MonthReportRow) => (
        <span style={row.month === '合计' ? totalRowStyle : undefined}>{fmtMoney(v)}</span>
      )
    },
    {
      title: '净盈亏',
      dataIndex: 'profit',
      key: 'profit',
      width: 180,
      align: 'right' as const,
      render: (v: number, row: MonthReportRow) => (
        <span
          style={{
            ...(row.month === '合计' ? totalRowStyle : undefined),
            color: v >= 0 ? '#3f8600' : '#cf1322',
            fontWeight: 500
          }}
        >
          {fmtSigned(v)}
        </span>
      )
    }
  ]

  const exportRows = rows.map((r) => ({
    月份: r.month,
    '收入（实缴）': r.income,
    '支出（实付）': r.expense,
    净盈亏: r.profit
  }))

  return (
    <div>
      <PageToolbar
        title="盈亏报表"
        actions={
          <>
            <DatePicker
              picker="year"
              allowClear={false}
              value={year}
              onChange={handleYearChange}
              placeholder="选择年份"
            />
            <ExportExcelButton
              module="盈亏报表"
              columns={[
                { header: '月份', key: '月份' },
                { header: '收入（实缴）', key: '收入（实缴）' },
                { header: '支出（实付）', key: '支出（实付）' },
                { header: '净盈亏', key: '净盈亏' }
              ]}
              rows={exportRows}
              disabled={rows.length === 0}
            />
          </>
        }
      />

      <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
        收入 = 学生实缴金额合计；支出 = 老师实付金额合计；净盈亏 = 收入 - 支出。
      </Typography.Paragraph>

      <Table
        rowKey="month"
        loading={loading}
        columns={columns}
        dataSource={rows}
        pagination={false}
        bordered
      />
    </div>
  )
}
