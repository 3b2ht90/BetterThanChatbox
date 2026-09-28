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

        for (int i = 0; i < Attempts.Length; i++)
        {
            string flags = Attempts[i];
            Process p = Start(core, runtime, root, flags, extra);
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
                if (code == 0)
                {
                    // 正常退出：多半是「已经有实例在跑」，不该再拉一次
                    started = true;
                    break;
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

    private static Process Start(string core, string runtime, string root, string flags, string extra)
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
            if (!Writable(Environment.GetEnvironmentVariable("APPDATA")))
            {
                try { Directory.CreateDirectory(dataHome); } catch (Exception) { }
                psi.EnvironmentVariables["APPDATA"] = dataHome;
                if (!Writable(Environment.GetEnvironmentVariable("LOCALAPPDATA")))
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
