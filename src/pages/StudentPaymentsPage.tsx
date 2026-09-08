/**
 * 学生缴费管理（仅财务可见页面）：
 * - 缴费记录列表：学生 / 课程 / 应缴 / 实缴 / 缴费方式 / 缴费日期 / 备注，支持增删改
 * - "自动计算应缴"：根据考勤批量生成 / 更新每个学生每门课的应缴金额（实缴不变）
 * - 按学生、课程筛选；底部合计行展示应缴合计与实缴合计
 * - 新增 / 编辑弹窗：选择学生后限定其报名课程，选择课程后自动带出课程费用
 * - 保存前异常交易检测：调用 checkPaymentAnomaly（本地规则），存在异常时弹窗确认是否仍然保存
 * - 缴费方式选项来自财务角色设置（RoleSettings 收窄后取值），未加载时用默认值兜底
 */
import {
  CalculatorOutlined,
  DeleteOutlined,
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
  Tag
} from 'antd'
import dayjs, { Dayjs } from 'dayjs'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, getErrorMessage, tryApi } from '../api'
import ExportExcelButton from '../components/ExportExcelButton'
import PageToolbar from '../components/PageToolbar'
import type { Course, RoleSettings, Student, StudentPayment } from '../types'

/** 新增/编辑弹窗表单值（日期在表单中为 Dayjs，提交时转 YYYY-MM-DD） */
interface PaymentFormValues {
  studentId: number
  courseId: number
  amountDue: number
  amountPaid: number
  paymentMethod: string
  paymentDate: Dayjs
  note?: string
}

/** 未加载到设置前的默认缴费方式 */
const DEFAULT_PAYMENT_METHODS = ['微信', '转账', '现金']

/** 金额展示：四舍五入到分后以 ¥ 前缀展示 */
const fmtMoney = (v: number): string => `¥${(Math.round(v * 100) / 100).toFixed(2)}`

/** 课程选项文本：科目 年级 班级号 */
const courseLabel = (c: Course): string => `${c.subject} ${c.grade} ${c.className}`

export default function StudentPaymentsPage(): JSX.Element {
  const { message } = AntdApp.useApp()
  const [payments, setPayments] = useState<StudentPayment[]>([])
  const [students, setStudents] = useState<Student[]>([])
  const [courses, setCourses] = useState<Course[]>([])
  /** 当前角色设置（财务角色返回 FinanceSettings，按 role 收窄后读取缴费方式） */
  const [settings, setSettings] = useState<RoleSettings | null>(null)
  const [loading, setLoading] = useState(false)
  /** 筛选条件（undefined 表示不筛选） */
  const [studentFilter, setStudentFilter] = useState<number | undefined>()
  const [courseFilter, setCourseFilter] = useState<number | undefined>()
  /** 弹窗状态：null 关闭，'new' 新增，StudentPayment 编辑 */
  const [editing, setEditing] = useState<StudentPayment | 'new' | null>(null)
  const [form] = Form.useForm<PaymentFormValues>()
  const [saving, setSaving] = useState(false)
  const [autoRunning, setAutoRunning] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const [p, s, c, st] = await Promise.all([
        api.getStudentPayments(),
        api.getStudents(),
        api.getFinanceCourses(),
        api.getSettings()
      ])
      setPayments(p)
      setStudents(s)
      setCourses(c)
      setSettings(st)
    } catch (err) {
      message.error(getErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [message])

  useEffect(() => {
    void load()
  }, [load])

  /** 课程 id → 课程费用，供选择课程后自动填入应缴金额 */
  const courseFeeById = useMemo(() => new Map(courses.map((c) => [c.id, c.fee])), [courses])
  const studentById = useMemo(() => new Map(students.map((s) => [s.id, s])), [students])
  /** 当前表单选中的学生（用于限定其报名课程） */
  const selectedStudentId = (Form.useWatch('studentId', form) ?? undefined) as number | undefined
  /** 缴费方式选项：设置加载完成且角色为财务时取自定义选项，否则用默认值兜底 */
  const paymentMethods =
    settings?.role === 'finance' ? settings.paymentMethods : DEFAULT_PAYMENT_METHODS

  /** 按学生 / 课程客户端过滤（与导出内容一致） */
  const filtered = useMemo(
    () =>
      payments.filter(
        (p) =>
          (studentFilter === undefined || p.studentId === studentFilter) &&
          (courseFilter === undefined || p.courseId === courseFilter)
      ),
    [payments, studentFilter, courseFilter]
  )

  const openCreate = (): void => {
    setEditing('new')
    form.resetFields()
    form.setFieldsValue({
      paymentMethod: paymentMethods[0],
      paymentDate: dayjs(),
      amountPaid: 0
    })
  }

  const openEdit = (p: StudentPayment): void => {
    setEditing(p)
    form.resetFields()
    form.setFieldsValue({
      studentId: p.studentId,
      courseId: p.courseId,
      amountDue: p.amountDue,
      amountPaid: p.amountPaid,
      paymentMethod: p.paymentMethod,
      paymentDate: dayjs(p.paymentDate),
      note: p.note ?? undefined
    })
  }

  /** 切换学生后清空已选课程（应缴由课程费用自动带出） */
  const handleStudentChange = (): void => {
    form.setFieldsValue({ courseId: undefined, amountDue: undefined })
  }

  /** 选择课程后自动填入该课程费用（可手动修改） */
  const handleCourseChange = (courseId: number | undefined): void => {
    if (courseId === undefined) {
      form.setFieldsValue({ amountDue: undefined })
      return
    }
    const fee = courseFeeById.get(courseId)
    if (fee !== undefined) form.setFieldsValue({ amountDue: fee })
  }

  /**
   * 保存前异常交易检测：后台按财务设置的异常倍数等本地规则校验；
   * 存在异常时弹窗二次确认，"仍然保存"放行、"返回检查"取消本次保存。
   */
  const confirmSaveIfAnomaly = async (amountDue: number, amountPaid: number): Promise<void> => {
    const check = await tryApi(() =>
      api.checkPaymentAnomaly({
        kind: 'student',
        id: editing === 'new' ? undefined : (editing as StudentPayment).id,
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
      studentId: values.studentId,
      courseId: values.courseId,
      amountDue: values.amountDue,
      amountPaid: values.amountPaid,
      paymentMethod: values.paymentMethod,
      paymentDate: values.paymentDate.format('YYYY-MM-DD'),
      note: values.note?.trim() || null
    }
    setSaving(true)
    try {
      // 保存前异常检测（通过则继续，异常时用户确认后放行）
      await confirmSaveIfAnomaly(values.amountDue, values.amountPaid)
      const res =
        editing === 'new'
          ? await tryApi(() => api.createStudentPayment(payload))
          : await tryApi(() => api.updateStudentPayment((editing as StudentPayment).id, payload))
      if (!res.ok) throw new Error(res.error)
      message.success(editing === 'new' ? '缴费记录已添加' : '缴费记录已保存')
      setEditing(null)
      await load()
    } catch (err) {
      message.error(getErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (p: StudentPayment): Promise<void> => {
    try {
      await api.deleteStudentPayment(p.id)
      message.success('缴费记录已删除')
      await load()
    } catch (err) {
      message.error(getErrorMessage(err))
    }
  }

  /** 自动计算应缴：根据考勤批量生成/更新（实缴金额保持不变） */
  const handleAutoCalc = async (): Promise<void> => {
    setAutoRunning(true)
    try {
      const n = await api.autoCalcStudentPayments()
      message.success(`已更新 ${n} 个学生课程的应缴金额`)
      await load()
    } catch (err) {
      message.error(getErrorMessage(err))
    } finally {
      setAutoRunning(false)
    }
  }

  const columns = [
    { title: '学生', dataIndex: 'studentName', key: 'studentName', width: 120, render: (v?: string) => v || '—' },
    { title: '课程', dataIndex: 'courseLabel', key: 'courseLabel', width: 200, render: (v?: string) => v || '—' },
    {
      title: '应缴金额',
      dataIndex: 'amountDue',
      key: 'amountDue',
      width: 120,
      align: 'right' as const,
      render: (v: number) => fmtMoney(v)
    },
    {
      title: '实缴金额',
      dataIndex: 'amountPaid',
      key: 'amountPaid',
      width: 120,
      align: 'right' as const,
      render: (v: number) => fmtMoney(v)
    },
    {
      title: '缴费方式',
      dataIndex: 'paymentMethod',
      key: 'paymentMethod',
      width: 110,
      render: (v: string) => <Tag color="blue">{v}</Tag>
    },
    { title: '缴费日期', dataIndex: 'paymentDate', key: 'paymentDate', width: 120 },
    { title: '备注', dataIndex: 'note', key: 'note', render: (v: string | null) => v || '—' },
    {
      title: '操作',
      key: 'actions',
      width: 150,
      render: (_: unknown, row: StudentPayment) => (
        <Space size={4}>
          <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(row)}>
            编辑
          </Button>
          <Popconfirm
            title="确认删除该缴费记录？"
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

  /** 当前筛选结果的应缴 / 实缴合计（四舍五入到分） */
  const totalDue = Math.round(filtered.reduce((s, p) => s + p.amountDue, 0) * 100) / 100
  const totalPaid = Math.round(filtered.reduce((s, p) => s + p.amountPaid, 0) * 100) / 100

  const exportRows = filtered.map((p) => ({
    学生: p.studentName ?? '',
    课程: p.courseLabel ?? '',
    应缴金额: p.amountDue,
    实缴金额: p.amountPaid,
    缴费方式: p.paymentMethod,
    缴费日期: p.paymentDate,
    备注: p.note ?? ''
  }))

  return (
    <div>
      <PageToolbar
        title="学生缴费"
        leftExtra={
          <Space>
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              placeholder="按学生筛选"
              style={{ width: 160 }}
              value={studentFilter}
              onChange={(v: number | undefined) => setStudentFilter(v ?? undefined)}
              options={students.map((s) => ({ value: s.id, label: s.name }))}
            />
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              placeholder="按课程筛选"
              style={{ width: 220 }}
              value={courseFilter}
              onChange={(v: number | undefined) => setCourseFilter(v ?? undefined)}
              options={courses.map((c) => ({ value: c.id, label: courseLabel(c) }))}
            />
          </Space>
        }
        actions={
          <Space>
            <ExportExcelButton
              module="学生缴费"
              columns={[
                { header: '学生', key: '学生' },
                { header: '课程', key: '课程' },
                { header: '应缴金额', key: '应缴金额' },
                { header: '实缴金额', key: '实缴金额' },
                { header: '缴费方式', key: '缴费方式' },
                { header: '缴费日期', key: '缴费日期' },
                { header: '备注', key: '备注' }
              ]}
              rows={exportRows}
              disabled={filtered.length === 0}
            />
            <Popconfirm
              title="自动计算应缴金额"
              description="根据考勤数据批量生成/更新每个学生每门课的应缴金额：出勤计费、请假免费、缺勤按系统设置收费或不收费；已有记录的实缴金额保持不变。"
              okText="开始计算"
              cancelText="取消"
              onConfirm={() => handleAutoCalc()}
            >
              <Button icon={<CalculatorOutlined />} loading={autoRunning}>
                自动计算应缴
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
            <Table.Summary.Cell index={3} align="right">
              <b>{fmtMoney(totalPaid)}</b>
            </Table.Summary.Cell>
            <Table.Summary.Cell index={4} colSpan={4} />
          </Table.Summary.Row>
        )}
      />

      {/* 新增 / 编辑弹窗 */}
      <Modal
        open={editing !== null}
        title={editing === 'new' ? '新增缴费记录' : '编辑缴费记录'}
        okText="保存"
        cancelText="取消"
        confirmLoading={saving}
        onOk={() => handleSave()}
        onCancel={() => setEditing(null)}
        width={560}
      >
        <Form form={form} layout="vertical" style={{ marginTop: 8 }}>
          <Form.Item
            name="studentId"
            label="学生"
            rules={[{ required: true, message: '请选择学生' }]}
          >
            <Select
              showSearch
              optionFilterProp="label"
              placeholder="请选择学生"
              onChange={handleStudentChange}
              options={students.map((s) => ({ value: s.id, label: s.name }))}
            />
          </Form.Item>
          <Form.Item
            name="courseId"
            label="关联课程"
            rules={[{ required: true, message: '请选择课程' }]}
          >
            <Select
              showSearch
              optionFilterProp="label"
              placeholder="请选择该学生所报课程"
              disabled={selectedStudentId === undefined}
              onChange={(v: number | undefined) => handleCourseChange(v)}
              options={
                selectedStudentId === undefined
                  ? []
                  : (studentById.get(selectedStudentId)?.courseIds ?? [])
                      .map((courseId) => courses.find((c) => c.id === courseId))
                      .filter((c): c is Course => c !== undefined)
                      .map((c) => ({ value: c.id, label: courseLabel(c) }))
              }
            />
          </Form.Item>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                name="amountDue"
                label="应缴金额（元）"
                rules={[{ required: true, message: '请输入应缴金额' }]}
              >
                <InputNumber min={0} precision={2} prefix="¥" style={{ width: '100%' }} placeholder="自动填入，可修改" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                name="amountPaid"
                label="实缴金额（元）"
                rules={[{ required: true, message: '请输入实缴金额' }]}
              >
                <InputNumber min={0} precision={2} prefix="¥" style={{ width: '100%' }} placeholder="请输入实缴金额" />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                name="paymentMethod"
                label="缴费方式"
                rules={[{ required: true, message: '请选择缴费方式' }]}
              >
                <Select
                  placeholder="请选择缴费方式"
                  options={paymentMethods.map((m) => ({ value: m, label: m }))}
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                name="paymentDate"
                label="缴费日期"
                rules={[{ required: true, message: '请选择缴费日期' }]}
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
