/**
 * 学生缴费管理（仅财务可见页面）：
 * - 缴费记录列表：学生 / 课程 / 应缴 / 锁定 / 实缴 / 缴费方式 / 缴费日期 / 备注，支持增删改
 * - "自动计算应缴"：根据考勤批量生成 / 更新每个学生每门课的应缴金额（实缴不变，锁定记录不覆盖）
 * - 按学生、课程筛选；底部合计行展示应缴合计与实缴合计
 * - 新增 / 编辑弹窗：选择学生后限定其报名课程，选择课程后自动带出课程费用
 * - 保存前异常交易检测：调用 checkPaymentAnomaly（本地规则），存在异常时弹窗确认是否仍然保存
 * - 缴费方式选项来自财务角色设置（RoleSettings 收窄后取值），未加载时用默认值兜底
 *
 * v4 新增：
 * - 记录锁定：主进程在实缴 > 0 时自动锁定；页面展示"锁定"列并可手动锁定 / 解锁（均二次确认）
 * - "个性化费用"：弹窗管理每名学生在每门课的单价 / 折扣类型 / 赠送课时（upsert / delete）
 * - "退费 / 转课 / 暂停"：弹窗内对选中的学生-课程执行暂停 / 恢复 / 退费 / 转课
 * - 所有变更成功后派发 vlearn:refresh-alerts，刷新侧边栏 Agent 提醒
 */
import {
  CalculatorOutlined,
  DeleteOutlined,
  EditOutlined,
  LockOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  SwapOutlined,
  TagsOutlined,
  UnlockOutlined
} from '@ant-design/icons'
import {
  App as AntdApp,
  Button,
  Card,
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
import type { Course, RoleSettings, Student, StudentCourseFee, StudentPayment } from '../types'

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

/** 个性化费用表单值（学生/课程由 Select 选择，编辑既有费用时二者锁定不可改） */
interface FeeFormValues {
  studentId: number
  courseId: number
  unitPrice: number
  discountType: string
  freeLessons: number
  note?: string
}

/** 未加载到设置前的默认缴费方式 */
const DEFAULT_PAYMENT_METHODS = ['微信', '转账', '现金']

/** 金额展示：四舍五入到分后以 ¥ 前缀展示 */
const fmtMoney = (v: number): string => `¥${(Math.round(v * 100) / 100).toFixed(2)}`

/** 课程选项文本：科目 年级 班级号 */
const courseLabel = (c: Course): string => `${c.subject} ${c.grade} ${c.className}`

/** 折扣类型选项（值存库，展示名用于弹窗与列表） */
const DISCOUNT_OPTIONS: { value: string; label: string; color?: string }[] = [
  { value: 'none', label: '无折扣' },
  { value: 'old_student', label: '老生优惠', color: 'blue' },
  { value: 'group_buy', label: '团报优惠', color: 'geekblue' },
  { value: 'gift', label: '赠送', color: 'gold' },
  { value: 'other', label: '其他' }
]

/** 折扣类型值 → 展示元信息（未知值按"无折扣"兜底） */
const discountMeta = (v: string): { value: string; label: string; color?: string } =>
  DISCOUNT_OPTIONS.find((o) => o.value === v) ?? DISCOUNT_OPTIONS[0]

export default function StudentPaymentsPage(): JSX.Element {
  const { message } = AntdApp.useApp()
  const [payments, setPayments] = useState<StudentPayment[]>([])
  const [students, setStudents] = useState<Student[]>([])
  const [courses, setCourses] = useState<Course[]>([])
  /** 个性化费用列表（v4，与缴费记录并行加载） */
  const [fees, setFees] = useState<StudentCourseFee[]>([])
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

  // ---------- 个性化费用弹窗（v4） ----------
  const [feeManagerOpen, setFeeManagerOpen] = useState(false)
  /** 费用表单是否展开（新增 / 编辑共用）；feeEditing 非空表示编辑既有记录 */
  const [feeFormVisible, setFeeFormVisible] = useState(false)
  const [feeEditing, setFeeEditing] = useState<StudentCourseFee | null>(null)
  const [feeForm] = Form.useForm<FeeFormValues>()
  const [feeSaving, setFeeSaving] = useState(false)

  // ---------- 退费 / 转课 / 暂停弹窗（v4） ----------
  const [lifecycleOpen, setLifecycleOpen] = useState(false)
  const [lifecycleStudentId, setLifecycleStudentId] = useState<number | undefined>(undefined)
  const [lifecycleCourseId, setLifecycleCourseId] = useState<number | undefined>(undefined)
  /** 转课目标课程 */
  const [transferTargetId, setTransferTargetId] = useState<number | undefined>(undefined)
  /** 退费 / 转课执行中（防重复点击） */
  const [lifecycleBusy, setLifecycleBusy] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const [p, s, c, st, f] = await Promise.all([
        api.getStudentPayments(),
        api.getStudents(),
        api.getFinanceCourses(),
        api.getSettings(),
        api.getStudentCourseFees()
      ])
      setPayments(p)
      setStudents(s)
      setCourses(c)
      setSettings(st)
      setFees(f)
    } catch (err) {
      message.error(getErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [message])

  useEffect(() => {
    void load()
  }, [load])

  /** 数据变更成功后通知侧边栏 Agent 刷新提醒 */
  const notifyAlertsRefresh = (): void => {
    window.dispatchEvent(new CustomEvent('vlearn:refresh-alerts'))
  }

  /** 课程 id → 课程对象 / 课程费用，供选项回填与名称展示 */
  const courseById = useMemo(() => new Map(courses.map((c) => [c.id, c])), [courses])
  const courseFeeById = useMemo(() => new Map(courses.map((c) => [c.id, c.fee])), [courses])
  const studentById = useMemo(() => new Map(students.map((s) => [s.id, s])), [students])

  /** 某学生报名的课程下拉选项（缴费弹窗 / 个性化费用 / 状态弹窗复用） */
  const courseOptionsOf = (studentId: number | undefined): { value: number; label: string }[] => {
    if (studentId === undefined) return []
    const ids = new Set(studentById.get(studentId)?.courseIds ?? [])
    return courses.filter((c) => ids.has(c.id)).map((c) => ({ value: c.id, label: courseLabel(c) }))
  }

  /** 当前表单选中的学生（用于限定其报名课程） */
  const selectedStudentId = (Form.useWatch('studentId', form) ?? undefined) as number | undefined
  /** 个性化费用表单当前选中的学生（限定其报名课程） */
  const feeFormStudentId = (Form.useWatch('studentId', feeForm) ?? undefined) as number | undefined
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
      // 实缴 > 0 的记录由主进程自动锁定（不参与自动重算）
      message.success(
        `${editing === 'new' ? '缴费记录已添加' : '缴费记录已保存'}；已实缴的记录将自动锁定`
      )
      setEditing(null)
      await load()
      notifyAlertsRefresh()
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

  /** 自动计算应缴：根据考勤批量生成/更新（实缴金额保持不变，锁定记录跳过） */
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

  // ---------- 锁定 / 解锁 ----------

  /** 锁定 / 解锁单条缴费记录（列表操作列按钮，Popconfirm 已二次确认） */
  const handleToggleLock = async (p: StudentPayment, locked: boolean): Promise<void> => {
    try {
      await api.updateStudentPaymentLock(p.id, locked)
      message.success(locked ? '记录已锁定，不再参与自动重算' : '记录已解锁，可参与自动重算')
      await load()
    } catch (err) {
      message.error(getErrorMessage(err))
    }
  }

  // ---------- 学生课程状态：暂停 / 恢复 ----------

  /** 暂停 / 恢复学生课程（行内按钮与状态弹窗共用） */
  const handleSetCourseStatus = async (
    studentId: number,
    courseId: number,
    status: 'active' | 'paused'
  ): Promise<void> => {
    try {
      await api.updateStudentCourseStatus(studentId, courseId, status)
      message.success(
        status === 'paused' ? '课程已暂停：暂停期间不参与考勤与计费' : '课程已恢复：正常参与考勤与计费'
      )
      await load()
      notifyAlertsRefresh()
    } catch (err) {
      message.error(getErrorMessage(err))
    }
  }

  // ---------- 学生个性化费用（v4） ----------

  const openFeeManager = (): void => {
    setFeeManagerOpen(true)
  }

  const closeFeeManager = (): void => {
    setFeeManagerOpen(false)
    setFeeFormVisible(false)
    setFeeEditing(null)
  }

  /** 打开"新增个性化费用"表单 */
  const openFeeCreate = (): void => {
    setFeeEditing(null)
    feeForm.resetFields()
    feeForm.setFieldsValue({ discountType: 'none', freeLessons: 0 })
    setFeeFormVisible(true)
  }

  /** 打开"编辑个性化费用"表单（学生 / 课程锁定，避免游离的旧配对记录残留） */
  const openFeeEdit = (f: StudentCourseFee): void => {
    setFeeEditing(f)
    feeForm.resetFields()
    feeForm.setFieldsValue({
      studentId: f.studentId,
      courseId: f.courseId,
      unitPrice: f.unitPrice,
      discountType: f.discountType,
      freeLessons: f.freeLessons,
      note: f.note ?? undefined
    })
    setFeeFormVisible(true)
  }

  const closeFeeForm = (): void => {
    setFeeFormVisible(false)
    setFeeEditing(null)
  }

  /** 保存个性化费用：Modal.confirm 二次确认（展示单价 / 折扣 / 赠送课时）后 upsert */
  const handleSaveFee = async (): Promise<void> => {
    let values: FeeFormValues
    try {
      values = await feeForm.validateFields()
    } catch {
      // 校验错误已由表单内联展示
      return
    }
    // 编辑既有费用时学生 / 课程不可改，取原记录值，避免旧配对残留
    const studentId = feeEditing ? feeEditing.studentId : values.studentId
    const courseId = feeEditing ? feeEditing.courseId : values.courseId
    const student = studentById.get(studentId)
    const course = courseById.get(courseId)
    if (!student || !course) return
    const unitPrice = Math.round((Number(values.unitPrice) || 0) * 100) / 100
    const freeLessons = Math.max(0, Math.floor(Number(values.freeLessons) || 0))
    const confirmed = await new Promise<boolean>((resolve) => {
      Modal.confirm({
        title: feeEditing ? '确认修改个性化费用' : '确认新增个性化费用',
        content: (
          <div>
            <p>
              确认设置 <b>{student.name}</b> 在 <b>{courseLabel(course)}</b> 的费用吗？
            </p>
            <p>
              单价 ¥{unitPrice.toFixed(2)}/次、折扣类型 {discountMeta(values.discountType).label}、赠送{' '}
              {freeLessons} 次
            </p>
          </div>
        ),
        okText: '确认保存',
        cancelText: '取消',
        onOk: () => resolve(true),
        onCancel: () => resolve(false)
      })
    })
    if (!confirmed) return
    setFeeSaving(true)
    try {
      await api.upsertStudentCourseFee({
        studentId,
        courseId,
        unitPrice,
        discountType: values.discountType,
        freeLessons,
        note: values.note?.trim() || null
      })
      message.success(feeEditing ? '个性化费用已更新' : '个性化费用已保存')
      closeFeeForm()
      await load()
      notifyAlertsRefresh()
    } catch (err) {
      message.error(getErrorMessage(err))
    } finally {
      setFeeSaving(false)
    }
  }

  const handleDeleteFee = async (f: StudentCourseFee): Promise<void> => {
    try {
      await api.deleteStudentCourseFee(f.studentId, f.courseId)
      message.success('个性化费用已删除')
      await load()
      notifyAlertsRefresh()
    } catch (err) {
      message.error(getErrorMessage(err))
    }
  }

  // ---------- 退费 / 转课 / 暂停（v4） ----------

  const openLifecycle = (): void => {
    setLifecycleStudentId(undefined)
    setLifecycleCourseId(undefined)
    setTransferTargetId(undefined)
    setLifecycleOpen(true)
  }

  const closeLifecycle = (): void => {
    if (lifecycleBusy) return
    setLifecycleOpen(false)
  }

  /** 状态弹窗内切换学生：清空已选课程与转课目标 */
  const handleLifecycleStudentChange = (v: number | undefined): void => {
    setLifecycleStudentId(v ?? undefined)
    setLifecycleCourseId(undefined)
    setTransferTargetId(undefined)
  }

  /** 状态弹窗内切换课程：清空转课目标 */
  const handleLifecycleCourseChange = (v: number | undefined): void => {
    setLifecycleCourseId(v ?? undefined)
    setTransferTargetId(undefined)
  }

  /** 退费：Modal.confirm 强提示 → refundStudentCourse → 展示退费明细并刷新 */
  const handleRefund = async (): Promise<void> => {
    if (lifecycleStudentId === undefined || lifecycleCourseId === undefined) return
    const student = studentById.get(lifecycleStudentId)
    const course = courseById.get(lifecycleCourseId)
    const confirmed = await new Promise<boolean>((resolve) => {
      Modal.confirm({
        title: '确认退费？',
        width: 520,
        content: (
          <div>
            <p>
              将对 <b>{student?.name ?? '—'}</b> 在 <b>{course ? courseLabel(course) : '—'}</b> 的课程进行退费：
            </p>
            <p>
              系统按「已缴总额 − 已消耗费用（计费次数 × 单价）」计算应退金额，生成负数实缴记录，并将课程状态置为
              <b>已退费</b>。
            </p>
            <p style={{ color: '#cf1322' }}>该操作不可撤销，请谨慎确认。</p>
          </div>
        ),
        okText: '确认退费',
        okButtonProps: { danger: true },
        cancelText: '取消',
        onOk: () => resolve(true),
        onCancel: () => resolve(false)
      })
    })
    if (!confirmed) return
    setLifecycleBusy(true)
    try {
      const r = await api.refundStudentCourse(lifecycleStudentId, lifecycleCourseId)
      message.success(
        `已退费 ${fmtMoney(r.refund)}（已缴 ${fmtMoney(r.paid)} − 已消耗 ${fmtMoney(r.consumed)}），课程状态已置为已退费`
      )
      await load()
      notifyAlertsRefresh()
    } catch (err) {
      message.error(getErrorMessage(err))
    } finally {
      setLifecycleBusy(false)
    }
  }

  /** 转课：Modal.confirm → transferStudentCourse → 按余额正负展示补缴 / 退还结果 */
  const handleTransfer = async (): Promise<void> => {
    if (
      lifecycleStudentId === undefined ||
      lifecycleCourseId === undefined ||
      transferTargetId === undefined
    )
      return
    const student = studentById.get(lifecycleStudentId)
    const fromCourse = courseById.get(lifecycleCourseId)
    const toCourse = courseById.get(transferTargetId)
    if (!student || !fromCourse || !toCourse) return
    const confirmed = await new Promise<boolean>((resolve) => {
      Modal.confirm({
        title: '确认转课？',
        width: 560,
        content: (
          <div>
            <p>
              将学生 <b>{student.name}</b> 从 <b>{courseLabel(fromCourse)}</b> 转至{' '}
              <b>{courseLabel(toCourse)}</b>。
            </p>
            <p>原课程余额自动结清（正数补缴 / 负数退还），新课程将自动建立报名关联。</p>
          </div>
        ),
        okText: '确认转课',
        cancelText: '取消',
        onOk: () => resolve(true),
        onCancel: () => resolve(false)
      })
    })
    if (!confirmed) return
    setLifecycleBusy(true)
    try {
      const { balance } = await api.transferStudentCourse(
        lifecycleStudentId,
        lifecycleCourseId,
        transferTargetId,
        null
      )
      message.success(
        balance >= 0
          ? `需补缴 ${fmtMoney(balance)}，已生成结清记录`
          : `退还 ${fmtMoney(-balance)}，已生成结清记录`
      )
      await load()
      notifyAlertsRefresh()
    } catch (err) {
      message.error(getErrorMessage(err))
    } finally {
      setLifecycleBusy(false)
    }
  }

  // ---------- 表格列 ----------

  const columns = [
    { title: '学生', dataIndex: 'studentName', key: 'studentName', width: 120, render: (v?: string) => v || '—' },
    { title: '课程', dataIndex: 'courseLabel', key: 'courseLabel', width: 190, render: (v?: string) => v || '—' },
    {
      title: '应缴金额',
      dataIndex: 'amountDue',
      key: 'amountDue',
      width: 110,
      align: 'right' as const,
      render: (v: number) => fmtMoney(v)
    },
    {
      title: '锁定',
      key: 'locked',
      width: 90,
      align: 'center' as const,
      render: (_: unknown, row: StudentPayment) =>
        row.isLocked === 1 ? (
          <Tooltip title="已实缴或手动锁定，不参与自动重算">
            <Tag color="gold">已锁定</Tag>
          </Tooltip>
        ) : (
          <Tag>未锁定</Tag>
        )
    },
    {
      title: '实缴金额',
      dataIndex: 'amountPaid',
      key: 'amountPaid',
      width: 110,
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
      width: 250,
      render: (_: unknown, row: StudentPayment) => (
        <Space size={4}>
          <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(row)}>
            编辑
          </Button>
          {row.isLocked === 1 ? (
            <Popconfirm
              title="确认解锁该记录？"
              description="解锁后该记录将参与自动重算，应缴金额可能被自动覆盖。"
              okText="解锁"
              cancelText="取消"
              onConfirm={() => handleToggleLock(row, false)}
            >
              <Button size="small" icon={<UnlockOutlined />}>
                解锁
              </Button>
            </Popconfirm>
          ) : (
            <Popconfirm
              title="确认锁定该记录？"
              description="锁定后该记录不参与自动重算（已实缴的记录保存后默认锁定）。"
              okText="锁定"
              cancelText="取消"
              onConfirm={() => handleToggleLock(row, true)}
            >
              <Button size="small" icon={<LockOutlined />}>
                锁定
              </Button>
            </Popconfirm>
          )}
          <Popconfirm
            title="确认暂停该生此课程？"
            description={`${row.studentName ?? ''} 在 ${row.courseLabel ?? ''} 暂停期间不参与考勤与计费。`}
            okText="暂停"
            cancelText="取消"
            onConfirm={() => handleSetCourseStatus(row.studentId, row.courseId, 'paused')}
          >
            <Button size="small" icon={<PauseCircleOutlined />}>
              暂停
            </Button>
          </Popconfirm>
          <Popconfirm
            title="确认恢复该生此课程？"
            description={`${row.studentName ?? ''} 在 ${row.courseLabel ?? ''} 恢复后正常参与考勤与计费。`}
            okText="恢复"
            cancelText="取消"
            onConfirm={() => handleSetCourseStatus(row.studentId, row.courseId, 'active')}
          >
            <Button size="small" icon={<PlayCircleOutlined />}>
              恢复
            </Button>
          </Popconfirm>
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
    锁定状态: p.isLocked === 1 ? '已锁定' : '未锁定',
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
                { header: '锁定状态', key: '锁定状态' },
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
              description="根据考勤数据批量生成/更新每个学生每门课的应缴金额：出勤计费、请假免费、缺勤按系统设置收费或不收费；已有记录的实缴金额保持不变，已锁定的记录不会被覆盖。"
              okText="开始计算"
              cancelText="取消"
              onConfirm={() => handleAutoCalc()}
            >
              <Button icon={<CalculatorOutlined />} loading={autoRunning}>
                自动计算应缴
              </Button>
            </Popconfirm>
            <Button icon={<TagsOutlined />} onClick={openFeeManager}>
              个性化费用
            </Button>
            <Button icon={<SwapOutlined />} onClick={openLifecycle}>
              退费/转课/暂停
            </Button>
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
        scroll={{ x: 1250 }}
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
            <Table.Summary.Cell index={5} colSpan={4} />
          </Table.Summary.Row>
        )}
      />

      {/* 新增 / 编辑缴费记录弹窗（v3 保留） */}
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
              options={courseOptionsOf(selectedStudentId)}
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

      {/* 学生个性化费用弹窗（v4） */}
      <Modal
        open={feeManagerOpen}
        title="学生个性化费用"
        width={860}
        onCancel={closeFeeManager}
        footer={null}
      >
        <div style={{ maxHeight: '68vh', overflowY: 'auto' }}>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
            未设置个性化费用的学生按课程标准费用计费；自动计算应缴 = max(0, 计费次数 − 赠送课时) × 单价。
          </Typography.Paragraph>
          {feeFormVisible ? (
            <Card size="small" style={{ marginBottom: 12 }} title={feeEditing ? '编辑个性化费用' : '新增个性化费用'}>
              <Form form={feeForm} layout="vertical">
                <Row gutter={12}>
                  <Col span={7}>
                    <Form.Item
                      name="studentId"
                      label="学生"
                      rules={[{ required: true, message: '请选择学生' }]}
                    >
                      <Select
                        showSearch
                        optionFilterProp="label"
                        placeholder="请选择学生"
                        disabled={feeEditing !== null}
                        options={students.map((s) => ({ value: s.id, label: s.name }))}
                      />
                    </Form.Item>
                  </Col>
                  <Col span={10}>
                    <Form.Item
                      name="courseId"
                      label="课程"
                      rules={[{ required: true, message: '请选择课程' }]}
                    >
                      <Select
                        showSearch
                        optionFilterProp="label"
                        placeholder="请选择该学生所报课程"
                        disabled={feeEditing !== null || feeFormStudentId === undefined}
                        options={courseOptionsOf(feeFormStudentId)}
                      />
                    </Form.Item>
                  </Col>
                  <Col span={7}>
                    <Form.Item
                      name="unitPrice"
                      label="单价（元/次）"
                      rules={[{ required: true, message: '请输入单价' }]}
                    >
                      <InputNumber min={0} precision={2} prefix="¥" style={{ width: '100%' }} placeholder="每次课费用" />
                    </Form.Item>
                  </Col>
                </Row>
                <Row gutter={12}>
                  <Col span={7}>
                    <Form.Item
                      name="discountType"
                      label="折扣类型"
                      rules={[{ required: true, message: '请选择折扣类型' }]}
                    >
                      <Select options={DISCOUNT_OPTIONS} />
                    </Form.Item>
                  </Col>
                  <Col span={7}>
                    <Form.Item name="freeLessons" label="赠送课时（次）">
                      <InputNumber min={0} precision={0} style={{ width: '100%' }} placeholder="0" />
                    </Form.Item>
                  </Col>
                  <Col span={10}>
                    <Form.Item name="note" label="备注">
                      <Input placeholder="其他说明（可选）" />
                    </Form.Item>
                  </Col>
                </Row>
                <Space>
                  <Button type="primary" loading={feeSaving} onClick={() => handleSaveFee()}>
                    保存
                  </Button>
                  <Button onClick={closeFeeForm}>取消</Button>
                </Space>
              </Form>
            </Card>
          ) : (
            <Button type="primary" icon={<PlusOutlined />} style={{ marginBottom: 12 }} onClick={openFeeCreate}>
              新增个性化费用
            </Button>
          )}
          <Table
            rowKey="id"
            size="small"
            loading={loading}
            dataSource={fees}
            pagination={false}
            columns={[
              { title: '学生', dataIndex: 'studentName', key: 'studentName', width: 120, render: (v?: string) => v || '—' },
              { title: '课程', dataIndex: 'courseLabel', key: 'courseLabel', width: 200, render: (v?: string) => v || '—' },
              {
                title: '单价（元/次）',
                dataIndex: 'unitPrice',
                key: 'unitPrice',
                width: 120,
                align: 'right' as const,
                render: (v: number) => fmtMoney(v)
              },
              {
                title: '折扣类型',
                dataIndex: 'discountType',
                key: 'discountType',
                width: 110,
                render: (v: string) => {
                  const meta = discountMeta(v)
                  return <Tag color={meta.color}>{meta.label}</Tag>
                }
              },
              {
                title: '赠送课时',
                dataIndex: 'freeLessons',
                key: 'freeLessons',
                width: 100,
                render: (v: number) => `${v} 次`
              },
              { title: '备注', dataIndex: 'note', key: 'note', render: (v: string | null) => v || '—' },
              {
                title: '操作',
                key: 'actions',
                width: 130,
                render: (_: unknown, f: StudentCourseFee) => (
                  <Space size={4}>
                    <Button size="small" icon={<EditOutlined />} onClick={() => openFeeEdit(f)}>
                      编辑
                    </Button>
                    <Popconfirm
                      title="确认删除该个性化费用？"
                      description="删除后该学生此课程将按课程标准费用计费。"
                      okText="删除"
                      cancelText="取消"
                      okButtonProps={{ danger: true }}
                      onConfirm={() => handleDeleteFee(f)}
                    >
                      <Button size="small" danger icon={<DeleteOutlined />} />
                    </Popconfirm>
                  </Space>
                )
              }
            ]}
          />
        </div>
      </Modal>

      {/* 退费 / 转课 / 暂停弹窗（v4） */}
      <Modal
        open={lifecycleOpen}
        title="退费 / 转课 / 暂停"
        width={720}
        onCancel={closeLifecycle}
        footer={null}
      >
        <div style={{ maxHeight: '68vh', overflowY: 'auto' }}>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
            请先选择学生与其报名课程，再执行下方操作。系统无课程状态列表接口，暂停 / 恢复按钮为幂等操作，可安全重复点击。
          </Typography.Paragraph>
          <Row gutter={12} style={{ marginBottom: 12 }}>
            <Col span={12}>
              <Typography.Text strong>学生</Typography.Text>
              <Select
                allowClear
                showSearch
                optionFilterProp="label"
                placeholder="请选择学生"
                style={{ width: '100%' }}
                value={lifecycleStudentId}
                onChange={(v: number | undefined) => handleLifecycleStudentChange(v)}
                options={students.map((s) => ({ value: s.id, label: s.name }))}
              />
            </Col>
            <Col span={12}>
              <Typography.Text strong>课程</Typography.Text>
              <Select
                allowClear
                showSearch
                optionFilterProp="label"
                placeholder="请选择该学生所报课程"
                style={{ width: '100%' }}
                disabled={lifecycleStudentId === undefined}
                value={lifecycleCourseId}
                onChange={(v: number | undefined) => handleLifecycleCourseChange(v)}
                options={courseOptionsOf(lifecycleStudentId)}
              />
            </Col>
          </Row>

          <Card size="small" title="课程状态（暂停 / 恢复）" style={{ marginBottom: 12 }}>
            <Space wrap>
              <Popconfirm
                title="确认暂停课程？"
                description="暂停期间该学生不参与考勤与计费（若已暂停可忽略本操作）。"
                okText="暂停"
                cancelText="取消"
                disabled={lifecycleCourseId === undefined || lifecycleBusy}
                onConfirm={() =>
                  lifecycleStudentId !== undefined &&
                  lifecycleCourseId !== undefined &&
                  handleSetCourseStatus(lifecycleStudentId, lifecycleCourseId, 'paused')
                }
              >
                <Button
                  icon={<PauseCircleOutlined />}
                  disabled={lifecycleStudentId === undefined || lifecycleCourseId === undefined || lifecycleBusy}
                >
                  暂停课程
                </Button>
              </Popconfirm>
              <Popconfirm
                title="确认恢复课程？"
                description="恢复后该学生正常参与考勤与计费（若未暂停可忽略本操作）。"
                okText="恢复"
                cancelText="取消"
                disabled={lifecycleCourseId === undefined || lifecycleBusy}
                onConfirm={() =>
                  lifecycleStudentId !== undefined &&
                  lifecycleCourseId !== undefined &&
                  handleSetCourseStatus(lifecycleStudentId, lifecycleCourseId, 'active')
                }
              >
                <Button
                  icon={<PlayCircleOutlined />}
                  disabled={lifecycleStudentId === undefined || lifecycleCourseId === undefined || lifecycleBusy}
                >
                  恢复课程
                </Button>
              </Popconfirm>
            </Space>
          </Card>

          <Card size="small" title="退费" style={{ marginBottom: 12 }}>
            <Space direction="vertical" style={{ width: '100%' }} size={8}>
              <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
                按「已缴总额 − 已消耗费用」计算应退金额并生成负数实缴记录，课程状态置为已退费，不可撤销。
              </Typography.Paragraph>
              <Button
                danger
                icon={<DeleteOutlined />}
                loading={lifecycleBusy}
                disabled={lifecycleStudentId === undefined || lifecycleCourseId === undefined}
                onClick={() => handleRefund()}
              >
                退费
              </Button>
            </Space>
          </Card>

          <Card size="small" title="转课">
            <Space direction="vertical" style={{ width: '100%' }} size={8}>
              <Select
                allowClear
                showSearch
                optionFilterProp="label"
                placeholder="选择目标课程"
                style={{ width: '100%' }}
                disabled={lifecycleCourseId === undefined}
                value={transferTargetId}
                onChange={(v: number | undefined) => setTransferTargetId(v ?? undefined)}
                options={courses
                  .filter((c) => c.id !== lifecycleCourseId)
                  .map((c) => ({ value: c.id, label: courseLabel(c) }))}
              />
              <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
                原课程余额自动结清（正数补缴 / 负数退还），新课程自动建立报名关联。
              </Typography.Paragraph>
              <Button
                icon={<SwapOutlined />}
                loading={lifecycleBusy}
                disabled={
                  lifecycleStudentId === undefined ||
                  lifecycleCourseId === undefined ||
                  transferTargetId === undefined
                }
                onClick={() => handleTransfer()}
              >
                确认转课
              </Button>
            </Space>
          </Card>
        </div>
      </Modal>
    </div>
  )
}
