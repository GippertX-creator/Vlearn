/**
 * Agent 侧边栏（右侧固定面板）：
 * - 顶部"系统通知"区：展示系统级通知（定时备份结果等，来源 system-notifications），
 *   最多显示 5 条；无通知时整个分区不渲染。
 * - 下方"助手提醒"区：Agent 主动提醒（考勤异常、信息补全、缴费逾期等），支持展开/收起、关闭单条
 * - 刷新时机：登录后、切换页面、每 4 小时定时、页面动作触发自定义事件 vlearn:refresh-alerts；
 *   刷新同时拉取系统通知与助手提醒两类数据。
 */
import {
  BellOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  CloseOutlined,
  InfoCircleOutlined,
  ReloadOutlined,
  RightOutlined
} from '@ant-design/icons'
import { Badge, Button, Divider, Empty, Tooltip, Typography } from 'antd'
import { useCallback, useEffect, useState } from 'react'
import { api, getErrorMessage } from '../api'
import type { AgentAlert, Role, SystemNotification } from '../types'

interface AgentSidebarProps {
  role: Role
}

const TYPE_STYLE: Record<AgentAlert['type'], { color: string; label: string }> = {
  warning: { color: '#faad14', label: '警告' },
  info: { color: '#1677ff', label: '信息' },
  suggestion: { color: '#52c41a', label: '建议' }
}

/** 系统通知级别的图标与颜色 */
const NOTIF_STYLE: Record<SystemNotification['level'], { color: string; icon: JSX.Element }> = {
  success: { color: '#52c41a', icon: <CheckCircleOutlined /> },
  error: { color: '#ff4d4f', icon: <CloseCircleOutlined /> },
  info: { color: '#1677ff', icon: <InfoCircleOutlined /> }
}

/** 系统通知最多展示条数 */
const MAX_NOTIFS = 5

export default function AgentSidebar({ role }: AgentSidebarProps): JSX.Element {
  const [open, setOpen] = useState(true)
  const [alerts, setAlerts] = useState<AgentAlert[]>([])
  const [notifications, setNotifications] = useState<SystemNotification[]>([])
  const [loading, setLoading] = useState(false)
  /** 本地已关闭的提醒 id（仅本次会话隐藏） */
  const [dismissed, setDismissed] = useState<string[]>([])

  /** 并行拉取系统通知 + 助手提醒（刷新按钮同时刷新两类） */
  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const [rows, notes] = await Promise.all([api.getAlerts(), api.getSystemNotifications()])
      setAlerts(rows)
      setNotifications(notes)
    } catch (err) {
      console.error(getErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    // 每 4 小时检查一次
    const timer = setInterval(() => void load(), 4 * 60 * 60 * 1000)
    // 页面动作（保存考勤、改设置等）通过自定义事件触发刷新
    const onCustom = (): void => void load()
    window.addEventListener('vlearn:refresh-alerts', onCustom)
    return () => {
      clearInterval(timer)
      window.removeEventListener('vlearn:refresh-alerts', onCustom)
    }
  }, [load, role])

  const visible = alerts.filter((a) => !dismissed.includes(a.id))
  const warningCount = visible.filter((a) => a.type === 'warning').length
  /** 系统通知（最多 5 条）；无通知时整个分区隐藏 */
  const showNotifs = notifications.slice(0, MAX_NOTIFS)
  const hasNotifs = showNotifs.length > 0

  return (
    <div
      style={{
        width: open ? 300 : 40,
        transition: 'width 0.2s',
        background: '#fff',
        borderLeft: '1px solid #f0f0f0',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        flexShrink: 0
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 10px', borderBottom: '1px solid #f0f0f0' }}>
        {open ? (
          <>
            <span style={{ fontWeight: 600 }}>
              <BellOutlined style={{ marginRight: 6 }} />
              {role === 'academic' ? '教务助手' : '财务助手'}
              <Badge count={warningCount} size="small" offset={[6, -2]} />
            </span>
            <span>
              <Tooltip title="刷新提醒">
                <Button type="text" size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => void load()} />
              </Tooltip>
              <Tooltip title="收起">
                <Button type="text" size="small" icon={<RightOutlined />} onClick={() => setOpen(false)} />
              </Tooltip>
            </span>
          </>
        ) : (
          <Tooltip title="展开助手面板" placement="left">
            <Button type="text" size="small" icon={<BellOutlined />} onClick={() => setOpen(true)} style={{ margin: '0 auto' }} />
          </Tooltip>
        )}
      </div>

      {open && (
        <div style={{ flex: 1, overflow: 'auto', padding: 12 }}>
          {/* 系统通知（无通知时不显示该区） */}
          {hasNotifs && (
            <>
              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>
                <span style={{ color: '#333' }}>系统通知</span>
              </div>
              {showNotifs.map((n) => {
                const style = NOTIF_STYLE[n.level]
                return (
                  <div
                    key={n.id}
                    style={{
                      border: '1px solid #f0f0f0',
                      borderLeft: `3px solid ${style.color}`,
                      borderRadius: 6,
                      padding: '10px 12px',
                      marginBottom: 10,
                      background: '#fafafa'
                    }}
                  >
                    <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>
                      <span style={{ color: style.color, marginRight: 6 }}>{style.icon}</span>
                      {n.title}
                    </div>
                    <Typography.Paragraph style={{ marginBottom: 0, fontSize: 12, color: '#666' }}>
                      {n.detail}
                    </Typography.Paragraph>
                    <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                      {n.ts}
                    </Typography.Text>
                  </div>
                )
              })}
              <Divider plain style={{ margin: '4px 0 12px' }}>
                助手提醒
              </Divider>
            </>
          )}

          {/* 助手提醒 */}
          {visible.length === 0 ? (
            hasNotifs ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无助手提醒" style={{ margin: '20px 0' }} />
            ) : (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={loading ? '检查中…' : '暂无提醒'}
                style={{ marginTop: 40 }}
              />
            )
          ) : (
            visible.map((alert) => {
              const style = TYPE_STYLE[alert.type]
              return (
                <div
                  key={alert.id}
                  style={{
                    border: `1px solid #f0f0f0`,
                    borderLeft: `3px solid ${style.color}`,
                    borderRadius: 6,
                    padding: '10px 12px',
                    marginBottom: 10,
                    background: '#fafafa'
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>
                        <span style={{ color: style.color }}>[{style.label}]</span> {alert.title}
                      </div>
                      <Typography.Paragraph style={{ marginBottom: 0, fontSize: 12, color: '#666' }}>
                        {alert.detail}
                      </Typography.Paragraph>
                      <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                        {alert.createdAt}
                      </Typography.Text>
                    </div>
                    <Button
                      type="text"
                      size="small"
                      icon={<CloseOutlined />}
                      onClick={() => setDismissed((d) => [...d, alert.id])}
                    />
                  </div>
                </div>
              )
            })
          )}
        </div>
      )}
    </div>
  )
}
