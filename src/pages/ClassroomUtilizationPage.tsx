/**
 * 教室利用率页（v4，教务端）：按日期范围统计各教室的排课占用情况。
 * - 日期范围（默认最近 14 天，不可清空）+ 导出 Excel
 * - 按校区分组展示：每间教室的已排课时间 / 可用时间 / 利用率进度条
 * - 可用时间按每天 8:00-22:00 计算；维护中/停用的教室计为 0%
 */
import { App as AntdApp, Card, DatePicker, Empty, Progress, Spin, Table, Tag } from 'antd'
import dayjs, { Dayjs } from 'dayjs'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, getErrorMessage } from '../api'
import ExportExcelButton from '../components/ExportExcelButton'
import PageToolbar from '../components/PageToolbar'
import type { ClassroomUtilization } from '../types'

/** 教室状态 → 标签颜色/文案（服务端 status 为字符串，未知值原样展示） */
const STATUS_META: Record<string, { color: string; label: string }> = {
  available: { color: 'green', label: '可用' },
  maintenance: { color: 'orange', label: '维护中' },
  disabled: { color: 'default', label: '停用' }
}

/** 分钟 → "X 小时 Y 分钟"（不足 1 小时仅显示分钟） */
function fmtMinutes(raw: number): string {
  const m = Math.max(0, Math.round(raw))
  const h = Math.floor(m / 60)
  const rest = m % 60
  if (h === 0) return `${rest} 分钟`
  return `${h} 小时 ${rest} 分钟`
}

/** 利用率进度条颜色：>80% 红色（接近饱和）、50-80% 蓝色、<50% 绿色（空余充足） */
function rateColor(rate: number): string {
  if (rate > 80) return '#cf1322'
  if (rate >= 50) return '#1677ff'
  return '#3f8600'
}

export default function ClassroomUtilizationPage(): JSX.Element {
  const { message } = AntdApp.useApp()
  /** 日期范围，默认最近 14 天（含今天），不可清空 */
  const [range, setRange] = useState<[Dayjs, Dayjs]>([dayjs().subtract(13, 'day'), dayjs()])
  const [rows, setRows] = useState<ClassroomUtilization[]>([])
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await api.getClassroomUtilization(range[0].format('YYYY-MM-DD'), range[1].format('YYYY-MM-DD'))
      setRows(data)
    } catch (err) {
      setRows([])
      message.error(getErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [range, message])

  useEffect(() => {
    load()
  }, [load])

  const handleRangeChange = (dates: [Dayjs | null, Dayjs | null] | null): void => {
    if (dates && dates[0] && dates[1]) setRange([dates[0], dates[1]])
  }

  /** 按校区（按出现顺序）分组，保留 campusName 展示 */
  const groups = useMemo(() => {
    const map = new Map<string, { campusName: string; items: ClassroomUtilization[] }>()
    for (const r of rows) {
      const g = map.get(r.campusName) ?? { campusName: r.campusName, items: [] }
      g.items.push(r)
      map.set(r.campusName, g)
    }
    return [...map.values()]
  }, [rows])

  const exportColumns = [
    { header: '校区', key: '校区' },
    { header: '教室', key: '教室' },
    { header: '状态', key: '状态' },
    { header: '已排课分钟', key: '已排课分钟' },
    { header: '可用分钟', key: '可用分钟' },
    { header: '利用率%', key: '利用率%' }
  ]
  const exportRows = rows.map((r) => ({
    校区: r.campusName,
    教室: r.name,
    状态: STATUS_META[r.status]?.label ?? r.status,
    已排课分钟: r.scheduledMinutes,
    可用分钟: r.availableMinutes,
    '利用率%': r.rate
  }))

  const tableColumns = [
    { title: '教室名称', dataIndex: 'name', key: 'name', width: 140 },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 90,
      render: (v: string) => {
        const meta = STATUS_META[v]
        return <Tag color={meta?.color}>{meta?.label ?? v}</Tag>
      }
    },
    {
      title: '已排课时间',
      dataIndex: 'scheduledMinutes',
      key: 'scheduledMinutes',
      width: 140,
      render: (v: number) => fmtMinutes(v)
    },
    {
      title: '可用时间',
      dataIndex: 'availableMinutes',
      key: 'availableMinutes',
      width: 140,
      render: (v: number) => fmtMinutes(v)
    },
    {
      title: '利用率',
      key: 'rate',
      width: 220,
      render: (_: unknown, row: ClassroomUtilization) => (
        <Progress
          percent={row.rate}
          strokeColor={rateColor(row.rate)}
          format={() => `${row.rate}%`}
          style={{ marginBottom: 0 }}
        />
      )
    }
  ]

  return (
    <div>
      <PageToolbar
        title="教室利用率"
        actions={
          <>
            <DatePicker.RangePicker
              value={range}
              allowClear={false}
              onChange={handleRangeChange}
              style={{ width: 260 }}
            />
            <ExportExcelButton
              module="教室利用率"
              columns={exportColumns}
              rows={exportRows}
              disabled={rows.length === 0}
            />
          </>
        }
      />

      {loading && groups.length === 0 ? (
        <div style={{ padding: 48, textAlign: 'center' }}>
          <Spin />
        </div>
      ) : rows.length === 0 ? (
        <Empty description="该时间段内暂无教室数据" style={{ padding: 48 }} />
      ) : (
        <>
          {groups.map((g) => (
            <Card
              key={g.campusName}
              title={g.campusName}
              extra={<span style={{ color: '#999', fontWeight: 400 }}>{g.items.length} 间教室</span>}
              style={{ marginBottom: 16 }}
            >
              <Table
                rowKey="id"
                size="small"
                loading={loading}
                columns={tableColumns}
                dataSource={g.items}
                pagination={false}
              />
            </Card>
          ))}
          <div style={{ color: '#999', fontSize: 12 }}>
            说明：可用时间按每天 8:00-22:00 计算；维护中/停用的教室计为 0%。
          </div>
        </>
      )}
    </div>
  )
}
