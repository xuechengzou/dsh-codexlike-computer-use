# 纯色窗口，用于验证"窗口被遮挡 / 不在前台时能否截到它自己的内容"。
#
# 整个客户区填一种高辨识度的纯色并写上标签，这样抓回来的位图可以按像素统计判断：
# 到底是抓到了目标窗口自身的内容，还是抓到了盖在它上面的东西，或者是一张黑图。
#
# 默认**不激活**：这个窗口是给"后台截图"当靶子的。它要是自己抢了前台，
# 被验证的前提（窗口不在前台）就当场失效，测量会变成一场自欺。
param(
    [Parameter(Mandatory = $true)][string]$OutPath,
    [string]$Title = "PAINT-TARGET",
    [string]$Color = "Magenta",
    [int]$Left = 200,
    [int]$Top = 150,
    [int]$Width = 500,
    [int]$Height = 360,
    # 是否置顶。置顶只影响 z 序，不改变"是否持有焦点"，因此可以在不抢前台的前提下
    # 可靠地盖住另一个窗口——"被完全遮挡"这类测试需要它。
    [switch]$TopMost,
    # 显式要求时才抢前台；默认不抢。
    [switch]$Activate
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
. "$PSScriptRoot/no-activate.ps1"

$form = New-TargetForm -Activate:$Activate
$form.Text = $Title
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$form.Left = $Left
$form.Top = $Top
$form.Width = $Width
$form.Height = $Height
$form.BackColor = [System.Drawing.Color]::FromName($Color)
Set-TargetWindowBehavior -Form $form -TopMost:$TopMost -Activate:$Activate

$label = [System.Windows.Forms.Label]::new()
$label.Text = $Title
$label.Dock = [System.Windows.Forms.DockStyle]::Fill
$label.TextAlign = [System.Drawing.ContentAlignment]::MiddleCenter
$label.Font = [System.Drawing.Font]::new("Consolas", 22)
$label.ForeColor = [System.Drawing.Color]::Black
$form.Controls.Add($label)

# 把自己的句柄与矩形持续写出来，探针据此精确定位与裁剪
$timer = [System.Windows.Forms.Timer]::new()
$timer.Interval = 200
$timer.add_Tick({
        $rect = $form.RectangleToScreen($form.ClientRectangle)
        $payload = [ordered]@{
            hwnd   = $form.Handle.ToInt64()
            left   = $rect.Left
            top    = $rect.Top
            width  = $rect.Width
            height = $rect.Height
            color  = $Color
            state  = $form.WindowState.ToString()
        } | ConvertTo-Json -Compress
        try { [System.IO.File]::WriteAllText($OutPath, $payload) } catch { }
    })
$timer.Start()

if ($Activate) {
    $form.add_Shown({ $form.Activate() })
}
[System.Windows.Forms.Application]::Run($form)
