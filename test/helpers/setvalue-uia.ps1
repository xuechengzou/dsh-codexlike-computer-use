# UI Automation 的 ValuePattern 探针：直接给控件设值，不经过任何按键。
#
# 对"往背景窗口里填文本"来说这是最干净的一条路：不需要焦点、不需要光标、
# 也不需要逐字模拟按键。前提是目标控件暴露 ValuePattern。
param(
    [Parameter(Mandatory = $true)][string]$Title,
    [Parameter(Mandatory = $true)][string]$Value
)

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

try {
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $windowCondition = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::NameProperty, $Title)
    $window = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $windowCondition)
    if ($null -eq $window) { Write-Output "UIA: 未找到窗体 '$Title'"; exit 1 }

    # 找第一个支持 ValuePattern 的控件（这里就是那个多行文本框）
    $editCondition = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Edit)
    $edit = $window.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $editCondition)
    if ($null -eq $edit) { Write-Output "UIA: 未找到文本控件"; exit 1 }

    $pattern = $edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    if ($null -eq $pattern) { Write-Output "UIA: 控件不支持 ValuePattern"; exit 1 }

    $pattern.SetValue($Value)
    Write-Output "UIA: ValuePattern.SetValue 已调用"
} catch {
    Write-Output "UIA: 失败 - $($_.Exception.Message)"
    exit 1
}
