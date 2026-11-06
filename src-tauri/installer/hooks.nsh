; shrinkdrop NSIS 安装钩子（Tauri `bundle.windows.nsis.installerHooks`）。
;
; 升级时辅助服务正跑着 `shrinkdrop-ssh-helper.exe`，Windows 会锁住这个文件，安装器
; 覆盖不了 —— 结果就是 app 更新了、helper 还是旧的。所以覆盖文件前先停服务：
; 新的 app 第一次连接或点「安装辅助服务」时会把它重新装起来（安装逻辑会先停再启）。

!macro NSIS_HOOK_PREINSTALL
  DetailPrint "Stopping ShrinkdropSshHelper..."
  nsExec::Exec 'sc.exe stop ShrinkdropSshHelper'
  Pop $0
  ; 服务停止是异步的，等它真正退出再让安装器覆盖文件。
  Sleep 2000
!macroend
