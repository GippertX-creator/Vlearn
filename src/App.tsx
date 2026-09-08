/**
 * 应用外壳（v2 三角色架构）：
 * - 启动后先查询登录状态：未登录显示角色选择登录页，已登录直接进入对应角色主界面
 * - 主界面：左侧角色菜单（Sider）+ 顶部角色标识/退出登录 + 内容区 + 右侧 Agent 助手面板
 * - 各角色菜单项不同，费用字段只在财务角色的页面中渲染（后端同样强制校验）
 */
import {
  AccountBookOutlined,
  BarChartOutlined,
  CalendarOutlined,
  DashboardOutlined,
  FileTextOutlined,
  IdcardOutlined,
  LineChartOutlined,
  LogoutOutlined,
  MessageOutlined,
  MoneyCollectOutlined,
  PayCircleOutlined,
  SettingOutlined,
  TeamOutlined,
  WalletOutlined
} from '@ant-design/icons'
import { App as AntdApp, Button, Layout, Menu, Spin, Tag } from 'antd'
import { useCallback, useEffect, useState } from 'react'
import { api, getErrorMessage } from './api'
import AgentSidebar from './components/AgentSidebar'
import CalendarPage from './pages/CalendarPage'
import CourseFeesPage from './pages/CourseFeesPage'
import FinanceDashboard from './pages/FinanceDashboard'
import HistoryMessagesPage from './pages/HistoryMessagesPage'
import LessonNotesPage from './pages/LessonNotesPage'
import LoginPage from './pages/LoginPage'
import ReportsCenterPage from './pages/ReportsCenterPage'
import ReportsPage from './pages/ReportsPage'
import SettingsPage from './pages/SettingsPage'
import StudentPaymentsPage from './pages/StudentPaymentsPage'
import StudentsPage from './pages/StudentsPage'
import TeacherPaymentsPage from './pages/TeacherPaymentsPage'
import TeachersPage from './pages/TeachersPage'
import { RoleContext, roleName } from './roleContext'
import type { AuthStatus, Role } from './types'

const { Header, Sider, Content } = Layout

/** 各角色菜单 */
const MENUS: Record<Role, { key: string; icon: JSX.Element; label: string }[]> = {
  academic: [
    { key: 'calendar', icon: <CalendarOutlined />, label: '课程日历' },
    { key: 'students', icon: <TeamOutlined />, label: '学生管理' },
    { key: 'teachers', icon: <IdcardOutlined />, label: '老师管理' },
    { key: 'reports', icon: <FileTextOutlined />, label: '报告中心' },
    { key: 'settings', icon: <SettingOutlined />, label: '系统设置' }
  ],
  finance: [
    { key: 'dashboard', icon: <DashboardOutlined />, label: '仪表盘' },
    { key: 'fees', icon: <MoneyCollectOutlined />, label: '课程费用' },
    { key: 'studentPayments', icon: <PayCircleOutlined />, label: '学生缴费' },
    { key: 'teacherPayments', icon: <WalletOutlined />, label: '老师课酬' },
    { key: 'reports', icon: <LineChartOutlined />, label: '盈亏报表' },
    { key: 'settings', icon: <SettingOutlined />, label: '系统设置' }
  ],
  assistant: [
    { key: 'calendar', icon: <CalendarOutlined />, label: '课程日历' },
    { key: 'notes', icon: <AccountBookOutlined />, label: '课程内容记录' },
    { key: 'messages', icon: <MessageOutlined />, label: '历史消息' },
    { key: 'settings', icon: <SettingOutlined />, label: '系统设置' }
  ]
}

/** 各角色默认首页 */
const DEFAULT_NAV: Record<Role, string> = { academic: 'calendar', finance: 'dashboard', assistant: 'calendar' }

/** 各角色标识颜色 */
const ROLE_COLOR: Record<Role, string> = { academic: 'blue', finance: 'gold', assistant: 'green' }

export default function App(): JSX.Element {
  const { message } = AntdApp.useApp()
  /** null = 启动加载中；role null 且已加载 = 未登录 */
  const [status, setStatus] = useState<AuthStatus | null>(null)
  const [navKey, setNavKey] = useState<string>('')

  const role = status?.loggedIn ? status.role : null
  const migrationError = status?.migrationError ?? null

  // 启动时查询登录状态
  useEffect(() => {
    let mounted = true
    api
      .getAuthStatus()
      .then((s) => {
        if (!mounted) return
        setStatus(s)
        if (s.loggedIn && s.role) setNavKey(DEFAULT_NAV[s.role])
      })
      .catch((err) => {
        if (mounted) {
          setStatus({ loggedIn: false, role: null, migrationError: null })
          message.error(getErrorMessage(err))
        }
      })
    return () => {
      mounted = false
    }
  }, [message])

  const handleLogin = useCallback((r: Role): void => {
    setStatus({ loggedIn: true, role: r, migrationError: null })
    setNavKey(DEFAULT_NAV[r])
  }, [])

  const handleLogout = useCallback(async (): Promise<void> => {
    try {
      await api.logout()
      setStatus({ loggedIn: false, role: null, migrationError: null })
      message.info('已退出登录')
    } catch (err) {
      message.error(getErrorMessage(err))
    }
  }, [message])

  // 页面切换时回到顶部
  useEffect(() => {
    document.querySelector('.app-content')?.scrollTo(0, 0)
  }, [navKey, role])

  // 启动加载中
  if (status === null) {
    return (
      <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Spin size="large" tip="正在启动…">
          <div style={{ width: 200, height: 100 }} />
        </Spin>
      </div>
    )
  }

  // 未登录（或迁移失败）：角色选择页
  if (!role) {
    return <LoginPage onLogin={handleLogin} migrationError={migrationError} />
  }

  const menus = MENUS[role]
  const showAgentSidebar = role !== 'assistant' // 助教暂无主动提醒，不显示面板

  const renderContent = (): JSX.Element => {
    if (role === 'academic') {
      switch (navKey) {
        case 'calendar':
          return <CalendarPage />
        case 'students':
          return <StudentsPage />
        case 'teachers':
          return <TeachersPage />
        case 'reports':
          return <ReportsCenterPage />
        case 'settings':
          return <SettingsPage />
      }
    }
    if (role === 'finance') {
      switch (navKey) {
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
        case 'settings':
          return <SettingsPage />
      }
    }
    switch (navKey) {
      case 'calendar':
        return <CalendarPage />
      case 'notes':
        return <LessonNotesPage />
      case 'messages':
        return <HistoryMessagesPage />
      case 'settings':
        return <SettingsPage />
    }
    return <CalendarPage />
  }

  return (
    <RoleContext.Provider value={role}>
      <Layout className="app-layout">
        <Header className="app-header">
          <div className="app-logo">
            <BarChartOutlined />
            <span>Vlearn 教培管理系统</span>
          </div>
          <div style={{ flex: 1 }} />
          <Tag color={ROLE_COLOR[role]} style={{ marginRight: 8 }}>
            {roleName(role)}端
          </Tag>
          <Button type="text" size="small" icon={<LogoutOutlined />} onClick={() => void handleLogout()}>
            退出登录
          </Button>
        </Header>
        <Layout>
          <Sider theme="light" width={180} collapsible>
            <Menu
              mode="inline"
              selectedKeys={[navKey]}
              onClick={({ key }) => setNavKey(key)}
              items={menus}
              style={{ height: '100%', borderRight: 0 }}
            />
          </Sider>
          <Content className="app-content">{renderContent()}</Content>
          {showAgentSidebar && <AgentSidebar role={role} />}
        </Layout>
      </Layout>
    </RoleContext.Provider>
  )
}
