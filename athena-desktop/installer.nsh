!macro customInstall
  !ifndef DO_NOT_CREATE_START_MENU_SHORTCUT
    !ifdef MENU_FILENAME
      CreateShortCut "$SMPROGRAMS\${MENU_FILENAME}\Athena Chat.lnk" "$appExe" "--chat" "$appExe" 0
    !else
      CreateShortCut "$SMPROGRAMS\Athena Chat.lnk" "$appExe" "--chat" "$appExe" 0
    !endif
  !endif
  !ifndef DO_NOT_CREATE_DESKTOP_SHORTCUT
    ${ifNot} ${isNoDesktopShortcut}
      ${if} ${FileExists} "$newDesktopLink"
        CreateShortCut "$DESKTOP\Athena Chat.lnk" "$appExe" "--chat" "$appExe" 0
      ${endIf}
    ${endIf}
  !endif
!macroend

!macro customUnInstall
  ${ifNot} ${isKeepShortcuts}
    Delete "$DESKTOP\Athena Chat.lnk"
    !ifdef MENU_FILENAME
      Delete "$SMPROGRAMS\${MENU_FILENAME}\Athena Chat.lnk"
    !else
      Delete "$SMPROGRAMS\Athena Chat.lnk"
    !endif
  ${endIf}
!macroend
