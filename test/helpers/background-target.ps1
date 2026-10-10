# 背景输入验证用的靶窗口：一个按钮 + 一个文本框。
#
# 用来回答"窗口不在前台时，投递消息能不能点到按钮、能不能输入文字"。
# 持续把点击次数与文本框内容写入 JSON 供比对。
#
# 注意：本窗口刻意**不置顶**。遮挡与前台由探针用另一个窗口控制。
param(
    [Parameter(Mandatory = $true)][string]$OutPath,
    [string]$Title = "BG-TARGET",
    [int]$Left = 200,
    [int]$Top = 160
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# 共用件：让靶窗口从不抢前台（原因见 no-activate.ps1 里的说明）
. "$PSScriptRoot/no-activate.ps1"

$global:clicks = 0

$form = New-NoActivateForm
$form.Text = $Title
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$form.Left = $Left
$form.Top = $Top
$form.Width = 560
$form.Height = 320

# 必须在显示之前调用：函数内部会先建好窗口句柄再改扩展样式
Set-WindowNoActivate -Form $form

$button = [System.Windows.Forms.Button]::new()
$button.Text = "CLICK"
$button.Name = "BgButton"
$button.Left = 30
$button.Top = 30
$button.Width = 180
$button.Height = 70
$button.add_Click({ $global:clicks += 1 })
$form.Controls.Add($button)

$box = [System.Windows.Forms.TextBox]::new()
$box.Multiline = $true
$box.Name = "BgTextBox"
$box.Left = 30
$box.Top = 130
$box.Width = 480
$box.Height = 130
$box.Font = [System.Drawing.Font]::new("Consolas", 14)
$form.Controls.Add($box)

$timer = [System.Windows.Forms.Timer]::new()
$timer.Interval = 150
$timer.add_Tick({
        $r = $form.RectangleToScreen($form.ClientRectangle)
        $payload = [ordered]@{
            clicks = $global:clicks
            text   = $box.Text
            form   = $form.Handle.ToInt64()
            button = $button.Handle.ToInt64()
            box    = $box.Handle.ToInt64()
            rect   = @{ left = $r.Left; top = $r.Top; width = $r.Width; height = $r.Height }
        } | ConvertTo-Json -Compress -Depth 5
        try { [System.IO.File]::WriteAllText($OutPath, $payload) } catch { }
    })
$timer.Start()

[System.Windows.Forms.Application]::Run($form)
