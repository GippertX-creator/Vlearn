/**
 * 助教课程内容记录编辑弹窗：
 * - 知识点（标签输入）、课堂表现、当日作业、当日总结（均可留空）
 * - 保存后生成 lesson_notes 记录（关联教务库课程实例）
 * - "生成微信群短信"：调用外部大模型（API 配置在助教设置中，未配置时报错），
 *   结果弹窗展示并可复制，自动保存到历史消息
 * - 底部"作业批改（未开发）"置灰按钮：提示功能即将上线
 */
import { EditOutlined, MessageOutlined, SaveOutlined } from '@ant-design/icons'
import { App as AntdApp, Button, Descriptions, Divider, Form, Input, Modal, Select, Space, Spin, Typography } from 'antd'
import { useCallback, useEffect, useState } from 'react'
import { api, getErrorMessage } from '../api'
import type { InstanceDetail, LessonNote } from '../types'

interface LessonNoteEditorModalProps {
  /** 课程实例 id（null 关闭） */
  scheduleInstanceId: number | null
  onClose: () => void
  /** 保存/生成后通知父组件刷新 */
  onChanged: () => void
}

export default function LessonNoteEditorModal({
  scheduleInstanceId,
  onClose,
  onChanged
}: LessonNoteEditorModalProps): JSX.Element {
  const { message } = AntdApp.useApp()
  const [instance, setInstance] = useState<InstanceDetail | null>(null)
  const [note, setNote] = useState<LessonNote | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [form] = Form.useForm()
  /** 生成结果弹窗 */
  const [smsResult, setSmsResult] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!scheduleInstanceId) return
    setLoading(true)
    try {
      const [detail, existing] = await Promise.all([
        api.getInstanceDetail(scheduleInstanceId),
        api.getLessonNote(scheduleInstanceId)
      ])
      setInstance(detail)
      setNote(existing)
      form.setFieldsValue({
        knowledgePoints: existing?.knowledgePoints ? existing.knowledgePoints.split(',').map((s) => s.trim()).filter(Boolean) : [],
        classPerformance: existing?.classPerformance ?? undefined,
        homework: existing?.homework ?? undefined,
        summary: existing?.summary ?? undefined
      })
    } catch (err) {
      message.error(getErrorMessage(err))
      onClose()
    } finally {
      setLoading(false)
    }
  }, [scheduleInstanceId, form, message, onClose])

  useEffect(() => {
    load()
  }, [load])

  const handleSave = async (): Promise<LessonNote | null> => {
    if (!scheduleInstanceId) return null
    try {
      const values = await form.validateFields()
      setSaving(true)
      const saved = await api.saveLessonNote({
        scheduleInstanceId,
        knowledgePoints: (values.knowledgePoints as string[] | undefined)?.join(',') ?? null,
        classPerformance: values.classPerformance?.trim() || null,
        homework: values.homework?.trim() || null,
        summary: values.summary?.trim() || null
      })
      setNote(saved)
      message.success('课程记录已保存')
      onChanged()
      return saved
    } catch (err) {
      if (err instanceof Error && err.message) message.error(getErrorMessage(err))
      return null
    } finally {
      setSaving(false)
    }
  }

  /** 生成短信前先保存当前内容，再调用大模型 */
  const handleGenerateSms = async (): Promise<void> => {
    const saved = note ?? (await handleSave())
    if (!saved) return
    setGenerating(true)
    try {
      const result = await api.generateSms(saved.id)
      setSmsResult(result.content)
      onChanged()
    } catch (err) {
      message.error(getErrorMessage(err))
    } finally {
      setGenerating(false)
    }
  }

  const inst = instance?.instance
  const course = instance?.course

  return (
    <Modal
      open={scheduleInstanceId !== null}
      onCancel={onClose}
      footer={null}
      width={680}
      title={
        <span>
          <EditOutlined style={{ marginRight: 8 }} />
          课程内容记录{course ? ` · ${course.subject} ${course.grade} ${course.className}` : ''}
        </span>
      }
    >
      <Spin spinning={loading}>
        <Descriptions size="small" column={2} bordered style={{ marginBottom: 16 }}>
          <Descriptions.Item label="上课时间">
            {inst ? `${inst.date} ${inst.startTime}-${inst.endTime}` : '—'}
          </Descriptions.Item>
          <Descriptions.Item label="授课老师">
            {inst ? inst.actualTeacherName ?? course?.defaultTeacherName ?? '—' : '—'}
          </Descriptions.Item>
        </Descriptions>

        <Form form={form} layout="vertical">
          <Form.Item name="knowledgePoints" label="知识点（输入后按回车添加，可多个）">
            <Select
              mode="tags"
              placeholder="如：函数单调性、导数应用"
              tokenSeparators={[',', '，']}
              open={false}
              suffixIcon={null}
            />
          </Form.Item>
          <Form.Item name="classPerformance" label="课堂表现">
            <Input.TextArea rows={3} placeholder="如：整体良好，张三回答问题积极" />
          </Form.Item>
          <Form.Item name="homework" label="当日作业">
            <Input.TextArea rows={2} placeholder="如：完成练习册 P45-46" />
          </Form.Item>
          <Form.Item name="summary" label="当日总结">
            <Input.TextArea rows={3} placeholder="本节课整体情况总结（可选）" />
          </Form.Item>
        </Form>

        <Divider style={{ margin: '8px 0 16px' }} />

        <Space wrap>
          <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={() => void handleSave()}>
            保存记录
          </Button>
          <Button icon={<MessageOutlined />} loading={generating} onClick={() => void handleGenerateSms()}>
            生成微信群短信
          </Button>
          <Button
            disabled
            onClick={() => message.info('该功能即将上线，敬请期待')}
            title="功能未开发"
          >
            作业批改（未开发）
          </Button>
        </Space>
        <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0, fontSize: 12 }}>
          生成微信群短信需要先在「系统设置 → 大模型 API 配置」中填写 API 地址与密钥。
        </Typography.Paragraph>
      </Spin>

      {/* 短信结果弹窗 */}
      <Modal
        open={smsResult !== null}
        onCancel={() => setSmsResult(null)}
        title="微信群短信（可直接复制发送）"
        footer={
          <Space>
            <Button
              type="primary"
              onClick={() => {
                if (smsResult) navigator.clipboard.writeText(smsResult)
                message.success('已复制到剪贴板')
              }}
            >
              复制
            </Button>
            <Button onClick={() => setSmsResult(null)}>关闭</Button>
          </Space>
        }
      >
        <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.8, background: '#fafafa', padding: 12, borderRadius: 6 }}>
          {smsResult}
        </div>
      </Modal>
    </Modal>
  )
}
