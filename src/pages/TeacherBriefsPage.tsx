/**
 * 老师简报（财务角色·v4）：
 * - 顶部工具栏：老师下拉（可搜索）+ 日期范围（默认未来 7 天：今天 → +7 天）+ 简报内容勾选
 *   （基本信息 / 课程安排表 / 学生名单及出勤 / 课酬汇总，默认前三项）
 * - "生成简报"：勾选课酬时先 Modal.confirm 二次确认（课酬金额仅供财务与老师本人知悉），
 *   再调用 getTeacherBriefData 生成数据并弹窗预览（宽 760）
 * - 预览弹窗按勾选动态渲染各板块（基本信息 / 课程安排表 / 学生名单及出勤 / 课酬汇总）
 * - footer 操作：复制为文本（navigator.clipboard，带降级方案）、导出 PDF（渲染层生成完整
 *   HTML → 主进程 briefExportPdf 弹保存框）、关闭
 */
import { CheckSquareOutlined, CopyOutlined, FilePdfOutlined, FileTextOutlined } from '@ant-design/icons'
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Checkbox,
  DatePicker,
  Empty,
  Modal,
  Select,
  Space,
  Table,
  Typography
} from 'antd'
import type { TableColumnsType } from 'antd'
import dayjs, { Dayjs } from 'dayjs'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, getErrorMessage } from '../api'
import PageToolbar from '../components/PageToolbar'
import type { Teacher, TeacherBriefData } from '../types'

// ---------------------------------------------------------------------------
// 类型与小工具
// ---------------------------------------------------------------------------

/** 简报板块 key（与勾选选项一一对应） */
type BriefSection = 'basic' | 'schedule' | 'students' | 'compensation'

/** 勾选选项：value 即板块 key */
const SECTION_OPTIONS: { label: string; value: BriefSection }[] = [
  { label: '基本信息', value: 'basic' },
  { label: '课程安排表', value: 'schedule' },
  { label: '学生名单及出勤', value: 'students' },
  { label: '课酬汇总', value: 'compensation' }
]

/** 默认勾选：前三项（课酬汇总默认不勾） */
const DEFAULT_SECTIONS: BriefSection[] = ['basic', 'schedule', 'students']

/** 金额展示：四舍五入到分后以 ¥ 前缀展示 */
const fmtMoney = (v: number): string => `¥${(Math.round(v * 100) / 100).toFixed(2)}`

/** HTML 转义（简报内容可能来自用户录入的姓名/班级等，插入 HTML 前必须转义） */
const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

/** 教室展示：空教室显示 — */
const classroomText = (name: string | null): string => (name && name.trim() ? name : '—')

/** 时间列拼接：15:00-17:00 */
const timeText = (start: string, end: string): string => `${start}-${end}`

/** 出勤统计列文案：出勤4 请假0 缺勤0 */
const statsText = (s: { present: number; leave: number; absent: number }): string =>
  `出勤${s.present} 请假${s.leave} 缺勤${s.absent}`

// ---------------------------------------------------------------------------
// 课程安排表 / 学生名单的表格列
// ---------------------------------------------------------------------------

interface BriefInstanceRow {
  date: string
  time: string
  courseLabel: string
  classroom: string
  /** 列表内无唯一 id，用内容拼接做稳定 rowKey */
  key: string
}

const scheduleColumns: TableColumnsType<BriefInstanceRow> = [
  { title: '日期', dataIndex: 'date', key: 'date', width: 116 },
  { title: '时间', dataIndex: 'time', key: 'time', width: 130 },
  { title: '课程', dataIndex: 'courseLabel', key: 'courseLabel' },
  { title: '教室', dataIndex: 'classroom', key: 'classroom', width: 120 }
]

const scheduleRows = (instances: TeacherBriefData['instances']): BriefInstanceRow[] =>
  instances.map((i, idx) => ({
    key: `${i.date}-${i.startTime}-${i.courseLabel}-${i.classroomName ?? ''}-${idx}`,
    date: i.date,
    time: timeText(i.startTime, i.endTime),
    courseLabel: i.courseLabel,
    classroom: classroomText(i.classroomName)
  }))

interface BriefStudentRow {
  key: string
  name: string
  schoolClass: string
  courseLabel: string
  stats: string
}

const studentColumns: TableColumnsType<BriefStudentRow> = [
  { title: '学生', dataIndex: 'name', key: 'name', width: 130 },
  { title: '学校班级', dataIndex: 'schoolClass', key: 'schoolClass', width: 150 },
  { title: '所属课程', dataIndex: 'courseLabel', key: 'courseLabel' },
  { title: '近4次课', dataIndex: 'stats', key: 'stats', width: 220 }
]

const studentRows = (students: TeacherBriefData['students']): BriefStudentRow[] =>
  students.map((s, idx) => ({
    key: `${s.name}-${s.courseLabel}-${idx}`,
    name: s.name,
    schoolClass: s.schoolClass && s.schoolClass.trim() ? s.schoolClass : '—',
    courseLabel: s.courseLabel,
    stats: statsText(s.stats)
  }))

/** 日期范围文案：2026-09-09 至 2026-09-16 */
const rangeText = (from: Dayjs, to: Dayjs): string => `${from.format('YYYY-MM-DD')} 至 ${to.format('YYYY-MM-DD')}`

// ---------------------------------------------------------------------------
// 纯文本 / HTML 生成（按勾选板块动态拼装）
// ---------------------------------------------------------------------------

/** 拼装简报纯文本（用于"复制为文本"） */
const buildPlainText = (
  brief: TeacherBriefData,
  sections: BriefSection[],
  from: Dayjs,
  to: Dayjs
): string => {
  const lines: string[] = []
  lines.push(`【Vlearn 老师简报】${brief.teacher.name}老师 · ${rangeText(from, to)}`)
  if (sections.includes('basic')) {
    const courses = brief.courses.length > 0 ? brief.courses.join('、') : '（暂无）'
    lines.push(`◆ 所教课程：${courses}`)
  }
  if (sections.includes('schedule')) {
    lines.push('◆ 课程安排：')
    if (brief.instances.length > 0) {
      brief.instances.forEach((i) => {
        lines.push(
          `  ${i.date} ${timeText(i.startTime, i.endTime)} ${i.courseLabel}（${classroomText(i.classroomName)}）`
        )
      })
    } else {
      lines.push('  该时段暂无课程安排')
    }
  }
  if (sections.includes('students')) {
    lines.push('◆ 学生出勤（近4次课）：')
    if (brief.students.length > 0) {
      brief.students.forEach((s) => {
        lines.push(`  ${s.name}（${s.schoolClass && s.schoolClass.trim() ? s.schoolClass : '未填写'}）：${statsText(s.stats)}`)
      })
    } else {
      lines.push('  该老师暂无学生')
    }
  }
  if (sections.includes('compensation') && brief.compensation) {
    lines.push(
      `◆ 课酬汇总：应付 ${fmtMoney(brief.compensation.due)} / 实付 ${fmtMoney(brief.compensation.paid)}`
    )
    lines.push('（含课酬信息，请勿外传）')
  }
  return lines.join('\n')
}

/** 拼装完整简报 HTML（内联 CSS、中文、简洁商务排版，供主进程导出 PDF） */
const buildBriefHtml = (
  brief: TeacherBriefData,
  sections: BriefSection[],
  from: Dayjs,
  to: Dayjs
): string => {
  const sec = (html: string): string => (html ? `<section style="margin-top:18px;">${html}</section>` : '')
  const title = (text: string): string =>
    `<h2 style="font-size:15px;color:#1f2937;margin:0 0 8px;padding-bottom:6px;border-bottom:1px solid #e5e7eb;">${text}</h2>`

  let body = sec(
    `<h1 style="font-size:20px;color:#111827;margin:0 0 6px;">【Vlearn 老师简报】${escapeHtml(brief.teacher.name)}老师</h1>
     <p style="font-size:13px;color:#6b7280;margin:0;">${rangeText(from, to)}</p>`
  )

  if (sections.includes('basic')) {
    body += sec(
      `${title('一、基本信息')}
       <p style="font-size:14px;margin:0;color:#374151;">所教课程：${escapeHtml(brief.courses.join('、') || '（暂无）')}</p>`
    )
  }

  if (sections.includes('schedule')) {
    const scheduleHtml =
      brief.instances.length > 0
        ? `<table style="width:100%;border-collapse:collapse;font-size:13px;">
             <thead><tr>
               <th style="border:1px solid #e5e7eb;background:#f9fafb;padding:6px 8px;text-align:left;">日期</th>
               <th style="border:1px solid #e5e7eb;background:#f9fafb;padding:6px 8px;text-align:left;">时间</th>
               <th style="border:1px solid #e5e7eb;background:#f9fafb;padding:6px 8px;text-align:left;">课程</th>
               <th style="border:1px solid #e5e7eb;background:#f9fafb;padding:6px 8px;text-align:left;">教室</th>
             </tr></thead><tbody>
             ${brief.instances
               .map(
                 (i) => `<tr>
                   <td style="border:1px solid #e5e7eb;padding:6px 8px;">${escapeHtml(i.date)}</td>
                   <td style="border:1px solid #e5e7eb;padding:6px 8px;">${escapeHtml(timeText(i.startTime, i.endTime))}</td>
                   <td style="border:1px solid #e5e7eb;padding:6px 8px;">${escapeHtml(i.courseLabel)}</td>
                   <td style="border:1px solid #e5e7eb;padding:6px 8px;">${escapeHtml(classroomText(i.classroomName))}</td>
                 </tr>`
               )
               .join('')}
             </tbody></table>`
        : `<p style="font-size:13px;color:#9ca3af;margin:0;">该时段暂无课程安排</p>`
    body += sec(`${title('二、课程安排表')}${scheduleHtml}`)
  }

  if (sections.includes('students')) {
    const studentsHtml =
      brief.students.length > 0
        ? `<table style="width:100%;border-collapse:collapse;font-size:13px;">
             <thead><tr>
               <th style="border:1px solid #e5e7eb;background:#f9fafb;padding:6px 8px;text-align:left;">学生</th>
               <th style="border:1px solid #e5e7eb;background:#f9fafb;padding:6px 8px;text-align:left;">学校班级</th>
               <th style="border:1px solid #e5e7eb;background:#f9fafb;padding:6px 8px;text-align:left;">所属课程</th>
               <th style="border:1px solid #e5e7eb;background:#f9fafb;padding:6px 8px;text-align:left;">近4次课</th>
             </tr></thead><tbody>
             ${brief.students
               .map(
                 (s) => `<tr>
                   <td style="border:1px solid #e5e7eb;padding:6px 8px;">${escapeHtml(s.name)}</td>
                   <td style="border:1px solid #e5e7eb;padding:6px 8px;">${escapeHtml(s.schoolClass && s.schoolClass.trim() ? s.schoolClass : '—')}</td>
                   <td style="border:1px solid #e5e7eb;padding:6px 8px;">${escapeHtml(s.courseLabel)}</td>
                   <td style="border:1px solid #e5e7eb;padding:6px 8px;">${escapeHtml(statsText(s.stats))}</td>
                 </tr>`
               )
               .join('')}
             </tbody></table>`
        : `<p style="font-size:13px;color:#9ca3af;margin:0;">该老师暂无学生</p>`
    body += sec(`${title('三、学生名单及出勤')}${studentsHtml}`)
  }

  if (sections.includes('compensation') && brief.compensation) {
    body += sec(
      `${title('四、课酬汇总')}
       <p style="font-size:14px;margin:0;color:#374151;">
         应付 <strong>${escapeHtml(fmtMoney(brief.compensation.due))}</strong> / 实付 <strong>${escapeHtml(fmtMoney(brief.compensation.paid))}</strong>
       </p>
       <p style="font-size:12px;font-weight:bold;color:#b91c1c;margin:10px 0 0;">含课酬信息，请勿外传</p>`
    )
  }

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<title>老师简报</title>
<style>
  body { font-family: "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Arial, sans-serif; color: #111827; line-height: 1.6; padding: 24px; }
</style>
</head>
<body>${body}</body>
</html>`
}

/** 剪贴板写入（带 document.execCommand 降级，兼容无安全上下文的情况） */
const copyToClipboard = async (text: string): Promise<void> => {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text)
    return
  }
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  const ok = document.execCommand('copy')
  document.body.removeChild(textarea)
  if (!ok) throw new Error('浏览器未授予剪贴板权限')
}

// ---------------------------------------------------------------------------
// 页面主体
// ---------------------------------------------------------------------------

export default function TeacherBriefsPage(): JSX.Element {
  const { message, modal } = AntdApp.useApp()

  // 老师列表（进入页面即加载）
  const [teachers, setTeachers] = useState<Teacher[]>([])
  const [teachersLoading, setTeachersLoading] = useState(false)
  const [selectedTeacherId, setSelectedTeacherId] = useState<number | null>(null)

  // 日期范围：默认未来 7 天（今天 → +7 天）
  const [range, setRange] = useState<[Dayjs, Dayjs]>(() => [dayjs(), dayjs().add(7, 'day')])

  // 简报内容勾选
  const [sections, setSections] = useState<BriefSection[]>(DEFAULT_SECTIONS)

  // 生成过程与预览
  const [generating, setGenerating] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [brief, setBrief] = useState<TeacherBriefData | null>(null)
  /** 生成简报时的板块快照（预览内容与弹窗期间的勾选无关，以生成时为准） */
  const [briefSections, setBriefSections] = useState<BriefSection[]>(DEFAULT_SECTIONS)
  /** 生成简报时的日期范围快照（复制/导出沿用生成时的范围） */
  const [briefRange, setBriefRange] = useState<[Dayjs, Dayjs]>([dayjs(), dayjs().add(7, 'day')])
  const [previewOpen, setPreviewOpen] = useState(false)

  const loadTeachers = useCallback(async (): Promise<void> => {
    setTeachersLoading(true)
    try {
      const list = await api.getTeachers()
      setTeachers(list)
    } catch (err) {
      message.error(getErrorMessage(err))
    } finally {
      setTeachersLoading(false)
    }
  }, [message])

  useEffect(() => {
    void loadTeachers()
  }, [loadTeachers])

  const selectedTeacher = useMemo(
    () => teachers.find((t) => t.id === selectedTeacherId) ?? null,
    [teachers, selectedTeacherId]
  )

  const handleRangeChange = (dates: [Dayjs | null, Dayjs | null] | null): void => {
    if (dates && dates[0] && dates[1]) {
      setRange([dates[0], dates[1]])
    }
  }

  /** 实际生成（已通过二次确认或未勾选课酬） */
  const doGenerate = useCallback(
    async (includeCompensation: boolean): Promise<void> => {
      if (selectedTeacherId === null) {
        message.warning('请先选择老师')
        return
      }
      setGenerating(true)
      try {
        const data = await api.getTeacherBriefData({
          teacherId: selectedTeacherId,
          start: range[0].format('YYYY-MM-DD'),
          end: range[1].format('YYYY-MM-DD'),
          includeCompensation
        })
        setBrief(data)
        setBriefSections(sections)
        setBriefRange([range[0], range[1]])
        setPreviewOpen(true)
      } catch (err) {
        message.error(getErrorMessage(err))
      } finally {
        setGenerating(false)
      }
    },
    [selectedTeacherId, range, sections, message]
  )

  /** 生成简报：勾选了课酬时先二次确认 */
  const handleGenerate = (): void => {
    if (selectedTeacherId === null) {
      message.warning('请先选择老师')
      return
    }
    if (sections.includes('compensation')) {
      modal.confirm({
        title: '包含课酬信息',
        content: '简报将包含该老师的课酬金额，仅供财务与老师本人知悉，确认继续？',
        okText: '确认生成',
        cancelText: '取消',
        onOk: () => doGenerate(true)
      })
    } else {
      void doGenerate(false)
    }
  }

  /** 复制为文本 */
  const handleCopy = useCallback(async (): Promise<void> => {
    if (!brief) return
    try {
      await copyToClipboard(buildPlainText(brief, briefSections, briefRange[0], briefRange[1]))
      message.success('简报已复制到剪贴板，可直接粘贴到微信/邮件发送')
    } catch (err) {
      message.error(`复制失败：${getErrorMessage(err)}`)
    }
  }, [brief, briefSections, briefRange, message])

  /** 导出 PDF（HTML 由渲染层生成，主进程弹保存框） */
  const handleExportPdf = useCallback(async (): Promise<void> => {
    if (!brief) return
    setExporting(true)
    try {
      const result = await api.briefExportPdf(buildBriefHtml(brief, briefSections, briefRange[0], briefRange[1]))
      if (result.canceled) return
      if (result.success) {
        message.success(`已导出：${result.path}`)
      } else {
        message.error(`导出失败：${result.error ?? '未知错误'}`)
      }
    } catch (err) {
      message.error(`导出失败：${getErrorMessage(err)}`)
    } finally {
      setExporting(false)
    }
  }, [brief, briefSections, briefRange, message])

  return (
    <div>
      <PageToolbar
        title="老师简报"
        actions={
          <Space wrap>
            <Select
              placeholder="请选择老师"
              style={{ width: 220 }}
              allowClear
              showSearch
              loading={teachersLoading}
              optionFilterProp="label"
              value={selectedTeacherId}
              onChange={(v: number | null) => setSelectedTeacherId(v ?? null)}
              options={teachers.map((t) => ({ value: t.id, label: t.name }))}
            />
            <DatePicker.RangePicker allowClear={false} value={range} onChange={handleRangeChange} />
            <Checkbox.Group
              options={SECTION_OPTIONS}
              value={sections}
              onChange={(vals) => setSections(vals as BriefSection[])}
            />
            <Button
              type="primary"
              icon={<FileTextOutlined />}
              loading={generating}
              disabled={selectedTeacherId === null || teachers.length === 0}
              onClick={handleGenerate}
            >
              生成简报
            </Button>
          </Space>
        }
      />

      <Typography.Paragraph type="secondary" style={{ marginTop: 4, marginBottom: 16 }}>
        简报由财务生成后转发给任课老师（老师本人不登录系统），可复制文本或导出 PDF。
        {sections.includes('compensation') && (
          <Typography.Text strong type="warning">　提示：当前勾选了课酬汇总，生成时会二次确认。</Typography.Text>
        )}
      </Typography.Paragraph>

      {teachers.length === 0 ? (
        <Empty description="暂无老师，请先在教务端录入老师信息" />
      ) : (
        <Card size="small">
          <Space size={40} wrap>
            <div>
              <Typography.Text type="secondary">当前老师</Typography.Text>
              <div style={{ fontSize: 16, fontWeight: 600 }}>{selectedTeacher ? `${selectedTeacher.name}老师` : '未选择'}</div>
            </div>
            <div>
              <Typography.Text type="secondary">简报日期范围</Typography.Text>
              <div style={{ fontSize: 16 }}>{rangeText(range[0], range[1])}</div>
            </div>
            <div>
              <Typography.Text type="secondary">简报内容</Typography.Text>
              <div style={{ fontSize: 16 }}>
                {briefSections.length > 0
                  ? SECTION_OPTIONS.filter((o) => briefSections.includes(o.value))
                      .map((o) => o.label)
                      .join(' / ')
                  : '（未勾选任何内容）'}
              </div>
            </div>
            <CheckSquareOutlined style={{ fontSize: 28, color: '#1677ff' }} />
          </Space>
        </Card>
      )}

      {/* 预览弹窗 */}
      <Modal
        open={previewOpen && brief !== null}
        title={brief ? `老师简报 · ${brief.teacher.name}` : '老师简报'}
        width={760}
        onCancel={() => setPreviewOpen(false)}
        footer={
          brief ? (
            <Space>
              <Button icon={<CopyOutlined />} onClick={() => void handleCopy()}>
                复制为文本
              </Button>
              <Button
                icon={<FilePdfOutlined />}
                loading={exporting}
                onClick={() => void handleExportPdf()}
              >
                导出 PDF
              </Button>
              <Button type="primary" onClick={() => setPreviewOpen(false)}>
                关闭
              </Button>
            </Space>
          ) : null
        }
      >
        {brief && (
          <div>
            <Typography.Title level={4} style={{ marginTop: 0, marginBottom: 4 }}>
              【Vlearn 老师简报】{brief.teacher.name}老师
            </Typography.Title>
            <Typography.Text type="secondary">{rangeText(briefRange[0], briefRange[1])}</Typography.Text>

            {/* 基本信息 */}
            {briefSections.includes('basic') && (
              <section>
                <Typography.Title level={5} style={{ marginBottom: 8 }}>
                  一、基本信息
                </Typography.Title>
                <Typography.Paragraph style={{ marginBottom: 0 }}>
                  <Typography.Text strong>{brief.teacher.name}老师</Typography.Text>
                  <br />
                  所教课程：{brief.courses.length > 0 ? brief.courses.join('、') : '（暂无）'}
                  {brief.teacher.note && (
                    <>
                      <br />
                      <Typography.Text type="secondary">备注：{brief.teacher.note}</Typography.Text>
                    </>
                  )}
                </Typography.Paragraph>
              </section>
            )}

            {/* 课程安排表 */}
            {briefSections.includes('schedule') && (
              <section style={{ marginTop: 16 }}>
                <Typography.Title level={5}>二、课程安排表</Typography.Title>
                {brief.instances.length > 0 ? (
                  <Table
                    rowKey="key"
                    size="small"
                    bordered
                    columns={scheduleColumns}
                    dataSource={scheduleRows(brief.instances)}
                    pagination={false}
                  />
                ) : (
                  <Alert type="info" showIcon message="该时段暂无课程安排" />
                )}
              </section>
            )}

            {/* 学生名单及出勤 */}
            {briefSections.includes('students') && (
              <section style={{ marginTop: 16 }}>
                <Typography.Title level={5}>三、学生名单及出勤（近4次课）</Typography.Title>
                {brief.students.length > 0 ? (
                  <Table
                    rowKey="key"
                    size="small"
                    bordered
                    columns={studentColumns}
                    dataSource={studentRows(brief.students)}
                    pagination={false}
                  />
                ) : (
                  <Alert type="info" showIcon message="该老师暂无学生" />
                )}
              </section>
            )}

            {/* 课酬汇总（仅生成时勾选且数据返回时展示） */}
            {briefSections.includes('compensation') && brief.compensation && (
              <section style={{ marginTop: 16 }}>
                <Typography.Title level={5}>四、课酬汇总</Typography.Title>
                <Alert
                  type="warning"
                  showIcon
                  message={
                    <Typography.Text>
                      该时段应付 <strong>{fmtMoney(brief.compensation.due)}</strong> / 实付{' '}
                      <strong>{fmtMoney(brief.compensation.paid)}</strong>
                    </Typography.Text>
                  }
                  description={
                    <Typography.Text strong type="danger">
                      含课酬信息，请勿外传
                    </Typography.Text>
                  }
                />
              </section>
            )}
          </div>
        )}
      </Modal>
    </div>
  )
}
