/**
 * 学生管理页：列表 + 关键词搜索（姓名 / 学校班级）+ 新增/编辑/删除 + 详情抽屉（考勤统计与考勤历史）。
 * 缴费情况仅财务可见，本页面（教务端）不渲染任何缴费 / 费用字段。
 */
import { DeleteOutlined, EditOutlined, EyeOutlined, PlusOutlined } from '@ant-design/icons'
import {
  App as AntdApp,
  Button,
  Descriptions,
  Drawer,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Typography
} from 'antd'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, getErrorMessage, tryApi } from '../api'
import AttendanceStatusTag, { attendanceStatusText } from '../components/AttendanceStatusTag'
import ExportExcelButton from '../components/ExportExcelButton'
import PageToolbar from '../components/PageToolbar'
import type { Course, Student, StudentAttendanceRecord, StudentDetail } from '../types'

interface StudentFormValues {
  name: string
  schoolClass?: string
  note?: string
  courseIds?: number[]
}

/** 课程文本标签：科目 + 年级 + 班级号（如 "数学 高一 A1班"） */
const courseLabel = (c: { subject: string; grade: string; className: string }): string =>
  `${c.subject} ${c.grade} ${c.className}`

export default function StudentsPage(): JSX.Element {
  const { message } = AntdApp.useApp()
  const [students, setStudents] = useState<Student[]>([])
  const [courses, setCourses] = useState<Course[]>([])
  const [loading, setLoading] = useState(false)
  const [keyword, setKeyword] = useState('')
  /** 表单弹窗状态：null 关闭，'new' 新增，Student 编辑 */
  const [editing, setEditing] = useState<Student | 'new' | null>(null)
  const [form] = Form.useForm<StudentFormValues>()
  const [saving, setSaving] = useState(false)
  /** 详情抽屉数据 */
  const [detail, setDetail] = useState<StudentDetail | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [s, c] = await Promise.all([api.getStudents(), api.getCourses()])
      setStudents(s)
      setCourses(c)
    } catch (err) {
      message.error(getErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [message])

  useEffect(() => {
    load()
  }, [load])

  /** 按姓名或学校班级过滤 */
  const filtered = useMemo(() => {
    const k = keyword.trim()
    if (!k) return students
    return students.filter(
      (s) => s.name.includes(k) || (s.schoolClass ?? '').includes(k)
    )
  }, [students, keyword])

  const openCreate = (): void => {
    setEditing('new')
    form.resetFields()
  }

  const openEdit = (s: Student): void => {
    setEditing(s)
    form.setFieldsValue({ name: s.name, schoolClass: s.schoolClass ?? undefined, note: s.note ?? undefined, courseIds: s.courseIds })
  }

  const handleSave = async (): Promise<void> => {
    try {
      const values = await form.validateFields()
      const payload = {
        name: values.name.trim(),
        schoolClass: values.schoolClass?.trim() || null,
        note: values.note?.trim() || null,
        courseIds: values.courseIds ?? []
      }
      setSaving(true)
      const result =
        editing === 'new'
          ? await tryApi(() => api.createStudent(payload))
          : await tryApi(() => api.updateStudent((editing as Student).id, payload))
      if (!result.ok) throw new Error(result.error)
      message.success(editing === 'new' ? '学生已添加' : '学生信息已保存')
      setEditing(null)
      await load()
    } catch (err) {
      if (err instanceof Error && err.message) message.error(getErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (s: Student): Promise<void> => {
    try {
      await api.deleteStudent(s.id)
      message.success('学生已删除')
      await load()
    } catch (err) {
      message.error(getErrorMessage(err))
    }
  }

  /** 打开详情抽屉并加载考勤统计 / 考勤历史 */
  const handleViewDetail = async (s: Student): Promise<void> => {
    try {
      const d = await api.getStudentDetail(s.id)
      setDetail(d)
    } catch (err) {
      message.error(getErrorMessage(err))
    }
  }

  const columns = [
    {
      title: '姓名',
      dataIndex: 'name',
      key: 'name',
      render: (v: string, row: Student) => (
        <Button type="link" style={{ padding: 0 }} onClick={() => handleViewDetail(row)}>
          {v}
        </Button>
      )
    },
    {
      title: '学校班级',
      dataIndex: 'schoolClass',
      key: 'schoolClass',
      render: (v: string | null) => v || '—'
    },
    {
      title: '所报课程',
      key: 'courses',
      render: (_: unknown, row: Student) =>
        row.courseLabels.length > 0 ? (
          <Space size={4} wrap>
            {row.courseLabels.map((label) => (
              <Tag key={label} color="blue">
                {label}
              </Tag>
            ))}
          </Space>
        ) : (
          <span style={{ color: '#999' }}>未报名</span>
        )
    },
    { title: '备注', dataIndex: 'note', key: 'note', render: (v: string | null) => v || '—' },
    {
      title: '操作',
      key: 'actions',
      width: 160,
      render: (_: unknown, row: Student) => (
        <Space size={4}>
          <Button size="small" icon={<EyeOutlined />} onClick={() => handleViewDetail(row)}>
            详情
          </Button>
          <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(row)}>
            编辑
          </Button>
          <Popconfirm
            title="确认删除该学生？"
            description="删除后该学生的考勤与缴费记录将一并删除。"
            okText="删除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={() => handleDelete(row)}
          >
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      )
    }
  ]

  const exportRows = filtered.map((s) => ({
    姓名: s.name,
    学校班级: s.schoolClass ?? '',
    所报课程: s.courseLabels.join('、') || '未报名',
    备注: s.note ?? ''
  }))

  return (
    <div>
      <PageToolbar
        title="学生管理"
        leftExtra={
          <Input.Search
            placeholder="按姓名或学校班级搜索"
            allowClear
            style={{ width: 240 }}
            onSearch={setKeyword}
            onChange={(e) => !e.target.value && setKeyword('')}
          />
        }
        actions={
          <Space>
            <ExportExcelButton
              module="学生管理"
              columns={[
                { header: '姓名', key: '姓名' },
                { header: '学校班级', key: '学校班级' },
                { header: '所报课程', key: '所报课程' },
                { header: '备注', key: '备注' }
              ]}
              rows={exportRows}
              disabled={filtered.length === 0}
            />
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              新增学生
            </Button>
          </Space>
        }
      />

      <Table
        rowKey="id"
        loading={loading}
        columns={columns}
        dataSource={filtered}
        pagination={{ pageSize: 20, showTotal: (total) => `共 ${total} 名学生` }}
      />

      {/* 新增/编辑表单 */}
      <Modal
        open={editing !== null}
        title={editing === 'new' ? '新增学生' : '编辑学生'}
        okText="保存"
        cancelText="取消"
        confirmLoading={saving}
        onOk={handleSave}
        onCancel={() => setEditing(null)}
      >
        <Form form={form} layout="vertical" style={{ marginTop: 8 }}>
          <Form.Item name="name" label="姓名" rules={[{ required: true, message: '请输入学生姓名' }]}>
            <Input placeholder="请输入学生姓名" />
          </Form.Item>
          <Form.Item name="schoolClass" label="学校班级">
            <Input placeholder="如：市一中 高二(3)班" />
          </Form.Item>
          <Form.Item name="courseIds" label="所报课程">
            <Select
              mode="multiple"
              allowClear
              placeholder="选择所报课程（可多选）"
              options={courses.map((c) => ({ value: c.id, label: courseLabel(c) }))}
            />
          </Form.Item>
          <Form.Item name="note" label="备注">
            <Input.TextArea rows={2} placeholder="其他说明（可选）" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 详情抽屉 */}
      <Drawer open={detail !== null} onClose={() => setDetail(null)} title="学生详情" width={560}>
        {detail && (
          <>
            <Descriptions column={1} bordered size="small">
              <Descriptions.Item label="姓名">{detail.student.name}</Descriptions.Item>
              <Descriptions.Item label="学校班级">{detail.student.schoolClass || '—'}</Descriptions.Item>
              <Descriptions.Item label="所报课程">
                {detail.student.courseLabels.length > 0 ? (
                  <Space size={4} wrap>
                    {detail.student.courseLabels.map((label) => (
                      <Tag key={label} color="blue">
                        {label}
                      </Tag>
                    ))}
                  </Space>
                ) : (
                  '未报名'
                )}
              </Descriptions.Item>
              <Descriptions.Item label="备注">{detail.student.note || '—'}</Descriptions.Item>
            </Descriptions>

            <Descriptions column={3} style={{ marginTop: 16 }} title="考勤统计">
              <Descriptions.Item label="出勤">
                <AttendanceStatusTag status="present" />
                <span style={{ marginLeft: 6 }}>{detail.stats.present} 次</span>
              </Descriptions.Item>
              <Descriptions.Item label="请假">
                <AttendanceStatusTag status="leave" />
                <span style={{ marginLeft: 6 }}>{detail.stats.leave} 次</span>
              </Descriptions.Item>
              <Descriptions.Item label="缺勤">
                <AttendanceStatusTag status="absent" />
                <span style={{ marginLeft: 6 }}>{detail.stats.absent} 次</span>
              </Descriptions.Item>
            </Descriptions>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '20px 0 8px' }}>
              <Typography.Text strong>考勤历史（{detail.attendances.length} 条）</Typography.Text>
              <ExportExcelButton
                module="考勤记录"
                columns={[
                  { header: '日期', key: '日期' },
                  { header: '课程', key: '课程' },
                  { header: '上课时间', key: '上课时间' },
                  { header: '老师', key: '老师' },
                  { header: '考勤状态', key: '考勤状态' },
                  { header: '备注', key: '备注' }
                ]}
                rows={detail.attendances.map((a) => ({
                  日期: a.date,
                  课程: courseLabel(a),
                  上课时间: `${a.startTime}-${a.endTime}`,
                  老师: a.teacherName ?? '',
                  考勤状态: attendanceStatusText(a.status),
                  备注: a.note ?? ''
                }))}
                disabled={detail.attendances.length === 0}
              />
            </div>
            <Table
              rowKey="id"
              size="small"
              columns={[
                { title: '日期', dataIndex: 'date', key: 'date' },
                {
                  title: '课程',
                  key: 'course',
                  render: (_: unknown, row: StudentAttendanceRecord) => courseLabel(row)
                },
                {
                  title: '上课时间',
                  key: 'time',
                  render: (_: unknown, row: StudentAttendanceRecord) => `${row.startTime}-${row.endTime}`
                },
                {
                  title: '老师',
                  dataIndex: 'teacherName',
                  key: 'teacherName',
                  render: (_: unknown, row: StudentAttendanceRecord) => row.teacherName || '—'
                },
                {
                  title: '状态',
                  key: 'status',
                  width: 90,
                  render: (_: unknown, row: StudentAttendanceRecord) => <AttendanceStatusTag status={row.status} />
                },
                {
                  title: '备注',
                  dataIndex: 'note',
                  key: 'note',
                  render: (_: unknown, row: StudentAttendanceRecord) => row.note || '—'
                }
              ]}
              dataSource={detail.attendances}
              pagination={{ pageSize: 8, size: 'small', hideOnSinglePage: true }}
            />

            <div style={{ marginTop: 16, color: '#999', fontSize: 12 }}>
              缴费情况属于财务数据，请进入「财务」模块查看。
            </div>
          </>
        )}
      </Drawer>
    </div>
  )
}
