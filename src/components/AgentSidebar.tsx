/**
 * Agent 侧边栏（右侧固定面板）：
 * - 展示 Agent 主动提醒（考勤异常、信息补全、缴费逾期等），支持展开/收起、关闭单条
 * - 提醒数据由主进程本地规则计算（agent:getAlerts），
 *   刷新时机：登录后、切换页面、每 4 小时定时、页面动作触发自定义事件 vlearn:refresh-alerts
 */
import { BellOutlined, CloseOutlined, ReloadOutlined, RightOutlined } from '@ant-design/icons'
import { Badge, Button, Empty, Tooltip, Typography } from 'antd'
import { useCallback, useEffect, useState } from 'react'
import { api, getErrorMessage } from '../api'
import type { AgentAlert, Role } from '../types'

interface AgentSidebarProps {
  role: Role
}

const TYPE_STYLE: Record<AgentAlert['type'], { color: string; label: string }> = {
  warning: { color: '#faad14', label: '警告' },
  info: { color: '#1677ff', label: '信息' },
  suggestion: { color: '#52c41a', label: '建议' }
}

export default function AgentSidebar({ role }: AgentSidebarProps): JSX.Element {
  const [open, setOpen] = useState(true)
  const [alerts, setAlerts] = useState<AgentAlert[]>([])
  const [loading, setLoading] = useState(false)
  /** 本地已关闭的提醒 id（仅本次会话隐藏） */
  const [dismissed, setDismissed] = useState<string[]>([])

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const rows = await api.getAlerts()
      setAlerts(rows)
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
          {visible.length === 0 ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={loading ? '检查中…' : '暂无提醒'}
              style={{ marginTop: 40 }}
            />
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
