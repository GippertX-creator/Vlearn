/**
 * 课程日历页：月 / 周 / 日三种视图展示课程实例。
 * - 每个实例显示科目、班级号、授课老师（代课显示代课老师）
 * - 点击实例弹出详情（学生名单 + 考勤操作 + 单次调课/取消）
 * - 月视图点击空白日期切换到该日的日视图
 */
import { BookOutlined, LeftOutlined, RightOutlined } from '@ant-design/icons'
import { Button, Calendar, Empty, Segmented, Space, Spin, Tag } from 'antd'
import dayjs, { Dayjs } from 'dayjs'
import isoWeek from 'dayjs/plugin/isoWeek'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, getErrorMessage } from '../api'
import CourseManagerModal from '../components/CourseManagerModal'
import InstanceDetailModal from '../components/InstanceDetailModal'
import PageToolbar from '../components/PageToolbar'
import type { ScheduleInstance } from '../types'

type ViewMode = 'month' | 'week' | 'day'

// 周视图使用 ISO 周（周一开始）
dayjs.extend(isoWeek)

const WEEKDAY_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

/** 实例状态 → CSS 类名（与 index.css 中样式对应） */
function statusClass(status: ScheduleInstance['status']): string {
  return status === 'adjusted' ? 'adjusted' : status === 'cancelled' ? 'cancelled' : 'normal'
}

/** 授课老师显示名（代课优先） */
function teacherName(inst: ScheduleInstance): string {
  return inst.actualTeacherName ?? inst.defaultTeacherName ?? ''
}

export default function CalendarPage(): JSX.Element {
  const [view, setView] = useState<ViewMode>('month')
  const [cursor, setCursor] = useState<Dayjs>(() => dayjs())
  const [instances, setInstances] = useState<ScheduleInstance[]>([])
  const [loading, setLoading] = useState(false)
  const [detailId, setDetailId] = useState<number | null>(null)
  const [courseManagerOpen, setCourseManagerOpen] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)

  // 按当前视图计算数据加载范围
  const range = useMemo(() => {
    switch (view) {
      case 'month':
        return { start: cursor.subtract(1, 'month'), end: cursor.add(1, 'month') }
      case 'week': {
        const monday = cursor.startOf('week').add(1, 'day')
        return { start: monday.subtract(1, 'day'), end: monday.add(7, 'day') }
      }
      case 'day':
        return { start: cursor.subtract(1, 'day'), end: cursor.add(1, 'day') }
    }
  }, [view, cursor])

  const loadInstances = useCallback(async () => {
    setLoading(true)
    try {
      const rows = await api.getInstances(range.start.format('YYYY-MM-DD'), range.end.format('YYYY-MM-DD'))
      setInstances(rows)
    } catch (err) {
      setInstances([])
      console.error(getErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [range.start, range.end])

  useEffect(() => {
    loadInstances()
  }, [loadInstances, refreshKey])

  /** 按日期分组：YYYY-MM-DD → 实例列表 */
  const byDate = useMemo(() => {
    const map = new Map<string, ScheduleInstance[]>()
    for (const inst of instances) {
      const list = map.get(inst.date) ?? []
      list.push(inst)
      map.set(inst.date, list)
    }
    return map
  }, [instances])

  // ---------- 导航 ----------

  const step = view === 'month' ? 'month' : view === 'week' ? 'week' : 'day'
  const navigate = (dir: 1 | -1): void => setCursor((c) => c.add(dir, step))

  const periodLabel = useMemo(() => {
    if (view === 'month') return cursor.format('YYYY年M月')
    if (view === 'week') {
      const monday = cursor.startOf('week').add(1, 'day')
      return `${monday.format('YYYY年M月D日')} - ${monday.add(6, 'day').format('M月D日')}`
    }
    return cursor.format('YYYY年M月D日 dddd')
  }, [view, cursor])

  // ---------- 事件渲染 ----------

  const renderChip = (inst: ScheduleInstance, card = false): JSX.Element => {
    const cls = card ? 'event-card' : 'event-chip'
    const name = teacherName(inst)
    return (
      <div
        key={inst.id}
        className={`${cls} ${statusClass(inst.status)}`}
        onClick={(e) => {
          e.stopPropagation()
          setDetailId(inst.id)
        }}
        title={`${inst.subject} ${inst.grade} ${inst.className} ${inst.startTime}-${inst.endTime} ${name}`}
      >
        {card ? (
          <>
            <div className="title">
              {inst.startTime}-{inst.endTime} {inst.subject}·{inst.className}
            </div>
            <div>
              {name}
              {inst.actualTeacherName && inst.actualTeacherName !== inst.defaultTeacherName && (
                <Tag color="orange" style={{ marginLeft: 4, fontSize: 11 }}>
                  代
                </Tag>
              )}
            </div>
          </>
        ) : (
          `${inst.startTime} ${inst.subject}·${inst.className} ${name}`
        )}
      </div>
    )
  }

  // 月视图单元格
  const dateCellRender = (date: Dayjs): JSX.Element => {
    const list = byDate.get(date.format('YYYY-MM-DD')) ?? []
    return <ul className="cell-events">{list.map((inst) => renderChip(inst))}</ul>
  }

  // 周视图（周一开始）
  const weekDays = useMemo(() => {
    const monday = cursor.startOf('week').add(1, 'day')
    return Array.from({ length: 7 }, (_, i) => monday.add(i, 'day'))
  }, [cursor])

  // 日视图小时行（8:00 - 22:00）
  const dayHours = useMemo(() => {
    const hours: number[] = []
    for (let h = 8; h <= 22; h++) hours.push(h)
    return hours
  }, [])

  const renderWeekView = (): JSX.Element => (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 8 }}>
      {weekDays.map((d) => {
        const key = d.format('YYYY-MM-DD')
        const isToday = d.isSame(dayjs(), 'day')
        return (
          <div
            key={key}
            style={{
              background: '#fff',
              borderRadius: 8,
              border: isToday ? '2px solid #1677ff' : '1px solid #f0f0f0',
              minHeight: 380,
              padding: 8,
              cursor: 'pointer'
            }}
            onClick={() => {
              setCursor(d)
              setView('day')
            }}
          >
            <div style={{ textAlign: 'center', fontWeight: isToday ? 700 : 400, marginBottom: 8, color: isToday ? '#1677ff' : undefined }}>
              <div>{WEEKDAY_LABELS[d.isoWeekday() - 1]}</div>
              <div style={{ fontSize: 12, color: isToday ? '#1677ff' : '#999' }}>{d.format('M月D日')}</div>
            </div>
            {(byDate.get(key) ?? []).map((inst) => renderChip(inst, true))}
          </div>
        )
      })}
    </div>
  )

  const renderDayView = (): JSX.Element => {
    const list = byDate.get(cursor.format('YYYY-MM-DD')) ?? []
    return (
      <div style={{ background: '#fff', borderRadius: 8, border: '1px solid #f0f0f0', padding: 8 }}>
        {dayHours.map((h) => {
          const hourInstances = list.filter((inst) => {
            const startHour = parseInt(inst.startTime.slice(0, 2), 10)
            return startHour === h
          })
          return (
            <div
              key={h}
              style={{
                display: 'flex',
                borderBottom: '1px dashed #f0f0f0',
                minHeight: 48,
                padding: '4px 0'
              }}
            >
              <div style={{ width: 64, color: '#999', fontSize: 12, paddingTop: 4 }}>
                {String(h).padStart(2, '0')}:00
              </div>
              <div style={{ flex: 1 }}>{hourInstances.map((inst) => renderChip(inst, true))}</div>
            </div>
          )
        })}
        {list.filter((inst) => {
          const startHour = parseInt(inst.startTime.slice(0, 2), 10)
          return startHour < 8 || startHour > 22
        }).length > 0 && (
          <div style={{ marginTop: 8, padding: 8, background: '#fffbe6', borderRadius: 6 }}>
            有 {list.filter((inst) => parseInt(inst.startTime.slice(0, 2), 10) < 8 || parseInt(inst.startTime.slice(0, 2), 10) > 22).length}{' '}
            节课在 8:00-22:00 之外（见上方月/周视图）。
          </div>
        )}
        {list.length === 0 && <Empty description="当日暂无课程" image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ padding: 32 }} />}
      </div>
    )
  }

  return (
    <div>
      <PageToolbar
        title="课程日历"
        actions={
          <Space>
            <Button icon={<BookOutlined />} onClick={() => setCourseManagerOpen(true)}>
              课程管理
            </Button>
            <Segmented
              value={view}
              onChange={(v) => setView(v as ViewMode)}
              options={[
                { label: '月', value: 'month' },
                { label: '周', value: 'week' },
                { label: '日', value: 'day' }
              ]}
            />
            <Space.Compact>
              <Button icon={<LeftOutlined />} onClick={() => navigate(-1)} />
              <Button onClick={() => setCursor(dayjs())}>今天</Button>
              <Button icon={<RightOutlined />} onClick={() => navigate(1)} />
            </Space.Compact>
            <span style={{ fontWeight: 600, minWidth: 200, display: 'inline-block' }}>{periodLabel}</span>
          </Space>
        }
      />

      {/* 图例 */}
      <Space style={{ marginBottom: 12 }} size={12}>
        <span className="event-chip normal" style={{ cursor: 'default' }}>正常</span>
        <span className="event-chip adjusted" style={{ cursor: 'default' }}>已调课</span>
        <span className="event-chip cancelled" style={{ cursor: 'default' }}>已取消</span>
      </Space>

      <Spin spinning={loading}>
        {view === 'month' && (
          <div style={{ background: '#fff', borderRadius: 8, padding: 8 }}>
            <Calendar
              value={cursor}
              onSelect={(d) => {
                setCursor(d)
                setView('day')
              }}
              onPanelChange={(d) => setCursor(d)}
              cellRender={(date, info) => (info.type === 'date' ? dateCellRender(date) : info.originNode)}
            />
          </div>
        )}
        {view === 'week' && renderWeekView()}
        {view === 'day' && renderDayView()}
      </Spin>

      <InstanceDetailModal
        instanceId={detailId}
        onClose={() => setDetailId(null)}
        onChanged={() => setRefreshKey((k) => k + 1)}
      />

      <CourseManagerModal
        open={courseManagerOpen}
        onClose={() => setCourseManagerOpen(false)}
        onChanged={() => setRefreshKey((k) => k + 1)}
      />
    </div>
  )
}
