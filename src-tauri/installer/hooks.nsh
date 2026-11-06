; shrinkdrop NSIS 安装钩子（Tauri `bundle.windows.nsis.installerHooks`）。
;
; 覆盖/删除文件前必须让「占着这些文件」的两个东西退场，否则安装器会停在
; 「无法写入 shrinkdrop-ssh-helper.exe / 无法终止 shrinkdrop」的重试对话框：
;   1. 正在运行的 app（shrinkdrop.exe）；
;   2. 正在运行的辅助服务（shrinkdrop-ssh-helper.exe，被 SCM 以服务方式持有）。
;
; 这里只用自己声明的变量，避免覆盖安装段落里模板正在用的 $0/$R9。

Var ShrinkdropHookResult
Var ShrinkdropHelperTries

; 停辅助服务并等它的进程真正退出；20 秒还没走就强杀（否则 exe 一直被锁）。
Function ShrinkdropStopHelper
  DetailPrint "Stopping ShrinkdropSshHelper..."
  nsExec::Exec 'sc.exe stop ShrinkdropSshHelper'
  Pop $ShrinkdropHookResult

  StrCpy $ShrinkdropHelperTries 0
  shrinkdrop_wait_helper:
    nsExec::Exec 'cmd /c "tasklist /fi "imagename eq shrinkdrop-ssh-helper.exe" /nh | find /i "shrinkdrop-ssh-helper" >nul"'
    Pop $ShrinkdropHookResult
    ${If} $ShrinkdropHookResult != 0
      Goto shrinkdrop_helper_gone
    ${EndIf}
    IntOp $ShrinkdropHelperTries $ShrinkdropHelperTries + 1
    ${If} $ShrinkdropHelperTries > 20
      DetailPrint "Force stopping ShrinkdropSshHelper..."
      nsExec::Exec 'taskkill /f /im shrinkdrop-ssh-helper.exe'
      Pop $ShrinkdropHookResult
      Sleep 1000
      Goto shrinkdrop_helper_gone
    ${EndIf}
    Sleep 1000
    Goto shrinkdrop_wait_helper
  shrinkdrop_helper_gone:
FunctionEnd

!macro NSIS_HOOK_PREINSTALL
  DetailPrint "Closing shrinkdrop..."
  nsExec::Exec 'taskkill /f /im shrinkdrop.exe'
  Pop $ShrinkdropHookResult
  Call ShrinkdropStopHelper
!macroend

; 卸载器是独立进程，只有 `un.` 前缀的函数能调用，必须再写一份同样的逻辑。
Function un.ShrinkdropStopHelper
  DetailPrint "Stopping ShrinkdropSshHelper..."
  nsExec::Exec 'sc.exe stop ShrinkdropSshHelper'
  Pop $ShrinkdropHookResult

  StrCpy $ShrinkdropHelperTries 0
  un_shrinkdrop_wait_helper:
    nsExec::Exec 'cmd /c "tasklist /fi "imagename eq shrinkdrop-ssh-helper.exe" /nh | find /i "shrinkdrop-ssh-helper" >nul"'
    Pop $ShrinkdropHookResult
    ${If} $ShrinkdropHookResult != 0
      Goto un_shrinkdrop_helper_gone
    ${EndIf}
    IntOp $ShrinkdropHelperTries $ShrinkdropHelperTries + 1
    ${If} $ShrinkdropHelperTries > 20
      nsExec::Exec 'taskkill /f /im shrinkdrop-ssh-helper.exe'
      Pop $ShrinkdropHookResult
      Sleep 1000
      Goto un_shrinkdrop_helper_gone
    ${EndIf}
    Sleep 1000
    Goto un_shrinkdrop_wait_helper
  un_shrinkdrop_helper_gone:
FunctionEnd

!macro NSIS_HOOK_PREUNINSTALL
  ; 卸载同样要先停服务，否则安装目录下的 exe 删不掉，卸载会残留。
  Call un.ShrinkdropStopHelper
!macroend
