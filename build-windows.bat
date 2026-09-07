@echo off
chcp 65001 >nul
title Vlearn 安装包一键构建
cd /d "%~dp0"

echo ==============================================
echo    Vlearn 教培管理系统 - 安装包一键构建
echo    全程自动，约 20-40 分钟，请保持联网
echo    中途弹出的窗口一律点"是 / 允许 / 确定"
echo    建议暂时关闭杀毒软件实时防护，避免误拦
echo ==============================================
echo.

:: 检查管理员权限，没有则自动重新以管理员身份启动
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo 正在申请管理员权限，请在弹出的窗口点"是"...
    powershell -NoProfile -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)

:: ---------- [1/4] 检查/安装 Node.js ----------
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [1/4] 未检测到 Node.js，正在自动安装（约 2 分钟）...
    winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
    if %errorlevel% neq 0 (
        echo.
        echo 自动安装 Node.js 失败：请先打开"微软商店"搜索安装"应用安装程序"，
        echo 然后重新双击运行本脚本。
        pause
        exit /b 1
    )
)
set "PATH=%ProgramFiles%\nodejs;%PATH%"

:: ---------- [2/4] 检查/安装 C++ 编译工具 ----------
echo [2/4] 检查 C++ 编译工具（Visual Studio 生成工具）...
reg query "HKLM\SOFTWARE\Microsoft\VisualStudio\Setup\Instances" /f "BuildTools" /s >nul 2>&1
if %errorlevel% neq 0 (
    echo 未检测到，正在自动安装（约 6GB，需要 20-30 分钟，请耐心等待）...
    winget install -e --id Microsoft.VisualStudio.2022.BuildTools --accept-source-agreements --accept-package-agreements --override "--wait --quiet --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
    if %errorlevel% neq 0 (
        echo.
        echo 编译工具安装失败，请截图此窗口联系技术支持。
        pause
        exit /b 1
    )
)

:: ---------- [3/4] 解除 PowerShell 脚本限制（保险起见） ----------
powershell -NoProfile -Command "Set-ExecutionPolicy -Scope CurrentUser RemoteSigned -Force" >nul 2>&1

:: ---------- [4/4] 安装依赖并打包 ----------
echo [3/4] 正在下载依赖并编译数据库组件（约 5-10 分钟，进度条卡住属正常）...
call npm install
if %errorlevel% neq 0 goto :fail

echo [4/4] 正在打包 Windows 安装包（约 5-10 分钟）...
call npm run dist:win
if %errorlevel% neq 0 goto :fail

echo.
echo ==============================================
echo    构建成功！
echo    安装包位置（已为你打开文件夹）：
echo      release\vlearn-1.0.0-win-x64.exe
echo    把安装包和《使用说明书.pdf》一起发给用户即可
echo ==============================================
start explorer "%~dp0release"
pause
exit /b 0

:fail
echo.
echo ==============================================
echo    构建失败：请把此窗口完整截图（尤其是最后 10 行）
echo    发给技术支持人员分析
echo ==============================================
pause
exit /b 1
