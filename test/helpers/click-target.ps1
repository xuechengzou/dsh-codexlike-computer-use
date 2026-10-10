# 点击方式对比用的靶窗口。
#
# 一个带按钮的普通 WinForms 窗口，持续把"按钮被点了多少次"写入 JSON，
# 供探针比对。用于区分三种点击投递方式：
#   - SendInput（会移动真实光标）
#   - PostMessage/SendMessage 投递 WM_LBUTTONDOWN/UP（不碰光标）
#   - UI Automation 的 InvokePattern（不碰光标、也不需要坐标）
param(
    [Parameter(Mandatory = $true)][string]$OutPath,
    [string]$Title = "DSH-CLICK-PROBE",
    # 默认**不**激活。只有显式要求时才把自己推到前台——
    # 靶窗口抢前台会打断用户，也会破坏"窗口不在前台"这类被验证的前提。
    [switch]$Activate
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
. "$PSScriptRoot/no-activate.ps1"

$global:clickCount = 0
$global:downCount = 0

$form = New-TargetForm -Activate:$Activate
$form.Text = $Title
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$form.Left = 200
$form.Top = 160
$form.Width = 560
$form.Height = 260
# 置顶是必需的：点击落在光标下的那个窗口，置顶后靶窗口才一定在光标下。
# 但置顶只影响 z 序，与是否抢前台无关，所以可以"盖住别人"而不"抢走焦点"。
Set-TargetWindowBehavior -Form $form -TopMost -Activate:$Activate

$button = [System.Windows.Forms.Button]::new()
$button.Text = "TARGET"
$button.Name = "TargetButton"
$button.Left = 40
$button.Top = 40
$button.Width = 200
$button.Height = 80
$button.add_Click({ $global:clickCount += 1 })
$button.add_MouseDown({ $global:downCount += 1 })
$form.Controls.Add($button)

$timer = [System.Windows.Forms.Timer]::new()
$timer.Interval = 100
$timer.add_Tick({
        # 同时报出按钮的屏幕坐标，探针据此换算客户区坐标
        $origin = $button.PointToScreen([System.Drawing.Point]::new(0, 0))
        $payload = [ordered]@{
            clicks    = $global:clickCount
            mouseDown = $global:downCount
            button    = @{ screenX = $origin.X; screenY = $origin.Y; width = $button.Width; height = $button.Height }
            cursor    = [System.Windows.Forms.Cursor]::Position.X, [System.Windows.Forms.Cursor]::Position.Y
        } | ConvertTo-Json -Compress -Depth 5
        try { [System.IO.File]::WriteAllText($OutPath, $payload) } catch { }
    })
$timer.Start()

# 只有显式要求时才抢前台，且必须等到窗口显示之后再激活
if ($Activate) {
    $form.add_Shown({ $form.Activate() })
}
[System.Windows.Forms.Application]::Run($form)
