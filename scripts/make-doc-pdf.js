/**
 * 将 Markdown 说明书渲染为 PDF（用于发送给无代码基础的用户）。
 * 用法：npx electron scripts/make-doc-pdf.js [输入.md] [输出.pdf]
 * 原理：marked 转 HTML → 隐藏 BrowserWindow 加载 → printToPDF。
 */
const { app, BrowserWindow } = require('electron')
const { marked } = require('marked')
const fs = require('node:fs')
const path = require('node:path')

const input = process.argv[2] ?? path.join(__dirname, '..', '使用说明书.md')
const output = process.argv[3] ?? path.join(__dirname, '..', '使用说明书.pdf')

const md = fs.readFileSync(input, 'utf8')
const body = marked.parse(md)

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<style>
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif;
    color: #24292f; line-height: 1.75; margin: 0; padding: 24px 36px; font-size: 14px;
  }
  h1 { font-size: 26px; border-bottom: 2px solid #1677ff; padding-bottom: 10px; margin-top: 0; }
  h2 { font-size: 20px; margin-top: 32px; border-left: 4px solid #1677ff; padding-left: 10px; }
  h3 { font-size: 16px; margin-top: 24px; }
  table { border-collapse: collapse; width: 100%; margin: 12px 0; font-size: 13px; }
  th, td { border: 1px solid #d0d7de; padding: 8px 12px; text-align: left; }
  th { background: #f0f5ff; font-weight: 600; }
  code { background: #f6f8fa; padding: 2px 5px; border-radius: 4px; font-size: 12.5px; }
  blockquote { border-left: 4px solid #ffd591; background: #fffbe6; margin: 12px 0; padding: 8px 16px; }
  blockquote p { margin: 4px 0; }
  img { max-width: 100%; border: 1px solid #e5e7eb; border-radius: 8px; margin: 8px 0; }
  hr { border: none; border-top: 1px solid #e5e7eb; margin: 24px 0; }
  a { color: #1677ff; text-decoration: none; }
</style>
</head>
<body>${body}</body>
</html>`

app.whenReady().then(async () => {
  // HTML 写入临时文件（位于项目根，保证相对图片路径可解析）
  const tmpHtml = path.join(__dirname, '..', '.doc-temp.html')
  fs.writeFileSync(tmpHtml, html)

  const win = new BrowserWindow({ show: false, width: 900, height: 1200 })
  await win.loadFile(tmpHtml)
  // 等待图片加载完成
  await new Promise((resolve) => setTimeout(resolve, 1500))

  const pdf = await win.webContents.printToPDF({
    printBackground: true,
    margins: { top: 0.6, bottom: 0.6, left: 0.5, right: 0.5 },
    pageSize: 'A4'
  })
  fs.writeFileSync(output, pdf)
  fs.rmSync(tmpHtml, { force: true })
  console.log(`PDF 已生成：${output}（${(pdf.length / 1024 / 1024).toFixed(1)} MB）`)
  app.exit(0)
})
