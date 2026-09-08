/**
 * 教务·报告中心页：
 * - 一键生成周报 / 月报：本地规则统计 + 可选 AI 润色（是否走大模型取决于系统设置中的 Agent 配置）
 * - 结果以弹窗展示：来源标签（AI 生成 / 系统模板）、正文预览，
 *   并支持导出 Excel（教务周报 / 教务月报）、复制全文、关闭
 */
import { CopyOutlined, FileDoneOutlined, FileTextOutlined } from '@ant-design/icons'
import { App as AntdApp, Button, Modal, Space, Tag, Typography } from 'antd'
import { useState } from 'react'
import { api, getErrorMessage } from '../api'
import ExportExcelButton from '../components/ExportExcelButton'
import PageToolbar from '../components/PageToolbar'
import type { GeneratedContent } from '../types'

type ReportKind = 'week' | 'month'

const KIND_NAME: Record<ReportKind, string> = { week: '周报', month: '月报' }

export default function ReportsCenterPage(): JSX.Element {
  const { message } = AntdApp.useApp()
  /** 生成结果弹窗数据（null 关闭） */
  const [report, setReport] = useState<GeneratedContent | null>(null)
  const [reportKind, setReportKind] = useState<ReportKind>('week')
  /** 正在生成的报告类型（null 无任务进行中） */
  const [generating, setGenerating] = useState<ReportKind | null>(null)

  const handleGenerate = async (kind: ReportKind): Promise<void> => {
    setGenerating(kind)
    try {
      const result = await api.generateReport(kind)
      setReport(result)
      setReportKind(kind)
    } catch (err) {
      message.error(getErrorMessage(err))
    } finally {
      setGenerating(null)
    }
  }

  const handleCopy = async (content: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(content)
      message.success('已复制')
    } catch (err) {
      message.error(getErrorMessage(err))
    }
  }

  const moduleName = `教务${KIND_NAME[reportKind]}`
  const busy = generating !== null

  return (
    <div>
      <PageToolbar
        title="报告中心"
        actions={
          <Space>
            <Button
              type="primary"
              icon={<FileTextOutlined />}
              loading={generating === 'week'}
              disabled={busy}
              onClick={() => void handleGenerate('week')}
            >
              生成周报
            </Button>
            <Button
              type="primary"
              icon={<FileDoneOutlined />}
              loading={generating === 'month'}
              disabled={busy}
              onClick={() => void handleGenerate('month')}
            >
              生成月报
            </Button>
          </Space>
        }
      />

      <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
        报告统计口径：课程 / 学生 / 老师数量，周期内排课与考勤汇总、出勤率；考勤异常、信息补全等主动提醒见右侧助手面板。
      </Typography.Paragraph>

      {/* 报告结果弹窗 */}
      {report && (
        <Modal
          open
          title={`教务${KIND_NAME[reportKind]}（${reportKind === 'week' ? '本周' : '本月'}）`}
          width={720}
          onCancel={() => setReport(null)}
          footer={
            <Space>
              <ExportExcelButton
                module={moduleName}
                columns={[{ header: '报告内容', key: '报告内容' }]}
                rows={[{ '报告内容': report.content }]}
              />
              <Button icon={<CopyOutlined />} onClick={() => void handleCopy(report.content)}>
                复制
              </Button>
              <Button onClick={() => setReport(null)}>关闭</Button>
            </Space>
          }
        >
          <Space align="center" wrap style={{ marginBottom: 12 }}>
            <Tag color={report.usedAi ? 'green' : 'blue'}>{report.usedAi ? 'AI 生成' : '系统模板'}</Tag>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              配置大模型 API 后可获得 AI 润色的报告（系统设置 → Agent 配置）
            </Typography.Text>
          </Space>
          <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.8, background: '#fafafa', padding: 12, borderRadius: 6 }}>
            {report.content}
          </div>
        </Modal>
      )}
    </div>
  )
}
