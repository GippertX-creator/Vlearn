/**
 * 资源管理页（v4）：校区 + 教室的统一管理页（教务角色）。
 * - 上半部分「校区管理」：校区名称 / 地址 / 备注，支持新增、编辑、删除
 * - 下半部分「教室管理」：所属校区 / 名称 / 容量 / 类型 / 设备信息 / 状态 / 备注
 * 写操作仅教务角色可见（财务 / 助教进入为只读：隐藏全部操作按钮与操作列，表格正常展示），
 * 后端 IPC 同样按角色强制校验。
 */
import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons'
import { App as AntdApp, Button, Card, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Table, Tag } from 'antd'
import { useCallback, useEffect, useState } from 'react'
import { api, getErrorMessage, tryApi } from '../api'
import PageToolbar from '../components/PageToolbar'
import { useRole } from '../roleContext'
import type { Campus, Classroom } from '../types'

/** 教室内置类型选项（tags 模式，可继续输入自定义类型） */
const CLASSROOM_TYPE_OPTIONS = ['普通', '多媒体', '实验室', '其他']

/** 教室状态 → 标签颜色/文案 */
const CLASSROOM_STATUS_META: Record<Classroom['status'], { color: string; label: string }> = {
  available: { color: 'green', label: '可用' },
  maintenance: { color: 'orange', label: '维护中' },
  disabled: { color: 'default', label: '停用' }
}

interface CampusFormValues {
  name: string
  address?: string
  note?: string
}

interface ClassroomFormValues {
  campusId: number
  name: string
  capacity?: number
  /** 类型为 tags 模式，表单值恒为 0/1 个元素，取最后一个生效 */
  type?: string[]
  deviceInfo?: string
  status?: Classroom['status']
  note?: string
}

/** 教室类型：取 tags 的最后一个值，为空时回退为「普通」 */
function pickType(v: string[] | undefined): string {
  const last = v && v.length > 0 ? v[v.length - 1] : ''
  const t = last.trim()
  return t || '普通'
}

/** 教室下拉选项（新增/编辑教室时选择所属校区，来自校区列表） */
function campusOptions(campuses: Campus[]): { value: number; label: string }[] {
  return campuses.map((c) => ({ value: c.id, label: c.name }))
}

export default function ResourcesPage(): JSX.Element {
  const { message } = AntdApp.useApp()
  const role = useRole()
  /** 写操作仅教务角色可见 */
  const canEdit = role === 'academic'
  const [campuses, setCampuses] = useState<Campus[]>([])
  const [classrooms, setClassrooms] = useState<Classroom[]>([])
  const [loading, setLoading] = useState(false)
  /** 校区表单弹窗：null 关闭，'new' 新增，Campus 编辑 */
  const [campusEditing, setCampusEditing] = useState<Campus | 'new' | null>(null)
  /** 教室表单弹窗：null 关闭，'new' 新增，Classroom 编辑 */
  const [classroomEditing, setClassroomEditing] = useState<Classroom | 'new' | null>(null)
  const [campusForm] = Form.useForm<CampusFormValues>()
  const [classroomForm] = Form.useForm<ClassroomFormValues>()
  const [savingCampus, setSavingCampus] = useState(false)
  const [savingClassroom, setSavingClassroom] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [cs, rooms] = await Promise.all([api.getCampuses(), api.getClassrooms()])
      setCampuses(cs)
      setClassrooms(rooms)
    } catch (err) {
      message.error(getErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [message])

  useEffect(() => {
    load()
  }, [load])

  // ---------- 校区：增删改 ----------

  const openCreateCampus = (): void => {
    setCampusEditing('new')
    campusForm.resetFields()
  }

  const openEditCampus = (c: Campus): void => {
    setCampusEditing(c)
    campusForm.setFieldsValue({ name: c.name, address: c.address ?? undefined, note: c.note ?? undefined })
  }

  const handleSaveCampus = async (): Promise<void> => {
    try {
      const values = await campusForm.validateFields()
      const payload = {
        name: values.name.trim(),
        address: values.address?.trim() || null,
        note: values.note?.trim() || null
      }
      setSavingCampus(true)
      const result =
        campusEditing === 'new'
          ? await tryApi(() => api.createCampus(payload))
          : await tryApi(() => api.updateCampus((campusEditing as Campus).id, payload))
      if (!result.ok) throw new Error(result.error)
      message.success(campusEditing === 'new' ? '校区已添加' : '校区信息已保存')
      setCampusEditing(null)
      await load()
    } catch (err) {
      if (err instanceof Error && err.message) message.error(getErrorMessage(err))
    } finally {
      setSavingCampus(false)
    }
  }

  const handleDeleteCampus = async (c: Campus): Promise<void> => {
    try {
      await api.deleteCampus(c.id)
      message.success('校区已删除')
      await load()
    } catch (err) {
      message.error(getErrorMessage(err))
    }
  }

  // ---------- 教室：增删改 ----------

  const openCreateClassroom = (): void => {
    setClassroomEditing('new')
    classroomForm.resetFields()
    classroomForm.setFieldsValue({ type: ['普通'] })
  }

  const openEditClassroom = (r: Classroom): void => {
    setClassroomEditing(r)
    classroomForm.setFieldsValue({
      campusId: r.campusId,
      name: r.name,
      capacity: r.capacity ?? undefined,
      type: [r.type || '普通'],
      deviceInfo: r.deviceInfo ?? undefined,
      status: r.status,
      note: r.note ?? undefined
    })
  }

  const handleSaveClassroom = async (): Promise<void> => {
    try {
      const values = await classroomForm.validateFields()
      const base = {
        campusId: values.campusId,
        name: values.name.trim(),
        capacity: values.capacity ?? null,
        type: pickType(values.type),
        note: values.note?.trim() || null,
        deviceInfo: values.deviceInfo?.trim() || null
      }
      setSavingClassroom(true)
      const result =
        classroomEditing === 'new'
          ? await tryApi(() => api.createClassroom(base))
          : await tryApi(() => api.updateClassroom((classroomEditing as Classroom).id, { ...base, status: values.status ?? 'available' }))
      if (!result.ok) throw new Error(result.error)
      message.success(classroomEditing === 'new' ? '教室已添加' : '教室信息已保存')
      setClassroomEditing(null)
      await load()
    } catch (err) {
      if (err instanceof Error && err.message) message.error(getErrorMessage(err))
    } finally {
      setSavingClassroom(false)
    }
  }

  const handleDeleteClassroom = async (r: Classroom): Promise<void> => {
    try {
      await api.deleteClassroom(r.id)
      message.success('教室已删除')
      await load()
    } catch (err) {
      message.error(getErrorMessage(err))
    }
  }

  // ---------- 列定义 ----------

  const campusColumns = [
    { title: '校区名称', dataIndex: 'name', key: 'name' },
    { title: '地址', dataIndex: 'address', key: 'address', render: (v: string | null) => v || '—' },
    { title: '备注', dataIndex: 'note', key: 'note', render: (v: string | null) => v || '—' },
    ...(canEdit
      ? [
          {
            title: '操作',
            key: 'actions',
            width: 130,
            render: (_: unknown, row: Campus) => (
              <Space size={4}>
                <Button size="small" icon={<EditOutlined />} onClick={() => openEditCampus(row)}>
                  编辑
                </Button>
                <Popconfirm
                  title="确认删除该校区？"
                  description="删除校区将级联删除其下全部教室，且不可恢复。"
                  okText="删除"
                  cancelText="取消"
                  okButtonProps={{ danger: true }}
                  onConfirm={() => handleDeleteCampus(row)}
                >
                  <Button size="small" danger icon={<DeleteOutlined />} />
                </Popconfirm>
              </Space>
            )
          }
        ]
      : [])
  ]

  const classroomColumns = [
    { title: '所属校区', dataIndex: 'campusName', key: 'campusName', width: 120, render: (v: string) => v || '—' },
    { title: '教室名称', dataIndex: 'name', key: 'name', width: 130 },
    {
      title: '容量',
      dataIndex: 'capacity',
      key: 'capacity',
      width: 90,
      render: (v: number | null) => (v == null ? '—' : `${v} 人`)
    },
    { title: '类型', dataIndex: 'type', key: 'type', width: 100, render: (v: string) => v || '普通' },
    { title: '设备信息', dataIndex: 'deviceInfo', key: 'deviceInfo', render: (v: string | null) => v || '—' },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 90,
      render: (v: Classroom['status']) => {
        const meta = CLASSROOM_STATUS_META[v] ?? { color: 'default', label: v }
        return <Tag color={meta.color}>{meta.label}</Tag>
      }
    },
    { title: '备注', dataIndex: 'note', key: 'note', width: 140, render: (v: string | null) => v || '—' },
    ...(canEdit
      ? [
          {
            title: '操作',
            key: 'actions',
            width: 130,
            render: (_: unknown, row: Classroom) => (
              <Space size={4}>
                <Button size="small" icon={<EditOutlined />} onClick={() => openEditClassroom(row)}>
                  编辑
                </Button>
                <Popconfirm
                  title="确认删除该教室？"
                  description="删除后其课程排课中的教室引用将被清空。"
                  okText="删除"
                  cancelText="取消"
                  okButtonProps={{ danger: true }}
                  onConfirm={() => handleDeleteClassroom(row)}
                >
                  <Button size="small" danger icon={<DeleteOutlined />} />
                </Popconfirm>
              </Space>
            )
          }
        ]
      : [])
  ]

  return (
    <div>
      <PageToolbar title="资源管理" />

      {/* 校区管理 */}
      <Card
        title="校区管理"
        style={{ marginBottom: 16 }}
        extra={
          canEdit && (
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreateCampus}>
              新增校区
            </Button>
          )
        }
      >
        <Table
          rowKey="id"
          loading={loading}
          columns={campusColumns}
          dataSource={campuses}
          pagination={false}
          locale={{ emptyText: '暂无校区，点击右上角「新增校区」创建' }}
        />
      </Card>

      {/* 教室管理 */}
      <Card
        title="教室管理"
        extra={
          canEdit && (
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreateClassroom}>
              新增教室
            </Button>
          )
        }
      >
        <Table
          rowKey="id"
          loading={loading}
          columns={classroomColumns}
          dataSource={classrooms}
          pagination={{ pageSize: 20, showTotal: (total) => `共 ${total} 间教室` }}
          locale={{ emptyText: '暂无教室，点击右上角「新增教室」创建' }}
        />
      </Card>

      {/* 校区新增/编辑表单 */}
      <Modal
        open={campusEditing !== null}
        title={campusEditing === 'new' ? '新增校区' : '编辑校区'}
        okText="保存"
        cancelText="取消"
        confirmLoading={savingCampus}
        onOk={() => void handleSaveCampus()}
        onCancel={() => setCampusEditing(null)}
      >
        <Form form={campusForm} layout="vertical" style={{ marginTop: 8 }}>
          <Form.Item name="name" label="校区名称" rules={[{ required: true, message: '请输入校区名称' }]}>
            <Input placeholder="如：总部校区" />
          </Form.Item>
          <Form.Item name="address" label="地址">
            <Input placeholder="校区地址（可选）" />
          </Form.Item>
          <Form.Item name="note" label="备注">
            <Input.TextArea rows={2} placeholder="其他说明（可选）" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 教室新增/编辑表单 */}
      <Modal
        open={classroomEditing !== null}
        title={classroomEditing === 'new' ? '新增教室' : '编辑教室'}
        okText="保存"
        cancelText="取消"
        confirmLoading={savingClassroom}
        onOk={() => void handleSaveClassroom()}
        onCancel={() => setClassroomEditing(null)}
      >
        <Form form={classroomForm} layout="vertical" style={{ marginTop: 8 }}>
          {campuses.length === 0 && (
            <div style={{ color: '#fa8c16', fontSize: 12, marginBottom: 8 }}>
              暂无校区，请先在「校区管理」中新增校区。
            </div>
          )}
          <Form.Item name="campusId" label="所属校区" rules={[{ required: true, message: '请选择所属校区' }]}>
            <Select placeholder="选择所属校区" options={campusOptions(campuses)} />
          </Form.Item>
          <Form.Item name="name" label="教室名称" rules={[{ required: true, message: '请输入教室名称' }]}>
            <Input placeholder="如：203 教室" />
          </Form.Item>
          <Form.Item name="capacity" label="容量">
            <InputNumber min={0} style={{ width: '100%' }} placeholder="座位数（可选）" />
          </Form.Item>
          <Form.Item name="type" label="教室类型">
            <Select
              mode="tags"
              allowClear
              placeholder="选择或输入自定义类型（如：普通/多媒体/实验室/其他）"
              options={CLASSROOM_TYPE_OPTIONS.map((t) => ({ value: t, label: t }))}
              onChange={(v: string[]) => classroomForm.setFieldsValue({ type: v.length > 0 ? [v[v.length - 1]] : [] })}
            />
          </Form.Item>
          <Form.Item name="deviceInfo" label="设备信息">
            <Input placeholder="如：投影仪、白板、空调（可选）" />
          </Form.Item>
          {classroomEditing !== 'new' && classroomEditing !== null && (
            <Form.Item name="status" label="状态">
              <Select
                options={[
                  { value: 'available', label: '可用' },
                  { value: 'maintenance', label: '维护中' },
                  { value: 'disabled', label: '停用' }
                ]}
              />
            </Form.Item>
          )}
          <Form.Item name="note" label="备注">
            <Input.TextArea rows={2} placeholder="其他说明（可选）" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
