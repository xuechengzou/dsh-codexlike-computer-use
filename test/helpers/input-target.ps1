# 输入注入验证用的隔离靶窗口。
#
# 置顶显示并持续把文本框内容与收到的鼠标/键盘事件写入结果文件，
# 供 live.test.mjs 比对。测试结束时会终止本进程。
#
# 之所以要一个自建窗口：合成键盘事件只会投递给**前台**窗口，直接往用户
# 桌面上打字会污染他们正在用的程序。自建置顶窗口把影响限制在测试范围内。
param(
    [Parameter(Mandatory = $true)][string]$OutPath,
    [string]$Title = "DSH-COMPUTER-USE-LIVE-TARGET",
    # 默认**不**激活。但这个窗口的用途恰恰是验证"合成输入能否到达有焦点的控件"，
    # 而合成键盘事件只投递给持有焦点的窗口——所以调用方**必须**显式传 -Activate，
    # 不能让它变成默认行为：抢前台会打断用户，也会破坏"窗口不在前台"这类前提。
    [switch]$Activate
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
. "$PSScriptRoot/no-activate.ps1"

$global:probeMouseDown = [System.Collections.Generic.List[string]]::new()
$global:probeKeyDown = [System.Collections.Generic.List[string]]::new()

$form = New-TargetForm -Activate:$Activate
$form.Text = $Title
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$form.Left = 120
$form.Top = 120
$form.Width = 700
$form.Height = 320
# 置顶是必需的：点击落在光标下的窗口，置顶后靶窗口才一定在光标下
Set-TargetWindowBehavior -Form $form -TopMost -Activate:$Activate

$box = [System.Windows.Forms.TextBox]::new()
$box.Multiline = $true
$box.Dock = [System.Windows.Forms.DockStyle]::Fill
$box.Font = [System.Drawing.Font]::new("Consolas", 16)
$box.ScrollBars = [System.Windows.Forms.ScrollBars]::Vertical
$form.Controls.Add($box)

$box.add_MouseDown({
        param($sender, $eventArgs)
        $global:probeMouseDown.Add("$($eventArgs.X),$($eventArgs.Y)")
    })
$box.add_KeyDown({
        param($sender, $eventArgs)
        $global:probeKeyDown.Add($eventArgs.KeyCode.ToString())
    })

$timer = [System.Windows.Forms.Timer]::new()
$timer.Interval = 120
$timer.add_Tick({
        $payload = [ordered]@{
            text      = $box.Text
            mouseDown = @($global:probeMouseDown)
            keyDown   = @($global:probeKeyDown)
        } | ConvertTo-Json -Compress -Depth 6
        try { [System.IO.File]::WriteAllText($OutPath, $payload) } catch { }
    })
$timer.Start()

# 只有显式要求时才抢前台。本脚本的调用方（输入注入验证）必须传 -Activate，
# 因为合成键盘事件只会投递给持有焦点的窗口，不激活就什么也验证不到。
if ($Activate) {
    $form.add_Shown({ $form.Activate() })
}
[System.Windows.Forms.Application]::Run($form)
