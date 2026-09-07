/**
 * 应用外壳：顶部导航（教务/财务/设置）+ 财务密码门 + 页面路由。
 * - 教务端无需登录：课程日历 / 学生管理 / 老师管理
 * - 财务模块需输入独立密码验证（初始 admin123），验证后主进程开启财务会话
 * - 费用相关字段只在财务页面渲染，教务端完全不显示
 */
import {
  CalendarOutlined,
  IdcardOutlined,
  LockOutlined,
  LogoutOutlined,
  MoneyCollectOutlined,
  SettingOutlined,
  TeamOutlined
} from '@ant-design/icons'
import { App as AntdApp, Button, Input, Layout, Menu, Modal, Tag, Typography } from 'antd'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, getErrorMessage } from './api'
import CalendarPage from './pages/CalendarPage'
import TeachersPage from './pages/TeachersPage'
import StudentsPage from './pages/StudentsPage'
import FinanceDashboard from './pages/FinanceDashboard'
import CourseFeesPage from './pages/CourseFeesPage'
import StudentPaymentsPage from './pages/StudentPaymentsPage'
import TeacherPaymentsPage from './pages/TeacherPaymentsPage'
import ReportsPage from './pages/ReportsPage'
import SettingsPage from './pages/SettingsPage'

const { Header, Content } = Layout

/** 顶层导航项 */
type NavKey = 'calendar' | 'students' | 'teachers' | 'finance' | 'settings'
/** 财务子页面 */
type FinanceSubKey = 'dashboard' | 'fees' | 'studentPayments' | 'teacherPayments' | 'reports'

const FINANCE_SUB_ITEMS: { key: FinanceSubKey; label: string }[] = [
  { key: 'dashboard', label: '仪表盘' },
  { key: 'fees', label: '课程费用' },
  { key: 'studentPayments', label: '学生缴费' },
  { key: 'teacherPayments', label: '老师课酬' },
  { key: 'reports', label: '盈亏报表' }
]

export default function App(): JSX.Element {
  const { message } = AntdApp.useApp()
  const [nav, setNav] = useState<NavKey>('calendar')
  const [financeSub, setFinanceSub] = useState<FinanceSubKey>('dashboard')
  /** 财务会话是否已解锁（主进程校验 + 前端渲染双重控制） */
  const [financeUnlocked, setFinanceUnlocked] = useState(false)
  /** 财务密码弹窗 */
  const [passwordOpen, setPasswordOpen] = useState(false)
  const [passwordInput, setPasswordInput] = useState('')
  const [passwordError, setPasswordError] = useState('')
  const [verifying, setVerifying] = useState(false)

  // 点击"财务"菜单：未解锁则弹出密码输入框，已解锁直接进入
  const handleMenuClick = useCallback(
    (key: string) => {
      if (key === 'finance') {
        if (financeUnlocked) {
          setNav('finance')
        } else {
          setPasswordInput('')
          setPasswordError('')
          setPasswordOpen(true)
        }
        return
      }
      setNav(key as NavKey)
    },
    [financeUnlocked]
  )

  const handleVerify = useCallback(async () => {
    if (!passwordInput) {
      setPasswordError('请输入财务密码')
      return
    }
    setVerifying(true)
    try {
      const ok = await api.verifyFinancePassword(passwordInput)
      if (ok) {
        setFinanceUnlocked(true)
        setPasswordOpen(false)
        setFinanceSub('dashboard')
        setNav('finance')
        message.success('财务验证通过')
      } else {
        setPasswordError('密码错误，请重试')
      }
    } catch (err) {
      setPasswordError(getErrorMessage(err))
    } finally {
      setVerifying(false)
    }
  }, [passwordInput, message])

  const handleLogoutFinance = useCallback(async () => {
    await api.logoutFinance()
    setFinanceUnlocked(false)
    setNav('calendar')
    message.info('已退出财务模式')
  }, [message])

  // 财务模式关闭弹窗时返回教务端
  const handlePasswordCancel = useCallback(() => {
    setPasswordOpen(false)
    if (!financeUnlocked) setNav('calendar')
  }, [financeUnlocked])

  // 页面切换时回到顶部
  useEffect(() => {
    document.querySelector('.app-content')?.scrollTo(0, 0)
  }, [nav, financeSub])

  const menuItems = useMemo(
    () => [
      { key: 'calendar', icon: <CalendarOutlined />, label: '课程日历' },
      { key: 'students', icon: <TeamOutlined />, label: '学生管理' },
      { key: 'teachers', icon: <IdcardOutlined />, label: '老师管理' },
      { key: 'finance', icon: <MoneyCollectOutlined />, label: '财务' },
      { key: 'settings', icon: <SettingOutlined />, label: '设置' }
    ],
    []
  )

  const renderContent = (): JSX.Element => {
    switch (nav) {
      case 'calendar':
        return <CalendarPage />
      case 'students':
        return <StudentsPage />
      case 'teachers':
        return <TeachersPage />
      case 'finance':
        switch (financeSub) {
          case 'dashboard':
            return <FinanceDashboard />
          case 'fees':
            return <CourseFeesPage />
          case 'studentPayments':
            return <StudentPaymentsPage />
          case 'teacherPayments':
            return <TeacherPaymentsPage />
          case 'reports':
            return <ReportsPage />
        }
        break
      case 'settings':
        return <SettingsPage />
    }
  }

  return (
    <Layout className="app-layout">
      <Header className="app-header">
        <div className="app-logo">
          <MoneyCollectOutlined />
          <span>Vlearn 教培管理系统</span>
        </div>
        <Menu
          mode="horizontal"
          selectedKeys={[nav]}
          onClick={({ key }) => handleMenuClick(key)}
          items={menuItems}
          style={{ flex: 1, minWidth: 0, background: 'transparent' }}
        />
        {financeUnlocked && (
          <Tag color="gold" style={{ marginLeft: 8 }}>
            财务已解锁
          </Tag>
        )}
        {financeUnlocked && (
          <Button type="text" size="small" icon={<LogoutOutlined />} onClick={handleLogoutFinance}>
            退出财务
          </Button>
        )}
      </Header>

      {/* 财务子页面标签栏：仅在财务解锁后渲染 */}
      {nav === 'finance' && financeUnlocked && (
        <div style={{ background: '#fff', padding: '0 24px', borderBottom: '1px solid #f0f0f0' }}>
          <Menu
            mode="horizontal"
            selectedKeys={[financeSub]}
            onClick={({ key }) => setFinanceSub(key as FinanceSubKey)}
            items={FINANCE_SUB_ITEMS}
            style={{ background: 'transparent' }}
          />
        </div>
      )}

      <Content className="app-content">{renderContent()}</Content>

      {/* 财务密码验证弹窗 */}
      <Modal
        open={passwordOpen}
        title={
          <span>
            <LockOutlined style={{ marginRight: 8 }} />
            进入财务模块
          </span>
        }
        okText="验证"
        cancelText="取消"
        confirmLoading={verifying}
        onOk={handleVerify}
        onCancel={handlePasswordCancel}
        width={400}
      >
        <Typography.Paragraph type="secondary" style={{ marginTop: 8 }}>
          财务数据（课程费用、缴费、课酬、盈亏）需验证独立密码后方可访问。
        </Typography.Paragraph>
        <Input.Password
          placeholder="请输入财务密码"
          value={passwordInput}
          onChange={(e) => {
            setPasswordInput(e.target.value)
            setPasswordError('')
          }}
          onPressEnter={handleVerify}
          autoFocus
        />
        {passwordError && (
          <Typography.Text type="danger" style={{ display: 'block', marginTop: 8 }}>
            {passwordError}
          </Typography.Text>
        )}
      </Modal>
    </Layout>
  )
}
