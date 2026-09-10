/**
 * 经营分析（财务角色·v4）：
 * - 顶部工具栏：粒度切换（月/季/年）+ 日期范围（默认当年 1/1-12/31），变化时联动刷新
 * - 三张图表（@ant-design/plots v2）：
 *   1) 收支盈亏趋势：分组柱状图（收入 / 支出 / 盈亏三系列，y 轴金额 ¥）
 *   2) 收入构成：环形图，可切换数据源（按科目 / 按缴费方式）
 *   3) 支出构成：环形图，可切换数据源（按老师 / 按课程）
 * - 下钻：点击趋势图某柱（onEvent，事件数据含 bucket）→ 下方展示该时间段的收支明细卡片
 *   （学生缴费明细 + 老师课酬明细两张表，顶部小计，可合并导出 Excel）
 * - 空数据显示"暂无数据"占位；数据刷新时保留旧图避免闪烁
 *
 * 图表配色说明：全部取自 dataviz 参考调色板（light 模式、白底卡片），
 * 系列颜色按固定顺序分配（收入=blue / 支出=orange / 盈亏=aqua，顺序即
 * 文档验证顺序的前三槽）；饼图扇区按名称排序后依序取槽位色（实体固定颜色，
 * 数量超过上限时尾部折叠为"其他"灰），避免"按排名染色"导致的幸存者换色。
 */
import { Column, Pie } from '@ant-design/plots'
import type { ColumnConfig, PieConfig } from '@ant-design/plots'
import { CloseOutlined, LineChartOutlined } from '@ant-design/icons'
import { Alert, App as AntdApp, Button, Card, Col, DatePicker, Empty, Row, Segmented, Space, Spin, Statistic, Table, Typography } from 'antd'
import type { TableColumnsType } from 'antd'
import dayjs, { Dayjs } from 'dayjs'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { api, getErrorMessage } from '../api'
import ExportExcelButton from '../components/ExportExcelButton'
import PageToolbar from '../components/PageToolbar'
import type { AnalyticsData, StudentPayment, TeacherPayment } from '../types'

// ---------------------------------------------------------------------------
// 图表视觉常量（dataviz 参考调色板 light 模式，赋值顺序即验证顺序）
// ---------------------------------------------------------------------------

/** 分类色阶：blue / orange / aqua / yellow / magenta / green / violet / red（前 8 槽，勿循环使用） */
const SERIES_PALETTE = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948']

/** 趋势图三系列色：收入 / 支出 / 盈亏（顺序=数据出现顺序，故取调色板前 3 槽） */
const TREND_COLORS = ['#2a78d6', '#eb6834', '#1baf7a']

/** 折叠尾部扇区"其他"的中性灰（非分类槽位色） */
const OTHER_COLOR = '#8c8c8c'

/** 饼图最大扇区数（超出部分折叠进"其他"，保证图例可读） */
const MAX_PIE_SLICES = 8

/** 粒度 */
type Granularity = 'month' | 'quarter' | 'year'

/** 粒度切换选项（Segmented 要求可变数组，故不用 as const） */
const GRANULARITY_OPTIONS: { label: string; value: Granularity }[] = [
  { label: '按月', value: 'month' },
  { label: '按季', value: 'quarter' },
  { label: '按年', value: 'year' }
]

/** 趋势图行列：type 为系列名（收入/支出/盈亏），value 为金额 */
interface TrendRow {
  bucket: string
  type: string
  value: number
}

/** 环形图扇区行 */
interface PieRow {
  name: string
  value: number
}

/** 下钻明细状态 */
interface BucketDetail {
  bucket: string
  loading: boolean
  error: string | null
  studentRows: StudentPayment[]
  teacherRows: TeacherPayment[]
}

/** 收入构成数据源切换 */
type IncomeSource = 'subject' | 'method'
/** 支出构成数据源切换 */
type ExpenseSource = 'teacher' | 'course'

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 金额展示：四舍五入到分后以 ¥ 前缀展示 */
const fmtMoney = (v: number): string => `¥${(Math.round(v * 100) / 100).toFixed(2)}`

/** 金额合计（分位四舍五入后展示用） */
const sumMoney = (rows: { amountPaid: number }[]): number =>
  Math.round(rows.reduce((acc, r) => acc + r.amountPaid, 0) * 100) / 100

/** 趋势图 y 轴刻度格式化：¥ + 千分位整数 */
const fmtYAxis = (v: unknown): string => {
  const n = Number(v)
  if (!Number.isFinite(n)) return String(v ?? '')
  return `¥${Math.round(n).toLocaleString('zh-CN')}`
}

/**
 * 从图表事件中提取 bucket 字符串。
 * G2 element 事件通常携带 data.data（原始数据行）；wrapper 会把所有事件原样转出，
 * 此处做防御性提取，最终以"是否命中当前趋势桶"为准，避免图例/空白区域点击误触。
 */
const extractBucket = (event: unknown): string | null => {
  const e = (event ?? {}) as { data?: unknown }
  const d = e.data
  if (d === null || d === undefined || typeof d !== 'object') return null
  const record = d as Record<string, unknown>
  // event.data 可能是 { data: row } 也可能就是 row 本身
  const row =
    record.data !== null && typeof record.data === 'object'
      ? (record.data as Record<string, unknown>)
      : record
  const b = row.bucket
  return typeof b === 'string' && b.length > 0 ? b : null
}

/**
 * 将趋势桶（月份 'YYYY-MM' / 季度 'YYYY-Qn' / 年份 'YYYY'）翻译为
 * 对缴费日期（YYYY-MM-DD）的匹配谓词。
 */
const makeDateMatcher = (granularity: Granularity, bucket: string): ((date: string) => boolean) => {
  if (granularity === 'month' && /^\d{4}-\d{2}$/.test(bucket)) {
    return (d) => d.startsWith(bucket)
  }
  if (granularity === 'year' && /^\d{4}$/.test(bucket)) {
    return (d) => d.startsWith(bucket)
  }
  const q = /^(\d{4})-Q([1-4])$/.exec(bucket)
  if (granularity === 'quarter' && q) {
    const year = q[1]
    const first = (Number(q[2]) - 1) * 3 + 1
    const months = [0, 1, 2].map((i) => `${year}-${String(first + i).padStart(2, '0')}`)
    return (d) => months.some((m) => d.startsWith(m))
  }
  // 无法解析的桶：不匹配任何记录
  return () => false
}

/** 趋势行：每月（季度/年度）一行，三系列（收入/支出/盈亏） */
const buildTrendRows = (trend: AnalyticsData['trend']): TrendRow[] =>
  trend.flatMap((t) => [
    { bucket: t.bucket, type: '收入', value: Math.round(t.income * 100) / 100 },
    { bucket: t.bucket, type: '支出', value: Math.round(t.expense * 100) / 100 },
    { bucket: t.bucket, type: '盈亏', value: Math.round(t.profit * 100) / 100 }
  ])

/**
 * 准备环形图数据：按名称合并同名项、数量过多时折叠尾部为"其他"，
 * 颜色按"名称排序后的槽位"分配（实体固定颜色，不随金额排名变化），
 * 扇区按金额降序排列（可读性），颜色与排序无关。
 */
const buildPie = (
  items: { name: string; value: number }[]
): { slices: PieRow[]; colorDomain: string[]; colorRange: string[] } => {
  const byName = new Map<string, number>()
  items.forEach((i) => {
    const v = Number(i.value)
    if (!Number.isFinite(v) || v <= 0) return
    byName.set(i.name, (byName.get(i.name) ?? 0) + v)
  })
  if (byName.size === 0) return { slices: [], colorDomain: [], colorRange: [] }

  let names = [...byName.keys()].sort((a, b) => a.localeCompare(b, 'zh-CN'))
  let othersValue = 0
  if (names.length > MAX_PIE_SLICES) {
    othersValue = [...byName.entries()]
      .filter(([n]) => names.indexOf(n) >= MAX_PIE_SLICES - 1)
      .reduce((acc, [, v]) => acc + v, 0)
    names = names.slice(0, MAX_PIE_SLICES - 1)
    if (othersValue > 0) names = [...names, '其他']
  }

  const colorDomain: string[] = []
  const colorRange: string[] = []
  names.forEach((name, idx) => {
    if (name === '其他') {
      colorDomain.push('其他')
      colorRange.push(OTHER_COLOR)
      return
    }
    colorDomain.push(name)
    colorRange.push(SERIES_PALETTE[idx % SERIES_PALETTE.length])
  })

  const slices: PieRow[] = [...byName.entries()]
    .map(([name, value]) => ({ name, value }))
    .filter((s) => !names.includes(s.name) || s.value > 0)
    .sort((a, b) => b.value - a.value)
  // 折叠尾部：把未上榜名称归入"其他"扇区
  if (othersValue > 0) {
    slices.push({ name: '其他', value: othersValue })
  }
  return { slices, colorDomain, colorRange }
}

// ---------------------------------------------------------------------------
// 明细表格列
// ---------------------------------------------------------------------------

const studentPaymentColumns: TableColumnsType<StudentPayment> = [
  { title: '缴费日期', dataIndex: 'paymentDate', key: 'paymentDate', width: 104 },
  { title: '学生', dataIndex: 'studentName', key: 'studentName', width: 110, render: (v?: string) => v || '—' },
  { title: '关联课程', dataIndex: 'courseLabel', key: 'courseLabel', width: 180, render: (v?: string) => v || '—' },
  {
    title: '应缴金额',
    dataIndex: 'amountDue',
    key: 'amountDue',
    width: 104,
    align: 'right' as const,
    render: (v: number) => fmtMoney(v)
  },
  {
    title: '实缴金额',
    dataIndex: 'amountPaid',
    key: 'amountPaid',
    width: 104,
    align: 'right' as const,
    render: (v: number) => fmtMoney(v)
  },
  { title: '缴费方式', dataIndex: 'paymentMethod', key: 'paymentMethod', width: 90 },
  { title: '备注', dataIndex: 'note', key: 'note', render: (v: string | null) => v || '—' }
]

const teacherPaymentColumns: TableColumnsType<TeacherPayment> = [
  { title: '支付日期', dataIndex: 'paymentDate', key: 'paymentDate', width: 104 },
  { title: '老师', dataIndex: 'teacherName', key: 'teacherName', width: 110, render: (v?: string) => v || '—' },
  { title: '关联课次', dataIndex: 'instanceLabel', key: 'instanceLabel', width: 220, render: (v?: string) => v || '—' },
  {
    title: '应付金额',
    dataIndex: 'amountDue',
    key: 'amountDue',
    width: 104,
    align: 'right' as const,
    render: (v: number) => fmtMoney(v)
  },
  {
    title: '实付金额',
    dataIndex: 'amountPaid',
    key: 'amountPaid',
    width: 104,
    align: 'right' as const,
    render: (v: number) => fmtMoney(v)
  },
  { title: '备注', dataIndex: 'note', key: 'note', render: (v: string | null) => v || '—' }
]

/** 明细合并导出列（两种记录并表，类型列区分） */
const DETAIL_EXPORT_COLUMNS = [
  { header: '类型', key: '类型' },
  { header: '日期', key: '日期' },
  { header: '对象', key: '对象' },
  { header: '关联课程/课次', key: '关联' },
  { header: '应缴/应付', key: '应缴应付' },
  { header: '实缴/实付', key: '实缴实付' },
  { header: '缴费方式', key: '缴费方式' },
  { header: '备注', key: '备注' }
]

/** 明细导出行：学生缴费与老师课酬合并，字段对齐 */
const buildDetailExportRows = (d: BucketDetail): Record<string, unknown>[] => [
  ...d.studentRows.map((r) => ({
    类型: '学生缴费',
    日期: r.paymentDate,
    对象: r.studentName ?? '—',
    关联: r.courseLabel ?? '—',
    应缴应付: r.amountDue,
    实缴实付: r.amountPaid,
    缴费方式: r.paymentMethod,
    备注: r.note ?? ''
  })),
  ...d.teacherRows.map((r) => ({
    类型: '老师课酬',
    日期: r.paymentDate,
    对象: r.teacherName ?? '—',
    关联: r.instanceLabel ?? '—',
    应缴应付: r.amountDue,
    实缴实付: r.amountPaid,
    缴费方式: '—',
    备注: r.note ?? ''
  }))
]

// ---------------------------------------------------------------------------
// 页面主体
// ---------------------------------------------------------------------------

export default function BusinessAnalyticsPage(): JSX.Element {
  const { message } = AntdApp.useApp()

  // 查询条件：粒度 + 日期范围（默认当年 1/1 - 12/31）
  const [granularity, setGranularity] = useState<Granularity>('month')
  const [range, setRange] = useState<[Dayjs, Dayjs]>(() => [dayjs().startOf('year'), dayjs().endOf('year')])
  const [analytics, setAnalytics] = useState<AnalyticsData | null>(null)
  const [loading, setLoading] = useState(false)

  // 环形图数据源切换
  const [incomeSource, setIncomeSource] = useState<IncomeSource>('subject')
  const [expenseSource, setExpenseSource] = useState<ExpenseSource>('teacher')

  // 下钻明细（点击趋势柱后展示）
  const [detail, setDetail] = useState<BucketDetail | null>(null)

  // 当前生效的粒度 / 当前趋势桶列表 —— 供"仅绑定一次"的图表 onEvent 回调读取
  const granularityRef = useRef<Granularity>(granularity)
  const trendBucketsRef = useRef<string[]>([])
  // 全量缴费/课酬记录缓存（首次下钻时拉取一次，避免反复 IPC）
  const paymentsCacheRef = useRef<{ loaded: boolean; students: StudentPayment[]; teachers: TeacherPayment[] }>({
    loaded: false,
    students: [],
    teachers: []
  })

  /** 拉取数据（粒度/范围变化联动刷新；失败提示错误） */
  const load = useCallback(
    async (granularityValue: Granularity, start: string, end: string): Promise<void> => {
      setLoading(true)
      try {
        const d = await api.getAnalytics({ granularity: granularityValue, start, end })
        setAnalytics(d)
      } catch (err) {
        message.error(getErrorMessage(err))
      } finally {
        setLoading(false)
      }
    },
    [message]
  )

  const startKey = range[0].format('YYYY-MM-DD')
  const endKey = range[1].format('YYYY-MM-DD')

  useEffect(() => {
    void load(granularity, startKey, endKey)
  }, [granularity, startKey, endKey, load])

  // 同步 ref，供事件回调读取最新粒度/桶列表
  useEffect(() => {
    granularityRef.current = granularity
  }, [granularity])
  useEffect(() => {
    trendBucketsRef.current = analytics?.trend.map((t) => t.bucket) ?? []
  }, [analytics])

  // 查询条件变化时，旧下钻明细失去时效，收起
  useEffect(() => {
    setDetail(null)
  }, [granularity, startKey, endKey])

  /** 打开某 bucket 的收支明细（拉取全量记录后按时间过滤） */
  const openDetail = useCallback(
    async (bucket: string): Promise<void> => {
      setDetail({ bucket, loading: true, error: null, studentRows: [], teacherRows: [] })
      try {
        const cache = paymentsCacheRef.current
        if (!cache.loaded) {
          const [students, teachers] = await Promise.all([api.getStudentPayments(), api.getTeacherPayments()])
          cache.students = students
          cache.teachers = teachers
          cache.loaded = true
        }
        const match = makeDateMatcher(granularityRef.current, bucket)
        const students = cache.students
          .filter((p) => match(p.paymentDate))
          .sort((a, b) => b.paymentDate.localeCompare(a.paymentDate))
        const teachers = cache.teachers
          .filter((p) => match(p.paymentDate))
          .sort((a, b) => b.paymentDate.localeCompare(a.paymentDate))
        setDetail({ bucket, loading: false, error: null, studentRows: students, teacherRows: teachers })
      } catch (err) {
        setDetail((prev) =>
          prev ? { ...prev, loading: false, error: getErrorMessage(err) } : prev
        )
        message.error(getErrorMessage(err))
      }
    },
    [message]
  )

  /**
   * 趋势图柱点击 → 下钻。
   * plots v2 的 onEvent 签名为 (chart, event)，在图表挂载时绑定一次，之后不会再换绑，
   * 因此这里只读取第二个参数 event，且仅引用 ref 与稳定回调，避免闭包过期。
   */
  const handleTrendEvent = useCallback(
    (chart: unknown, event: unknown): void => {
      void chart
      if (!event || typeof event !== 'object') return
      const type = String((event as { type?: unknown }).type ?? '')
      if (!type.includes('click')) return
      const bucket = extractBucket(event)
      if (bucket === null || !trendBucketsRef.current.includes(bucket)) return
      void openDetail(bucket)
    },
    [openDetail]
  )

  const handleRangeChange = (dates: [Dayjs | null, Dayjs | null] | null): void => {
    if (dates && dates[0] && dates[1]) {
      setRange([dates[0], dates[1]])
    }
  }

  // -------------------------------------------------------------------------
  // 图表数据与配置（计算属性：全部来自 analytics）
  // -------------------------------------------------------------------------

  const trendRows = useMemo(() => (analytics ? buildTrendRows(analytics.trend) : []), [analytics])

  const incomePie = useMemo(
    () =>
      buildPie(
        analytics
          ? incomeSource === 'subject'
            ? analytics.incomeBySubject
            : analytics.incomeByMethod
          : []
      ),
    [analytics, incomeSource]
  )

  const expensePie = useMemo(
    () =>
      buildPie(
        analytics
          ? expenseSource === 'teacher'
            ? analytics.expenseByTeacher
            : analytics.expenseByCourse
          : []
      ),
    [analytics, expenseSource]
  )

  const trendConfig = useMemo<ColumnConfig>(() => {
    return {
      data: trendRows,
      xField: 'bucket',
      yField: 'value',
      colorField: 'type',
      group: true,
      scale: {
        y: { nice: true },
        color: { domain: ['收入', '支出', '盈亏'], range: TREND_COLORS }
      },
      axis: {
        x: { title: false, labelAutoRotate: false },
        y: { title: false, labelFormatter: fmtYAxis }
      },
      legend: { color: { position: 'top' } }
    } as ColumnConfig
  }, [trendRows])

  const incomePieConfig = useMemo<PieConfig>(
    () => ({
      data: incomePie.slices,
      angleField: 'value',
      colorField: 'name',
      innerRadius: 0.62,
      scale: { color: { domain: incomePie.colorDomain, range: incomePie.colorRange } },
      legend: { color: { position: 'bottom' } },
      label: false
    } as PieConfig),
    [incomePie]
  )

  const expensePieConfig = useMemo<PieConfig>(
    () => ({
      data: expensePie.slices,
      angleField: 'value',
      colorField: 'name',
      innerRadius: 0.62,
      scale: { color: { domain: expensePie.colorDomain, range: expensePie.colorRange } },
      legend: { color: { position: 'bottom' } },
      label: false
    } as PieConfig),
    [expensePie]
  )

  /** 图表卡片内的统一容器高度，保证卡片在"有图 / 暂无数据"两种状态下高度一致 */
  const chartBoxStyle: CSSProperties = { height: 320, width: '100%' }

  /** 空状态占位（保持与图表同高，避免卡片跳动） */
  const renderEmpty = (): JSX.Element => (
    <div style={{ ...chartBoxStyle, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无数据" />
    </div>
  )

  const incomeTotal = detail ? sumMoney(detail.studentRows) : 0
  const expenseTotal = detail ? sumMoney(detail.teacherRows) : 0

  return (
    <div>
      <PageToolbar
        title="经营分析"
        actions={
          <Space wrap>
            <Typography.Text type="secondary">粒度</Typography.Text>
            <Segmented
              options={GRANULARITY_OPTIONS}
              value={granularity}
              onChange={(v) => setGranularity(v as Granularity)}
            />
            <DatePicker.RangePicker
              allowClear={false}
              value={range}
              onChange={handleRangeChange}
            />
          </Space>
        }
      />

      <Spin spinning={loading}>
        {/* 趋势图（整行） */}
        <Card
          title={
            <Space size={8}>
              <LineChartOutlined style={{ color: '#1677ff' }} />
              收支盈亏趋势
            </Space>
          }
          extra={<Typography.Text type="secondary">点击柱体可查看该时间段收支明细</Typography.Text>}
        >
          {trendRows.length > 0 ? (
            <div style={chartBoxStyle}>
              <Column {...trendConfig} onEvent={handleTrendEvent} />
            </div>
          ) : (
            renderEmpty()
          )}
        </Card>

        {/* 两张构成图（并排） */}
        <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
          <Col span={12}>
            <Card
              title="收入构成"
              extra={
                <Segmented
                  size="small"
                  options={[
                    { label: '按科目', value: 'subject' },
                    { label: '按缴费方式', value: 'method' }
                  ]}
                  value={incomeSource}
                  onChange={(v) => setIncomeSource(v as IncomeSource)}
                />
              }
            >
              {incomePie.slices.length > 0 ? (
                <div style={{ ...chartBoxStyle, height: 320 }}>
                  <Pie {...incomePieConfig} />
                </div>
              ) : (
                renderEmpty()
              )}
            </Card>
          </Col>
          <Col span={12}>
            <Card
              title="支出构成"
              extra={
                <Segmented
                  size="small"
                  options={[
                    { label: '按老师', value: 'teacher' },
                    { label: '按课程', value: 'course' }
                  ]}
                  value={expenseSource}
                  onChange={(v) => setExpenseSource(v as ExpenseSource)}
                />
              }
            >
              {expensePie.slices.length > 0 ? (
                <div style={{ ...chartBoxStyle, height: 320 }}>
                  <Pie {...expensePieConfig} />
                </div>
              ) : (
                renderEmpty()
              )}
            </Card>
          </Col>
        </Row>

        {/* 下钻明细（点击趋势柱后出现） */}
        {detail && (
          <Card
            style={{ marginTop: 16 }}
            title={
              <Space size={8}>
                <LineChartOutlined style={{ color: '#1677ff' }} />
                {detail.bucket} 收支明细
              </Space>
            }
            extra={
              <Space>
                <ExportExcelButton
                  module="经营分析明细"
                  columns={DETAIL_EXPORT_COLUMNS}
                  rows={buildDetailExportRows(detail)}
                  disabled={detail.loading || (detail.studentRows.length === 0 && detail.teacherRows.length === 0)}
                />
                <Button icon={<CloseOutlined />} onClick={() => setDetail(null)}>
                  收起明细
                </Button>
              </Space>
            }
          >
            {detail.error && (
              <Alert
                type="error"
                showIcon
                style={{ marginBottom: 12 }}
                message={`明细加载失败：${detail.error}`}
              />
            )}
            <Space size={32} style={{ marginBottom: 12 }}>
              <Statistic
                title="学生实缴合计（收入）"
                value={incomeTotal}
                precision={2}
                prefix="¥"
                valueStyle={{ fontSize: 22 }}
              />
              <Statistic
                title="老师实付合计（支出）"
                value={expenseTotal}
                precision={2}
                prefix="¥"
                valueStyle={{ fontSize: 22 }}
              />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                共 {detail.studentRows.length} 笔学生缴费、{detail.teacherRows.length} 笔老师课酬
              </Typography.Text>
            </Space>
            <Spin spinning={detail.loading}>
              <Typography.Title level={5} style={{ marginTop: 0 }}>
                学生缴费明细
              </Typography.Title>
              <Table
                rowKey="id"
                size="small"
                bordered
                columns={studentPaymentColumns}
                dataSource={detail.studentRows}
                pagination={false}
                locale={{ emptyText: '该时间段内没有学生缴费记录' }}
              />
              <Typography.Title level={5} style={{ marginTop: 16 }}>
                老师课酬明细
              </Typography.Title>
              <Table
                rowKey="id"
                size="small"
                bordered
                columns={teacherPaymentColumns}
                dataSource={detail.teacherRows}
                pagination={false}
                locale={{ emptyText: '该时间段内没有老师课酬记录' }}
              />
            </Spin>
          </Card>
        )}
      </Spin>
    </div>
  )
}
