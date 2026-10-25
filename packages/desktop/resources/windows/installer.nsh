!include "nsDialogs.nsh"
!include "LogicLib.nsh"

; Registry key that records where the tuned Firefox lives. The installer writes it, the page reads
; it to decide "already installed", the desktop app reads it to launch, and the uninstaller reads
; it to offer removal. A registry value survives reinstalls and works no matter which drive or
; folder the user picked, which path probing cannot do.
!define TUNED_FF_KEY "Software\WLstudio\TunedFirefox"

; ---------------------------------------------------------------------------
; Silent close of a running app.
;
; electron-builder's default CHECK_APP_RUNNING shows a modal "WLstudio is
; running" box and only kills the process after the user presses OK, so every
; upgrade on a test box stops on a dialog. This hook produces the same outcome
; (terminate the running app so files are not in use) without the prompt.
; Installing is already an explicit user action, so asking again adds a click
; and nothing else.
;
; Defined above the installer-only guard on purpose: the uninstaller pass runs
; the same check (un.checkAppRunning), and both passes must see the override.
;
; taskkill is used by image name rather than the bundled FIND_PROCESS macro so
; the hook does not depend on include ordering; the installer runs under a
; different executable name and is unaffected.
; ---------------------------------------------------------------------------
!macro customCheckAppRunning
  nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /F /IM "${APP_EXECUTABLE_FILENAME}"'
  Pop $0
  ; Give the process tree a moment to release handles on the install directory.
  Sleep 500
!macroend

; ---------------------------------------------------------------------------
; Optional tuned browser.
;
; WLstudio ships a Firefox Developer Edition with the remote-control banner off and the debugging
; port on, so the assistant can drive real pages. This page is a plain opt-in:
;
;   - not installed yet: tick to install it, plus tick for a desktop shortcut
;   - already installed (registry says so): tick to reinstall/upgrade over it
;
; There is deliberately no "replace the browser you already use" mode. Taking over a browsing
; profile the user relies on is a data-loss risk, and detecting "their" Firefox reliably is not
; possible from an installer. A separate, clearly labelled build is predictable.
;
; The bundled browser is redistributed unmodified under the Mozilla Public
; License 2.0 (see THIRD-PARTY-NOTICES.md) and always lands in the user's own
; %LOCALAPPDATA%, never over a system-wide Firefox installation.
; ---------------------------------------------------------------------------

; The page and its functions exist only in the installer pass. The common header is
; shared with the uninstaller build, where no install page is emitted, and an unused
; function would trip NSIS warning 6010 (treated as an error).
!ifndef BUILD_UNINSTALLER

Var BridgeCheckBox
Var ShortcutCheckBox
Var BridgeInstallOpt
Var BridgeShortcutOpt
Var TunedFirefoxPath

!macro customPageAfterChangeDir
  Page custom WlBridgePageCreate WlBridgePageLeave
!macroend

; Reads the recorded install location. An empty result means "nothing to reuse": the value is
; either absent or points at a directory the user has since deleted, and a stale path must not be
; treated as a live installation.
Function WlDetectTunedFirefox
  StrCpy $TunedFirefoxPath ""
  ReadRegStr $0 HKCU "${TUNED_FF_KEY}" "Path"
  ${If} $0 != ""
    ${If} ${FileExists} "$0\firefox.exe"
      StrCpy $TunedFirefoxPath "$0"
    ${EndIf}
  ${EndIf}
FunctionEnd

Function WlBridgePageCreate
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  Call WlDetectTunedFirefox

  ${If} $TunedFirefoxPath != ""

    ${NSD_CreateLabel} 0 0 100% 26u "已安装 WLstudio 特调版 Firefox：$\r$\n$TunedFirefoxPath"
    Pop $0

    ${NSD_CreateLabel} 0 34u 100% 26u "特调版关闭了远程控制提示、启动即带调试端口，供助手直接操作页面。重新安装会覆盖程序文件，书签和登录状态保留。"
    Pop $0

    ${NSD_CreateCheckBox} 0 68u 100% 24u "重新安装特调版 Firefox（覆盖程序文件，保留现有配置）"
    Pop $BridgeCheckBox
    ${NSD_SetState} $BridgeCheckBox ${BST_UNCHECKED}

  ${Else}

    ${NSD_CreateLabel} 0 0 100% 26u "WLstudio 的浏览器功能需要一个可被助手控制的火狐浏览器。"
    Pop $0

    ${NSD_CreateLabel} 0 34u 100% 26u "特调版关闭了远程控制提示、启动即带调试端口，使用独立配置，不影响系统里其它浏览器。"
    Pop $0

    ${NSD_CreateCheckBox} 0 68u 100% 24u "安装 WLstudio 特调版 Firefox Developer Edition"
    Pop $BridgeCheckBox
    ${NSD_SetState} $BridgeCheckBox ${BST_CHECKED}

  ${EndIf}

  ${NSD_CreateCheckBox} 0 96u 100% 12u "在桌面创建「Firefox Developer Edition 特调版」快捷方式"
  Pop $ShortcutCheckBox
  ${NSD_SetState} $ShortcutCheckBox ${BST_CHECKED}

  nsDialogs::Show
FunctionEnd

Function WlBridgePageLeave
  ${NSD_GetState} $BridgeCheckBox $BridgeInstallOpt
  ${NSD_GetState} $ShortcutCheckBox $BridgeShortcutOpt
FunctionEnd

!endif

!macro customInstall
  ; Chromium's sandbox needs read/execute access to the installed runtime files.
  ; https://github.com/electron/electron/issues/49143#issuecomment-3618354787
  nsExec::ExecToLog '"$SYSDIR\icacls.exe" "$INSTDIR" /grant "*S-1-15-2-2:(OI)(CI)(RX)"'
  Pop $0

  ; The experience library lives beside the installation, on whatever volume the user picked,
  ; because it grows without bound and must outlive reinstalls. Record the resolved root so the
  ; app can seed into it and rewrite the paths inside AGENTS.md / WARMUP.md on every launch.
  ;
  ; `$INSTDIR\..` is wrong for the per-user default (`%LOCALAPPDATA%\Programs\WLstudio`), where it
  ; would resolve to `%LOCALAPPDATA%\Programs\WLstudio-data` and litter the Programs folder. Take
  ; the drive root instead, so it always lands next to the installation volume as `X:\WLstudio-data`.
  StrCpy $R6 "$INSTDIR"
  StrCpy $R6 $R6 3            ; keep "X:\" only
  StrCpy $R6 "$R6WLstudio-data"
  System::Call 'Kernel32::GetFullPathName(t r6, i 1024, t .r6, i 0)'
  CreateDirectory "$R6"
  CreateDirectory "$R6\ex-bags"
  WriteRegStr HKCU "Environment" "WLSTUDIO_DATA" "$R6"
  System::Call 'Kernel32::SetEnvironmentVariable(t "WLSTUDIO_DATA", t r6)'
  DetailPrint "数据目录（经验库）：$R6"

  ; One-click cleaner for server test deployments: stops every WLstudio process, runs
  ; the official NSIS uninstaller and removes caches, state and shortcuts. Shipped as a
  ; shortcut so a test box can be reset without hunting through the install directory.
  SetShellVarContext current
  ${If} ${FileExists} "$INSTDIR\resources\tools\uninstall-wlstudio.ps1"
    CreateShortCut "$DESKTOP\一键卸载 WLstudio.lnk" "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" \
      '-NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\resources\tools\uninstall-wlstudio.ps1"' \
      "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" 0
  ${EndIf}

  ${If} $BridgeInstallOpt == ${BST_CHECKED}
    ; Per-user locations so nothing touches a system-wide Firefox or another user.
    StrCpy $R7 "$LOCALAPPDATA\WLstudio\firefox"
    StrCpy $R8 "$LOCALAPPDATA\WLstudio\firefox-profile"

    DetailPrint "正在安装特调版 Firefox Developer Edition"
    nsExec::ExecToLog '"$INSTDIR\resources\windows\firefox-devedition-setup.exe" /S /InstallDirectoryPath="$R7"'
    Pop $0

    ; Record the location before doing anything else: if a later step fails, the next run still
    ; knows what is already on disk instead of installing a second copy.
    WriteRegStr HKCU "${TUNED_FF_KEY}" "Path" "$R7"
    WriteRegStr HKCU "${TUNED_FF_KEY}" "Profile" "$R8"
    WriteRegStr HKCU "${TUNED_FF_KEY}" "Version" "159.0"
    WriteRegStr HKCU "${TUNED_FF_KEY}" "InstalledBy" "WLstudio installer"

    ; A dedicated profile whose userChrome.css hides Firefox's "remote control" cue.
    ; This is user-level customization, not a change to the redistributed browser.
    CreateDirectory "$R8\chrome"
    FileOpen $R9 "$R8\user.js" w
    FileWrite $R9 'user_pref("toolkit.legacyUserProfileCustomizations.stylesheets", true);$\r$\n'
    FileWrite $R9 'user_pref("browser.toolbars.bookmarks.visibility", "always");$\r$\n'
    FileClose $R9

    FileOpen $R9 "$R8\chrome\userChrome.css" w
    FileWrite $R9 '#remote-control-box { visibility: hidden !important; width: 0 !important; }$\r$\n'
    FileWrite $R9 ':root[remotecontrol] #urlbar > .urlbar-background { background-image: none !important; }$\r$\n'
    FileClose $R9

    ; Drop a marker from the old "take over the user's browser" mode so the bridge cannot keep
    ; driving a profile the user did not ask for after this upgrade.
    Delete "$LOCALAPPDATA\WLstudio\firefox-shared.json"

    ${If} $BridgeShortcutOpt == ${BST_CHECKED}
      CreateShortCut "$DESKTOP\Firefox Developer Edition 特调版.lnk" "$R7\firefox.exe" \
        '-profile "$R8" --remote-debugging-port=9222' "$R7\firefox.exe" 0
    ${EndIf}
  ${Else}
    ; Declined: remove the shortcut from an earlier install so the desktop does not keep a browser
    ; the user just opted out of. The browser itself is left alone: it is theirs now.
    Delete "$DESKTOP\Firefox Developer Edition 特调版.lnk"
  ${EndIf}

  SetShellVarContext current
!macroend

!macro customUnInstall
  Delete "$DESKTOP\一键卸载 WLstudio.lnk"
  Delete "$DESKTOP\Firefox Developer Edition 特调版.lnk"

  ; The data root holds the experience library, which the user builds up over months. Removing the
  ; app must never take it, so only the environment variable goes; the directory stays where it is.
  ; The standalone uninstaller offers an explicit opt-in if someone really wants it gone.
  DeleteRegValue HKCU "Environment" "WLSTUDIO_DATA"

  ; The tuned browser is a real browser that may hold the user's bookmarks and logins, so removal
  ; is a question, never a default. Silent uninstalls keep it, because a script cannot answer.
  ReadRegStr $R0 HKCU "${TUNED_FF_KEY}" "Path"
  ReadRegStr $R1 HKCU "${TUNED_FF_KEY}" "Profile"

  ${If} $R0 != ""
    IfSilent wl_uninst_keep

    MessageBox MB_YESNO|MB_ICONQUESTION \
      "是否同时删除 WLstudio 特调版 Firefox？$\r$\n$\r$\n位置：$R0$\r$\n$\r$\n选择「否」保留浏览器及其书签、登录状态。" \
      IDNO wl_uninst_keep

    DetailPrint "正在删除特调版 Firefox：$R0"
    ${If} ${FileExists} "$INSTDIR\resources\tools\remove-tuned-firefox.ps1"
      nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\resources\tools\remove-tuned-firefox.ps1" -Path "$R0" -Profile "$R1"'
      Pop $0
    ${Else}
      RMDir /r "$R0"
      ${If} $R1 != ""
        RMDir /r "$R1"
      ${EndIf}
    ${EndIf}
    DeleteRegKey HKCU "${TUNED_FF_KEY}"
    Goto wl_uninst_done

  wl_uninst_keep:
    DetailPrint "已保留特调版 Firefox。"
    ; Keep the registry entry: the browser is still installed and the next installer should see it.
    Goto wl_uninst_done

  wl_uninst_done:
    ClearErrors
  ${EndIf}
!macroend
