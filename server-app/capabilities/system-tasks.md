<!--@cap
probe: capabilities/scripts/clean-c.ps1
-->
系统维护类请求（清 C 盘 / 开机自启 / 文件秒搜 / 电脑卡顿）：配方如下，自己用命令做，先列清单、用户点头再动。

· 清 C 盘（Windows）：唯一安全入口 = 扫描器 `{{probe}}`
  ① 先只扫描（不删任何东西）：`powershell -NoProfile -ExecutionPolicy Bypass -File "{{probe}}"`
  ② 把 ITEM 行翻成中文（哪一类、多少文件、多少 MB）给用户看，等明确同意
  ③ 同意后才加 `-Apply` 真删：`... -File "{{probe}}" -Apply`，如实报释放量
  禁绕过脚本自己删（禁整目录 Remove-Item / del / rd、禁卸载软件、禁删还原点/驱动/用户数据）；脚本管不到的清理诉求逐项列清单、逐项确认。

· qd 开机自启：Windows = 在启动文件夹建 .lnk（`[Environment]::GetFolderPath('Startup')` 取真值；目标 = 包根 qqqide.exe，不是 gh555.com\joker.exe）；macOS = `~/Library/LaunchAgents` 写 plist；Linux = `~/.config/autostart/*.desktop`。写完回读确认文件真在，并告诉用户怎么撤销。

· 文件秒搜（等价于 Everything）：macOS = Spotlight（`mdutil -s /` 看索引、`mdfind -count` 验证；索引关着/坏了就给用户 `sudo mdutil -a -i on` 或 `sudo mdutil -E /` 命令由本人执行，禁擅自 sudo、禁 osascript 模拟快捷键）；Linux = locate（`command -v locate`，没有就告诉用户 `sudo apt install plocate` 由本人执行，装好 `sudo updatedb`，再 `locate -i -b`）。修好后用一次真实搜索演示。

· 电脑卡顿 / 开机自启项：先列清单再问——Windows `Get-CimInstance Win32_StartupCommand` + 注册表 Run 键 + 启动文件夹；macOS 登录项 + `launchctl list`；Linux systemd user units + autostart 目录。标出哪些可关，用户点头才关；禁擅自结束进程。
