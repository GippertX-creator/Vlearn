/**
 * 多校区同步页（教务/助教角色可用）：
 * - 校区信息：校区名称 + 校区编号（随同步包携带，用于区分各校区数据）
 * - 同步操作：导出同步包（发微信/邮件给其他校区）、导入同步包（合并，最近修改优先）
 * - 同步范围：教务数据（课程/学生/老师/排课/考勤/设置）+ 助教课程记录；
 *   财务数据、登录密码、大模型密钥永不参与同步
 */
import { CloudDownloadOutlined, CloudUploadOutlined, SaveOutlined } from '@ant-design/icons'
import { App as AntdApp, Alert, Button, Card, Input, List, Modal, Popconfirm, Space, Tag, Typography } from 'antd'
import { useCallback, useEffect, useState } from 'react'
import { api, getErrorMessage } from '../api'
import PageToolbar from '../components/PageToolbar'
import type { SyncInfo, SyncStats } from '../types'

export default function SyncPage(): JSX.Element {
  const { message } = AntdApp.useApp()
  const [info, setInfo] = useState<SyncInfo | null>(null)
  const [campusName, setCampusName] = useState('')
  const [savingName, setSavingName] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState<SyncStats | null>(null)

  const load = useCallback(async (): Promise<void> => {
    try {
      const s = await api.getSyncInfo()
      setInfo(s)
      setCampusName(s.campusName)
    } catch (err) {
      message.error(getErrorMessage(err))
    }
  }, [message])

  useEffect(() => {
    void load()
  }, [load])

  const handleSaveName = async (): Promise<void> => {
    setSavingName(true)
    try {
      await api.saveCampusName(campusName)
      message.success('校区名称已保存')
      await load()
    } catch (err) {
      message.error(getErrorMessage(err))
    } finally {
      setSavingName(false)
    }
  }

  const handleExport = async (): Promise<void> => {
    setExporting(true)
    try {
      const result = await api.syncExport()
      if (result.canceled) return
      if (result.success) {
        message.success(`同步包已导出（${result.counts ?? 0} 条记录）：${result.path}`)
        await load()
      } else {
        message.error(result.error ?? '导出失败')
      }
    } catch (err) {
      message.error(getErrorMessage(err))
    } finally {
      setExporting(false)
    }
  }

  const handleImport = async (): Promise<void> => {
    setImporting(true)
    try {
      const result = await api.syncImport()
      if (result.canceled) return
      if (result.success && result.stats) {
        setImportResult(result.stats)
        await load()
      } else {
        message.error(result.error ?? '导入失败')
      }
    } catch (err) {
      message.error(getErrorMessage(err))
    } finally {
      setImporting(false)
    }
  }

  return (
    <div style={{ maxWidth: 860 }}>
      <PageToolbar title="多校区同步" />

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="同步方式：导出同步包 → 通过微信/邮件发送给其他校区 → 对方导入。财务数据不参与同步。"
      />

      {/* 校区信息 */}
      <Card title="校区信息" style={{ marginBottom: 16 }}>
        <div style={{ marginBottom: 16 }}>
          <Typography.Text strong>校区名称</Typography.Text>
          <Space.Compact style={{ width: '100%', marginTop: 4 }}>
            <Input
              placeholder="如：总部 / 东城校区"
              value={campusName}
              maxLength={30}
              onChange={(e) => setCampusName(e.target.value)}
            />
            <Button type="primary" icon={<SaveOutlined />} loading={savingName} onClick={() => void handleSaveName()}>
              保存
            </Button>
          </Space.Compact>
        </div>
        <div>
          <Typography.Text strong>校区编号</Typography.Text>
          <div style={{ marginTop: 4 }}>
            <Typography.Text copyable code>
              {info?.campusId ?? ''}
            </Typography.Text>
            <Typography.Paragraph type="secondary" style={{ margin: '6px 0 0', fontSize: 12 }}>
              随同步包自动携带，用于区分各校区的数据；同一机构各校区编号互不相同，无需手动修改。
            </Typography.Paragraph>
          </div>
        </div>
      </Card>

      {/* 同步操作 */}
      <Card title="同步操作" style={{ marginBottom: 16 }}>
        <Space wrap>
          <Button
            type="primary"
            icon={<CloudUploadOutlined />}
            loading={exporting}
            onClick={() => void handleExport()}
          >
            导出同步包
          </Button>
          <Popconfirm
            title="导入同步包？"
            description="将把其他校区的数据合并到本机：同一记录两边都改过时以最近修改为准；删除操作也会同步。建议导入前先导出本校区数据备份。"
            okText="选择文件并导入"
            cancelText="取消"
            onConfirm={() => void handleImport()}
          >
            <Button danger icon={<CloudDownloadOutlined />} loading={importing}>
              导入同步包
            </Button>
          </Popconfirm>
        </Space>
        <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
          合并规则：① 同一条记录两边都修改过 → 以最近修改为准；② 两个校区各自新建的数据 → 全部保留（编号冲突自动重新分配）；
          ③ 某校区删除的记录 → 导入后本机同步删除；④ 登录密码与大模型密钥不参与同步，各校区自行管理。
        </Typography.Paragraph>
      </Card>

      {/* 使用说明 */}
      <Card title="使用说明" style={{ marginBottom: 16 }}>
        <Typography.Paragraph style={{ marginBottom: 8 }}>
          <Typography.Text strong>1. 建立联系</Typography.Text>
          ：每个校区填写自己的「校区名称」（如"总部"、"东城校区"）。
        </Typography.Paragraph>
        <Typography.Paragraph style={{ marginBottom: 8 }}>
          <Typography.Text strong>2. 分享数据</Typography.Text>
          ：在任一校区点「导出同步包」，把生成的文件通过微信或邮件发给其他校区。
        </Typography.Paragraph>
        <Typography.Paragraph style={{ marginBottom: 8 }}>
          <Typography.Text strong>3. 接收数据</Typography.Text>
          ：收到文件后点「导入同步包」选择该文件，系统自动合并（新增/更新/删除一目了然）。
        </Typography.Paragraph>
        <Typography.Paragraph style={{ marginBottom: 0 }}>
          <Typography.Text strong>建议节奏</Typography.Text>
          ：每天或每周固定导出一到两次，按"谁改动谁导出"的习惯保持各校区数据一致。
        </Typography.Paragraph>
      </Card>

      {/* 同步历史 */}
      <Card title="同步历史">
        {!info || info.history.length === 0 ? (
          <Typography.Text type="secondary">暂无同步记录</Typography.Text>
        ) : (
          <List
            size="small"
            dataSource={info.history}
            renderItem={(item) => (
              <List.Item>
                <Space>
                  <Tag color={item.type === 'export' ? 'blue' : 'green'}>
                    {item.type === 'export' ? <CloudUploadOutlined /> : <CloudDownloadOutlined />}
                    {item.type === 'export' ? ' 导出' : ' 导入'}
                  </Tag>
                  <span>{item.ts}</span>
                  <span>来源：{item.campusName}</span>
                  {item.counts && <Typography.Text type="secondary">{item.counts}</Typography.Text>}
                </Space>
              </List.Item>
            )}
          />
        )}
      </Card>

      {/* 导入结果 */}
      <Modal
        open={importResult !== null}
        onCancel={() => setImportResult(null)}
        footer={<Button type="primary" onClick={() => setImportResult(null)}>知道了</Button>}
        title="同步完成"
        width={480}
      >
        {importResult && (
          <div>
            <p>
              已合并来自「{importResult.fromCampus}」的数据：
            </p>
            <ul style={{ paddingLeft: 20, lineHeight: 2 }}>
              <li>新增 {importResult.added} 条</li>
              <li>更新 {importResult.updated} 条</li>
              <li>删除 {importResult.deleted} 条</li>
              {importResult.remapped > 0 && (
                <li style={{ color: '#fa8c16' }}>编号冲突自动重分配 {importResult.remapped} 条（数据完整保留）</li>
              )}
            </ul>
            <Typography.Text type="secondary">请到对应页面查看合并后的数据。</Typography.Text>
          </div>
        )}
      </Modal>
    </div>
  )
}
