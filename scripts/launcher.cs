// BetterThanChatbox 启动器（编译后就是用户双击的那个 BetterThanChatbox.exe）
//
// 为什么要这么一层：
//   Electron 在受限环境里（被别的沙箱/受限令牌包着启动）Chromium 的沙箱会初始化失败，
//   进程在 JS 还没跑起来时就以 0x80000003（STATUS_BREAKPOINT）退出，表现就是「双击 exe 毫无反应」。
//   因为崩在 main.js 之前，在应用代码里加 --no-sandbox 是没用的，必须由外部启动参数解决。
//   而且这种失败在同样参数下还可能时好时坏，所以这里做的是「多套参数依次重试」。
//
// 它做的事：
//   1. 依次用下面 Attempts 里的参数组合去拉 app-runtime\BetterThanChatboxCore.exe；
//      某一套能让进程活过 1.5 秒就算成功（环境正常时第一套「带沙箱」就会成功，不牺牲安全性）。
//   2. 若 %APPDATA% / %LOCALAPPDATA% / %TEMP% 不可写，就在启动子进程前把它们指到程序目录下，
//      因为 Electron 在 main.js 执行之前（crashpad 等早期初始化）就已经在用这些目录了。
//   3. 全部尝试都失败时，把每一步的退出码写进「启动日志.txt」并弹窗提示，便于排查。
//
// 编译：csc /nologo /target:winexe /codepage:65001 /r:System.Windows.Forms.dll
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;
using System.Windows.Forms;

internal static class Launcher
{
    private const string RuntimeDir = "app-runtime";
    private const string CoreName = "BetterThanChatboxCore.exe";
    private const int LiveCheckMs = 1500;
    // 主进程约定的退出码（见 app/main.js）：要能区分「已有实例」和「数据目录写不进去」
    private const int ExitAlreadyRunning = 3;
    private const int ExitDataDirUnusable = 4;

    // 依次尝试的启动参数（用户自己传的参数会跟在后面）
    private static readonly string[] Attempts = new string[]
    {
        "",                                                        // 1. 默认：保留 Chromium 沙箱
        "--no-sandbox",                                            // 2. 沙箱初始化失败时最常用的一招
        "--no-sandbox --disable-gpu",                              // 3. 显卡/驱动相关的启动失败
        "--no-sandbox --disable-gpu-sandbox",                      // 4. GPU 进程沙箱
        "--no-sandbox --disable-features=RendererCodeIntegrity",   // 5. 杀软/代码完整性策略拦截渲染进程
    };

    [STAThread]
    private static int Main(string[] args)
    {
        string root = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
        string runtime = Path.Combine(root, RuntimeDir);
        string core = Path.Combine(runtime, CoreName);
        if (!File.Exists(core)) core = Path.Combine(runtime, "electron.exe");
        if (!File.Exists(core))
        {
            Fail("找不到运行文件：\r\n" + core +
                 "\r\n\r\n请确认 app-runtime 文件夹与本程序放在一起（整个文件夹一起拷贝）。");
            return 2;
        }

        string extra = args != null && args.Length > 0 ? string.Join(" ", args) : "";
        List<string> log = new List<string>();
        log.Add("时间：" + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss"));
        log.Add("程序目录：" + root);
        log.Add("系统：" + Environment.OSVersion.VersionString + " / " + (Environment.Is64BitOperatingSystem ? "64" : "32") + " 位");
        log.Add("");
        bool started = false;
        bool alreadyRunning = false;
        bool forceRedirect = false;

        for (int i = 0; i < Attempts.Length; i++)
        {
            string flags = Attempts[i];
            Process p = Start(core, runtime, root, flags, extra, forceRedirect);
            string label = "第 " + (i + 1) + " 次" + (flags.Length == 0 ? "（默认，带沙箱）" : "（" + flags + "）") + "：";
            if (p == null)
            {
                log.Add(label + "启动失败（见弹窗信息）");
                continue;
            }

            try
            {
                if (!p.WaitForExit(LiveCheckMs))
                {
                    // 还活着 —— 起来了
                    log.Add(label + "进程存活，已启动成功");
                    started = true;
                    break;
                }
                int code = p.ExitCode;
                log.Add(label + "进程在 " + LiveCheckMs + " 毫秒内退出，退出码 " + code +
                        "（0x" + unchecked((uint)code).ToString("X8") + "）");

                // 主进程用专门的退出码说明「为什么退出」，别靠猜：
                //   3 = 已经有一个实例在跑（正常，把前台窗口交给它就行）
                //   4 = 数据目录写不进去（锁文件建不了）—— 环境问题，换重定向后的目录再试
                if (code == ExitAlreadyRunning)
                {
                    log.Add(label + "程序报告：已经有一个实例在运行。");
                    alreadyRunning = true;
                    started = true;
                    break;
                }
                if (code == ExitDataDirUnusable)
                {
                    log.Add(label + "程序报告：数据目录写不进去（单实例锁建不了）。" +
                            "本次已把 %APPDATA% 指向程序目录重试。");
                    // 这一次的尝试不算数，但下面会用重定向后的环境再试一遍
                    forceRedirect = true;
                    continue;
                }

                if (code == 0)
                {
                    // 「退出码 0」有两种可能：真的已经有实例在跑，或者它自己悄悄退了。
                    // 以前一律当成成功 —— 于是 build 完第一次双击、或数据目录有问题时，
                    // 启动器什么都不做也不提示，用户看到的就是「双击毫无反应」。
                    // 现在必须确认「确实有另一个实例活着」才算成功。
                    if (AnotherInstanceAlive())
                    {
                        log.Add(label + "正常退出，且确实已有实例在运行 → 视为成功。");
                        alreadyRunning = true;
                        started = true;
                        break;
                    }
                    log.Add(label + "正常退出，但并没有任何实例在跑（多半是它自己启动失败后退出了）" +
                            "→ 这次不算成功，继续试下一种方式。");
                    continue;
                }
            }
            catch (Exception ex)
            {
                log.Add(label + "拿不到退出状态：" + ex.Message);
            }
        }

        if (!started)
        {
            log.Add("");
            log.Add("结论：所有启动方式都没能让程序起来。");
        }
        else if (alreadyRunning)
        {
            log.Add("");
            log.Add("结论：程序本来就在运行，已把它的窗口调到前台（没有重复启动）。");
        }

        // 失败时、或诊断模式（BTC_SMOKE）下留一份日志，便于排查
        if (!started || Environment.GetEnvironmentVariable("BTC_SMOKE") != null)
        {
            string logPath = Path.Combine(root, "启动日志.txt");
            try { File.WriteAllText(logPath, string.Join("\r\n", log.ToArray()), new UTF8Encoding(false)); }
            catch (Exception) { }
        }

        if (!started)
        {
            Fail("启动失败：程序连续尝试了 " + Attempts.Length + " 种方式都没能起来。\r\n\r\n" +
                 "详细信息已写入：\r\n" + Path.Combine(root, "启动日志.txt") + "\r\n\r\n" +
                 "把这个「启动日志.txt」发给我就能定位原因。");
            return 5;
        }
        return 0;
    }

    /// <summary>是不是真有另一个实例在跑（用来判断「退出码 0」到底是哪种情况）</summary>
    private static bool AnotherInstanceAlive()
    {
        foreach (string name in new string[] { "BetterThanChatboxCore", "electron" })
        {
            try
            {
                Process[] ps = Process.GetProcessesByName(name);
                if (ps != null && ps.Length > 0) return true;
            }
            catch (Exception) { }
        }
        return false;
    }

    /// <summary>
    /// APPDATA 能不能真的用。
    /// 注意不能只探 %APPDATA% 根本身 —— 程序写的是 %APPDATA%\BetterThanChatbox，
    /// 这个子目录完全可能因为权限/安全软件而写不进去（探测却在根目录成功了），
    /// 于是 Chromium 建不了单实例锁、程序以退出码 0 悄悄死掉 = 双击没反应。
    /// </summary>
    private static bool AppDataUsable(string appDataRoot)
    {
        if (!Writable(appDataRoot)) return false;
        string dir = Path.Combine(appDataRoot, "BetterThanChatbox");
        try { Directory.CreateDirectory(dir); } catch (Exception) { return false; }
        return Writable(dir);
    }

    private static Process Start(string core, string runtime, string root, string flags, string extra, bool forceRedirect)
    {
        try
        {
            ProcessStartInfo psi = new ProcessStartInfo(core);
            psi.WorkingDirectory = runtime;
            psi.UseShellExecute = false;

            string a = flags;
            if (extra.Length > 0) a = a.Length > 0 ? a + " " + extra : extra;
            psi.Arguments = a;

            psi.EnvironmentVariables["BTC_APP_HOME"] = root;

            // 下面这些目录在受限环境里可能不可写，而 Electron 在 main.js 之前就会用到它们
            string dataHome = Path.Combine(root, "data");
            if (forceRedirect || !AppDataUsable(Environment.GetEnvironmentVariable("APPDATA")))
            {
                try { Directory.CreateDirectory(dataHome); } catch (Exception) { }
                psi.EnvironmentVariables["APPDATA"] = dataHome;
                if (forceRedirect || !Writable(Environment.GetEnvironmentVariable("LOCALAPPDATA")))
                {
                    psi.EnvironmentVariables["LOCALAPPDATA"] = dataHome;
                }
            }
            if (!Writable(Path.GetTempPath()))
            {
                string alt = Path.Combine(root, ".temp");
                try { Directory.CreateDirectory(alt); } catch (Exception) { }
                psi.EnvironmentVariables["TMP"] = alt;
                psi.EnvironmentVariables["TEMP"] = alt;
            }

            return Process.Start(psi);
        }
        catch (Exception ex)
        {
            Fail("启动失败：\r\n" + ex.Message);
            return null;
        }
    }

    private static bool Writable(string dir)
    {
        if (string.IsNullOrEmpty(dir)) return false;
        try
        {
            string probe = Path.Combine(dir, "btc-write-test-" + Guid.NewGuid().ToString("N") + ".tmp");
            File.WriteAllText(probe, "ok");
            File.Delete(probe);
            return true;
        }
        catch (Exception)
        {
            return false;
        }
    }

    private static void Fail(string msg)
    {
        // 自动化测试（BTC_SMOKE）下不弹窗，否则会卡住没人点「确定」
        if (Environment.GetEnvironmentVariable("BTC_SMOKE") != null)
        {
            try { Console.Error.WriteLine(msg); } catch (Exception) { }
            return;
        }
        try
        {
            MessageBox.Show(msg, "BetterThanChatbox 启动器", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        catch (Exception)
        {
            try { Console.Error.WriteLine(msg); } catch (Exception) { }
        }
    }
}
