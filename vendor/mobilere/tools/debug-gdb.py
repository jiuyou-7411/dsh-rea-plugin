#!/usr/bin/env python3
"""GDB 原生调试验证工具（替代 debug-gdb.bat）

用法: python debug-gdb.py cn.boccfc.loan.finance
流程: 启动进程 -> 检查 TracerPid -> 附加 gdbserver -> GDB 取证 -> 反调试存活检测
"""
import argparse
import os
import re
import signal
import subprocess
import sys
import tempfile
import time

CONFIG = dict(
    adb="adb",
    gdbserver="/data/local/tmp/gdbserver64",
    gdbserver_log="/data/local/tmp/gdbserver.log",
    port=5039,
    gdb_launcher=os.path.join(os.path.dirname(os.path.abspath(__file__)), "gdb-aarch64.cmd"),
    gdb_script=os.path.join(os.path.dirname(os.path.abspath(__file__)), "debug.gdb"),
    attach_tries=4,
    trace_seconds=12,
)

C_RESULT = {"ok": True}


def sh(args):
    try:
        return subprocess.run(args, capture_output=True, text=True,
                              encoding="utf-8", errors="replace", timeout=30)
    except subprocess.TimeoutExpired:
        r = subprocess.CompletedProcess(args, 124, "", "timeout")
        return r


def adb(args):
    return sh([CONFIG["adb"]] + args)


def su(cmd):
    return adb(["shell", "su -c '%s'" % cmd.replace("'", "'\\''")])


def device_pids(pkg):
    r = adb(["shell", "pidof %s" % pkg])
    pids = set()
    for tok in r.stdout.split():
        if tok.isdigit():
            pids.add(int(tok))
    return pids


def tracer_pid(pid):
    r = su("cat /proc/%d/status 2>/dev/null | grep TracerPid" % pid)
    m = re.search(r"TracerPid:\s+(\d+)", r.stdout + r.stderr)
    if m:
        return int(m.group(1))
    if r.returncode != 0:
        return None
    return None


def netstat_port(port):
    r = su("netstat -tlnp 2>/dev/null")
    m = re.search(r"0\.0\.0\.0:%d\s+.*?LISTEN\s+(\d+)/" % port, r.stdout)
    if m:
        return int(m.group(1))
    return None


def cleanup_gdbserver():
    su("killall gdbserver64 2>/dev/null; pkill gdbserver64 2>/dev/null")
    stale = netstat_port(CONFIG["port"])
    if stale:
        su("kill -9 %d 2>/dev/null" % stale)
        time.sleep(1)


def ensure_app_running(pkg):
    pids = device_pids(pkg)
    if pids:
        return pids
    print("[提示] 目标进程未运行，正在启动...")
    adb(["shell", "monkey -p %s 1" % pkg])
    time.sleep(4)
    return device_pids(pkg)


def gdbserver_attached(pid):
    su("rm -f %s" % CONFIG["gdbserver_log"])
    proc = subprocess.Popen(
        [CONFIG["adb"], "shell",
         "su -c '%s :%d --attach %d 2>&1 | tee %s'" % (
             CONFIG["gdbserver"], CONFIG["port"], pid, CONFIG["gdbserver_log"])])
    time.sleep(2)
    owner = netstat_port(CONFIG["port"])
    if owner:
        return True, proc
    try:
        proc.terminate()
    except Exception:
        pass
    return False, proc


def report_antidebug(pkg, pid, died_after, tp_before, tp_after, sig=None):
    print()
    print("=" * 50)
    print("  检测结论: 存在反调试（App 闪退）")
    print("=" * 50)
    print("  包名        : %s" % pkg)
    print("  TracerPid   : %s -> %s (gdbserver 附加) -> 进程消失" % (tp_before, tp_after))
    if died_after is not None:
        print("  运行表现    : GDB 会话第 %.1f 秒进程消失（App 闪退）" % died_after)
    else:
        print("  运行表现    : 进程消失（App 闪退）")
    if sig:
        print("  GDB 信号    : %s" % sig)
    print("  判据        : pidof 中进程消失，GDB 连接仍存活")
    print("=" * 50)
    return 1


def make_gdb_script():
    with open(CONFIG["gdb_script"], "r", encoding="utf-8") as f:
        script = f.read()
    fd, path = tempfile.mkstemp(prefix="re_debug_", suffix=".gdb")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(script)
    return path


def find_gdb_exe():
    for root in (os.environ.get("ANDROID_NDK_HOME"), os.environ.get("NDK_ROOT"),
                 r"C:\Users\Administrator\AppData\Local\Android\Sdk\ndk\21.4.7075529"):
        if not root:
            continue
        p = os.path.join(root, "prebuilt", "windows-x86_64", "bin", "gdb.exe")
        if os.path.exists(p):
            return p
    return None


def start_gdb(script_path):
    gdb_exe = find_gdb_exe()
    fd, out_path = tempfile.mkstemp(prefix="re_gdb_out_", suffix=".log")
    os.close(fd)
    creationflags = 0
    if os.name == "nt":
        creationflags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    out_f = open(out_path, "wb")
    if gdb_exe:
        cmd = [gdb_exe, "-batch", "-x", script_path]
        kwargs = {}
    else:
        cmd = '"%s" -batch -x "%s"' % (CONFIG["gdb_launcher"], script_path)
        kwargs = {"shell": True}
    proc = subprocess.Popen(cmd, stdout=out_f, stderr=subprocess.STDOUT,
                            creationflags=creationflags, **kwargs)
    return proc, out_path, out_f


def stop_gdb(proc, out_path, out_f):
    if proc.poll() is None:
        # 进程刚死时 GDB 会自行打印 termination 信号并退出，先给它落盘时间
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            pass
    if proc.poll() is None:
        try:
            proc.send_signal(signal.CTRL_BREAK_EVENT)
        except Exception:
            pass
        try:
            proc.wait(timeout=6)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)
    out_f.close()
    with open(out_path, "r", encoding="utf-8", errors="replace") as f:
        text = f.read()
    try:
        os.unlink(out_path)
    except OSError:
        pass
    return text, proc.returncode


def main():
    parser = argparse.ArgumentParser(description="GDB 原生调试验证")
    parser.add_argument("pkg", help="目标包名")
    parser.add_argument("-v", "--verbose", action="store_true",
                        help="打印 GDB 原始输出（默认只打结论摘要，便于截图）")
    args = parser.parse_args()
    pkg = args.pkg
    port = CONFIG["port"]

    print("=" * 44)
    print("  GDB 原生调试验证")
    print("  目标: %s" % pkg)
    print("  时间: %s" % time.strftime("%Y/%m/%d %H:%M:%S"))
    print("=" * 44)
    print()

    print("[1/7] 检查 ADB 设备...")
    r = adb(["devices"])
    if "device" not in r.stdout:
        print("[失败] 未检测到 ADB 设备")
        return 1
    print("[成功] 设备已连接")
    print()

    print("[2/7] 检查目标进程: %s..." % pkg)
    pids = ensure_app_running(pkg)
    if not pids:
        print("[失败] 无法启动目标进程")
        return 1
    pid = min(pids)
    print("[成功] 进程 PID: %s" % ", ".join(str(p) for p in sorted(pids)))
    print()

    print("  --- 调试前 TracerPid (应为 0) ---")
    tp_before = tracer_pid(pid)
    print("  结果: TracerPid = %s" % tp_before)
    if tp_before == 0:
        print("  状态: 未被调试 - 干净")
    else:
        print()
        print("=" * 50)
        print("  检测结论: 存在反调试（进程已被跟踪）")
        print("=" * 50)
        print("  包名        : %s (PID %d)" % (pkg, pid))
        print("  TracerPid   : %s（非 0，已被其他调试器占用）" % tp_before)
        print("=" * 50)
        return 1
    print()

    print("[3/7] 启动 gdbserver (端口 %d)..." % port)
    attached = False
    last_proc = None
    for try_no in range(1, CONFIG["attach_tries"] + 1):
        cleanup_gdbserver()
        pids = ensure_app_running(pkg)
        if not pids:
            print("[失败] PID %d 已失效且无法重新拉起进程" % pid)
            break
        pid = min(pids)
        ok, proc = gdbserver_attached(pid)
        last_proc = proc
        if ok:
            attached = True
            print("[成功] gdbserver 已附加 PID %d 并在 :%d 监听" % (pid, port))
            break
        print("[重试 %d/%d] PID %d 附加失败，重新获取 PID..." % (try_no, CONFIG["attach_tries"], pid))
    if not attached:
        print()
        print("  --- gdbserver 日志 ---")
        print(su("cat %s 2>/dev/null" % CONFIG["gdbserver_log"]).stdout.strip() or "(空)")
        print()
        print("=" * 44)
        print("  检测结论: 无法附加调试器")
        print("=" * 44)
        print("  目标: %s" % pkg)
        print("  证据: 见上方 gdbserver 日志")
        print("=" * 44)
        return 1
    print()
    try:
        print("  --- 调试中 TracerPid (应为 gdbserver PID) ---")
        tp_after = tracer_pid(pid)
        print("  结果: TracerPid = %s" % tp_after)
        if tp_after and tp_after != 0:
            print("  状态: 调试器已附加 - 跟踪进程 PID %d" % tp_after)
        else:
            print("  [失败] TracerPid 仍为 0 - 调试器未附加")
        print()

        print("[4/7] 端口转发...")
        adb(["forward", "tcp:%d" % port, "tcp:%d" % port])
        print(adb(["forward", "--list"]).stdout.strip())
        print("[成功] 端口 %d 转发完成" % port)
        print()

        print("[5/7] GDB 连接：状态取证 + 运行态放行观察 %d 秒..." % CONFIG["trace_seconds"])
        print()
        script_path = make_gdb_script()
        proc, out_path, out_f = start_gdb(script_path)
        died_after = None
        t0 = time.time()
        try:
            while time.time() - t0 < CONFIG["trace_seconds"]:
                if proc.poll() is not None:
                    break
                if pid not in device_pids(pkg):
                    died_after = time.time() - t0
                    break
                time.sleep(0.5)
            alive_at_end = pid in device_pids(pkg)
            if not alive_at_end and died_after is None:
                died_after = time.time() - t0
        finally:
            out, gdb_rc = stop_gdb(proc, out_path, out_f)
            try:
                os.unlink(script_path)
            except OSError:
                pass
        if args.verbose:
            print(out)
            if gdb_rc != 0:
                print("[信息] GDB 返回码 %d" % gdb_rc)
            print()

        print("[6/7] 运行态反调试判定...")
        m = re.search(r"Program terminated with signal (SIG[A-Z]+)", out)
        if not alive_at_end:
            return report_antidebug(
                pkg, pid, died_after, tp_before, tp_after,
                m.group(1) if m else None)
        print("[成功] 调试器下放行 %d 秒，进程存活" % CONFIG["trace_seconds"])
        print()

        print("[7/7] 调试后 TracerPid (应为 0)...")
        tp_after_detach = tracer_pid(pid)
        if tp_after_detach is None:
            return report_antidebug(pkg, pid, None, tp_before, tp_after)
        if tp_after_detach != 0:
            print()
            print("=" * 50)
            print("  检测结论: 异常（GDB 分离后 TracerPid 仍为 %d）" % tp_after_detach)
            print("=" * 50)
            return 1
        print()

        print("=" * 50)
        print("  检测结论: 未发现反调试")
        print("=" * 50)
        print("  包名        : %s (PID %d)" % (pkg, pid))
        print("  TracerPid   : %s -> %s (gdbserver 附加) -> %s (已分离)" % (
            tp_before, tp_after, tp_after_detach))
        print("  运行表现    : 调试器下放行 %d 秒，进程存活" % CONFIG["trace_seconds"])
        print("=" * 50)
        return 0
    finally:
        cleanup_gdbserver()


if __name__ == "__main__":
    code = main()
    if sys.stdin.isatty():
        try:
            input("\n按任意键退出...")
        except EOFError:
            pass
    sys.exit(code)