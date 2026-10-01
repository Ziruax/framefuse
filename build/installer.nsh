; build/installer.nsh — v1.18 icon + shortcut hardening, auto-included by
; electron-builder (macro names are its extension contract).
;
; FIELD REPORT (v1.17.0): "the icon is showing everywhere (installer, exe in
; Explorer), but after installation the DESKTOP SHORTCUT is blank, and the
; taskbar shows blank white while the app runs."
;
; Root causes addressed:
;   1. DESKTOP SHORTCUT: electron-builder's stock shortcut points its icon
;      at the installed EXE and relies on Windows re-extracting the
;      RT_GROUP_ICON — which the shell icon cache can refuse after an
;      in-place upgrade (same exe path), and which the NSIS CreateShortCut
;      command's description argument (the package.json `description`, ~430
;      chars in v1.17 — now shortened) overflowed. Fix: recreate BOTH
;      shortcuts with an EXPLICIT icon file — $INSTDIR\resources\icon.ico
;      (shipped via extraResources) — so the shell never extracts anything.
;   2. TASKBAR BLANK WHITE: the RUNNING app's taskbar icon keys off the
;      AppUserModelID. electron-builder writes AUMI = appId into the
;      shortcuts (WinShell::SetLnkAUMI); main.js now calls
;      app.setAppUserModelId("com.framefuse.app") to match. The shortcut
;      recreation below re-applies the same AUMI so grouping + icon stay
;      consistent.
;   3. Shell icon cache: notify associations changed + rebuild per-user
;      icon caches (Chrome/VSCode installers do the equivalent; kept from
;      v1.14.3).

!macro customInstall
  ; Recreate the shortcuts with an EXPLICIT icon file (runs AFTER
  ; electron-builder's addDesktopLink/addStartMenuLink, so the stock
  ; .lnk files are simply overwritten).
  ${ifNot} ${isNoDesktopShortcut}
    CreateShortCut "$newDesktopLink" "$appExe" "" "$INSTDIR\resources\icon.ico" 0 "" "" "${APP_DESCRIPTION}"
    ClearErrors
    WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
  ${endif}
  ; start-menu link: recreate only when the stock installer created it
  ${if} ${FileExists} "$newStartMenuLink"
    CreateShortCut "$newStartMenuLink" "$appExe" "" "$INSTDIR\resources\icon.ico" 0 "" "" "${APP_DESCRIPTION}"
    ClearErrors
    WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
  ${endif}
  ; SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, NULL, NULL) — makes
  ; Explorer flush icon cache entries and reload them lazily.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  ; Windows 10/11: rebuild the per-user icon cache DBs now (harmless no-op
  ; where the task is unavailable).
  Exec '"$SYSDIR\ie4uinit.exe" -show'
!macroend

!macro customUnInstall
  ; Same notification after shortcut removal so no stale ghosts linger.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
