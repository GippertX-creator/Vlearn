/**
 * 角色选择登录页：教务 / 财务 / 助教 三个入口，各自独立密码。
 * 登录成功后进入对应角色主界面；密码错误提示；迁移失败时展示错误并阻止进入。
 */
import { AccountBookOutlined, LockOutlined, MoneyCollectOutlined, TeamOutlined } from '@ant-design/icons'
import { Card, Col, Input, Modal, Row, Typography } from 'antd'
import { useCallback, useEffect, useState } from 'react'
import { api, getErrorMessage } from '../api'
import type { LoginResult, Role } from '../types'

interface LoginPageProps {
  /** 登录成功回调 */
  onLogin: (role: Role) => void
  /** 旧库数据迁移失败信息（阻止进入系统） */
  migrationError?: string | null
}

const ROLE_ENTRIES: { role: Role; title: string; desc: string; icon: JSX.Element }[] = [
  {
    role: 'academic',
    title: '教务登录',
    desc: '课程排课 · 学生老师 · 考勤管理',
    icon: <TeamOutlined style={{ fontSize: 36, color: '#1677ff' }} />
  },
  {
    role: 'finance',
    title: '财务登录',
    desc: '缴费课酬 · 盈亏报表 · 对账',
    icon: <MoneyCollectOutlined style={{ fontSize: 36, color: '#faad14' }} />
  },
  {
    role: 'assistant',
    title: '助教登录',
    desc: '课程记录 · 微信群短信生成',
    icon: <AccountBookOutlined style={{ fontSize: 36, color: '#52c41a' }} />
  }
]

export default function LoginPage({ onLogin, migrationError }: LoginPageProps): JSX.Element {
  const [target, setTarget] = useState<Role | null>(null)
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [verifying, setVerifying] = useState(false)
  const [version, setVersion] = useState('')

  useEffect(() => {
    api.getAppVersion().then(setVersion).catch(() => setVersion(''))
  }, [])

  const handleVerify = useCallback(async (): Promise<void> => {
    if (!target) return
    if (!password) {
      setError('请输入密码')
      return
    }
    setVerifying(true)
    try {
      const result: LoginResult = await api.login(target, password)
      if (result.success) {
        setTarget(null)
        setPassword('')
        onLogin(target)
      } else {
        setError(result.error ?? '登录失败')
      }
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setVerifying(false)
    }
  }, [target, password, onLogin])

  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'linear-gradient(180deg, #e6f4ff 0%, #f5f5f5 60%)'
      }}
    >
      <Typography.Title level={2} style={{ marginBottom: 4 }}>
        Vlearn 教培管理系统
      </Typography.Title>
      <Typography.Text type="secondary" style={{ marginBottom: 32 }}>
        请选择您的角色登录（三个角色数据相互隔离）
      </Typography.Text>

      {migrationError && (
        <Card
          style={{ width: 520, marginBottom: 24, borderColor: '#ff4d4f' }}
          bodyStyle={{ color: '#cf1322' }}
        >
          <Typography.Text strong>⚠️ {migrationError}</Typography.Text>
        </Card>
      )}

      <Row gutter={24}>
        {ROLE_ENTRIES.map((entry) => (
          <Col key={entry.role}>
            <Card
              hoverable
              style={{ width: 240, textAlign: 'center' }}
              onClick={() => {
                setTarget(entry.role)
                setPassword('')
                setError('')
              }}
            >
              <div style={{ marginBottom: 12 }}>{entry.icon}</div>
              <Typography.Title level={4} style={{ marginBottom: 4 }}>
                {entry.title}
              </Typography.Title>
              <Typography.Text type="secondary">{entry.desc}</Typography.Text>
            </Card>
          </Col>
        ))}
      </Row>

      <Typography.Text type="secondary" style={{ position: 'absolute', bottom: 16 }}>
        Vlearn v{version || '—'}
      </Typography.Text>

      {/* 密码输入弹窗 */}
      <Modal
        open={target !== null}
        title={
          <span>
            <LockOutlined style={{ marginRight: 8 }} />
            {target ? ROLE_ENTRIES.find((e) => e.role === target)?.title : ''}
          </span>
        }
        okText="登录"
        cancelText="取消"
        confirmLoading={verifying}
        onOk={handleVerify}
        onCancel={() => setTarget(null)}
        width={400}
      >
        <Input.Password
          placeholder="请输入密码"
          value={password}
          onChange={(e) => {
            setPassword(e.target.value)
            setError('')
          }}
          onPressEnter={handleVerify}
          autoFocus
        />
        {error && (
          <Typography.Text type="danger" style={{ display: 'block', marginTop: 8 }}>
            {error}
          </Typography.Text>
        )}
      </Modal>
    </div>
  )
}
