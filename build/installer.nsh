; build/installer.nsh — v1.14.3 icon-cache fix, auto-included by electron-builder
; (macro names are its extension contract).
;
; FIELD REPORT (v1.14.2): "the icon shows during installation, but after
; install it is blank on the desktop and on the shortcut." The exe's icon
; resources are complete (verified: RT_GROUP_ICON id=1, 7 entries —
; scripts/verify-icons-1.14.2.js) and the INSTALLER shows its icon fine
; because each downloaded setup exe is a NEW file path. The INSTALLED exe
; keeps the same path across upgrades, and Windows' shell icon cache can
; keep rendering the STALE entry (the pre-v1.14.1 washed-out/near-blank
; icon) instead of re-extracting from the upgraded exe — a well-known
; upgrade-in-place quirk. The standard remedy (Chrome/VSCode installers do
; the equivalent): tell the shell that associations/icons changed and let
; it rebuild the icon caches.

!macro customInstall
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
