using System;
using System.IO;
using System.Text;
using System.Threading;

// 测试专用的「假核心」：按 FAKE_CORE_MODE 环境变量表现出不同的启动行为，
// 用来验证启动器的判定逻辑（尤其是「退出码 0 但窗口没起来」这一种 —— 它就是
// 用户报的「双击没反应」的成因）。编译产物只在测试的临时目录里用，不进发行包。
internal static class FakeCore
{
    private static int Main(string[] args)
    {
        string mode = Environment.GetEnvironmentVariable("FAKE_CORE_MODE") ?? "exit0";
        // 把自己看到的环境写下来，测试据此断言启动器有没有正确重定向数据目录
        try
        {
            string dump = "mode=" + mode + "\n" +
                          "argv=" + string.Join(" ", args) + "\n" +
                          "APPDATA=" + Environment.GetEnvironmentVariable("APPDATA") + "\n" +
                          "LOCALAPPDATA=" + Environment.GetEnvironmentVariable("LOCALAPPDATA") + "\n" +
                          "TEMP=" + Environment.GetEnvironmentVariable("TEMP") + "\n" +
                          "BTC_APP_HOME=" + Environment.GetEnvironmentVariable("BTC_APP_HOME") + "\n";
            string dir = Environment.GetEnvironmentVariable("FAKE_CORE_DUMP_DIR");
            if (string.IsNullOrEmpty(dir)) dir = Directory.GetCurrentDirectory();
            Directory.CreateDirectory(dir);
            File.WriteAllText(Path.Combine(dir, "fake-core-" + mode + "-" +
                Guid.NewGuid().ToString("N").Substring(0, 6) + ".txt"), dump, new UTF8Encoding(false));
        }
        catch (Exception) { }

        if (mode == "exit0") return 0;                                   // 干净退出（老逻辑会误判成"成功"）
        if (mode == "exit3") return 3;                                   // 已有实例
        if (mode == "exit4") return 4;                                   // 数据目录不可用
        if (mode == "crash") return unchecked((int)0x80000003);           // 沙箱初始化崩
        if (mode == "crashThenAlive")                                    // 第一次崩、之后活着（模拟真实环境）
        {
            string marker = Path.Combine(Path.GetTempPath(), "btc-fake-crash-once.marker");
            if (!File.Exists(marker)) { File.WriteAllText(marker, "1"); return unchecked((int)0x80000003); }
            Thread.Sleep(60000);
            return 0;
        }
        Thread.Sleep(60000);                                             // 活着
        return 0;
    }
}
