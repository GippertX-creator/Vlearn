/**
 * 系统设置页（v2：按当前角色分节展示）。
 * 教务角色：基础选项（年级 / 自动排课周数）+ Agent 配置（教务助手）+ 修改密码 + 备份恢复 + 关于
 * 财务角色：基础选项（缴费方式 / 缺勤收费）+ Agent 配置（财务助手）+ 修改密码 + 备份恢复 + 关于
 * 助教角色：大模型 API 配置 + 修改密码 + 备份恢复 + 关于
 * 设置保存在本地 state（RoleSettings 联合类型），各节"保存"按钮统一调用 api.saveSettings 持久化。
 * 密码哈希存储于当前角色数据库的 settings 表中，修改时需先校验旧密码。
 */
import {
  App as AntdApp,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Popconfirm,
  Select,
  Space,
  Spin,
  Switch,
  Typography
} from 'antd'
import { useEffect, useState } from 'react'
import { api, getErrorMessage, tryApi } from '../api'
import { useRole } from '../roleContext'
import type {
  AcademicSettings,
  AssistantSettings,
  FinanceSettings,
  RoleSettings
} from '../types'

interface PasswordFormValues {
  oldPassword: string
  newPassword: string
  confirmPassword: string
}

/** 加载完成前的兜底默认值（各角色独立数据库，字段结构互不相同） */
const DEFAULT_ACADEMIC: AcademicSettings = {
  role: 'academic',
  grades: ['高一', '高二', '高三'],
  scheduleWeeks: 8,
  agentConflictDetect: true,
  agentAttendanceAlert: true,
  agentAttendanceThreshold: 3,
  agentCompletenessHint: true,
  apiUrl: '',
  apiKey: ''
}

const DEFAULT_FINANCE: FinanceSettings = {
  role: 'finance',
  paymentMethods: ['微信', '转账', '现金'],
  chargeAbsent: true,
  agentOverdueAlert: true,
  agentOverdueDays: 7,
  agentAnomalyDetect: true,
  agentAnomalyMultiplier: 2,
  apiUrl: '',
  apiKey: ''
}

const DEFAULT_ASSISTANT: AssistantSettings = {
  role: 'assistant',
  apiUrl: '',
  apiKey: ''
}

/** 各角色设置的默认初始密码提示（首次使用请尽快修改） */
const DEFAULT_PASSWORD_HINTS: Record<RoleSettings['role'], string> = {
  academic: '初始密码为 admin123',
  finance: '初始密码为 admin123',
  assistant: '初始密码为 assistant123'
}

/**
 * 通用"保存设置"：持久化当前角色的完整设置对象（base / agent 各卡共用同一份本地 state）。
 * 所有卡的保存按钮统一调用此逻辑，成功后提示"设置已保存"。
 */
function useSaveSettings(settings: RoleSettings): { saving: boolean; save: () => Promise<void> } {
  const { message } = AntdApp.useApp()
  const [saving, setSaving] = useState(false)

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      const result = await tryApi(() => api.saveSettings(settings))
      if (!result.ok) {
        message.error(result.error)
        return
      }
      message.success('设置已保存')
    } finally {
      setSaving(false)
    }
  }

  return { saving, save }
}

/** 控件上方的小标签（沿用旧版排版风格） */
function FieldLabel({ text }: { text: string }): JSX.Element {
  return (
    <div style={{ marginBottom: 4 }}>
      <Typography.Text strong>{text}</Typography.Text>
    </div>
  )
}

/** 控件下方灰色说明文字 */
function FieldHint({ text }: { text: string }): JSX.Element {
  return (
    <Typography.Paragraph type="secondary" style={{ margin: '6px 0 0', fontSize: 12 }}>
      {text}
    </Typography.Paragraph>
  )
}

// ---------------------------------------------------------------------------
// 教务角色
// ---------------------------------------------------------------------------

/** 教务：基础选项（年级 / 自动排课周数） */
function AcademicBaseCard({
  settings,
  onChange
}: {
  settings: AcademicSettings
  onChange: (s: AcademicSettings) => void
}): JSX.Element {
  const { saving, save } = useSaveSettings(settings)
  return (
    <Card title="基础选项" style={{ marginBottom: 16 }}>
      <div style={{ maxWidth: 520 }}>
        <div style={{ marginBottom: 20 }}>
          <FieldLabel text="年级选项" />
          <Select
            mode="tags"
            style={{ width: '100%' }}
            placeholder="输入新年级后按回车添加"
            value={settings.grades}
            options={settings.grades.map((g) => ({ value: g, label: g }))}
            onChange={(v: string[]) => onChange({ ...settings, grades: v })}
          />
          <FieldHint text="用于课程表单的年级下拉选项。" />
        </div>
        <div style={{ marginBottom: 20 }}>
          <FieldLabel text="自动排课周数" />
          <InputNumber
            min={1}
            max={52}
            precision={0}
            value={settings.scheduleWeeks}
            onChange={(v) => onChange({ ...settings, scheduleWeeks: v ?? 1 })}
            addonAfter="周"
            style={{ width: 200 }}
          />
          <FieldHint text="新建课程（或手动重新生成排课时），系统自动生成未来 N 周的课程实例。" />
        </div>
        <Button type="primary" loading={saving} onClick={() => void save()}>
          保存
        </Button>
      </div>
    </Card>
  )
}

/** 教务：Agent 配置（教务助手） */
function AcademicAgentCard({
  settings,
  onChange
}: {
  settings: AcademicSettings
  onChange: (s: AcademicSettings) => void
}): JSX.Element {
  const { saving, save } = useSaveSettings(settings)
  return (
    <Card title="Agent 配置（教务助手）" style={{ marginBottom: 16 }}>
      <div style={{ maxWidth: 520 }}>
        <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
          可留空；配置大模型后报告将由 AI 润色，冲突检测 / 考勤提醒无需 AI 也可工作。
        </Typography.Paragraph>
        <div style={{ marginBottom: 20 }}>
          <FieldLabel text="API 地址" />
          <Input
            placeholder="如 https://api.deepseek.com/v1"
            value={settings.apiUrl}
            onChange={(e) => onChange({ ...settings, apiUrl: e.target.value })}
          />
        </div>
        <div style={{ marginBottom: 20 }}>
          <FieldLabel text="API 密钥" />
          <Input.Password
            placeholder="请输入 API 密钥（可留空）"
            value={settings.apiKey}
            onChange={(e) => onChange({ ...settings, apiKey: e.target.value })}
          />
        </div>
        <div style={{ marginBottom: 20 }}>
          <FieldLabel text="排课冲突检测" />
          <Switch
            checked={settings.agentConflictDetect}
            onChange={(v: boolean) => onChange({ ...settings, agentConflictDetect: v })}
          />
          <FieldHint text="保存课程或单次调课时，自动检测老师 / 学生的时间冲突。" />
        </div>
        <div style={{ marginBottom: 20 }}>
          <FieldLabel text="考勤异常提醒" />
          <Switch
            checked={settings.agentAttendanceAlert}
            onChange={(v: boolean) => onChange({ ...settings, agentAttendanceAlert: v })}
          />
          <FieldHint text="连续缺勤 / 请假达到阈值次数时在侧边栏提醒。" />
        </div>
        <div style={{ marginBottom: 20 }}>
          <FieldLabel text="考勤异常阈值" />
          <InputNumber
            min={1}
            max={10}
            precision={0}
            value={settings.agentAttendanceThreshold}
            onChange={(v) => onChange({ ...settings, agentAttendanceThreshold: v ?? 3 })}
            addonAfter="次"
            style={{ width: 200 }}
          />
          <FieldHint text="连续缺勤 / 请假达到该次数时提醒。" />
        </div>
        <div style={{ marginBottom: 20 }}>
          <FieldLabel text="信息补全提示" />
          <Switch
            checked={settings.agentCompletenessHint}
            onChange={(v: boolean) => onChange({ ...settings, agentCompletenessHint: v })}
          />
          <FieldHint text="学生 / 老师等基础信息不完整时给出补全建议。" />
        </div>
        <Button type="primary" loading={saving} onClick={() => void save()}>
          保存
        </Button>
      </div>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// 财务角色
// ---------------------------------------------------------------------------

/** 财务：基础选项（缴费方式 / 缺勤是否收费） */
function FinanceBaseCard({
  settings,
  onChange
}: {
  settings: FinanceSettings
  onChange: (s: FinanceSettings) => void
}): JSX.Element {
  const { saving, save } = useSaveSettings(settings)
  return (
    <Card title="基础选项" style={{ marginBottom: 16 }}>
      <div style={{ maxWidth: 520 }}>
        <div style={{ marginBottom: 20 }}>
          <FieldLabel text="缴费方式" />
          <Select
            mode="tags"
            style={{ width: '100%' }}
            placeholder="输入新缴费方式后按回车添加"
            value={settings.paymentMethods}
            options={settings.paymentMethods.map((m) => ({ value: m, label: m }))}
            onChange={(v: string[]) => onChange({ ...settings, paymentMethods: v })}
          />
          <FieldHint text="用于「学生缴费」记录的方式下拉选项。" />
        </div>
        <div style={{ marginBottom: 20 }}>
          <FieldLabel text="缺勤是否收费" />
          <Switch
            checked={settings.chargeAbsent}
            checkedChildren="收费"
            unCheckedChildren="不收费"
            onChange={(v: boolean) => onChange({ ...settings, chargeAbsent: v })}
          />
          <FieldHint text="关闭后缺勤不计入应缴（请假始终不收费）。" />
        </div>
        <Button type="primary" loading={saving} onClick={() => void save()}>
          保存
        </Button>
      </div>
    </Card>
  )
}

/** 财务：Agent 配置（财务助手） */
function FinanceAgentCard({
  settings,
  onChange
}: {
  settings: FinanceSettings
  onChange: (s: FinanceSettings) => void
}): JSX.Element {
  const { saving, save } = useSaveSettings(settings)
  return (
    <Card title="Agent 配置（财务助手）" style={{ marginBottom: 16 }}>
      <div style={{ maxWidth: 520 }}>
        <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
          可留空；配置大模型后智能报表等将由 AI 生成，对账 / 逾期预警 / 异常交易检测无需 AI 也可工作。
        </Typography.Paragraph>
        <div style={{ marginBottom: 20 }}>
          <FieldLabel text="API 地址" />
          <Input
            placeholder="如 https://api.deepseek.com/v1"
            value={settings.apiUrl}
            onChange={(e) => onChange({ ...settings, apiUrl: e.target.value })}
          />
        </div>
        <div style={{ marginBottom: 20 }}>
          <FieldLabel text="API 密钥" />
          <Input.Password
            placeholder="请输入 API 密钥（可留空）"
            value={settings.apiKey}
            onChange={(e) => onChange({ ...settings, apiKey: e.target.value })}
          />
        </div>
        <div style={{ marginBottom: 20 }}>
          <FieldLabel text="缴费逾期预警" />
          <Switch
            checked={settings.agentOverdueAlert}
            onChange={(v: boolean) => onChange({ ...settings, agentOverdueAlert: v })}
          />
          <FieldHint text="存在即将逾期未缴清的缴费记录时在侧边栏提醒。" />
        </div>
        <div style={{ marginBottom: 20 }}>
          <FieldLabel text="逾期预警提前天数" />
          <InputNumber
            min={1}
            max={30}
            precision={0}
            value={settings.agentOverdueDays}
            onChange={(v) => onChange({ ...settings, agentOverdueDays: v ?? 7 })}
            addonAfter="天"
            style={{ width: 200 }}
          />
        </div>
        <div style={{ marginBottom: 20 }}>
          <FieldLabel text="异常交易检测" />
          <Switch
            checked={settings.agentAnomalyDetect}
            onChange={(v: boolean) => onChange({ ...settings, agentAnomalyDetect: v })}
          />
          <FieldHint text="新增 / 修改缴费或课酬记录时，校验是否超出异常金额倍数。" />
        </div>
        <div style={{ marginBottom: 20 }}>
          <FieldLabel text="异常金额倍数" />
          <InputNumber
            min={1}
            max={10}
            precision={0}
            value={settings.agentAnomalyMultiplier}
            onChange={(v) => onChange({ ...settings, agentAnomalyMultiplier: v ?? 2 })}
            addonAfter="倍"
            style={{ width: 200 }}
          />
          <FieldHint text="单笔金额相对应缴 / 应付基准超过该倍数时判定为异常。" />
        </div>
        <Button type="primary" loading={saving} onClick={() => void save()}>
          保存
        </Button>
      </div>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// 助教角色
// ---------------------------------------------------------------------------

/** 助教：大模型 API 配置（生成微信群短信必需） */
function AssistantApiCard({
  settings,
  onChange
}: {
  settings: AssistantSettings
  onChange: (s: AssistantSettings) => void
}): JSX.Element {
  const { saving, save } = useSaveSettings(settings)
  return (
    <Card title="大模型 API 配置" style={{ marginBottom: 16 }}>
      <div style={{ maxWidth: 520 }}>
        <Typography.Paragraph type="warning" style={{ marginTop: 0 }}>
          生成微信群短信必须配置，否则该功能不可用。
        </Typography.Paragraph>
        <div style={{ marginBottom: 20 }}>
          <FieldLabel text="API 地址" />
          <Input
            placeholder="如 https://api.deepseek.com/v1"
            value={settings.apiUrl}
            onChange={(e) => onChange({ ...settings, apiUrl: e.target.value })}
          />
        </div>
        <div style={{ marginBottom: 20 }}>
          <FieldLabel text="API 密钥" />
          <Input.Password
            placeholder="请输入 API 密钥"
            value={settings.apiKey}
            onChange={(e) => onChange({ ...settings, apiKey: e.target.value })}
          />
        </div>
        <Button type="primary" loading={saving} onClick={() => void save()}>
          保存
        </Button>
      </div>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// 各角色通用的卡片：修改密码 / 数据备份与恢复 / 关于
// ---------------------------------------------------------------------------

/** 修改当前角色密码：后端校验旧密码，成功后替换本地哈希 */
function PasswordCard({ hint }: { hint: string }): JSX.Element {
  const { message } = AntdApp.useApp()
  const [form] = Form.useForm<PasswordFormValues>()
  const [changing, setChanging] = useState(false)

  const handleChangePassword = async (values: PasswordFormValues): Promise<void> => {
    setChanging(true)
    try {
      const result = await api.changePassword(values.oldPassword, values.newPassword)
      if (result.success) {
        message.success('密码已修改')
        form.resetFields()
      } else {
        message.error(result.error ?? '密码修改失败')
      }
    } catch (err) {
      message.error(getErrorMessage(err))
    } finally {
      setChanging(false)
    }
  }

  return (
    <Card title="修改密码" style={{ marginBottom: 16 }}>
      <div style={{ maxWidth: 420 }}>
        <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
          {hint}，首次使用请尽快修改。修改时需验证当前密码，新密码至少 6 位。
        </Typography.Paragraph>
        <Form form={form} layout="vertical" onFinish={handleChangePassword} autoComplete="off">
          <Form.Item
            name="oldPassword"
            label="当前密码"
            rules={[{ required: true, message: '请输入当前密码' }]}
          >
            <Input.Password placeholder="请输入当前密码" />
          </Form.Item>
          <Form.Item
            name="newPassword"
            label="新密码"
            rules={[
              { required: true, message: '请输入新密码' },
              { min: 6, message: '新密码至少 6 位' }
            ]}
          >
            <Input.Password placeholder="请输入新密码（至少 6 位）" />
          </Form.Item>
          <Form.Item
            name="confirmPassword"
            label="确认新密码"
            dependencies={['newPassword']}
            rules={[
              { required: true, message: '请再次输入新密码' },
              {
                validator: (_rule: unknown, value: string | undefined) =>
                  !value || form.getFieldValue('newPassword') === value
                    ? Promise.resolve()
                    : Promise.reject(new Error('两次输入的密码不一致'))
              }
            ]}
          >
            <Input.Password placeholder="请再次输入新密码" />
          </Form.Item>
          <Form.Item style={{ marginBottom: 0 }}>
            <Button type="primary" htmlType="submit" loading={changing}>
              修改密码
            </Button>
          </Form.Item>
        </Form>
      </div>
    </Card>
  )
}

/** 数据备份与恢复：教务 / 财务 / 助教三个数据库一并备份或恢复 */
function BackupCard(): JSX.Element {
  const { message } = AntdApp.useApp()

  const handleBackup = async (): Promise<void> => {
    const result = await tryApi(() => api.backupData())
    if (!result.ok) {
      message.error(result.error)
      return
    }
    if (result.data.canceled) return
    if (result.data.success) {
      message.success(`备份成功：${result.data.path ?? ''}`)
    } else {
      message.error(result.data.error ?? '备份失败')
    }
  }

  const handleRestore = async (): Promise<void> => {
    const result = await tryApi(() => api.restoreData())
    if (!result.ok) {
      message.error(result.error)
      return
    }
    if (result.data.canceled) return
    if (result.data.success) {
      message.success('恢复成功，正在刷新数据…')
    } else {
      message.error(result.data.error ?? '恢复失败')
    }
  }

  return (
    <Card title="数据备份与恢复" style={{ marginBottom: 16 }}>
      <div style={{ maxWidth: 520 }}>
        <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
          数据保存在本机 SQLite 数据库中。备份会一次生成教务 / 财务 / 助教三个数据库的备份文件；恢复会覆盖三个数据库的当前数据，建议先手动备份。
        </Typography.Paragraph>
        <Space>
          <Button onClick={() => void handleBackup()}>备份数据</Button>
          <Popconfirm
            title="确认恢复数据？"
            description="恢复将覆盖三个数据库的当前全部数据，需依次选择三个备份文件，成功后软件会自动刷新。"
            okText="恢复"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={() => void handleRestore()}
          >
            <Button danger>恢复数据</Button>
          </Popconfirm>
        </Space>
      </div>
    </Card>
  )
}

/** 关于：应用名称与版本 */
function AboutCard({ appVersion }: { appVersion: string }): JSX.Element {
  return (
    <Card title="关于">
      <Typography.Paragraph style={{ marginBottom: 4 }}>
        <Typography.Text strong>Vlearn</Typography.Text> 教培管理系统 · 版本 {appVersion || '—'}
      </Typography.Paragraph>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
        面向教培机构的本地教务 / 财务 / 助教管理系统。三角色数据分库存储，全部保存在本机，不会上传网络，可离线使用。
      </Typography.Paragraph>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// 页面入口：按当前角色渲染对应分节
// ---------------------------------------------------------------------------

export default function SettingsPage(): JSX.Element {
  const { message } = AntdApp.useApp()
  const role = useRole()
  const [settings, setSettings] = useState<RoleSettings | null>(null)
  const [appVersion, setAppVersion] = useState('')
  const [loading, setLoading] = useState(true)

  // 挂载时并行加载：当前角色设置 + 应用版本
  useEffect(() => {
    let mounted = true
    ;(async () => {
      try {
        const [s, v] = await Promise.all([api.getSettings(), api.getAppVersion()])
        if (mounted) {
          setSettings(s)
          setAppVersion(v)
        }
      } catch (err) {
        message.error(getErrorMessage(err))
      } finally {
        if (mounted) setLoading(false)
      }
    })()
    return () => {
      mounted = false
    }
  }, [message])

  // 从联合类型中收窄出当前角色对应的设置对象（未加载成功时用默认值兜底展示）
  const academicSettings: AcademicSettings = settings?.role === 'academic' ? settings : DEFAULT_ACADEMIC
  const financeSettings: FinanceSettings = settings?.role === 'finance' ? settings : DEFAULT_FINANCE
  const assistantSettings: AssistantSettings = settings?.role === 'assistant' ? settings : DEFAULT_ASSISTANT

  // 各角色切换时页面只渲染一次，未登录（role null）按教务展示
  const currentRole: RoleSettings['role'] = role === 'finance' ? 'finance' : role === 'assistant' ? 'assistant' : 'academic'

  return (
    <Spin spinning={loading}>
      <div style={{ maxWidth: 760 }}>
        {currentRole === 'finance' ? (
          <>
            <FinanceBaseCard settings={financeSettings} onChange={(s) => setSettings(s)} />
            <FinanceAgentCard settings={financeSettings} onChange={(s) => setSettings(s)} />
            <PasswordCard hint={DEFAULT_PASSWORD_HINTS.finance} />
            <BackupCard />
            <AboutCard appVersion={appVersion} />
          </>
        ) : currentRole === 'assistant' ? (
          <>
            <AssistantApiCard settings={assistantSettings} onChange={(s) => setSettings(s)} />
            <PasswordCard hint={DEFAULT_PASSWORD_HINTS.assistant} />
            <BackupCard />
            <AboutCard appVersion={appVersion} />
          </>
        ) : (
          <>
            <AcademicBaseCard settings={academicSettings} onChange={(s) => setSettings(s)} />
            <AcademicAgentCard settings={academicSettings} onChange={(s) => setSettings(s)} />
            <PasswordCard hint={DEFAULT_PASSWORD_HINTS.academic} />
            <BackupCard />
            <AboutCard appVersion={appVersion} />
          </>
        )}
      </div>
    </Spin>
  )
}
