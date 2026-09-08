/**
 * 盈亏报表（仅财务可见页面）：
 * - 按年份展示月度收支：收入（学生实缴） / 支出（老师实付） / 净盈亏
 * - 净盈亏 >= 0 显示绿色（+ 前缀），< 0 显示红色；"合计"行整行加粗
 * - 支持导出 Excel（module="盈亏报表"，含"合计"行）
 * - "AI 趋势分析"：调用 trendAnalysis()（已配大模型时由 AI 生成，否则用系统模板），
 *   弹窗展示正文，支持复制与导出 Excel（module="盈亏趋势分析"）
 */
import { CopyOutlined, RiseOutlined } from '@ant-design/icons'
import {
  App as AntdApp,
  Button,
  DatePicker,
  Modal,
  Space,
  Table,
  Tag,
  Typography
} from 'antd'
import dayjs, { Dayjs } from 'dayjs'
import { useCallback, useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import { api, getErrorMessage } from '../api'
import ExportExcelButton from '../components/ExportExcelButton'
import PageToolbar from '../components/PageToolbar'
import type { GeneratedContent, MonthReportRow } from '../types'

/** 金额展示：四舍五入到分后以 ¥ 前缀展示 */
const fmtMoney = (v: number): string => `¥${(Math.round(v * 100) / 100).toFixed(2)}`

/** 净盈亏带正负号展示：+¥100.00 / ¥-100.00 */
const fmtSigned = (v: number): string => `${v >= 0 ? '+' : ''}${fmtMoney(v)}`

/** 合计行的行样式：整行加粗 */
const totalRowStyle: CSSProperties = { fontWeight: 600 }

/** 趋势分析导出用列（单行报告，module="盈亏趋势分析"） */
const trendExportColumns = [{ header: '报告内容', key: '报告内容' }]

export default function ReportsPage(): JSX.Element {
  const { message } = AntdApp.useApp()
  const [year, setYear] = useState<Dayjs>(() => dayjs())
  const [rows, setRows] = useState<MonthReportRow[]>([])
  const [loading, setLoading] = useState(false)
  /** AI 趋势分析弹窗状态 */
  const [trendOpen, setTrendOpen] = useState(false)
  const [trendLoading, setTrendLoading] = useState(false)
  const [trend, setTrend] = useState<GeneratedContent | null>(null)

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

  /** AI 趋势分析：大模型生成（未配置时回退系统模板） */
  const handleTrendAnalysis = async (): Promise<void> => {
    setTrendLoading(true)
    try {
      const content = await api.trendAnalysis()
      setTrend(content)
      setTrendOpen(true)
    } catch (err) {
      message.error(getErrorMessage(err))
    } finally {
      setTrendLoading(false)
    }
  }

  /** 复制分析正文到剪贴板 */
  const handleCopy = async (content: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(content)
      message.success('已复制到剪贴板')
    } catch {
      message.error('复制失败，请手动复制')
    }
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
          <Space>
            <DatePicker
              picker="year"
              allowClear={false}
              value={year}
              onChange={handleYearChange}
              placeholder="选择年份"
            />
            <Button icon={<RiseOutlined />} loading={trendLoading} onClick={() => void handleTrendAnalysis()}>
              AI 趋势分析
            </Button>
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
          </Space>
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

      {/* AI 趋势分析结果弹窗 */}
      <Modal
        open={trendOpen && trend !== null}
        title="AI 趋势分析"
        width={720}
        onCancel={() => setTrendOpen(false)}
        footer={
          trend ? (
            <Space>
              <Button icon={<CopyOutlined />} onClick={() => void handleCopy(trend.content)}>
                复制内容
              </Button>
              <ExportExcelButton
                module="盈亏趋势分析"
                columns={trendExportColumns}
                rows={[{ 报告内容: trend.content }]}
              />
              <Button type="primary" onClick={() => setTrendOpen(false)}>
                关闭
              </Button>
            </Space>
          ) : null
        }
      >
        {trend && (
          <>
            {trend.usedAi ? <Tag color="green">AI 生成</Tag> : <Tag color="blue">系统模板</Tag>}
            <div style={{ whiteSpace: 'pre-wrap', marginTop: 12, lineHeight: 1.8 }}>{trend.content}</div>
          </>
        )}
      </Modal>
    </div>
  )
}
