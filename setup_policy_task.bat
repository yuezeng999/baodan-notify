@echo off
chcp 65001 >nul
echo ========================================
echo   保单缴费提醒 - 任务计划设置
echo ========================================
echo.

:: 检查 Python
python --version >nul 2>&1
if errorlevel 1 (
    echo [错误] 未找到 Python，请先安装 Python
    pause
    exit /b 1
)

:: 获取脚本所在目录
set "SCRIPT_DIR=%~dp0"

:: 创建任务计划，每天上午9点运行
echo 正在创建 Windows 任务计划...
echo.

schtasks /create ^
    /tn "家庭保单缴费提醒" ^
    /tr "python \"%SCRIPT_DIR%policy_notification_service.py\"" ^
    /sc daily ^
    /st 09:00 ^
    /f ^
    >nul 2>&1

if errorlevel 1 (
    echo [失败] 任务计划创建失败，可能需要管理员权限
    echo 请右键以管理员身份运行此脚本
    pause
    exit /b 1
)

echo [成功] 任务计划创建完成!
echo.
echo 任务详情:
echo   名称: 家庭保单缴费提醒
echo   执行时间: 每天 09:00
echo   执行脚本: policy_notification_service.py
echo.
echo.
echo === 下一步操作 ===
echo 1. 运行以下命令配置钉钉通知:
echo    python policy_notification_service.py --setup
echo.
echo 2. 查看当前配置:
echo    python policy_notification_service.py --config
echo.
echo 3. 手动测试提醒:
echo    python policy_notification_service.py --test
echo.
echo 4. 立即检查（不发送通知，只打印）:
echo    python policy_notification_service.py
echo.
echo 5. 删除任务计划:
echo    schtasks /delete /tn "家庭保单缴费提醒" /f
echo.
pause
