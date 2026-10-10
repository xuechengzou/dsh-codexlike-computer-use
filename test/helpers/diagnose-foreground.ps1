# 诊断：置顶 + 不激活的窗体，究竟在哪一刻把前台夺走了。
#
# 与其继续猜"是显示时、还是置顶时、还是之后被系统推上去的"，不如把时间线打出来。
#
# 实测教训（这版就是为它改的）：PowerShell 的脚本块**不会**捕获外层变量。
# 计时器回调里写 `$count += 1`，读到的永远是空的，于是 `$count -ge 10` 永不成立、
# 窗体永不关闭、脚本挂死。凡是跨回调共享的状态必须显式放到 $script: 作用域，
# 否则回调看到的是另一个同名变量。前台归还那一手失败也是同一个原因。
param()

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/no-activate.ps1"

$script:log = [System.Collections.Generic.List[string]]::new()
$script:baseline = [Native.Style]::GetForegroundWindow()
$script:count = 0

function Note($label) {
    $now = [Native.Style]::GetForegroundWindow()
    $mark = if ($now -eq $script:baseline) { '  (仍是原窗口)' } else { '  ← 变了' }
    $script:log.Add(("{0,-26} 前台={1}{2}" -f $label, $now, $mark))
}

Note '起始'

$form = New-NoActivateForm
$form.Text = 'TIMELINE-TEST'
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$form.Left = 400
$form.Top = 300
$form.Width = 400
$form.Height = 300
Note '窗体已 new'

# 分步复现 Set-WindowNoActivate 内部的两件事，定位是哪一步出的问题
$form.TopMost = $true
Note '设置 TopMost 之后'

$style = [Native.Style]::GetWindowLongPtr($form.Handle, -20).ToInt64()
[Native.Style]::SetWindowLongPtr($form.Handle, -20, [IntPtr]($style -bor 0x08000000)) | Out-Null
Note '设置 WS_EX_NOACTIVATE 之后'

$form.add_Shown({
        Note 'Shown 事件内'

        # 归还前台：用 $script: 作用域，保证回调里读到的是同一个变量
        $current = [Native.Style]::GetForegroundWindow()
        Note '归还前'
        if ($current -ne $script:baseline) {
            [Native.Style]::SetForegroundWindow($script:baseline) | Out-Null
            Note '归还后'
        }

        $script:timer = [System.Windows.Forms.Timer]::new()
        $script:timer.Interval = 150
        $script:timer.add_Tick({
                $script:count += 1
                Note ("显示后 +{0}ms" -f ($script:count * 150))
                if ($script:count -ge 8) {
                    $script:timer.Stop()
                    [System.IO.File]::WriteAllLines($env:TEMP + '\dsh-foreground-timeline.txt', $script:log)
                    $form.Close()
                }
            })
        $script:timer.Start()
    })

[System.Windows.Forms.Application]::Run($form)

$outPath = $env:TEMP + '\dsh-foreground-timeline.txt'
Write-Output '=== 前台时间线 ==='
Get-Content $outPath
Remove-Item $outPath -Force -ErrorAction SilentlyContinue
