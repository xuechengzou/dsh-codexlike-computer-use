# 让测试用的窗口**从不抢前台**。
#
# 为什么需要它：这些窗口是给自动化测试当靶子的。如果它们显示时把自己推到前台，
# 就会打断用户正在做的事——更糟的是，它会破坏被验证的前提本身：
#
#   - 测"窗口不在前台时能否操作"，结果窗口自己成了前台，测的就不是那件事了；
#   - 而从后台进程调用 SetForegroundWindow 会被 Windows 的前台锁拒绝，
#     测试脚本**没有能力**把前台再移走，只能眼睁睁看着前提失效并误报成功能失败。
#
# 三层防护，缺一层都会实测漏过去：
#   1. `ShowWithoutActivation` 覆盖为 true —— 挡住 WinForms 在显示那一刻的自我激活。
#   2. `WS_EX_NOACTIVATE` 扩展样式 —— 挡住用户点击时的激活。
#   3. **显示之后归还前台** —— 前两层都挡不住"置顶窗口被系统推到前台"这一情况（实测如此）。
#      好在窗口刚成为前台时，**当前进程就握有前台**，于是它有权调用
#      SetForegroundWindow 把前台还给原来那个窗口——这是唯一能撤销既成事实的时机。

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# PowerShell 7（.NET 10）下 Add-Type 的默认引用集不含 Component 所在的程序集，
# 只写 -ReferencedAssemblies System.Windows.Forms 会报 CS0012（"类型 Component
# 在未引用的程序集中定义"）。显式把这些程序集的位置传进去，不依赖默认值。
$formReferences = @(
    [System.Windows.Forms.Form].Assembly.Location
    [System.ComponentModel.Component].Assembly.Location
    [System.Drawing.Point].Assembly.Location
) | Select-Object -Unique

Add-Type -ReferencedAssemblies $formReferences -TypeDefinition @'
using System.Windows.Forms;

/// <summary>
/// 显示时不会激活自己的窗体。
///
/// 只靠 WS_EX_NOACTIVATE 是不够的：那个扩展样式管的是"用户点击时是否激活"，
/// 管不住窗体在显示那一刻主动激活自己。ShowWithoutActivation 才是针对后者的开关。
/// </summary>
public class DshNoActivateForm : Form
{
    protected override bool ShowWithoutActivation
    {
        get { return true; }
    }
}
'@

Add-Type -Namespace Native -Name Style -MemberDefinition @'
[DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")]
public static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int nIndex);
[DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")]
public static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int nIndex, IntPtr dwNewLong);
[DllImport("user32.dll")]
public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")]
public static extern bool SetForegroundWindow(IntPtr hWnd);
'@

$script:GWL_EXSTYLE = -20
$script:WS_EX_NOACTIVATE = 0x08000000

<#
.SYNOPSIS
    创建一个"永不抢前台"的窗体。

.DESCRIPTION
    代替 [System.Windows.Forms.Form]::new()。返回的是覆盖了 ShowWithoutActivation
    的子类实例，因此显示时不会激活。
#>
function New-NoActivateForm {
    return [DshNoActivateForm]::new()
}

<#
.SYNOPSIS
    按需创建靶窗体：默认"永不抢前台"，显式 -Activate 时返回普通可激活窗体。

.DESCRIPTION
    -Activate 必须换用**普通**窗体，不能只在现有窗体上调用 Activate()：
    WS_EX_NOACTIVATE 与 ShowWithoutActivation 都会让窗口根本无法被激活，
    此时 Activate() 是空操作，依赖焦点的测试会静默失败——它不会报错，
    只会收不到任何输入，于是失败原因看起来像是"输入没送到"。
#>
function New-TargetForm {
    param([switch]$Activate)

    if ($Activate) { return [System.Windows.Forms.Form]::new() }
    return [DshNoActivateForm]::new()
}

<#
.SYNOPSIS
    配置靶窗体：默认不激活（可选置顶），显式 -Activate 时保持普通可激活行为。

.PARAMETER TopMost
    是否置顶。置顶只影响 z 序，与是否激活正交——可以在不抢前台的前提下盖住别的窗口。

.PARAMETER Activate
    是否允许该窗口抢前台。只有那些**必须验证焦点相关行为**的测试才该传它。
#>
function Set-TargetWindowBehavior {
    param(
        [Parameter(Mandatory = $true)][System.Windows.Forms.Form]$Form,
        [switch]$TopMost,
        [switch]$Activate
    )

    if ($Activate) {
        if ($TopMost) { $Form.TopMost = $true }
        return
    }
    Set-WindowNoActivate -Form $Form -TopMost:$TopMost
}

<#
.SYNOPSIS
    给一个尚未显示的窗体打上"永不激活"的样式，并安排"显示后归还前台"。

.DESCRIPTION
    必须在窗体**显示之前**调用。函数内部会先访问 Form.Handle，这会立即创建
    窗口句柄（但窗口仍不可见），因此正好能在"已建好、还没显示"这个窗口期改样式。

    同时会记录"当前谁持有前台"，并在本窗体显示之后检查：如果前台被本窗体夺走，
    就立刻还回去。这一手是必要的——实测即使有 ShowWithoutActivation 与
    WS_EX_NOACTIVATE，置顶窗口仍可能被系统推到前台。

.PARAMETER Form
    目标窗体。

.PARAMETER TopMost
    是否同时置顶。置顶只影响 z 序，与是否激活是两件正交的事，因此可以在不抢前台的
    前提下可靠地盖住其它窗口——这正是"被遮挡"这类测试需要的。
#>
function Set-WindowNoActivate {
    param(
        [Parameter(Mandatory = $true)][System.Windows.Forms.Form]$Form,
        [switch]$TopMost
    )

    if ($TopMost) { $Form.TopMost = $true }

    $style = [Native.Style]::GetWindowLongPtr($Form.Handle, $script:GWL_EXSTYLE).ToInt64()
    [Native.Style]::SetWindowLongPtr(
        $Form.Handle,
        $script:GWL_EXSTYLE,
        [IntPtr]($style -bor $script:WS_EX_NOACTIVATE)
    ) | Out-Null

    # 记下"原本谁持有前台"。此刻本窗体还没显示，所以拿到的一定是别人。
    $previousForeground = [Native.Style]::GetForegroundWindow()

    $Form.add_Shown({
            param($sender, $eventArgs)
            $current = [Native.Style]::GetForegroundWindow()
            if ($current -eq $sender.Handle -and $previousForeground -ne [IntPtr]::Zero) {
                # 只有当我们**确实**夺走了前台时才归还，避免无谓地打断别人
                [Native.Style]::SetForegroundWindow($previousForeground) | Out-Null
            }
        })
}
