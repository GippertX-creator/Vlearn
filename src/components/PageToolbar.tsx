/**
 * 列表页通用工具栏：左侧标题 + 右侧操作按钮组，保证各页面布局一致。
 */
import { Typography } from 'antd'
import type { ReactNode } from 'react'

interface PageToolbarProps {
  title: string
  /** 左侧附加控件（搜索框、筛选器等） */
  leftExtra?: ReactNode
  /** 右侧操作按钮 */
  actions?: ReactNode
}

export default function PageToolbar({ title, leftExtra, actions }: PageToolbarProps): JSX.Element {
  return (
    <div className="page-toolbar">
      <div className="left">
        <Typography.Title level={4} style={{ margin: 0 }}>
          {title}
        </Typography.Title>
        {leftExtra}
      </div>
      {actions && <div className="right">{actions}</div>}
    </div>
  )
}
