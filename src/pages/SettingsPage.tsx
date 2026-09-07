/**
 * 系统设置页：年级 / 缴费方式选项、排课与收费业务规则、财务密码修改、数据备份与恢复、关于信息。
 * 设置以 Card 分节展示，所有状态本地管理（切换导航后组件仍保留自身 state）。
 * 财务密码哈希存储于本地 settings 表中，修改时需先校验旧密码。
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
import type { AppSettings } from '../types'

interface PasswordFormValues {
  oldPassword: string
  newPassword: string
  confirmPassword: string
}

/** 与主进程一致的默认选项，加载完成前先兜底展示 */
const DEFAULT_SETTINGS: AppSettings = {
  grades: ['高一', '高二', '高三'],
  paymentMethods: ['微信', '转账', '现金'],
  scheduleWeeks: 8,
  chargeAbsent: true
}

export default function SettingsPage(): JSX.Element {
  const { message } = AntdApp.useApp()
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)
  const [loading, setLoading] = useState(true)
  const [baseSaving, setBaseSaving] = useState(false)
  const [ruleSaving, setRuleSaving] = useState(false)
  const [changing, setChanging] = useState(false)
  const [passwordForm] = Form.useForm<PasswordFormValues>()

  useEffect(() => {
    let mounted = true
    ;(async () => {
      try {
        const s = await api.getSettings()
        if (mounted) setSettings(s)
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

  /** 合并部分设置 */
  const patch = (p: Partial<AppSettings>): void => setSettings((s) => ({ ...s, ...p }))

  /** 持久化完整设置（基础选项与业务规则同存于一份 AppSettings） */
  const persist = async (setBusy: (b: boolean) => void): Promise<void> => {
    setBusy(true)
    try {
      const result = await tryApi(() => api.saveSettings(settings))
      if (!result.ok) {
        message.error(result.error)
        return
      }
      message.success('设置已保存')
    } finally {
      setBusy(false)
    }
  }

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

  /** 修改财务密码：后端校验旧密码，成功后替换本地哈希 */
  const handleChangePassword = async (values: PasswordFormValues): Promise<void> => {
    setChanging(true)
    try {
      const result = await api.changeFinancePassword(values.oldPassword, values.newPassword)
      if (result.success) {
        message.success('财务密码已修改')
        passwordForm.resetFields()
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
    <Spin spinning={loading}>
      <div style={{ maxWidth: 760 }}>
        {/* a) 基础选项 */}
        <Card title="基础选项" style={{ marginBottom: 16 }}>
          <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
            自定义下拉选项，保存后课程 / 缴费表单中的对应选项将同步更新。
          </Typography.Paragraph>
          <div style={{ maxWidth: 520 }}>
            <div style={{ marginBottom: 20 }}>
              <div style={{ marginBottom: 4 }}>
                <Typography.Text strong>年级选项</Typography.Text>
              </div>
              <Select
                mode="tags"
                style={{ width: '100%' }}
                placeholder="输入新年级后按回车添加"
                value={settings.grades}
                options={settings.grades.map((g) => ({ value: g, label: g }))}
                onChange={(v: string[]) => patch({ grades: v })}
              />
              <Typography.Paragraph type="secondary" style={{ margin: '6px 0 0', fontSize: 12 }}>
                用于课程表单的年级下拉选项。
              </Typography.Paragraph>
            </div>
            <div style={{ marginBottom: 20 }}>
              <div style={{ marginBottom: 4 }}>
                <Typography.Text strong>缴费方式</Typography.Text>
              </div>
              <Select
                mode="tags"
                style={{ width: '100%' }}
                placeholder="输入新缴费方式后按回车添加"
                value={settings.paymentMethods}
                options={settings.paymentMethods.map((m) => ({ value: m, label: m }))}
                onChange={(v: string[]) => patch({ paymentMethods: v })}
              />
              <Typography.Paragraph type="secondary" style={{ margin: '6px 0 0', fontSize: 12 }}>
                用于财务模块「学生缴费」记录的方式下拉选项。
              </Typography.Paragraph>
            </div>
            <Button type="primary" loading={baseSaving} onClick={() => persist(setBaseSaving)}>
              保存基础选项
            </Button>
          </div>
        </Card>

        {/* b) 业务规则 */}
        <Card title="业务规则" style={{ marginBottom: 16 }}>
          <div style={{ maxWidth: 520 }}>
            <div style={{ marginBottom: 20 }}>
              <div style={{ marginBottom: 4 }}>
                <Typography.Text strong>自动排课周数</Typography.Text>
              </div>
              <InputNumber
                min={1}
                max={52}
                precision={0}
                value={settings.scheduleWeeks}
                onChange={(v) => patch({ scheduleWeeks: v ?? 1 })}
                addonAfter="周"
                style={{ width: 200 }}
              />
              <Typography.Paragraph type="secondary" style={{ margin: '6px 0 0', fontSize: 12 }}>
                新建课程（或手动重新生成排课时），系统自动生成未来 N 周的课程实例。
              </Typography.Paragraph>
            </div>
            <div style={{ marginBottom: 20 }}>
              <div style={{ marginBottom: 4 }}>
                <Typography.Text strong>缺勤是否收费</Typography.Text>
              </div>
              <Switch
                checked={settings.chargeAbsent}
                checkedChildren="收费"
                unCheckedChildren="不收费"
                onChange={(v) => patch({ chargeAbsent: v })}
              />
              <Typography.Paragraph type="secondary" style={{ margin: '6px 0 0', fontSize: 12 }}>
                开启：缺勤与出勤一样计入学生应缴费用；关闭：缺勤不计入应缴（请假始终不计入）。
              </Typography.Paragraph>
            </div>
            <Button type="primary" loading={ruleSaving} onClick={() => persist(setRuleSaving)}>
              保存业务规则
            </Button>
          </div>
        </Card>

        {/* c) 财务密码 */}
        <Card title="财务密码" style={{ marginBottom: 16 }}>
          <div style={{ maxWidth: 420 }}>
            <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
              初始密码为 admin123，首次使用请尽快修改。修改时需验证当前密码，新密码至少 6 位。
            </Typography.Paragraph>
            <Form
              form={passwordForm}
              layout="vertical"
              onFinish={handleChangePassword}
              autoComplete="off"
            >
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
                      !value || passwordForm.getFieldValue('newPassword') === value
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

        {/* d) 数据备份与恢复 */}
        <Card title="数据备份与恢复" style={{ marginBottom: 16 }}>
          <div style={{ maxWidth: 520 }}>
            <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
              数据保存在本机 SQLite 数据库中。备份会导出一份完整的数据库文件；恢复会用所选文件覆盖当前全部数据。
            </Typography.Paragraph>
            <Space>
              <Button onClick={handleBackup}>备份数据</Button>
              <Popconfirm
                title="确认恢复数据？"
                description="恢复将覆盖当前全部数据，建议先备份。恢复成功后软件会自动刷新。"
                okText="恢复"
                cancelText="取消"
                okButtonProps={{ danger: true }}
                onConfirm={handleRestore}
              >
                <Button danger>恢复数据</Button>
              </Popconfirm>
            </Space>
          </div>
        </Card>

        {/* e) 关于 */}
        <Card title="关于">
          <Typography.Paragraph style={{ marginBottom: 4 }}>
            <Typography.Text strong>Vlearn</Typography.Text> 教培管理系统 · 版本 1.0.0
          </Typography.Paragraph>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
            面向教培机构的本地教务与财务管理系统。所有数据保存在本机数据库中，不会上传网络，可离线使用。
          </Typography.Paragraph>
        </Card>
      </div>
    </Spin>
  )
}
