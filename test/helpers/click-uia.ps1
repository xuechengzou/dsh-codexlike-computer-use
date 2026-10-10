# UI Automation 探针：通过 InvokePattern 触发按钮，完全不涉及鼠标与坐标。
#
# 这是三条路里唯一"语义化"的方式——按控件名寻址，而不是按像素点击。
param(
    [Parameter(Mandatory = $true)][string]$Title,
    [Parameter(Mandatory = $true)][string]$ButtonName
)

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

try {
    $root = [System.Windows.Automation.AutomationElement]::RootElement

    # 先定位目标窗体，再在其子树里找按钮，避免误匹配其它同名控件
    $windowCondition = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::NameProperty, $Title)
    $window = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $windowCondition)
    if ($null -eq $window) { Write-Output "UIA: 未找到窗体 '$Title'"; exit 1 }

    $buttonCondition = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::NameProperty, $ButtonName)
    $button = $window.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $buttonCondition)
    if ($null -eq $button) { Write-Output "UIA: 未找到按钮 '$ButtonName'"; exit 1 }

    $pattern = $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    if ($null -eq $pattern) { Write-Output "UIA: 按钮不支持 InvokePattern"; exit 1 }

    $pattern.Invoke()
    Write-Output "UIA: InvokePattern 已调用"
} catch {
    Write-Output "UIA: 失败 - $($_.Exception.Message)"
    exit 1
}
