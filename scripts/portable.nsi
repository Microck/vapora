!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "x64.nsh"
!include "WinVer.nsh"

Unicode true
Name "Vapora"
Caption "Starting Vapora"
OutFile "${OUTPUT}"
Icon "${ICON}"
RequestExecutionLevel user
; Solid compression creates a full decompression cache in system TEMP before
; .onInit runs. Per-file compression streams directly to the selected drive.
SetCompressor lzma
CRCCheck force
AutoCloseWindow true
ShowInstDetails show
VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "Vapora"
VIAddVersionKey "FileDescription" "Vapora portable launcher"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "Copyright (c) 2025 Microck"
Page instfiles

Var runtimeDirectory
Var runtimeToken
Var childTemp
Var parameters
Var exitCode

Function .onInit
  ${IfNot} ${RunningX64}
  ${OrIfNot} ${AtLeastWin10}
    MessageBox MB_OK|MB_ICONSTOP "Vapora requires 64-bit Windows 10 or later. Download the package for your system."
    SetErrorLevel 1
    Quit
  ${EndIf}
  ClearErrors
  GetTempFileName $runtimeToken "$EXEDIR"
  ${If} ${Errors}
    MessageBox MB_OK|MB_ICONSTOP "Vapora cannot write beside its EXE. Move the EXE to a writable folder and reopen it."
    SetErrorLevel 1
    Quit
  ${EndIf}
  ; Keep the reserved file until exit so concurrent launches cannot reuse this name.
  StrCpy $runtimeDirectory "$runtimeToken.vapora-runtime"
  StrCpy $childTemp "$runtimeDirectory\Temp"
  System::Call 'kernel32::GetDiskFreeSpaceExW(w "$EXEDIR", *l .r1, p 0, p 0) i .r0'
  ${If} $0 == 0
    MessageBox MB_OK|MB_ICONSTOP "Vapora cannot check free space beside its EXE. Check folder permissions and reopen it."
    Call CleanupRuntime
    SetErrorLevel 1
    Quit
  ${EndIf}
  System::Int64Op $1 < ${REQUIRED_BYTES}
  Pop $0
  ${If} $0 == 1
    MessageBox MB_OK|MB_ICONSTOP "Vapora needs at least ${REQUIRED_MB} MB free on the drive containing its EXE. Free space or move the EXE together with Vapora-data to another drive, then reopen it."
    Call CleanupRuntime
    SetErrorLevel 1
    Quit
  ${EndIf}
  CreateDirectory "$childTemp"
FunctionEnd

Section
  SetOutPath "$runtimeDirectory"
  ClearErrors
  File /r "${APP_DIRECTORY}\*.*"
  ${If} ${Errors}
    MessageBox MB_OK|MB_ICONSTOP "Vapora could not extract its files. Check free space and folder permissions, then reopen it."
    SetErrorLevel 1
    Quit
  ${EndIf}
  System::Call 'kernel32::SetEnvironmentVariableW(w "PORTABLE_EXECUTABLE_DIR", w "$EXEDIR")'
  ; Electron and the frozen history helper must use the EXE's drive too.
  System::Call 'kernel32::SetEnvironmentVariableW(w "TEMP", w "$childTemp")'
  System::Call 'kernel32::SetEnvironmentVariableW(w "TMP", w "$childTemp")'
  ${GetParameters} $parameters
  HideWindow
  ClearErrors
  ExecWait '"$runtimeDirectory\Vapora.exe" $parameters' $exitCode
  ${If} ${Errors}
    MessageBox MB_OK|MB_ICONSTOP "Windows could not start Vapora. Check Windows Application errors in Event Viewer for details, then reopen it."
    StrCpy $exitCode 1
  ${ElseIf} $exitCode != 0
    MessageBox MB_OK|MB_ICONSTOP "Vapora exited with code $exitCode. Check Windows Application errors in Event Viewer for details. Your saved runs remain in Vapora-data."
  ${EndIf}
  SetErrorLevel $exitCode
SectionEnd

; Both failure and normal exit remove only the unique folder created by this launch.
Function CleanupRuntime
  SetOutPath "$EXEDIR"
  ${If} $runtimeDirectory != ""
    RMDir /r "$runtimeDirectory"
    Delete "$runtimeToken"
  ${EndIf}
FunctionEnd

Function .onGUIEnd
  Call CleanupRuntime
FunctionEnd
