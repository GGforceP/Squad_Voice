Unicode true
!include "MUI2.nsh"
!include "x64.nsh"
!include "WinVer.nsh"
!include "LogicLib.nsh"
!include "TextFunc.nsh"
!include "FileFunc.nsh"

!ifndef APP_VERSION
  !define APP_VERSION "0.5.0"
!endif
!define DESKTOP_LINK_NAME "SquadVoice.lnk"
!define LEGACY_DESKTOP_LINK_NAME "Squad Voice.lnk"
Name "Squad Voice"
OutFile "${SETUP}"
InstallDir "$EXEDIR\Squad Voice"
RequestExecutionLevel user
SetCompressor /SOLID lzma
Icon "${STAGE}\SquadVoice.ico"
VIProductVersion "${APP_VERSION}.0"
VIAddVersionKey /LANG=1033 "ProductName" "Squad Voice"
VIAddVersionKey /LANG=1033 "FileDescription" "Squad Voice Portable Installer"
VIAddVersionKey /LANG=1033 "FileVersion" "${APP_VERSION}"
VIAddVersionKey /LANG=1033 "ProductVersion" "${APP_VERSION}"
VIAddVersionKey /LANG=1033 "LegalCopyright" "Squad Voice"

Var PublicDir
Var PreviousPath
Var PreviousVersion
Var UpdateDir
Var LockHandle
Var MetadataTemp
Var MigrateLegacy
Var FromUpdater
Var RelaunchAfterUpdate
Var DesktopDirectory
Var DesktopLink

!define MUI_ABORTWARNING
!define MUI_DIRECTORYPAGE_TEXT_TOP "升级时将读取 Windows 文档中的安装记录。请选择 Squad Voice 的程序目录。"
!define MUI_FINISHPAGE_RUN "$INSTDIR\SquadVoice.exe"
!define MUI_UNCONFIRMPAGE_TEXT_TOP "卸载将清除本安装的程序与加密数据，并移除 Windows 文档中的 Squad Voice 配置。请先从托盘退出程序。"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"

!macro SetPublicDir
  !ifdef TEST_DOCUMENTS
    StrCpy $PublicDir "${TEST_DOCUMENTS}\Squad Voice"
  !else
    StrCpy $PublicDir "$DOCUMENTS\Squad Voice"
  !endif
!macroend

!macro ReadInstallation
  StrCpy $PreviousPath ""
  StrCpy $PreviousVersion ""
  ClearErrors
  FileOpen $0 "$PublicDir\installation.txt" r
  ${IfNot} ${Errors}
    FileReadUTF16LE $0 $PreviousPath
    FileReadUTF16LE $0 $PreviousVersion
    FileClose $0
  ${EndIf}
  ClearErrors
!macroend

!macro SetDesktopDirectory
  !ifdef TEST_DESKTOP
    StrCpy $DesktopDirectory "${TEST_DESKTOP}"
  !else
    StrCpy $DesktopDirectory "$DESKTOP"
  !endif
!macroend

!macro ShortcutTarget name
  Function ${name}
    StrCpy $3 ""
    ${IfNot} ${FileExists} "$DesktopLink"
      Push $3
      Return
    ${EndIf}
    System::Call 'ole32::CoCreateInstance(g "{00021401-0000-0000-C000-000000000046}", p 0, i 1, g "{000214F9-0000-0000-C000-000000000046}", *p .r1) i.r0'
    ${If} $0 == 0
      System::Call '$1->0(g "{0000010B-0000-0000-C000-000000000046}", *p .r2) i.r0'
      ${If} $0 == 0
        System::Call '$2->5(w "$DesktopLink", i 0) i.r0'
        ${If} $0 == 0
          System::Call '$1->3(w .r3, i 1024, p 0, i 4) i.r0'
        ${EndIf}
        System::Call '$2->2()'
      ${EndIf}
      System::Call '$1->2()'
    ${EndIf}
    Push $3
  FunctionEnd
!macroend
!insertmacro ShortcutTarget ReadDesktopLink
!insertmacro ShortcutTarget un.ReadDesktopLink

!macro LockData
  System::Call 'kernel32::CreateFileW(w "$INSTDIR\Data\run.lock", i 0xc0000000, i 0, p 0, i 4, i 0x80, p 0) p.r0'
  StrCpy $LockHandle $0
!macroend

!macro UnlockData
  ${If} $LockHandle != 0
  ${AndIf} $LockHandle != -1
    System::Call 'kernel32::CloseHandle(p $LockHandle)'
    StrCpy $LockHandle 0
  ${EndIf}
!macroend

!macro EachPayload operation
  !insertmacro ${operation} "SquadVoice.exe" ""
  !insertmacro ${operation} "SquadVoice.exe.config" ""
  !insertmacro ${operation} "Microsoft.Web.WebView2.Core.dll" ""
  !insertmacro ${operation} "Microsoft.Web.WebView2.WinForms.dll" ""
  !insertmacro ${operation} "WebView2Loader.dll" ""
  !insertmacro ${operation} "WebView2-LICENSE.txt" ""
  !insertmacro ${operation} "WebView2-NOTICE.txt" ""
  !insertmacro ${operation} "SquadVoice-LICENSE.txt" ""
  !insertmacro ${operation} "app" "\*.*"
  !insertmacro ${operation} "Uninstall.exe" ""
!macroend

!macro SavePrevious name wildcard
  ${If} ${FileExists} "$INSTDIR\${name}${wildcard}"
    ClearErrors
    Rename "$INSTDIR\${name}" "$UpdateDir\previous\${name}"
    IfErrors install_failed
  ${EndIf}
!macroend

!macro Publish name wildcard
  ${If} ${FileExists} "$UpdateDir\new\${name}${wildcard}"
    ClearErrors
    Rename "$UpdateDir\new\${name}" "$INSTDIR\${name}"
    IfErrors install_failed
  ${EndIf}
!macroend

!macro ParkNew name wildcard
  ${If} ${FileExists} "$INSTDIR\${name}${wildcard}"
    ClearErrors
    Rename "$INSTDIR\${name}" "$UpdateDir\new\${name}"
    IfErrors recovery_failed
  ${EndIf}
!macroend

!macro RestorePrevious name wildcard
  ${If} ${FileExists} "$UpdateDir\previous\${name}${wildcard}"
    ClearErrors
    Rename "$UpdateDir\previous\${name}" "$INSTDIR\${name}"
    IfErrors recovery_failed
  ${EndIf}
!macroend

Function .onInit
  StrCpy $LockHandle 0
  StrCpy $FromUpdater 0
  StrCpy $RelaunchAfterUpdate 0
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "/UPDATE" $1
  ${IfNot} ${Errors}
    StrCpy $FromUpdater 1
    ClearErrors
    ${GetOptions} $0 "/RELAUNCH" $1
    ${IfNot} ${Errors}
      StrCpy $RelaunchAfterUpdate 1
    ${EndIf}
    ClearErrors
    ${GetOptions} $0 "/WAITPID=" $1
    ${IfNot} ${Errors}
    ${AndIf} $1 > 0
      System::Call 'kernel32::OpenProcess(i 0x00100000, i 0, i r1) p.r2'
      ${If} $2 != 0
        System::Call 'kernel32::WaitForSingleObject(p r2, i 15000) i.r3'
        System::Call 'kernel32::CloseHandle(p r2)'
        ${If} $3 != 0
          SetErrorLevel 1
          Abort
        ${EndIf}
      ${EndIf}
    ${EndIf}
  ${EndIf}
  ClearErrors
  ${IfNot} ${RunningX64}
  ${OrIfNot} ${AtLeastWin10}
    MessageBox MB_ICONSTOP "Squad Voice 需要 64 位 Windows 10 或 Windows 11。" /SD IDOK
    Abort
  ${EndIf}
  !insertmacro SetPublicDir
  !insertmacro ReadInstallation
  ${TrimNewLines} "$PreviousPath" $PreviousPath
  ${TrimNewLines} "$PreviousVersion" $PreviousVersion
  ; An explicit destination on the command line wins over discovery.
  ${If} $INSTDIR == "$EXEDIR\Squad Voice"
    ${If} $PreviousPath != ""
    ${AndIf} ${FileExists} "$PreviousPath\SquadVoice.exe"
    ${AndIf} ${FileExists} "$PreviousPath\app\index.html"
      GetFullPathName $INSTDIR "$PreviousPath"
    ${ElseIf} $PreviousPath != ""
    ${AndIf} ${FileExists} "$PreviousPath\Data\.squadvoice-setup\owned"
      GetFullPathName $INSTDIR "$PreviousPath"
    ${ElseIf} ${FileExists} "$EXEDIR\SquadVoice.exe"
    ${AndIf} ${FileExists} "$EXEDIR\app\index.html"
      StrCpy $INSTDIR "$EXEDIR"
    ${EndIf}
  ${EndIf}
FunctionEnd

Function .onGUIEnd
  !insertmacro UnlockData
FunctionEnd

; Leave the rollback copy within the app's own data directory until uninstall.
Function ArchiveUpdate
  CreateDirectory "$INSTDIR\Data\UpgradeBackups"
  ClearErrors
  GetTempFileName $1 "$INSTDIR\Data\UpgradeBackups"
  IfErrors archive_failed
  Delete "$1"
  ClearErrors
  Rename "$UpdateDir" "$1"
  Return
archive_failed:
  SetErrors
FunctionEnd

Function RecoverUpdate
  ClearErrors
  ${IfNot} ${FileExists} "$UpdateDir\*.*"
    Return
  ${EndIf}
  ${IfNot} ${FileExists} "$UpdateDir\owned"
    Goto recovery_failed
  ${EndIf}
  ${IfNot} ${FileExists} "$UpdateDir\committed"
    ${If} ${FileExists} "$UpdateDir\backup.ready"
      !insertmacro EachPayload ParkNew
      ; A second recovery attempt will only restore previous files.
      Delete "$UpdateDir\backup.ready"
    ${EndIf}
    !insertmacro EachPayload RestorePrevious
  ${EndIf}
  Call ArchiveUpdate
  Return
recovery_failed:
  SetErrors
FunctionEnd

Section "Squad Voice"
  ${If} $INSTDIR == ""
    Goto invalid_directory
  ${EndIf}
  System::Call 'kernel32::GetFullPathNameW(w "$INSTDIR", i 1024, w .r0, p 0) i.r1'
  ${If} $1 == 0
  ${OrIf} $1 >= 1024
    Goto invalid_directory
  ${EndIf}
  StrCpy $INSTDIR $0
  ${GetRoot} "$INSTDIR" $0
  ${If} $INSTDIR == "$0"
  ${OrIf} $INSTDIR == "$0\"
  ${OrIf} $INSTDIR == "$DOCUMENTS"
  ${OrIf} $INSTDIR == "$PublicDir"
  ${OrIf} $INSTDIR == "$WINDIR"
    Goto invalid_directory
  ${EndIf}
  System::Call 'kernel32::GetFileAttributesW(w "$INSTDIR") i.r0'
  ${If} $0 != -1
    IntOp $0 $0 & 0x400
    ${If} $0 != 0
      Goto invalid_directory
    ${EndIf}
  ${EndIf}
  StrCpy $MetadataTemp ""
  StrCpy $MigrateLegacy 0
  ${If} ${FileExists} "$INSTDIR\app\*.*"
  ${AndIfNot} ${FileExists} "$INSTDIR\SquadVoice.exe"
  ${AndIfNot} ${FileExists} "$INSTDIR\Data\.squadvoice-setup\owned"
    Goto invalid_directory
  ${EndIf}
  ; Older releases have no directory lock. Check their executable as well.
  ${If} ${FileExists} "$INSTDIR\SquadVoice.exe"
    System::Call 'kernel32::CreateFileW(w "$INSTDIR\SquadVoice.exe", i 0x40000000, i 0, p 0, i 3, i 0x80, p 0) p.r0'
    ${If} $0 == -1
      Goto directory_locked
    ${EndIf}
    System::Call 'kernel32::CloseHandle(p r0)'
    ClearErrors
    GetDLLVersion "$INSTDIR\SquadVoice.exe" $0 $1
    ${IfNot} ${Errors}
    ${AndIf} $0 < 3
      StrCpy $MigrateLegacy 1
    ${EndIf}
  ${EndIf}
  CreateDirectory "$INSTDIR\Data"
  System::Call 'kernel32::GetFileAttributesW(w "$INSTDIR\Data") i.r0'
  IntOp $0 $0 & 0x400
  ${If} $0 != 0
    Goto invalid_directory
  ${EndIf}
  !insertmacro LockData
  ${If} $LockHandle == -1
    Goto directory_locked
  ${EndIf}
  StrCpy $UpdateDir "$INSTDIR\Data\.squadvoice-setup"
  Call RecoverUpdate
  IfErrors install_recovery
  ${If} $PreviousPath == $INSTDIR
  ${AndIf} $PreviousVersion != ""
    DetailPrint "已读取旧版本 $PreviousVersion 的安装记录。"
  ${EndIf}

  ClearErrors
  CreateDirectory "$PublicDir"
  GetTempFileName $MetadataTemp "$PublicDir"
  IfErrors install_failed
  FileOpen $0 "$MetadataTemp" w
  IfErrors install_failed
  FileWriteUTF16LE /BOM $0 "$INSTDIR$\r$\n${APP_VERSION}$\r$\n"
  FileClose $0
  IfErrors install_failed

  ClearErrors
  CreateDirectory "$UpdateDir\new"
  CreateDirectory "$UpdateDir\previous"
  FileOpen $0 "$UpdateDir\owned" w
  IfErrors install_failed
  FileClose $0
  SetOutPath "$UpdateDir\new"
  File "${STAGE}\SquadVoice.exe"
  File "${STAGE}\SquadVoice.exe.config"
  File "${STAGE}\Microsoft.Web.WebView2.Core.dll"
  File "${STAGE}\Microsoft.Web.WebView2.WinForms.dll"
  File "${STAGE}\WebView2Loader.dll"
  File /nonfatal "${STAGE}\WebView2-LICENSE.txt"
  File "${STAGE}\WebView2-NOTICE.txt"
  File "${STAGE}\SquadVoice-LICENSE.txt"
  SetOutPath "$UpdateDir\new\app"
  File /r "${STAGE}\app\*"
  WriteUninstaller "$UpdateDir\new\Uninstall.exe"
  IfErrors install_failed
  SetOutPath "$INSTDIR"
  !insertmacro EachPayload SavePrevious
  ClearErrors
  FileOpen $0 "$UpdateDir\backup.ready" w
  IfErrors install_failed
  FileClose $0
  !insertmacro EachPayload Publish
  ClearErrors
  FileOpen $0 "$UpdateDir\committed" w
  IfErrors install_failed
  FileClose $0
  System::Call 'kernel32::MoveFileExW(w "$MetadataTemp", w "$PublicDir\installation.txt", i 9) i.r0'
  ${If} $0 == 0
    Delete "$UpdateDir\committed"
    Goto install_failed
  ${EndIf}
  StrCpy $MetadataTemp ""
  ${If} $MigrateLegacy == 1
    ClearErrors
    FileOpen $0 "$INSTDIR\Data\migrate-legacy" w
    ${IfNot} ${Errors}
      FileClose $0
    ${EndIf}
  ${EndIf}
  Call ArchiveUpdate
  Call RefreshDesktopLink
  !insertmacro UnlockData
  ${If} $RelaunchAfterUpdate == 1
    SetOutPath "$INSTDIR"
    ClearErrors
    Exec '"$INSTDIR\SquadVoice.exe"'
    ${If} ${Errors}
      SetErrorLevel 1
    ${EndIf}
  ${EndIf}
  Goto install_done

install_failed:
  SetOutPath "$INSTDIR"
  ${If} $MetadataTemp != ""
    Delete "$MetadataTemp"
  ${EndIf}
  Call RecoverUpdate
  IfErrors install_recovery
  !insertmacro UnlockData
  SetErrorLevel 1
  MessageBox MB_ICONSTOP "无法完成安装。若检测到旧程序，已恢复原程序文件。" /SD IDOK
  Abort
install_recovery:
  !insertmacro UnlockData
  SetErrorLevel 1
  MessageBox MB_ICONSTOP "上次更新需要恢复。请退出 Squad Voice 后重新运行安装包。" /SD IDOK
  Abort
invalid_directory:
  SetErrorLevel 1
  MessageBox MB_ICONSTOP "此目录已有其他程序文件。请选择 Squad Voice 的安装目录或一个空目录。" /SD IDOK
  Abort
directory_locked:
  SetErrorLevel 1
  MessageBox MB_ICONSTOP "无法锁定安装目录。请从托盘退出 Squad Voice，并确认目录可写。" /SD IDOK
  Abort
install_done:
SectionEnd

Function RefreshDesktopLink
  !insertmacro SetDesktopDirectory
  StrCpy $DesktopLink "$DesktopDirectory\${DESKTOP_LINK_NAME}"
  Call ReadDesktopLink
  Pop $4
  StrCpy $DesktopLink "$DesktopDirectory\${LEGACY_DESKTOP_LINK_NAME}"
  Call ReadDesktopLink
  Pop $6
  ${If} $4 == "$INSTDIR\SquadVoice.exe"
    ${If} $6 == "$INSTDIR\SquadVoice.exe"
      Delete "$DesktopLink"
    ${EndIf}
    Return
  ${EndIf}
  ${If} $6 != "$INSTDIR\SquadVoice.exe"
    ${If} $FromUpdater != 1
    ${OrIf} ${FileExists} "$DesktopDirectory\${DESKTOP_LINK_NAME}"
      Return
    ${EndIf}
  ${EndIf}

  ; A renamed shortcut already launches the newly installed executable.
  FindFirst $4 $5 "$DesktopDirectory\*.lnk"
  ${DoWhile} $5 != ""
    ${If} $5 != "${LEGACY_DESKTOP_LINK_NAME}"
      StrCpy $DesktopLink "$DesktopDirectory\$5"
      Call ReadDesktopLink
      Pop $0
      ${If} $0 == "$INSTDIR\SquadVoice.exe"
        FindClose $4
        ${If} $6 == "$INSTDIR\SquadVoice.exe"
          Delete "$DesktopDirectory\${LEGACY_DESKTOP_LINK_NAME}"
        ${EndIf}
        Return
      ${EndIf}
    ${EndIf}
    FindNext $4 $5
  ${Loop}
  FindClose $4

  StrCpy $DesktopLink "$DesktopDirectory\${DESKTOP_LINK_NAME}"
  ${IfNot} ${FileExists} "$DesktopLink"
    ${If} $6 == "$INSTDIR\SquadVoice.exe"
      Rename "$DesktopDirectory\${LEGACY_DESKTOP_LINK_NAME}" "$DesktopLink"
    ${Else}
      SetOutPath "$INSTDIR"
      CreateShortCut "$DesktopLink" "$INSTDIR\SquadVoice.exe" "" "$INSTDIR\SquadVoice.exe" 0 SW_SHOWNORMAL "" "Squad Voice"
    ${EndIf}
  ${EndIf}
FunctionEnd

Function un.onInit
  StrCpy $LockHandle 0
  !insertmacro SetPublicDir
  !insertmacro ReadInstallation
  ${un.TrimNewLines} "$PreviousPath" $PreviousPath
  GetFullPathName $0 "$INSTDIR"
  IfErrors unsafe_uninstall_path
  StrCpy $INSTDIR $0
  System::Call 'kernel32::GetFileAttributesW(w "$INSTDIR") i.r0'
  IntOp $0 $0 & 0x400
  ${If} $0 != 0
    Goto unsafe_uninstall_path
  ${EndIf}
  ; The generated uninstaller is run from the application root.
  ${IfNot} ${FileExists} "$INSTDIR\Uninstall.exe"
    Abort
  ${EndIf}
  ${If} $INSTDIR == $WINDIR
  ${OrIf} $INSTDIR == $DOCUMENTS
  ${OrIf} $INSTDIR == $PublicDir
    Goto unsafe_uninstall_path
  ${EndIf}
  Return
unsafe_uninstall_path:
  Abort
FunctionEnd

; Remove only a tree owned by the app. Remove junctions and symbolic links
; themselves, never enumerate the content they point to.
Function un.RemoveTree
  Exch $0
  Push $1
  Push $2
  Push $3
  Push $4
  System::Call 'kernel32::GetFileAttributesW(w r0) i.r4'
  ${If} $4 != -1
    IntOp $4 $4 & 0x400
    ${If} $4 == 0
      FindFirst $1 $2 "$0\*.*"
      ${DoWhile} $2 != ""
        ${If} $2 != "."
        ${AndIf} $2 != ".."
          StrCpy $3 "$0\$2"
          System::Call 'kernel32::GetFileAttributesW(w r3) i.r4'
          ${If} $4 != -1
            IntOp $4 $4 & 0x10
            ${If} $4 != 0
              Push $3
              Call un.RemoveTree
            ${Else}
              Delete "$3"
            ${EndIf}
          ${EndIf}
        ${EndIf}
        FindNext $1 $2
      ${Loop}
      FindClose $1
    ${EndIf}
    RMDir "$0"
  ${EndIf}
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

Function un.RemoveExternalCache
  IfFileExists "$INSTDIR\Data\cache-location.txt" 0 cache_done
  ClearErrors
  FileOpen $0 "$INSTDIR\Data\cache-location.txt" r
  IfErrors cache_done
  FileReadUTF16LE $0 $1
  FileClose $0
  ${un.TrimNewLines} "$1" $1
  ${If} $1 == ""
    Goto cache_done
  ${EndIf}
  ClearErrors
  GetFullPathName $2 "$1"
  IfErrors cache_done
  ${If} $1 != $2
    Goto cache_done
  ${EndIf}
  ${un.GetFileName} "$2" $3
  ${If} $3 != "Squad Voice Media Cache"
    Goto cache_done
  ${EndIf}
  System::Call 'kernel32::GetFileAttributesW(w r2) i.r0'
  IntOp $0 $0 & 0x400
  ${If} $0 != 0
    Goto cache_done
  ${EndIf}
  ClearErrors
  FileOpen $0 "$2\owner.txt" r
  IfErrors cache_done
  FileReadUTF16LE $0 $1
  FileClose $0
  ${un.TrimNewLines} "$1" $1
  ${If} $1 == "$INSTDIR\Data"
    Push "$2"
    Call un.RemoveTree
    IfFileExists "$2\*.*" cache_locked
  ${EndIf}
cache_done:
  ClearErrors
  Return
cache_locked:
  SetErrors
FunctionEnd

!macro RemoveDesktopLink name
  StrCpy $DesktopLink "$DesktopDirectory\${name}"
  Call un.ReadDesktopLink
  Pop $0
  ${If} $0 == "$INSTDIR\SquadVoice.exe"
    Delete "$DesktopLink"
  ${EndIf}
!macroend

Section "Uninstall"
  SetOutPath "$TEMP"
  System::Call 'kernel32::GetFileAttributesW(w "$INSTDIR\Data") i.r0'
  IntOp $0 $0 & 0x400
  ${If} $0 == 0
    !insertmacro LockData
    ${If} $LockHandle == -1
      Goto uninstall_locked
    ${EndIf}
  ${EndIf}
  Delete "$INSTDIR\SquadVoice.exe"
  ${If} ${FileExists} "$INSTDIR\SquadVoice.exe"
    !insertmacro UnlockData
    Goto uninstall_locked
  ${EndIf}
  !insertmacro UnlockData
  !insertmacro SetDesktopDirectory
  !insertmacro RemoveDesktopLink "${DESKTOP_LINK_NAME}"
  !insertmacro RemoveDesktopLink "${LEGACY_DESKTOP_LINK_NAME}"
  Delete "$INSTDIR\SquadVoice.exe.config"
  Delete "$INSTDIR\Microsoft.Web.WebView2.Core.dll"
  Delete "$INSTDIR\Microsoft.Web.WebView2.WinForms.dll"
  Delete "$INSTDIR\WebView2Loader.dll"
  Delete "$INSTDIR\WebView2-LICENSE.txt"
  Delete "$INSTDIR\WebView2-NOTICE.txt"
  Delete "$INSTDIR\SquadVoice-LICENSE.txt"
  Call un.RemoveExternalCache
  IfErrors uninstall_incomplete
  Push "$INSTDIR\app"
  Call un.RemoveTree
  Push "$INSTDIR\Data"
  Call un.RemoveTree
  ${If} $PreviousPath == ""
  ${OrIf} $PreviousPath == $INSTDIR
    Delete "$PublicDir\preferences.json"
    Delete "$PublicDir\chat-cache.json"
    ${If} ${FileExists} "$PublicDir\preferences.json"
    ${OrIf} ${FileExists} "$PublicDir\chat-cache.json"
      Goto uninstall_incomplete
    ${EndIf}
    Delete "$PublicDir\installation.txt"
    ${If} ${FileExists} "$PublicDir\installation.txt"
      Goto uninstall_incomplete
    ${EndIf}
    RMDir "$PublicDir"
  ${EndIf}
  ${If} ${FileExists} "$INSTDIR\Data\*.*"
  ${OrIf} ${FileExists} "$INSTDIR\app\*.*"
    Goto uninstall_incomplete
  ${EndIf}
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  Goto uninstall_done

uninstall_incomplete:
  SetErrorLevel 1
  MessageBox MB_ICONSTOP "仍有数据被占用。请关闭占用文件的程序，再运行 Uninstall.exe 完成清理。" /SD IDOK
  Abort
uninstall_locked:
  SetErrorLevel 1
  MessageBox MB_ICONSTOP "请先从右下角托盘退出 Squad Voice，再重新卸载。" /SD IDOK
  Abort
uninstall_done:
SectionEnd
