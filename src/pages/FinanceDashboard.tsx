/**
 * 财务仪表盘：月度汇总 KPI 统计卡片。
 * - 顶部工具栏：月份选择（DatePicker picker="month"）+ 刷新按钮
 * - 5 张汇总卡片：本月学生应缴 / 学生实缴 / 老师应付 / 老师实付 / 本月盈亏
 * - 盈亏 >= 0 显示绿色，< 0 显示红色；各卡片图标以淡色背景弱化呈现
 * - 数据按缴费 / 支付日期所在月份统计（getDashboard），接口失败时提示错误
 */
import {
  AccountBookOutlined,
  LineChartOutlined,
  MoneyCollectOutlined,
  PayCircleOutlined,
  ReloadOutlined,
  WalletOutlined
} from '@ant-design/icons'
import { App as AntdApp, Button, Card, Col, DatePicker, Row, Space, Statistic, Typography } from 'antd'
import dayjs, { Dayjs } from 'dayjs'
import { useCallback, useEffect, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { api, getErrorMessage } from '../api'
import PageToolbar from '../components/PageToolbar'
import type { DashboardData } from '../types'

/** 卡片视觉配置：图标（淡色背景块 + 主题色图标，弱化图标存在感） */
interface StatCardConfig {
  title: string
  icon: ReactNode
  /** 图标主题色 */
  color: string
  /** 图标背景淡色 */
  bg: string
}

/** 除盈亏外的 4 张金额卡片配置 */
const CARD_CONFIGS: StatCardConfig[] = [
  {
    title: '本月学生应缴总额',
    icon: <MoneyCollectOutlined />,
    color: '#1677ff',
    bg: '#e6f4ff'
  },
  {
    title: '本月学生实缴总额',
    icon: <PayCircleOutlined />,
    color: '#52c41a',
    bg: '#f6ffed'
  },
  {
    title: '本月老师应付总额',
    icon: <AccountBookOutlined />,
    color: '#fa8c16',
    bg: '#fff7e6'
  },
  {
    title: '本月老师实付总额',
    icon: <WalletOutlined />,
    color: '#722ed1',
    bg: '#f9f0ff'
  }
]

/** 盈亏卡片配置（数值按正负染色，图标本身仍保持淡色） */
const PROFIT_CONFIG: StatCardConfig = {
  title: '本月盈亏（实缴-实付）',
  icon: <LineChartOutlined />,
  color: '#2f54eb',
  bg: '#f0f5ff'
}

/** 图标徽章：淡色圆角底 + 主题色图标，弱化视觉重量 */
function IconBadge({ config }: { config: StatCardConfig }): JSX.Element {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 34,
        height: 34,
        borderRadius: 10,
        background: config.bg,
        color: config.color,
        fontSize: 18,
        marginRight: 8,
        verticalAlign: 'middle'
      }}
    >
      {config.icon}
    </span>
  )
}

export default function FinanceDashboard(): JSX.Element {
  const { message } = AntdApp.useApp()
  const [month, setMonth] = useState<Dayjs>(() => dayjs())
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(
    async (monthStr: string): Promise<void> => {
      setLoading(true)
      try {
        const d = await api.getDashboard(monthStr)
        setData(d)
      } catch (err) {
        message.error(getErrorMessage(err))
      } finally {
        setLoading(false)
      }
    },
    [message]
  )

  useEffect(() => {
    void load(month.format('YYYY-MM'))
  }, [load, month])

  const handleMonthChange = (m: Dayjs | null): void => {
    if (!m) return
    setMonth(m)
  }

  const handleRefresh = (): void => {
    void load(month.format('YYYY-MM'))
  }

  /** 卡片金额（加载中沿用旧值，避免闪烁；无数据时显示 0） */
  const money = (v: number | undefined): number => (v === undefined ? 0 : Math.round(v * 100) / 100)

  /** 盈亏着色：>=0 绿色、<0 红色（状态语义色，卡片带图标与文字标签共同表达） */
  const profitStyle = (v: number | undefined): CSSProperties =>
    (v ?? 0) >= 0 ? { color: '#3f8600' } : { color: '#cf1322' }

  return (
    <div>
      <PageToolbar
        title="财务仪表盘"
        actions={
          <Space>
            <DatePicker
              picker="month"
              allowClear={false}
              value={month}
              onChange={handleMonthChange}
              placeholder="选择月份"
            />
            <Button icon={<ReloadOutlined />} loading={loading} onClick={handleRefresh}>
              刷新
            </Button>
          </Space>
        }
      />

      {/* 第一行：3 张卡片（应缴 / 实缴 / 老师应付） */}
      <Row gutter={[16, 16]}>
        <Col span={8}>
          <Card className="dashboard-card" loading={loading && data === null}>
            <Statistic
              title={
                <span>
                  <IconBadge config={CARD_CONFIGS[0]} />
                  {CARD_CONFIGS[0].title}
                </span>
              }
              value={money(data?.studentDue)}
              precision={2}
              prefix="¥"
            />
          </Card>
        </Col>
        <Col span={8}>
          <Card className="dashboard-card" loading={loading && data === null}>
            <Statistic
              title={
                <span>
                  <IconBadge config={CARD_CONFIGS[1]} />
                  {CARD_CONFIGS[1].title}
                </span>
              }
              value={money(data?.studentPaid)}
              precision={2}
              prefix="¥"
            />
          </Card>
        </Col>
        <Col span={8}>
          <Card className="dashboard-card" loading={loading && data === null}>
            <Statistic
              title={
                <span>
                  <IconBadge config={CARD_CONFIGS[2]} />
                  {CARD_CONFIGS[2].title}
                </span>
              }
              value={money(data?.teacherDue)}
              precision={2}
              prefix="¥"
            />
          </Card>
        </Col>
      </Row>

      {/* 第二行：2 张卡片（居中，左右留白对称） */}
      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col span={8} offset={4}>
          <Card className="dashboard-card" loading={loading && data === null}>
            <Statistic
              title={
                <span>
                  <IconBadge config={CARD_CONFIGS[3]} />
                  {CARD_CONFIGS[3].title}
                </span>
              }
              value={money(data?.teacherPaid)}
              precision={2}
              prefix="¥"
            />
          </Card>
        </Col>
        <Col span={8}>
          <Card className="dashboard-card" loading={loading && data === null}>
            <Statistic
              title={
                <span>
                  <IconBadge config={PROFIT_CONFIG} />
                  {PROFIT_CONFIG.title}
                </span>
              }
              value={money(data?.profit)}
              precision={2}
              prefix="¥"
              valueStyle={profitStyle(data?.profit)}
            />
          </Card>
        </Col>
      </Row>

      <Typography.Text type="secondary" style={{ display: 'block', marginTop: 16 }}>
        统计口径：按记录的缴费 / 支付日期所在月份汇总；盈亏 = 学生实缴 - 老师实付。
      </Typography.Text>
    </div>
  )
}
