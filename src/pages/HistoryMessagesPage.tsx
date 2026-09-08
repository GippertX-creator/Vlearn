/**
 * 助教·历史消息页：
 * - 展示由课程记录一键生成的微信群短信历史（来源课程、生成时间、内容全文）
 * - 支持复制内容到剪贴板、删除单条记录
 */
import { CopyOutlined, DeleteOutlined, ReloadOutlined } from '@ant-design/icons'
import { App as AntdApp, Button, Empty, Popconfirm, Space, Table, Typography } from 'antd'
import { useCallback, useEffect, useState } from 'react'
import { api, getErrorMessage } from '../api'
import PageToolbar from '../components/PageToolbar'
import type { GeneratedMessage } from '../types'

export default function HistoryMessagesPage(): JSX.Element {
  const { message } = AntdApp.useApp()
  const [messages, setMessages] = useState<GeneratedMessage[]>([])
  const [loading, setLoading] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const data = await api.listMessages()
      setMessages(data)
    } catch (err) {
      message.error(getErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [message])

  useEffect(() => {
    void load()
  }, [load])

  const handleCopy = async (content: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(content)
      message.success('已复制')
    } catch (err) {
      message.error(getErrorMessage(err))
    }
  }

  const handleDelete = async (row: GeneratedMessage): Promise<void> => {
    try {
      await api.deleteMessage(row.id)
      message.success('消息已删除')
      await load()
    } catch (err) {
      message.error(getErrorMessage(err))
    }
  }

  const columns = [
    {
      title: '生成时间',
      dataIndex: 'generatedAt',
      key: 'generatedAt',
      width: 160,
      render: (v: string) => v.slice(0, 16)
    },
    {
      title: '所属课程',
      dataIndex: 'instanceLabel',
      key: 'instanceLabel',
      width: 200,
      render: (v: string | undefined) => v || '—'
    },
    {
      title: '消息内容',
      dataIndex: 'messageContent',
      key: 'messageContent',
      render: (v: string) => (
        <Typography.Paragraph
          ellipsis={{ rows: 2, expandable: true }}
          style={{ marginBottom: 0 }}
        >
          {v}
        </Typography.Paragraph>
      )
    },
    {
      title: '操作',
      key: 'actions',
      width: 140,
      render: (_: unknown, row: GeneratedMessage) => (
        <Space size={4}>
          <Button size="small" icon={<CopyOutlined />} onClick={() => void handleCopy(row.messageContent)}>
            复制
          </Button>
          <Popconfirm
            title="确认删除该条历史消息？"
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

  return (
    <div>
      <PageToolbar
        title="历史消息"
        actions={
          <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
            刷新
          </Button>
        }
      />

      {!loading && messages.length === 0 ? (
        <Empty description="暂无历史消息" style={{ marginTop: 64 }} />
      ) : (
        <Table
          rowKey="id"
          loading={loading}
          columns={columns}
          dataSource={messages}
          pagination={{ pageSize: 10, showTotal: (total) => `共 ${total} 条消息` }}
        />
      )}
    </div>
  )
}
