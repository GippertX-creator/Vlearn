/**
 * 老师管理页：列表 + 新增/编辑/删除 + 详情抽屉（授课统计）。
 * 课酬信息仅财务可见，本页面（教务端）不渲染任何费用字段。
 */
import { DeleteOutlined, EditOutlined, EyeOutlined, PlusOutlined } from '@ant-design/icons'
import { App as AntdApp, Button, Descriptions, Drawer, Form, Input, Modal, Popconfirm, Select, Space, Table, Tag } from 'antd'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, getErrorMessage, tryApi } from '../api'
import ExportExcelButton from '../components/ExportExcelButton'
import PageToolbar from '../components/PageToolbar'
import type { Course, Teacher, TeacherDetail } from '../types'

interface TeacherFormValues {
  name: string
  note?: string
  courseIds?: number[]
}

export default function TeachersPage(): JSX.Element {
  const { message } = AntdApp.useApp()
  const [teachers, setTeachers] = useState<Teacher[]>([])
  const [courses, setCourses] = useState<Course[]>([])
  const [loading, setLoading] = useState(false)
  const [keyword, setKeyword] = useState('')
  /** 表单弹窗状态：null 关闭，'new' 新增，Teacher 编辑 */
  const [editing, setEditing] = useState<Teacher | 'new' | null>(null)
  const [form] = Form.useForm<TeacherFormValues>()
  const [saving, setSaving] = useState(false)
  /** 详情抽屉 */
  const [detail, setDetail] = useState<TeacherDetail | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [t, c] = await Promise.all([api.getTeachers(), api.getCourses()])
      setTeachers(t)
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

  const filtered = useMemo(
    () => teachers.filter((t) => t.name.includes(keyword.trim())),
    [teachers, keyword]
  )

  const openCreate = (): void => {
    setEditing('new')
    form.resetFields()
  }

  const openEdit = (t: Teacher): void => {
    setEditing(t)
    form.setFieldsValue({ name: t.name, note: t.note ?? undefined, courseIds: t.courseIds })
  }

  const handleSave = async (): Promise<void> => {
    try {
      const values = await form.validateFields()
      const payload = {
        name: values.name.trim(),
        note: values.note?.trim() || null,
        courseIds: values.courseIds ?? []
      }
      // Agent：新增时相似姓名检测（如"张三" vs "张 三"）
      if (editing === 'new') {
        const dup = await tryApi(() => api.checkDuplicateName('teacher', payload.name))
        if (!dup.ok) throw new Error(dup.error)
        if (dup.data.matches.length > 0) {
          await new Promise<void>((resolve, reject) => {
            Modal.confirm({
              title: '发现相似姓名',
              content: (
                <div>
                  <p>已有以下相似老师：{dup.data.matches.join('、')}</p>
                  <p>是否仍然保存？</p>
                </div>
              ),
              okText: '仍然保存',
              cancelText: '返回检查',
              onOk: () => resolve(),
              onCancel: () => reject(new Error('已取消保存'))
            })
          })
        }
      }
      setSaving(true)
      const result =
        editing === 'new' ? await tryApi(() => api.createTeacher(payload)) : await tryApi(() => api.updateTeacher((editing as Teacher).id, payload))
      if (!result.ok) throw new Error(result.error)
      message.success(editing === 'new' ? '老师已添加' : '老师信息已保存')
      setEditing(null)
      await load()
    } catch (err) {
      if (err instanceof Error && err.message) message.error(getErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (t: Teacher): Promise<void> => {
    try {
      await api.deleteTeacher(t.id)
      message.success('老师已删除')
      await load()
    } catch (err) {
      message.error(getErrorMessage(err))
    }
  }

  const handleViewDetail = async (t: Teacher): Promise<void> => {
    try {
      const d = await api.getTeacherDetail(t.id)
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
      render: (v: string, row: Teacher) => (
        <Button type="link" style={{ padding: 0 }} onClick={() => handleViewDetail(row)}>
          {v}
        </Button>
      )
    },
    {
      title: '所教课程',
      key: 'courses',
      render: (_: unknown, row: Teacher) =>
        row.courseLabels.length > 0 ? (
          <Space size={4} wrap>
            {row.courseLabels.map((label) => (
              <Tag key={label} color="blue">
                {label}
              </Tag>
            ))}
          </Space>
        ) : (
          <span style={{ color: '#999' }}>未分配</span>
        )
    },
    { title: '备注', dataIndex: 'note', key: 'note', render: (v: string | null) => v || '—' },
    {
      title: '操作',
      key: 'actions',
      width: 160,
      render: (_: unknown, row: Teacher) => (
        <Space size={4}>
          <Button size="small" icon={<EyeOutlined />} onClick={() => handleViewDetail(row)}>
            详情
          </Button>
          <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(row)}>
            编辑
          </Button>
          <Popconfirm
            title="确认删除该老师？"
            description="删除后其课程中的「默认老师」引用将被清空。"
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

  const exportRows = filtered.map((t) => ({
    姓名: t.name,
    所教课程: t.courseLabels.join('、') || '未分配',
    备注: t.note ?? ''
  }))

  return (
    <div>
      <PageToolbar
        title="老师管理"
        leftExtra={
          <Input.Search
            placeholder="按姓名搜索"
            allowClear
            style={{ width: 220 }}
            onSearch={setKeyword}
            onChange={(e) => !e.target.value && setKeyword('')}
          />
        }
        actions={
          <Space>
            <ExportExcelButton
              module="老师管理"
              columns={[
                { header: '姓名', key: '姓名' },
                { header: '所教课程', key: '所教课程' },
                { header: '备注', key: '备注' }
              ]}
              rows={exportRows}
              disabled={filtered.length === 0}
            />
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              新增老师
            </Button>
          </Space>
        }
      />

      <Table
        rowKey="id"
        loading={loading}
        columns={columns}
        dataSource={filtered}
        pagination={{ pageSize: 20, showTotal: (total) => `共 ${total} 位老师` }}
      />

      {/* 新增/编辑表单 */}
      <Modal
        open={editing !== null}
        title={editing === 'new' ? '新增老师' : '编辑老师'}
        okText="保存"
        cancelText="取消"
        confirmLoading={saving}
        onOk={handleSave}
        onCancel={() => setEditing(null)}
      >
        <Form form={form} layout="vertical" style={{ marginTop: 8 }}>
          <Form.Item name="name" label="姓名" rules={[{ required: true, message: '请输入老师姓名' }]}>
            <Input placeholder="请输入老师姓名" />
          </Form.Item>
          <Form.Item name="courseIds" label="所教课程">
            <Select
              mode="multiple"
              allowClear
              placeholder="选择所教课程（可多选）"
              options={courses.map((c) => ({ value: c.id, label: `${c.subject} ${c.grade} ${c.className}` }))}
            />
          </Form.Item>
          <Form.Item name="note" label="备注">
            <Input.TextArea rows={2} placeholder="其他说明（可选）" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 详情抽屉 */}
      <Drawer
        open={detail !== null}
        onClose={() => setDetail(null)}
        title="老师详情"
        width={480}
      >
        {detail && (
          <>
            <Descriptions column={1} bordered size="small">
              <Descriptions.Item label="姓名">{detail.teacher.name}</Descriptions.Item>
              <Descriptions.Item label="所教课程">
                {detail.teacher.courseLabels.length > 0 ? (
                  <Space size={4} wrap>
                    {detail.teacher.courseLabels.map((label) => (
                      <Tag key={label} color="blue">
                        {label}
                      </Tag>
                    ))}
                  </Space>
                ) : (
                  '未分配'
                )}
              </Descriptions.Item>
              <Descriptions.Item label="备注">{detail.teacher.note || '—'}</Descriptions.Item>
            </Descriptions>
            <Descriptions column={2} style={{ marginTop: 16 }} title="授课统计">
              <Descriptions.Item label="累计授课次数">
                <b>{detail.totalInstances}</b> 次
              </Descriptions.Item>
              <Descriptions.Item label="未来待上课程">
                <b>{detail.upcomingInstances}</b> 次
              </Descriptions.Item>
            </Descriptions>
            <div style={{ marginTop: 16, color: '#999', fontSize: 12 }}>
              课酬金额属于财务数据，请进入「财务」模块查看。
            </div>
          </>
        )}
      </Drawer>
    </div>
  )
}
