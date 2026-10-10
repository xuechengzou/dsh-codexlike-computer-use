# 诊断：**两个**窗口（底窗 + 置顶遮挡窗）时的前台时间线。
#
# 单窗口的版本已经证明"置顶 + 不激活"不抢前台，所以差别只可能出在"两个窗口"上：
# 谁先创建、谁继承了什么、后创建的那个是否被系统顺手推到前台。
#
# 仍然遵守那条教训：跨回调共享的状态一律放 $script: 作用域。
param()

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/no-activate.ps1"

$script:log = [System.Collections.Generic.List[string]]::new()
$script:baseline = [Native.Style]::GetForegroundWindow()
$script:count = 0

function Note($label) {
    $now = [Native.Style]::GetForegroundWindow()
    $tag = if ($now -eq $script:baseline) { '原窗口' } elseif ($now -eq $script:bottom.Handle) { '底窗' } elseif ($now -eq $script:cover.Handle) { '遮挡窗' } else { "其它($now)" }
    $script:log.Add(("{0,-24} -> {1}" -f $label, $tag))
}

function New-PaintForm($title, $color, $left, $top, $w, $h, $topmost) {
    $form = New-NoActivateForm
    $form.Text = $title
    $form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
    $form.Left = $left
    $form.Top = $top
    $form.Width = $w
    $form.Height = $h
    $form.BackColor = [System.Drawing.Color]::FromName($color)
    Set-WindowNoActivate -Form $form -TopMost:$topmost
    return $form
}

$script:bottom = New-PaintForm 'TL-BOTTOM' 'Magenta' 300 240 520 380 $false
Note '底窗已创建'

$script:cover = New-PaintForm 'TL-COVER' 'Cyan' 280 220 600 460 $true
Note '遮挡窗已创建'

# 先把底窗显示出来，再显示遮挡窗——这正是 verify 脚本的实际顺序
$script:bottom.add_Shown({ Note '底窗 Shown' })
$script:cover.add_Shown({
        Note '遮挡窗 Shown'
        $script:timer = [System.Windows.Forms.Timer]::new()
        $script:timer.Interval = 120
        $script:timer.add_Tick({
                $script:count += 1
                Note ("+{0}ms" -f ($script:count * 120))
                if ($script:count -ge 12) {
                    $script:timer.Stop()
                    [System.IO.File]::WriteAllLines($env:TEMP + '\dsh-fg-two.txt', $script:log)
                    # 必须把**主窗体**也关掉：Application.Run 的消息循环只认它，
                    # 只关遮挡窗的话循环永远不退出，脚本就会挂死在那儿。
                    $script:cover.Close()
                    $script:bottom.Close()
                }
            })
        $script:timer.Start()
    })

# 两窗先后显示：Application.Run 只管第一个，第二个用 Show 显示
$script:bottom.add_Shown({
        $script:cover.Show()
    })

[System.Windows.Forms.Application]::Run($script:bottom)

$outPath = $env:TEMP + '\dsh-fg-two.txt'
Write-Output '=== 双窗口前台时间线 ==='
Get-Content $outPath
Remove-Item $outPath -Force -ErrorAction SilentlyContinue
