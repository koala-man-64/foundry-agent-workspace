; Spike S6: a per-user installer for the toast spike (docs/spikes/s6-toast-activation.md). Test only; never shipped.
; Run-S6.ps1 compiles it with ISCC /DSourceDir=<published folder> /DResults=<results folder> /O<output folder>,
; installs it silently, starts it from its Start menu shortcut, and uninstalls it afterwards.
#ifndef SourceDir
  #error Pass /DSourceDir= the published spike folder.
#endif
#ifndef Results
  #error Pass /DResults= the results folder.
#endif

[Setup]
AppId={{CE1A3DDF-7D9D-4FF8-8888-D8AA5D1700AD}
AppName=Foundry S6 toast spike
AppVersion=0.0.0
AppPublisher=Foundry Agent Workspace spike (test only)
; Per-user and unelevated, as the product's installer (decision 6): {autopf} is %LOCALAPPDATA%\Programs.
PrivilegesRequired=lowest
DefaultDirName={autopf}\Foundry S6 toast spike
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=yes
DisableFinishedPage=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputBaseFilename=FoundryS6ToastSpikeSetup
Compression=lzma2/fast
SolidCompression=no
Uninstallable=yes
SetupLogging=yes
CloseApplications=no

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
; The shortcut carries the AUMID the app sets for itself, as the product's installer is expected to.
Name: "{userprograms}\Foundry S6 toast spike"; Filename: "{app}\Foundry.Spikes.Toast.exe"; Parameters: "run --label installed --results ""{#Results}"""; WorkingDir: "{app}"; AppUserModelID: "Foundry.Spikes.S6Toast"

[UninstallDelete]
Type: filesandordirs; Name: "{app}"
