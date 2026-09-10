/**
 * 老师课酬管理（仅财务可见页面）：
 * - 课酬记录列表：老师 / 课程实例 / 应付 / 标准来源 / 实付 / 支付日期 / 备注，支持增删改
 * - "自动计算应付"：为每个未取消的课程实例生成 / 更新一条课酬记录，
 *   应付金额取值优先级：课次覆盖课酬 → 老师默认课酬 → 课程单次课酬标准；
 *   实例有代课老师时支付给代课老师（实际授课老师）
 * - 按老师、课程筛选；底部合计行展示应付合计与实付合计
 * - 新增 / 编辑弹窗：选择课程实例后按所属课程单次课酬自动带出应付金额
 * - 保存前异常交易检测：调用 checkPaymentAnomaly（本地规则），存在异常时弹窗确认是否仍然保存
 * - "课酬标准"弹窗：a) 老师默认课酬（元/次）编辑；b) 单次课次课酬覆盖（如代课场景）
 */
import {
  CalculatorOutlined,
  DeleteOutlined,
  DollarOutlined,
  EditOutlined,
  PlusOutlined
} from '@ant-design/icons'
import {
  App as AntdApp,
  Button,
  Col,
  DatePicker,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography
} from 'antd'
import dayjs, { Dayjs } from 'dayjs'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, getErrorMessage, tryApi } from '../api'
import ExportExcelButton from '../components/ExportExcelButton'
import PageToolbar from '../components/PageToolbar'
import type { Course, ScheduleInstance, Teacher, TeacherPayment } from '../types'

/** 新增/编辑弹窗表单值（日期在表单中为 Dayjs，提交时转 YYYY-MM-DD） */
interface PaymentFormValues {
  teacherId: number
  scheduleInstanceId: number
  amountDue: number
  amountPaid: number
  paymentDate: Dayjs
  note?: string
}

/** 金额展示：四舍五入到分后以 ¥ 前缀展示 */
const fmtMoney = (v: number): string => `¥${(Math.round(v * 100) / 100).toFixed(2)}`

/** 课程实例选项文本：日期 科目 年级 班级号 开始-结束 */
const instanceLabel = (i: ScheduleInstance): string =>
  `${i.date} ${i.subject ?? ''} ${i.grade ?? ''} ${i.className ?? ''} ${i.startTime}-${i.endTime}`.trim()

/** 课酬标准来源展示配置（值来自 TeacherPayment.rateSource） */
const RATE_SOURCE_META: Record<string, { label: string; color: string }> = {
  instance: { label: '实例覆盖', color: 'blue' },
  teacher: { label: '老师默认', color: 'purple' },
  course: { label: '课程标准', color: 'green' }
}

/** 课酬取值优先级说明（列头 Tooltip 与弹窗提示共用） */
const RATE_SOURCE_TIP = '课酬取值优先级：实例覆盖 > 老师默认 > 课程标准'

/**
 * 修改老师默认课酬弹窗内容：Modal.confirm 的内容树是独立挂载的，
 * 通过外部 store 对象把用户输入回传给 confirm 的 onOk 回调。
 */
function TeacherRateEditor({
  teacherName,
  oldRate,
  store
}: {
  teacherName: string
  oldRate: number
  store: { value: number }
}): JSX.Element {
  const [value, setValue] = useState<number | null>(oldRate)
  return (
    <div>
      <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
        确认修改 {teacherName} 的默认课酬：原 {fmtMoney(oldRate)}/次 → 新{' '}
        {value !== null ? fmtMoney(value) : '—'}/次
      </Typography.Paragraph>
      <InputNumber
        min={0}
        precision={2}
        prefix="¥"
        style={{ width: '100%' }}
        placeholder="请输入默认课酬（元/次）"
        value={value}
        onChange={(v: number | null) => {
          setValue(v)
          store.value = v ?? 0
        }}
      />
    </div>
  )
}

export default function TeacherPaymentsPage(): JSX.Element {
  const { message } = AntdApp.useApp()
  const [payments, setPayments] = useState<TeacherPayment[]>([])
  const [teachers, setTeachers] = useState<Teacher[]>([])
  const [instances, setInstances] = useState<ScheduleInstance[]>([])
  const [courses, setCourses] = useState<Course[]>([])
  const [loading, setLoading] = useState(false)
  /** 筛选条件（undefined 表示不筛选） */
  const [teacherFilter, setTeacherFilter] = useState<number | undefined>()
  const [courseFilter, setCourseFilter] = useState<number | undefined>()
  /** 弹窗状态：null 关闭，'new' 新增，TeacherPayment 编辑 */
  const [editing, setEditing] = useState<TeacherPayment | 'new' | null>(null)
  const [form] = Form.useForm<PaymentFormValues>()
  const [saving, setSaving] = useState(false)
  const [autoRunning, setAutoRunning] = useState(false)
  /** "课酬标准"弹窗开关 */
  const [rateOpen, setRateOpen] = useState(false)
  /** 课次课酬覆盖：选中实例 + 输入金额 */
  const [overrideInstanceId, setOverrideInstanceId] = useState<number | undefined>()
  const [overrideValue, setOverrideValue] = useState<number | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const [p, t, ins, c] = await Promise.all([
        api.getTeacherPayments(),
        api.getTeachers(),
        api.getPaymentInstances(),
        api.getFinanceCourses()
      ])
      setPayments(p)
      setTeachers(t)
      setInstances(ins)
      setCourses(c)
    } catch (err) {
      message.error(getErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [message])

  useEffect(() => {
    void load()
  }, [load])

  /** 实例 id → 课程 id；课程 id → 单次课酬标准（选择实例后自动带出应付金额） */
  const instanceById = useMemo(() => new Map(instances.map((i) => [i.id, i])), [instances])
  const coursePayById = useMemo(() => new Map(courses.map((c) => [c.id, c.payPerSession])), [courses])
  /** 课程筛选下拉：取实例涉及课程（去重） */
  const courseOptions = useMemo(() => {
    const seen = new Map<number, string>()
    for (const i of instances) {
      if (i.courseId !== undefined && i.courseId !== null) {
        const label = `${i.subject ?? ''} ${i.grade ?? ''} ${i.className ?? ''}`.trim()
        if (!seen.has(i.courseId)) seen.set(i.courseId, label)
      }
    }
    return [...seen.entries()].map(([value, label]) => ({ value, label }))
  }, [instances])

  /** 按老师 / 课程（记录对应实例的课程）客户端过滤 */
  const filtered = useMemo(
    () =>
      payments.filter((p) => {
        if (teacherFilter !== undefined && p.teacherId !== teacherFilter) return false
        if (courseFilter !== undefined) {
          const courseId = instanceById.get(p.scheduleInstanceId)?.courseId
          if (courseId !== courseFilter) return false
        }
        return true
      }),
    [payments, teacherFilter, courseFilter, instanceById]
  )

  const openCreate = (): void => {
    setEditing('new')
    form.resetFields()
    form.setFieldsValue({ paymentDate: dayjs(), amountPaid: 0 })
  }

  const openEdit = (p: TeacherPayment): void => {
    setEditing(p)
    form.resetFields()
    form.setFieldsValue({
      teacherId: p.teacherId,
      scheduleInstanceId: p.scheduleInstanceId,
      amountDue: p.amountDue,
      amountPaid: p.amountPaid,
      paymentDate: dayjs(p.paymentDate),
      note: p.note ?? undefined
    })
  }

  /** 选择课程实例后按该实例所属课程的单次课酬标准自动填入应付金额（可手动修改） */
  const handleInstanceChange = (instanceId: number | undefined): void => {
    if (instanceId === undefined) {
      form.setFieldsValue({ amountDue: undefined })
      return
    }
    const courseId = instanceById.get(instanceId)?.courseId
    const pay = courseId !== undefined ? coursePayById.get(courseId) : undefined
    if (pay !== undefined) form.setFieldsValue({ amountDue: pay })
  }

  /**
   * 保存前异常交易检测：后台按财务设置的异常倍数等本地规则校验；
   * 存在异常时弹窗二次确认，"仍然保存"放行、"返回检查"取消本次保存。
   */
  const confirmSaveIfAnomaly = async (amountDue: number, amountPaid: number): Promise<void> => {
    const check = await tryApi(() =>
      api.checkPaymentAnomaly({
        kind: 'teacher',
        id: editing === 'new' ? undefined : (editing as TeacherPayment).id,
        amountPaid,
        amountDue
      })
    )
    if (!check.ok) throw new Error(check.error)
    if (check.data.anomalies.length > 0) {
      await new Promise<void>((resolve, reject) => {
        Modal.confirm({
          title: '异常交易提醒',
          width: 560,
          content: (
            <div>
              {check.data.anomalies.map((a) => (
                <p key={a.message}>⚠️ {a.message}</p>
              ))}
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

  const handleSave = async (): Promise<void> => {
    let values: PaymentFormValues
    try {
      values = await form.validateFields()
    } catch {
      // 校验错误已由表单内联展示
      return
    }
    const payload = {
      teacherId: values.teacherId,
      scheduleInstanceId: values.scheduleInstanceId,
      amountDue: values.amountDue,
      amountPaid: values.amountPaid,
      paymentDate: values.paymentDate.format('YYYY-MM-DD'),
      note: values.note?.trim() || null
    }
    setSaving(true)
    try {
      // 保存前异常检测（通过则继续，异常时用户确认后放行）
      await confirmSaveIfAnomaly(values.amountDue, values.amountPaid)
      const res =
        editing === 'new'
          ? await tryApi(() => api.createTeacherPayment(payload))
          : await tryApi(() => api.updateTeacherPayment((editing as TeacherPayment).id, payload))
      if (!res.ok) throw new Error(res.error)
      message.success(editing === 'new' ? '课酬记录已添加' : '课酬记录已保存')
      setEditing(null)
      await load()
    } catch (err) {
      message.error(getErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (p: TeacherPayment): Promise<void> => {
    try {
      await api.deleteTeacherPayment(p.id)
      message.success('课酬记录已删除')
      await load()
    } catch (err) {
      message.error(getErrorMessage(err))
    }
  }

  /** 自动计算应付：按未取消课程实例批量生成 / 更新（实付金额保持不变） */
  const handleAutoCalc = async (): Promise<void> => {
    setAutoRunning(true)
    try {
      const n = await api.autoCalcTeacherPayments()
      message.success(`已生成/更新 ${n} 条课酬记录`)
      await load()
    } catch (err) {
      message.error(getErrorMessage(err))
    } finally {
      setAutoRunning(false)
    }
  }

  // -------------------------------------------------------------------------
  // 课酬标准（老师默认课酬 / 课次课酬覆盖）
  // -------------------------------------------------------------------------

  /** 打开"课酬标准"弹窗前刷新一次数据，确保展示最新默认课酬与可选实例 */
  const openRateModal = (): void => {
    void load()
    setRateOpen(true)
  }

  /** 编辑某老师默认课酬：Modal.confirm 内含金额输入，二次确认后保存 */
  const openTeacherRateEdit = (teacher: Teacher): void => {
    const store: { value: number } = { value: teacher.defaultRatePerLesson }
    const oldRate = teacher.defaultRatePerLesson
    Modal.confirm({
      title: '修改老师默认课酬',
      width: 480,
      content: <TeacherRateEditor teacherName={teacher.name} oldRate={oldRate} store={store} />,
      okText: '确认修改',
      cancelText: '取消',
      onOk: async (): Promise<void> => {
        const newRate = store.value
        if (newRate === oldRate) return // 数值未变化，无需保存
        try {
          await api.updateTeacherRate(teacher.id, newRate)
          message.success(`已修改 ${teacher.name} 的默认课酬`)
          await load()
        } catch (err) {
          message.error(getErrorMessage(err))
        }
      }
    })
  }

  /** 设置课次课酬覆盖（优先于老师默认课酬与课程标准） */
  const handleSetOverride = (): void => {
    if (overrideInstanceId === undefined) {
      message.warning('请先选择要覆盖的课程实例')
      return
    }
    if (overrideValue === null || overrideValue === undefined) {
      message.warning('请先输入覆盖金额')
      return
    }
    const label = instanceById.get(overrideInstanceId)
      ? instanceLabel(instanceById.get(overrideInstanceId) as ScheduleInstance)
      : `课次#${overrideInstanceId}`
    const value = overrideValue
    Modal.confirm({
      title: '设置课次课酬覆盖',
      width: 520,
      content: (
        <div>
          <p style={{ marginBottom: 4 }}>
            将「{label}」的课酬覆盖为 <b>{fmtMoney(value)}</b>？
          </p>
          <p style={{ color: '#999', fontSize: 12, marginBottom: 0 }}>
            覆盖后，自动计算应付时该课次以此金额为准（代课等场景用），优先于老师默认课酬与课程标准。
          </p>
        </div>
      ),
      okText: '确认设置',
      cancelText: '取消',
      onOk: async (): Promise<void> => {
        try {
          await api.updateInstanceRate(overrideInstanceId, value)
          message.success('课次课酬覆盖已设置')
          await load()
        } catch (err) {
          message.error(getErrorMessage(err))
        }
      }
    })
  }

  /** 清除课次课酬覆盖（恢复为按老师默认课酬 / 课程标准取值） */
  const handleClearOverride = (): void => {
    if (overrideInstanceId === undefined) {
      message.warning('请先选择要清除覆盖的课程实例')
      return
    }
    const label = instanceById.get(overrideInstanceId)
      ? instanceLabel(instanceById.get(overrideInstanceId) as ScheduleInstance)
      : `课次#${overrideInstanceId}`
    Modal.confirm({
      title: '清除课次课酬覆盖',
      width: 520,
      content: (
        <div>
          <p style={{ marginBottom: 0 }}>
            确认清除「{label}」的课酬覆盖？清除后该课次按老师默认课酬 / 课程标准取值。
          </p>
        </div>
      ),
      okText: '确认清除',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: async (): Promise<void> => {
        try {
          await api.updateInstanceRate(overrideInstanceId, null)
          message.success('已清除课次课酬覆盖')
          await load()
        } catch (err) {
          message.error(getErrorMessage(err))
        }
      }
    })
  }

  // -------------------------------------------------------------------------
  // 列表列定义
  // -------------------------------------------------------------------------

  const columns = [
    { title: '老师', dataIndex: 'teacherName', key: 'teacherName', width: 110, render: (v?: string) => v || '—' },
    { title: '课程实例', dataIndex: 'instanceLabel', key: 'instanceLabel', width: 260, render: (v?: string) => v || '—' },
    {
      title: '应付金额',
      dataIndex: 'amountDue',
      key: 'amountDue',
      width: 120,
      align: 'right' as const,
      render: (v: number) => fmtMoney(v)
    },
    {
      title: '标准来源',
      dataIndex: 'rateSource',
      key: 'rateSource',
      width: 130,
      render: (v?: string) => {
        const meta = v !== undefined ? RATE_SOURCE_META[v] : undefined
        if (!meta) return <span style={{ color: '#999' }}>—</span>
        return (
          <Tooltip title={RATE_SOURCE_TIP}>
            <Tag color={meta.color}>{meta.label}</Tag>
          </Tooltip>
        )
      }
    },
    {
      title: '实付金额',
      dataIndex: 'amountPaid',
      key: 'amountPaid',
      width: 120,
      align: 'right' as const,
      render: (v: number) => fmtMoney(v)
    },
    { title: '支付日期', dataIndex: 'paymentDate', key: 'paymentDate', width: 120 },
    { title: '备注', dataIndex: 'note', key: 'note', render: (v: string | null) => v || '—' },
    {
      title: '操作',
      key: 'actions',
      width: 150,
      render: (_: unknown, row: TeacherPayment) => (
        <Space size={4}>
          <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(row)}>
            编辑
          </Button>
          <Popconfirm
            title="确认删除该课酬记录？"
            description="删除后不可恢复。"
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

  /** 当前筛选结果的应付 / 实付合计（四舍五入到分） */
  const totalDue = Math.round(filtered.reduce((s, p) => s + p.amountDue, 0) * 100) / 100
  const totalPaid = Math.round(filtered.reduce((s, p) => s + p.amountPaid, 0) * 100) / 100

  const exportRows = filtered.map((p) => ({
    老师: p.teacherName ?? '',
    课程实例: p.instanceLabel ?? '',
    应付金额: p.amountDue,
    标准来源: (p.rateSource !== undefined ? RATE_SOURCE_META[p.rateSource]?.label : undefined) ?? '',
    实付金额: p.amountPaid,
    支付日期: p.paymentDate,
    备注: p.note ?? ''
  }))

  return (
    <div>
      <PageToolbar
        title="老师课酬"
        leftExtra={
          <Space>
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              placeholder="按老师筛选"
              style={{ width: 160 }}
              value={teacherFilter}
              onChange={(v: number | undefined) => setTeacherFilter(v ?? undefined)}
              options={teachers.map((t) => ({ value: t.id, label: t.name }))}
            />
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              placeholder="按课程筛选"
              style={{ width: 220 }}
              value={courseFilter}
              onChange={(v: number | undefined) => setCourseFilter(v ?? undefined)}
              options={courseOptions}
            />
          </Space>
        }
        actions={
          <Space>
            <Button icon={<DollarOutlined />} onClick={openRateModal}>
              课酬标准
            </Button>
            <ExportExcelButton
              module="老师课酬"
              columns={[
                { header: '老师', key: '老师' },
                { header: '课程实例', key: '课程实例' },
                { header: '应付金额', key: '应付金额' },
                { header: '标准来源', key: '标准来源' },
                { header: '实付金额', key: '实付金额' },
                { header: '支付日期', key: '支付日期' },
                { header: '备注', key: '备注' }
              ]}
              rows={exportRows}
              disabled={filtered.length === 0}
            />
            <Popconfirm
              title="自动计算应付课酬"
              description="为每个未取消的课程实例生成/更新一条课酬记录：应付金额按 课次覆盖 → 老师默认课酬 → 课程标准 的优先级取值；实例有代课老师时，课酬支付给代课老师。已有记录的实付金额保持不变。"
              okText="开始计算"
              cancelText="取消"
              onConfirm={() => handleAutoCalc()}
            >
              <Button icon={<CalculatorOutlined />} loading={autoRunning}>
                自动计算应付
              </Button>
            </Popconfirm>
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              新增记录
            </Button>
          </Space>
        }
      />

      <Table
        rowKey="id"
        loading={loading}
        columns={columns}
        dataSource={filtered}
        pagination={{ pageSize: 20, showTotal: (total) => `共 ${total} 条记录` }}
        summary={() => (
          <Table.Summary.Row>
            <Table.Summary.Cell index={0}>
              <b>合计（{filtered.length} 条）</b>
            </Table.Summary.Cell>
            <Table.Summary.Cell index={1} />
            <Table.Summary.Cell index={2} align="right">
              <b>{fmtMoney(totalDue)}</b>
            </Table.Summary.Cell>
            <Table.Summary.Cell index={3} />
            <Table.Summary.Cell index={4} align="right">
              <b>{fmtMoney(totalPaid)}</b>
            </Table.Summary.Cell>
            <Table.Summary.Cell index={5} colSpan={3} />
          </Table.Summary.Row>
        )}
      />

      {/* 课酬标准弹窗：老师默认课酬 + 课次课酬覆盖 */}
      <Modal
        open={rateOpen}
        title="课酬标准"
        width={760}
        footer={<Button onClick={() => setRateOpen(false)}>关闭</Button>}
        onCancel={() => setRateOpen(false)}
      >
        <Typography.Title level={5} style={{ marginTop: 0 }}>
          老师默认课酬
        </Typography.Title>
        <Typography.Paragraph type="secondary" style={{ marginTop: -8 }}>
          老师在全系统的默认单次课酬（元/次），供"自动计算应付"在无课次覆盖时取用。
        </Typography.Paragraph>
        <Table
          size="small"
          rowKey="id"
          dataSource={teachers}
          pagination={{ pageSize: 6, showTotal: (total) => `共 ${total} 位老师` }}
          columns={[
            { title: '老师', dataIndex: 'name', key: 'name', render: (v: string) => v || '—' },
            {
              title: '默认课酬（元/次）',
              dataIndex: 'defaultRatePerLesson',
              key: 'defaultRatePerLesson',
              width: 180,
              align: 'right' as const,
              render: (v: number) => fmtMoney(v)
            },
            {
              title: '操作',
              key: 'act',
              width: 100,
              render: (_: unknown, row: Teacher) => (
                <Button size="small" icon={<EditOutlined />} onClick={() => openTeacherRateEdit(row)}>
                  编辑
                </Button>
              )
            }
          ]}
        />

        <Typography.Title level={5} style={{ marginTop: 24 }}>
          课次课酬覆盖
        </Typography.Title>
        <Typography.Paragraph type="secondary" style={{ marginTop: -8 }}>
          针对单个课次覆盖课酬（如代课），优先于老师默认课酬与课程标准。设置后点"自动计算应付"即按覆盖金额更新对应课酬记录。
        </Typography.Paragraph>
        <Space wrap>
          <Select
            showSearch
            optionFilterProp="label"
            placeholder="选择要覆盖的课程实例"
            style={{ width: 420 }}
            value={overrideInstanceId}
            onChange={(v: number | undefined) => setOverrideInstanceId(v ?? undefined)}
            options={instances.map((i) => ({ value: i.id, label: instanceLabel(i) }))}
          />
          <InputNumber
            min={0}
            precision={2}
            prefix="¥"
            placeholder="覆盖金额（元）"
            style={{ width: 150 }}
            value={overrideValue}
            onChange={(v: number | null) => setOverrideValue(v)}
          />
          <Button type="primary" onClick={() => handleSetOverride()}>
            设置覆盖
          </Button>
          <Button danger onClick={() => handleClearOverride()}>
            清除覆盖
          </Button>
        </Space>
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>
          {RATE_SOURCE_TIP}。列表"标准来源"列显示各条记录实际采用的取值来源。
        </Typography.Paragraph>
      </Modal>

      {/* 新增 / 编辑弹窗 */}
      <Modal
        open={editing !== null}
        title={editing === 'new' ? '新增课酬记录' : '编辑课酬记录'}
        okText="保存"
        cancelText="取消"
        confirmLoading={saving}
        onOk={() => handleSave()}
        onCancel={() => setEditing(null)}
        width={560}
      >
        <Form form={form} layout="vertical" style={{ marginTop: 8 }}>
          <Form.Item
            name="teacherId"
            label="老师"
            rules={[{ required: true, message: '请选择老师' }]}
          >
            <Select
              showSearch
              optionFilterProp="label"
              placeholder="请选择老师"
              options={teachers.map((t) => ({ value: t.id, label: t.name }))}
            />
          </Form.Item>
          <Form.Item
            name="scheduleInstanceId"
            label="关联课程实例"
            rules={[{ required: true, message: '请选择课程实例' }]}
          >
            <Select
              showSearch
              optionFilterProp="label"
              placeholder="请选择课程实例"
              onChange={(v: number | undefined) => handleInstanceChange(v)}
              options={instances.map((i) => ({ value: i.id, label: instanceLabel(i) }))}
            />
          </Form.Item>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                name="amountDue"
                label="应付金额（元）"
                rules={[{ required: true, message: '请输入应付金额' }]}
              >
                <InputNumber min={0} precision={2} prefix="¥" style={{ width: '100%' }} placeholder="自动填入，可修改" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                name="amountPaid"
                label="实付金额（元）"
                rules={[{ required: true, message: '请输入实付金额' }]}
              >
                <InputNumber min={0} precision={2} prefix="¥" style={{ width: '100%' }} placeholder="请输入实付金额" />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                name="paymentDate"
                label="支付日期"
                rules={[{ required: true, message: '请选择支付日期' }]}
              >
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="note" label="备注">
            <Input.TextArea rows={2} placeholder="其他说明（可选）" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
