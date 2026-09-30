// The agent's hands on this computer.
//
// It reads a window's controls from UI Automation, moves the real cursor to
// one of them along an eased path, and clicks or types there, so whoever is
// supervising sees where it is going. Built like hello-helper.exe: compiled by
// the csc.exe inside Windows against the .NET Framework assemblies inside
// Windows, so there is no SDK, no Python and no node-gyp. See
// scripts/build-desktop-helper.js. That compiler speaks C# 5, which is why
// there is no string interpolation, no `?.` and no `=>` members below.
//
// One long-lived process, spoken to in JSON lines. Every request on stdin has
// an `id` and gets one answer on stdout with the same id and `ok`; events that
// nobody asked for (the user taking over, Esc) carry `event` instead. The
// policy (who may drive, which apps, when) is src/main/ai/computer.js; this
// only does what it is told, and refuses the few things that are never right.
//
// Four jobs:
//
//   see    the UI Automation tree of a window and its popups, as numbered
//          elements, and what is under a point
//   move   the real cursor, gliding along an eased, slightly bowed path, then
//          a real click, wheel or keystrokes through SendInput. Typing is
//          Unicode, so any character arrives, whatever the keyboard layout.
//   show   an outline on the target, a ripple where it clicks, and a badge
//          saying who is driving. All three are hidden from screen capture.
//   watch  low-level hooks. Every event this process sends carries a mark;
//          anything without it is the person. Their click or key outside
//          Acestes, or their hand on the mouse mid-action, pauses the agent
//          at once. Esc is swallowed and reported, so no app sees it either.
//
// Refused whatever it is told: any window of the processes named with
// --protect (Acestes itself, so the agent can never click its own approval
// card), and input to an elevated window, which Windows would drop anyway.

using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;
using System.Windows.Forms;
using WinPoint = System.Windows.Point;
using WinRect = System.Windows.Rect;

/// <summary>An action that stopped on purpose, with a code the caller can act on.</summary>
class Stop : Exception
{
    public readonly string Code;

    public Stop(string code, string message) : base(message)
    {
        Code = code;
    }
}

static class DesktopHelper
{
    const string Version = "1";

    // On every event we send, so the hooks can tell ours from the person's.
    static readonly IntPtr Mark = new IntPtr(0x41434553);

    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
    static readonly object WriteLock = new object();
    static StreamWriter output;

    static readonly HashSet<uint> Protected = new HashSet<uint>();
    public static bool Capturable;
    static readonly uint SelfPid = (uint)Process.GetCurrentProcess().Id;
    static bool selfElevated;

    static Form host;
    static Overlay overlay;
    static readonly BlockingCollection<Dictionary<string, object>> Queue = new BlockingCollection<Dictionary<string, object>>();

    // Driving: set by the caller for the length of a turn. Paused: the person
    // took over, or pressed Esc, and nothing moves until the next turn.
    static volatile bool driving;
    static volatile bool paused;
    static volatile string pauseCode = "";
    static volatile bool cancelled;
    static int lastX;
    static int lastY;

    static string labelDriving = "The agent is using your computer · Esc to stop";
    static string labelPaused = "Paused · you have control";
    static string labelStopped = "Stopped";

    [STAThread]
    static int Main(string[] args)
    {
        // Physical pixels everywhere, on every monitor: UI Automation reports
        // them, SendInput takes them, and a mixed-DPI desk agrees with itself.
        try
        {
            if (Native.SetProcessDpiAwarenessContext(new IntPtr(-4)) == IntPtr.Zero) Native.SetProcessDPIAware();
        }
        catch (EntryPointNotFoundException)
        {
            Native.SetProcessDPIAware();
        }

        for (int index = 0; index < args.Length; index++)
        {
            uint pid;
            if (args[index] == "--protect" && index + 1 < args.Length && uint.TryParse(args[index + 1], out pid)) Protected.Add(pid);
            // For recording a demo or checking the overlays: leaves them in
            // screenshots. Never passed by the app.
            if (args[index] == "--capturable") Capturable = true;
        }
        Protected.Add(SelfPid);
        selfElevated = IsElevated(SelfPid);

        output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
        output.AutoFlush = true;

        host = new Form();
        IntPtr made = host.Handle; // the handle is what BeginInvoke needs; the form is never shown
        overlay = new Overlay();

        var reader = new Thread(Read);
        reader.IsBackground = true;
        reader.Start();

        var worker = new Thread(Work);
        worker.IsBackground = true;
        worker.SetApartmentState(ApartmentState.MTA);
        worker.Start();

        var ready = new Dictionary<string, object>();
        ready["event"] = "ready";
        ready["version"] = Version;
        ready["elevated"] = selfElevated;
        Emit(ready);

        Application.Run();
        return 0;
    }

    /* ---------------------------------------------------------------- *
     * The line protocol
     * ---------------------------------------------------------------- */

    static void Read()
    {
        var input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
        string line;
        while ((line = input.ReadLine()) != null)
        {
            if (line.Trim().Length == 0) continue;
            Dictionary<string, object> request;
            try
            {
                request = Json.Deserialize<Dictionary<string, object>>(line);
            }
            catch (Exception error)
            {
                var bad = new Dictionary<string, object>();
                bad["event"] = "error";
                bad["error"] = "Unreadable request: " + error.Message;
                Emit(bad);
                continue;
            }
            // Stopping the action in hand cannot wait behind it in the queue.
            if (Text(request, "cmd") == "cancel")
            {
                cancelled = true;
                continue;
            }
            Queue.Add(request);
        }
        // The app went away. So do we, rather than hold hooks for nobody.
        host.BeginInvoke(new Action(Application.ExitThread));
    }

    static void Work()
    {
        foreach (var request in Queue.GetConsumingEnumerable())
        {
            object id = request.ContainsKey("id") ? request["id"] : null;
            cancelled = false;
            acting = Actions.Contains(Text(request, "cmd"));
            Dictionary<string, object> answer;
            try
            {
                answer = Handle(request);
                answer["ok"] = true;
            }
            catch (Stop stop)
            {
                answer = Failure(stop.Code, stop.Message);
            }
            catch (ElementNotAvailableException)
            {
                answer = Failure("gone", "That element is gone. Read the screen again.");
            }
            catch (Exception error)
            {
                answer = Failure("failed", error.Message);
            }
            acting = false;
            answer["id"] = id;
            Emit(answer);
        }
    }

    static Dictionary<string, object> Failure(string code, string message)
    {
        var failure = new Dictionary<string, object>();
        failure["ok"] = false;
        failure["code"] = code;
        failure["error"] = message;
        return failure;
    }

    static void Emit(Dictionary<string, object> message)
    {
        string line = Json.Serialize(message);
        lock (WriteLock)
        {
            output.WriteLine(line);
        }
    }

    /// <summary>From a hook: never write on the thread that has to answer Windows quickly.</summary>
    static void EmitLater(Dictionary<string, object> message)
    {
        ThreadPool.QueueUserWorkItem(delegate { Emit(message); });
    }

    static void Ui(Action action)
    {
        host.Invoke(action);
    }

    static Dictionary<string, object> Handle(Dictionary<string, object> request)
    {
        switch (Text(request, "cmd"))
        {
            case "ping": return Ping();
            case "windows": return Windows();
            case "foreground": return Foreground();
            case "focus": return Focus(Handle(request, "hwnd"));
            case "launch": return Launch(Text(request, "target"), Text(request, "args"));
            case "tree": return Tree(request);
            case "text": return ReadText(request);
            case "capture": return Capture(request);
            case "captcha": return Captchas(request);
            case "target": return Target(request);
            case "click": return Click(request);
            case "type": return TypeText(request);
            case "keys": return PressKeys(request);
            case "scroll": return Scroll(request);
            case "drag": return Drag(request);
            case "drive": return Drive(request);
            default: throw new Stop("unknown", "Unknown command: " + Text(request, "cmd"));
        }
    }

    static Dictionary<string, object> Ping()
    {
        var answer = new Dictionary<string, object>();
        answer["version"] = Version;
        answer["elevated"] = selfElevated;
        return answer;
    }

    /* ---------------------------------------------------------------- *
     * Driving, and the person taking over
     * ---------------------------------------------------------------- */

    static IntPtr mouseHook = IntPtr.Zero;
    static IntPtr keyboardHook = IntPtr.Zero;
    // Held so the collector never takes a callback Windows still calls.
    static readonly Native.HookProc MouseProc = OnMouse;
    static readonly Native.HookProc KeyboardProc = OnKeyboard;

    static Dictionary<string, object> Drive(Dictionary<string, object> request)
    {
        bool on = Flag(request, "on");
        if (on)
        {
            if (Text(request, "label").Length > 0) labelDriving = Text(request, "label");
            if (Text(request, "paused").Length > 0) labelPaused = Text(request, "paused");
            if (Text(request, "stopped").Length > 0) labelStopped = Text(request, "stopped");
            Native.POINT point;
            Native.GetCursorPos(out point);
            lastX = point.X;
            lastY = point.Y;
            paused = false;
            pauseCode = "";
            driving = true;
            Ui(delegate
            {
                InstallHooks();
                overlay.Badge(labelDriving, Overlay.Tone.Driving);
            });
        }
        else
        {
            driving = false;
            paused = false;
            pauseCode = "";
            Ui(delegate
            {
                RemoveHooks();
                overlay.HideAll();
            });
        }
        return new Dictionary<string, object>();
    }

    static void InstallHooks()
    {
        IntPtr module = Native.GetModuleHandle(null);
        if (mouseHook == IntPtr.Zero) mouseHook = Native.SetWindowsHookEx(14, MouseProc, module, 0);
        if (keyboardHook == IntPtr.Zero) keyboardHook = Native.SetWindowsHookEx(13, KeyboardProc, module, 0);
    }

    static void RemoveHooks()
    {
        if (mouseHook != IntPtr.Zero) Native.UnhookWindowsHookEx(mouseHook);
        if (keyboardHook != IntPtr.Zero) Native.UnhookWindowsHookEx(keyboardHook);
        mouseHook = IntPtr.Zero;
        keyboardHook = IntPtr.Zero;
    }

    // Set while an action is under way: the only time the person's hand on
    // the mouse is a hand fighting the agent's.
    static volatile bool acting;

    static readonly HashSet<string> Actions = new HashSet<string> { "focus", "launch", "target", "click", "type", "keys", "scroll", "drag" };

    /// <summary>
    /// The person's input, by the rule the badge promises. Clicking or typing
    /// into Acestes is the person answering the agent (a card, a question, a
    /// message), not taking over. Anywhere else it is. Moving the mouse only
    /// counts while an action is under way; between actions it is someone
    /// reaching for the Acestes window.
    /// </summary>
    static IntPtr OnMouse(int code, IntPtr message, IntPtr data)
    {
        if (code >= 0 && driving)
        {
            var info = (Native.MSLLHOOKSTRUCT)Marshal.PtrToStructure(data, typeof(Native.MSLLHOOKSTRUCT));
            if (info.dwExtraInfo != Mark)
            {
                if (message.ToInt32() == 0x0200)
                {
                    // A hand resting on a mouse drifts a pixel or two; a hand
                    // reaching for it does not stop there.
                    if (acting && Math.Abs(info.pt.X - lastX) + Math.Abs(info.pt.Y - lastY) > 8) TakeOver("mouse");
                }
                else if (!Protected.Contains(PidOf(RootAt(info.pt.X, info.pt.Y))))
                {
                    TakeOver("mouse");
                }
            }
        }
        return Native.CallNextHookEx(IntPtr.Zero, code, message, data);
    }

    static IntPtr OnKeyboard(int code, IntPtr message, IntPtr data)
    {
        if (code >= 0 && driving)
        {
            var info = (Native.KBDLLHOOKSTRUCT)Marshal.PtrToStructure(data, typeof(Native.KBDLLHOOKSTRUCT));
            if (info.dwExtraInfo != Mark)
            {
                int kind = message.ToInt32();
                bool down = kind == 0x0100 || kind == 0x0104;
                if (info.vkCode == 0x1B)
                {
                    if (down) Escape();
                    // Swallowed, down and up: nothing on screen gets to see it,
                    // so nothing on screen can use it to dismiss a dialog.
                    return new IntPtr(1);
                }
                if (down && !Protected.Contains(PidOf(Native.GetForegroundWindow()))) TakeOver("keyboard");
            }
        }
        return Native.CallNextHookEx(IntPtr.Zero, code, message, data);
    }

    static void TakeOver(string by)
    {
        if (paused) return;
        paused = true;
        pauseCode = "took-over";
        overlay.Badge(labelPaused, Overlay.Tone.Paused);
        var message = new Dictionary<string, object>();
        message["event"] = "took-over";
        message["by"] = by;
        EmitLater(message);
    }

    static void Escape()
    {
        if (paused && pauseCode == "escape") return;
        paused = true;
        pauseCode = "escape";
        overlay.Badge(labelStopped, Overlay.Tone.Stopped);
        var message = new Dictionary<string, object>();
        message["event"] = "escape";
        EmitLater(message);
    }

    /// <summary>Between every step of every action: has anyone said stop?</summary>
    static void Guard()
    {
        if (paused)
        {
            throw pauseCode == "escape"
                ? new Stop("escape", "The user pressed Esc to stop.")
                : new Stop("took-over", "The user took control of the mouse or keyboard.");
        }
        if (cancelled) throw new Stop("cancelled", "Stopped by the app.");
    }

    static void RequireDriving()
    {
        if (!driving) throw new Stop("not-driving", "Not driving: take the desktop first.");
        Guard();
    }

    /* ---------------------------------------------------------------- *
     * Windows
     * ---------------------------------------------------------------- */

    static bool Listed(IntPtr window)
    {
        if (!Native.IsWindowVisible(window)) return false;
        int cloaked;
        if (Native.DwmGetWindowAttribute(window, 14, out cloaked, 4) == 0 && cloaked != 0) return false;
        int style = Native.GetWindowLong(window, -20);
        bool tool = (style & 0x00000080) != 0;
        bool app = (style & 0x00040000) != 0;
        if (tool && !app) return false;
        if (Native.GetWindow(window, 4) != IntPtr.Zero && !app) return false;
        if (Native.GetWindowTextLength(window) == 0) return false;
        uint pid;
        Native.GetWindowThreadProcessId(window, out pid);
        if (Protected.Contains(pid)) return false;
        if (ClassOf(window) == "Progman") return false;
        return true;
    }

    /// <summary>Every top-level window a person could switch to, front to back.</summary>
    static List<IntPtr> ListWindows()
    {
        var found = new List<IntPtr>();
        Native.EnumWindows(delegate(IntPtr window, IntPtr unused)
        {
            if (Listed(window)) found.Add(window);
            return true;
        }, IntPtr.Zero);
        return found;
    }

    static Dictionary<string, object> Windows()
    {
        var list = new List<object>();
        foreach (var window in ListWindows()) list.Add(Describe(window));
        var answer = new Dictionary<string, object>();
        answer["windows"] = list;
        return answer;
    }

    static Dictionary<string, object> Foreground()
    {
        var answer = new Dictionary<string, object>();
        IntPtr window = Native.GetForegroundWindow();
        if (window != IntPtr.Zero) answer["window"] = Describe(window);
        return answer;
    }

    static Dictionary<string, object> Describe(IntPtr window)
    {
        uint pid;
        Native.GetWindowThreadProcessId(window, out pid);
        Native.RECT rect;
        Native.GetWindowRect(window, out rect);
        var info = new Dictionary<string, object>();
        info["hwnd"] = window.ToInt64();
        info["title"] = TitleOf(window);
        info["process"] = ProcessOf(window, pid);
        info["pid"] = (long)pid;
        info["x"] = rect.Left;
        info["y"] = rect.Top;
        info["width"] = rect.Right - rect.Left;
        info["height"] = rect.Bottom - rect.Top;
        info["minimized"] = Native.IsIconic(window);
        info["foreground"] = Native.GetForegroundWindow() == window;
        info["protected"] = Protected.Contains(pid);
        info["elevated"] = !selfElevated && IsElevated(pid);
        return info;
    }

    static string TitleOf(IntPtr window)
    {
        int length = Native.GetWindowTextLength(window);
        var text = new StringBuilder(length + 1);
        Native.GetWindowText(window, text, text.Capacity);
        return text.ToString();
    }

    static string ClassOf(IntPtr window)
    {
        var text = new StringBuilder(256);
        Native.GetClassName(window, text, text.Capacity);
        return text.ToString();
    }

    /// <summary>The program behind a window. A Store app's frame is hosted by ApplicationFrameHost; the app is the child from another process.</summary>
    static string ProcessOf(IntPtr window, uint pid)
    {
        string name = NameOf(pid);
        if (!string.Equals(name, "ApplicationFrameHost.exe", StringComparison.OrdinalIgnoreCase)) return name;
        string inner = null;
        Native.EnumChildWindows(window, delegate(IntPtr child, IntPtr unused)
        {
            uint childPid;
            Native.GetWindowThreadProcessId(child, out childPid);
            if (childPid != pid && childPid != 0)
            {
                inner = NameOf(childPid);
                return false;
            }
            return true;
        }, IntPtr.Zero);
        return inner ?? name;
    }

    static string NameOf(uint pid)
    {
        try
        {
            using (var process = Process.GetProcessById((int)pid)) return process.ProcessName + ".exe";
        }
        catch (Exception)
        {
            return "";
        }
    }

    static bool IsElevated(uint pid)
    {
        IntPtr process = Native.OpenProcess(0x1000, false, pid);
        // Refused even the least a caller can ask for: something protected,
        // and certainly nothing input from here would reach.
        if (process == IntPtr.Zero) return Marshal.GetLastWin32Error() == 5;
        try
        {
            IntPtr token;
            if (!Native.OpenProcessToken(process, 0x0008, out token)) return Marshal.GetLastWin32Error() == 5;
            try
            {
                int elevated;
                int size;
                if (!Native.GetTokenInformation(token, 20, out elevated, 4, out size)) return false;
                return elevated != 0;
            }
            finally
            {
                Native.CloseHandle(token);
            }
        }
        finally
        {
            Native.CloseHandle(process);
        }
    }

    static uint PidOf(IntPtr window)
    {
        uint pid;
        Native.GetWindowThreadProcessId(window, out pid);
        return pid;
    }

    static IntPtr RootAt(int x, int y)
    {
        var point = new Native.POINT { X = x, Y = y };
        IntPtr window = Native.WindowFromPoint(point);
        return window == IntPtr.Zero ? IntPtr.Zero : Native.GetAncestor(window, 2);
    }

    /// <summary>What is at a point may be touched: not Acestes, not something elevated.</summary>
    static void Allowed(IntPtr root)
    {
        if (root == IntPtr.Zero) return;
        uint pid = PidOf(root);
        if (Protected.Contains(pid)) throw new Stop("protected", "That is on the Acestes window itself, which the agent may not touch.");
        if (!selfElevated && IsElevated(pid))
        {
            throw new Stop("elevated", "\"" + TitleOf(root) + "\" runs as administrator. Windows does not let a normal app send it input; the user has to do this part, or run Acestes as administrator.");
        }
    }

    static Dictionary<string, object> Focus(IntPtr window)
    {
        RequireDriving();
        if (window == IntPtr.Zero || !Native.IsWindow(window)) throw new Stop("gone", "That window is gone. List the windows again.");
        Allowed(window);
        BringForward(window);
        var answer = new Dictionary<string, object>();
        answer["window"] = Describe(window);
        return answer;
    }

    /// <summary>To the front, by the gentlest way that works. Windows refuses a background process that simply asks.</summary>
    static void BringForward(IntPtr window)
    {
        if (Native.IsIconic(window)) Native.ShowWindow(window, 9);
        if (Native.GetForegroundWindow() == window) return;
        Native.SetForegroundWindow(window);
        if (Native.GetForegroundWindow() != window)
        {
            IntPtr front = Native.GetForegroundWindow();
            uint unused;
            uint theirs = Native.GetWindowThreadProcessId(front, out unused);
            uint ours = Native.GetCurrentThreadId();
            if (theirs != 0 && theirs != ours) Native.AttachThreadInput(ours, theirs, true);
            Native.BringWindowToTop(window);
            Native.SetForegroundWindow(window);
            if (theirs != 0 && theirs != ours) Native.AttachThreadInput(ours, theirs, false);
        }
        if (Native.GetForegroundWindow() != window)
        {
            // The last resort: a tap of Alt releases the foreground lock.
            KeyTap(0x12);
            Native.SetForegroundWindow(window);
        }
        for (int wait = 0; wait < 20 && Native.GetForegroundWindow() != window; wait++) Thread.Sleep(25);
        Thread.Sleep(40);
    }

    static Dictionary<string, object> Launch(string target, string arguments)
    {
        RequireDriving();
        if (target.Length == 0) throw new Stop("bad-request", "Name the app to open.");
        var before = new HashSet<long>();
        foreach (var window in ListWindows()) before.Add(window.ToInt64());

        var start = new ProcessStartInfo(target);
        start.UseShellExecute = true;
        if (arguments.Length > 0) start.Arguments = arguments;
        try
        {
            Process.Start(start);
        }
        catch (Win32Exception error)
        {
            throw new Stop("not-found", "Could not open \"" + target + "\": " + error.Message);
        }

        var clock = Stopwatch.StartNew();
        while (clock.ElapsedMilliseconds < 15000)
        {
            Thread.Sleep(250);
            Guard();
            foreach (var window in ListWindows())
            {
                if (before.Contains(window.ToInt64())) continue;
                // A window is often titled a beat after it appears.
                Thread.Sleep(200);
                BringForward(window);
                var answer = new Dictionary<string, object>();
                answer["window"] = Describe(window);
                return answer;
            }
        }
        // A single-instance app raises the window it already had.
        IntPtr front = Native.GetForegroundWindow();
        if (front != IntPtr.Zero && Listed(front))
        {
            var answer = new Dictionary<string, object>();
            answer["window"] = Describe(front);
            answer["note"] = "No new window appeared; this is the one in front now.";
            return answer;
        }
        throw new Stop("no-window", "It started, but no window appeared within 15 seconds.");
    }

    /* ---------------------------------------------------------------- *
     * Seeing: the UI Automation tree
     * ---------------------------------------------------------------- */

    // The elements of the last read, by the number the agent was given.
    static Dictionary<int, AutomationElement> elements = new Dictionary<int, AutomationElement>();
    static Dictionary<int, IntPtr> elementRoots = new Dictionary<int, IntPtr>();
    static int counter;
    static CacheRequest cache;

    const int MaxVisited = 2500;
    const int MaxChildren = 80;
    const int MaxDepth = 30;

    static readonly HashSet<string> Interactive = new HashSet<string>
    {
        "button", "check box", "combo box", "edit", "link", "list item", "menu item",
        "radio button", "slider", "spinner", "split button", "tab item", "tree item",
        "data item", "document", "header item", "calendar",
    };

    static readonly HashSet<string> Containers = new HashSet<string>
    {
        "window", "pane", "group", "tab", "list", "tree", "table", "data grid", "tool bar",
        "menu bar", "menu", "status bar", "header",
    };

    // Chrome of the chrome: never what anyone means to click.
    static readonly HashSet<string> Skipped = new HashSet<string> { "scroll bar", "thumb" };

    static CacheRequest Props()
    {
        if (cache != null) return cache;
        cache = new CacheRequest();
        cache.TreeScope = TreeScope.Element;
        cache.AutomationElementMode = AutomationElementMode.Full;
        cache.Add(AutomationElement.NameProperty);
        cache.Add(AutomationElement.ControlTypeProperty);
        cache.Add(AutomationElement.IsEnabledProperty);
        cache.Add(AutomationElement.IsOffscreenProperty);
        cache.Add(AutomationElement.HasKeyboardFocusProperty);
        cache.Add(AutomationElement.IsPasswordProperty);
        cache.Add(AutomationElement.IsInvokePatternAvailableProperty);
        cache.Add(AutomationElement.IsValuePatternAvailableProperty);
        cache.Add(AutomationElement.IsTogglePatternAvailableProperty);
        cache.Add(AutomationElement.IsExpandCollapsePatternAvailableProperty);
        cache.Add(AutomationElement.IsSelectionItemPatternAvailableProperty);
        cache.Add(ValuePattern.ValueProperty);
        cache.Add(ValuePattern.IsReadOnlyProperty);
        cache.Add(TogglePattern.ToggleStateProperty);
        cache.Add(ExpandCollapsePattern.ExpandCollapseStateProperty);
        cache.Add(SelectionItemPattern.IsSelectedProperty);
        return cache;
    }

    static Dictionary<string, object> Tree(Dictionary<string, object> request)
    {
        int limit = Math.Max(20, Math.Min(1500, Number(request, "maxNodes", 500)));
        var roots = new List<KeyValuePair<AutomationElement, IntPtr>>();
        IntPtr window = Handle(request, "hwnd");
        int under = Number(request, "under", 0);

        if (under > 0)
        {
            AutomationElement start = Lookup(under);
            roots.Add(new KeyValuePair<AutomationElement, IntPtr>(start, elementRoots[under]));
            window = elementRoots[under];
        }
        else
        {
            if (window == IntPtr.Zero || !Native.IsWindow(window)) throw new Stop("gone", "That window is gone. List the windows again.");
            uint pid = PidOf(window);
            if (Protected.Contains(pid)) throw new Stop("protected", "That is the Acestes window itself, which the agent may not read.");
            // The window, and whatever the same program has open over it: a
            // menu, a dialog, a dropdown. Those are windows of their own, and a
            // tree of the main window alone would not show the menu just opened.
            Native.EnumWindows(delegate(IntPtr other, IntPtr unused)
            {
                if (other == window || (Native.IsWindowVisible(other) && PidOf(other) == pid && Popup(other, window)))
                {
                    AutomationElement element = FromHandle(other);
                    if (element != null) roots.Add(new KeyValuePair<AutomationElement, IntPtr>(element, other));
                }
                return true;
            }, IntPtr.Zero);
        }

        var nodes = new List<object>();
        // What is scrolled away is counted, not listed: most of a long page
        // is off screen, and listing it made every read several times the
        // size of what the person can see. A minimised window is all off
        // screen, so there it is listed after all.
        var state = new WalkState
        {
            Limit = limit,
            Offscreen = Flag(request, "offscreen") || Native.IsIconic(window),
            Register = true,
        };

        // Looking for something is a walk that numbers nothing, so the
        // numbers the agent holds stay good while it waits.
        string wanted = Text(request, "find");
        if (wanted.Length > 0)
        {
            state.Register = false;
            state.Find = wanted;
            state.FindRole = Text(request, "role").ToLowerInvariant();
            state.Offscreen = true;
            foreach (var root in roots)
            {
                if (state.Truncated) break;
                Walk(root.Key, root.Value, 0, 0, nodes, state);
            }
            var search = new Dictionary<string, object>();
            search["window"] = Describe(window);
            if (state.Found != null) search["found"] = state.Found;
            return search;
        }

        elements = new Dictionary<int, AutomationElement>();
        elementRoots = new Dictionary<int, IntPtr>();
        counter = 0;
        foreach (var root in roots)
        {
            if (state.Truncated) break;
            Walk(root.Key, root.Value, 0, 0, nodes, state);
        }

        var answer = new Dictionary<string, object>();
        answer["window"] = Describe(window);
        answer["nodes"] = nodes;
        answer["truncated"] = state.Truncated;
        return answer;
    }

    /// <summary>Another window of the same program that sits over this one.</summary>
    static bool Popup(IntPtr other, IntPtr window)
    {
        if (ClassOf(other) == "#32768") return true;
        IntPtr owner = Native.GetWindow(other, 4);
        while (owner != IntPtr.Zero)
        {
            if (owner == window) return true;
            owner = Native.GetWindow(owner, 4);
        }
        return false;
    }

    static AutomationElement FromHandle(IntPtr window)
    {
        try
        {
            using (Props().Activate()) return AutomationElement.FromHandle(window);
        }
        catch (Exception)
        {
            return null;
        }
    }

    class WalkState
    {
        public int Limit;
        public int Visited;
        public bool Truncated;
        public bool Offscreen;
        public bool Register;
        public string Find;
        public string FindRole;
        public Dictionary<string, object> Found;
    }

    static void Walk(AutomationElement element, IntPtr root, int depth, int shown, List<object> nodes, WalkState state, string above = "")
    {
        if (state.Truncated) return;
        if (++state.Visited > MaxVisited || nodes.Count >= state.Limit)
        {
            state.Truncated = true;
            return;
        }

        string role = RoleOf(element);
        if (Skipped.Contains(role)) return;
        string name = CachedText(element, AutomationElement.NameProperty);

        if (state.Find != null)
        {
            string value = CachedFlag(element, AutomationElement.IsPasswordProperty) ? "" : CachedText(element, ValuePattern.ValueProperty);
            bool named = name.IndexOf(state.Find, StringComparison.OrdinalIgnoreCase) >= 0
                || value.IndexOf(state.Find, StringComparison.OrdinalIgnoreCase) >= 0;
            if (named && (state.FindRole.Length == 0 || state.FindRole == role))
            {
                state.Found = new Dictionary<string, object>();
                state.Found["r"] = role;
                state.Found["n"] = Clip(name.Length > 0 ? name : value, 120);
                state.Truncated = true;
                return;
            }
        }

        // An unnamed thing that merely offers an action is usually a wrapper
        // around the real control, which is kept on its own account.
        bool keep = Interactive.Contains(role)
            || (Containers.Contains(role) && (name.Length > 0 || depth == 0))
            // A label inside a link or a button mostly repeats its name.
            || (role == "text" && name.Length > 0 && above.IndexOf(name, StringComparison.OrdinalIgnoreCase) < 0)
            || (role != "title bar" && name.Length > 0 && (CachedFlag(element, AutomationElement.IsInvokePatternAvailableProperty)
                || CachedFlag(element, AutomationElement.IsTogglePatternAvailableProperty)
                || CachedFlag(element, AutomationElement.IsExpandCollapsePatternAvailableProperty)
                || CachedFlag(element, AutomationElement.IsSelectionItemPatternAvailableProperty)));

        int childShown = shown;
        if (keep && state.Register)
        {
            int id = ++counter;
            elements[id] = element;
            elementRoots[id] = root;
            nodes.Add(Node(element, id, shown, role, name));
            childShown = shown + 1;
        }
        if (depth >= MaxDepth) return;

        AutomationElementCollection children;
        try
        {
            using (Props().Activate()) children = element.FindAll(TreeScope.Children, Automation.ControlViewCondition);
        }
        catch (Exception)
        {
            return;
        }
        int count = Math.Min(children.Count, MaxChildren);
        int hidden = 0;
        for (int index = 0; index < count && !state.Truncated; index++)
        {
            if (!state.Offscreen && CachedFlag(children[index], AutomationElement.IsOffscreenProperty))
            {
                hidden++;
                continue;
            }
            Walk(children[index], root, depth + 1, childShown, nodes, state, keep && name.Length > 0 ? name : above);
        }
        if (hidden > 0 && !state.Truncated && state.Register)
        {
            var away = new Dictionary<string, object>();
            away["d"] = childShown;
            away["offscreen"] = hidden;
            nodes.Add(away);
        }
        if (children.Count > count && !state.Truncated && state.Register)
        {
            var more = new Dictionary<string, object>();
            more["d"] = childShown;
            more["more"] = children.Count - count;
            nodes.Add(more);
        }
    }

    static Dictionary<string, object> Node(AutomationElement element, int id, int depth, string role, string name)
    {
        var node = new Dictionary<string, object>();
        node["id"] = id;
        node["d"] = depth;
        node["r"] = role;
        if (name.Length > 0) node["n"] = Clip(name, 120);

        // The start of a long value, and how long it is: a page or a
        // document is read whole with the text command, not in every tree.
        // A link's value is its address, which was most of the value text in
        // a page's tree and is not what anyone clicks by.
        bool password = CachedFlag(element, AutomationElement.IsPasswordProperty);
        if (!password && role != "link" && CachedFlag(element, AutomationElement.IsValuePatternAvailableProperty))
        {
            string value = CachedText(element, ValuePattern.ValueProperty);
            if (value.Length > 0 && value != name)
            {
                node["v"] = Clip(value, 150);
                if (value.Length > 150) node["len"] = value.Length;
            }
        }

        var states = new List<string>();
        if (!CachedFlag(element, AutomationElement.IsEnabledProperty, true)) states.Add("disabled");
        if (CachedFlag(element, AutomationElement.HasKeyboardFocusProperty)) states.Add("focused");
        if (CachedFlag(element, AutomationElement.IsOffscreenProperty)) states.Add("offscreen");
        if (password) states.Add("password");
        if (CachedFlag(element, AutomationElement.IsTogglePatternAvailableProperty))
        {
            object toggle = Cached(element, TogglePattern.ToggleStateProperty);
            if (toggle is ToggleState)
            {
                var value = (ToggleState)toggle;
                states.Add(value == ToggleState.On ? "checked" : value == ToggleState.Off ? "unchecked" : "mixed");
            }
        }
        if (CachedFlag(element, AutomationElement.IsExpandCollapsePatternAvailableProperty))
        {
            object expand = Cached(element, ExpandCollapsePattern.ExpandCollapseStateProperty);
            if (expand is ExpandCollapseState)
            {
                var value = (ExpandCollapseState)expand;
                if (value == ExpandCollapseState.Expanded) states.Add("expanded");
                else if (value == ExpandCollapseState.Collapsed) states.Add("collapsed");
                else if (value == ExpandCollapseState.PartiallyExpanded) states.Add("partly expanded");
            }
        }
        if (CachedFlag(element, AutomationElement.IsSelectionItemPatternAvailableProperty)
            && CachedFlag(element, SelectionItemPattern.IsSelectedProperty)) states.Add("selected");
        if (role == "edit" && CachedFlag(element, ValuePattern.IsReadOnlyProperty)) states.Add("read-only");
        if (states.Count > 0) node["s"] = string.Join(", ", states.ToArray());
        return node;
    }

    const int MaxText = 400000;

    /// <summary>
    /// The whole text of an element, or of a window: what a page, an email or
    /// a document says, in one answer. The text pattern when the app offers
    /// one, the value when it offers that, and otherwise every named thing in
    /// reading order. Never a password field.
    /// </summary>
    static Dictionary<string, object> ReadText(Dictionary<string, object> request)
    {
        int id = Number(request, "element", 0);
        AutomationElement element;
        if (id > 0)
        {
            element = Lookup(id);
        }
        else
        {
            IntPtr window = Handle(request, "hwnd");
            if (window == IntPtr.Zero || !Native.IsWindow(window)) throw new Stop("gone", "That window is gone. List the windows again.");
            if (Protected.Contains(PidOf(window))) throw new Stop("protected", "That is the Acestes window itself, which the agent may not read.");
            element = AutomationElement.FromHandle(window);
        }
        object password = element.GetCurrentPropertyValue(AutomationElement.IsPasswordProperty);
        if (password is bool && (bool)password) throw new Stop("password", "That is a password field. Its text is not read.");

        string text = null;
        object pattern;
        if (element.TryGetCurrentPattern(TextPattern.Pattern, out pattern))
        {
            try { text = ((TextPattern)pattern).DocumentRange.GetText(MaxText); } catch (Exception) { }
        }
        if (string.IsNullOrEmpty(text) && element.TryGetCurrentPattern(ValuePattern.Pattern, out pattern))
        {
            try { text = ((ValuePattern)pattern).Current.Value; } catch (Exception) { }
        }
        if (string.IsNullOrEmpty(text)) text = Flatten(element);

        var answer = new Dictionary<string, object>();
        answer["text"] = text ?? "";
        answer["length"] = (text ?? "").Length;
        return answer;
    }

    /// <summary>Every named thing inside, in reading order, one per line, repeats dropped.</summary>
    static string Flatten(AutomationElement root)
    {
        AutomationElementCollection all;
        using (Props().Activate()) all = root.FindAll(TreeScope.Descendants, Automation.ControlViewCondition);
        var lines = new List<string>();
        string last = null;
        int total = 0;
        foreach (AutomationElement element in all)
        {
            if (CachedFlag(element, AutomationElement.IsPasswordProperty)) continue;
            string role = RoleOf(element);
            if (Skipped.Contains(role)) continue;
            string name = CachedText(element, AutomationElement.NameProperty);
            string value = role != "link" && CachedFlag(element, AutomationElement.IsValuePatternAvailableProperty)
                ? CachedText(element, ValuePattern.ValueProperty)
                : "";
            string line = value.Length > 0 && value != name ? (name.Length > 0 ? name + ": " + value : value) : name;
            if (line.Length == 0 || line == last) continue;
            lines.Add(line);
            last = line;
            total += line.Length + 1;
            if (total > MaxText) break;
        }
        return string.Join("\n", lines.ToArray());
    }

    /* ---------------------------------------------------------------- *
     * Seeing: captchas
     * ---------------------------------------------------------------- */

    /// <summary>
    /// The captcha widgets in a window, found by the address of the frame each
    /// lives in, which reads the same in every language where the words on it
    /// do not. Each comes with its checkbox and that box's state, and a
    /// challenge with its buttons and what it asks. Everything reported is
    /// numbered on from the last read, so the agent can act on it and the
    /// numbers it already holds stay good. Also any image named as a captcha,
    /// for the kind that is a picture of letters beside a field.
    /// </summary>
    static Dictionary<string, object> Captchas(Dictionary<string, object> request)
    {
        IntPtr window = Handle(request, "hwnd");
        if (window == IntPtr.Zero || !Native.IsWindow(window)) throw new Stop("gone", "That window is gone. List the windows again.");
        if (Protected.Contains(PidOf(window))) throw new Stop("protected", "That is the Acestes window itself, which the agent may not read.");
        AutomationElement root = FromHandle(window);
        if (root == null) throw new Stop("gone", "That window cannot be read.");
        object[] box = Bounds(window);
        var area = new WinRect((int)box[0], (int)box[1], Math.Max(1, (int)box[2]), Math.Max(1, (int)box[3]));

        var condition = new OrCondition(
            new PropertyCondition(AutomationElement.IsValuePatternAvailableProperty, true),
            new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Image));
        AutomationElementCollection all;
        using (Props().Activate()) all = root.FindAll(TreeScope.Descendants, condition);

        var widgets = new List<object>();
        var images = new List<object>();
        foreach (AutomationElement element in all)
        {
            string role = RoleOf(element);
            if (role == "image")
            {
                string name = CachedText(element, AutomationElement.NameProperty);
                // The word on its own: "captcha", "CAPTCHA image", but not a
                // solver's logo ("2Captcha") on a page about them.
                if (images.Count >= 5 || !System.Text.RegularExpressions.Regex.IsMatch(name, @"\bcaptcha\b", System.Text.RegularExpressions.RegexOptions.IgnoreCase)) continue;
                WinRect bounds = element.Current.BoundingRectangle;
                var image = new Dictionary<string, object>();
                image["id"] = Register(element, window);
                image["name"] = Clip(name, 80);
                image["rect"] = RectOf(bounds);
                image["visible"] = Shown(element, bounds, area);
                images.Add(image);
                continue;
            }
            // A link's value is its address, and a field's is whatever was
            // typed: neither is a frame.
            if (role == "link" || role == "edit" || role == "combo box") continue;
            string url = CachedText(element, ValuePattern.ValueProperty);
            if (!url.StartsWith("http", StringComparison.OrdinalIgnoreCase)) continue;
            string[] kind = CaptchaKind(url);
            if (kind == null || widgets.Count >= 8) continue;

            WinRect frame = element.Current.BoundingRectangle;
            var widget = new Dictionary<string, object>();
            widget["kind"] = kind[0];
            widget["part"] = kind[1];
            widget["url"] = Clip(url, 300);
            widget["id"] = Register(element, window);
            widget["rect"] = RectOf(frame);
            widget["visible"] = Shown(element, frame, area);
            Inside(element, window, area, widget);
            widgets.Add(widget);
        }

        var answer = new Dictionary<string, object>();
        answer["window"] = Describe(window);
        answer["widgets"] = widgets;
        answer["images"] = images;
        return answer;
    }

    /// <summary>Which captcha a frame's address belongs to, and which part of it: { kind, part }, or null.</summary>
    static string[] CaptchaKind(string url)
    {
        string address = url.ToLowerInvariant();
        if (address.Contains("/recaptcha/api2/anchor") || address.Contains("/recaptcha/enterprise/anchor")) return new[] { "recaptcha", "checkbox" };
        if (address.Contains("/recaptcha/api2/bframe") || address.Contains("/recaptcha/enterprise/bframe")) return new[] { "recaptcha", "challenge" };
        if (address.Contains("hcaptcha.com") && address.Contains("frame=checkbox")) return new[] { "hcaptcha", "checkbox" };
        if (address.Contains("hcaptcha.com") && address.Contains("frame=challenge")) return new[] { "hcaptcha", "challenge" };
        if (address.Contains("challenges.cloudflare.com")) return new[] { "turnstile", "checkbox" };
        if (address.Contains("arkoselabs.com") || address.Contains("funcaptcha.com")) return new[] { "arkose", "challenge" };
        return null;
    }

    /// <summary>What a captcha frame holds: its checkbox, its named buttons, and the words it shows.</summary>
    static void Inside(AutomationElement frame, IntPtr window, WinRect area, Dictionary<string, object> widget)
    {
        AutomationElementCollection inner;
        try
        {
            using (Props().Activate()) inner = frame.FindAll(TreeScope.Descendants, Automation.ControlViewCondition);
        }
        catch (Exception)
        {
            return;
        }
        var buttons = new List<object>();
        var words = new StringBuilder();
        string last = null;
        int seen = 0;
        foreach (AutomationElement element in inner)
        {
            if (++seen > 400) break;
            string role = RoleOf(element);
            string name = CachedText(element, AutomationElement.NameProperty);
            if (role == "check box")
            {
                if (widget.ContainsKey("checkbox")) continue;
                WinRect bounds = element.Current.BoundingRectangle;
                var check = new Dictionary<string, object>();
                check["id"] = Register(element, window);
                check["name"] = Clip(name, 80);
                check["rect"] = RectOf(bounds);
                check["state"] = ToggleOf(element);
                check["visible"] = Shown(element, bounds, area);
                widget["checkbox"] = check;
                continue;
            }
            if (role == "button" && buttons.Count < 30)
            {
                string automationId = "";
                string className = "";
                try
                {
                    automationId = element.Current.AutomationId ?? "";
                    className = element.Current.ClassName ?? "";
                }
                catch (Exception)
                {
                }
                // An image tile is a button with no name: the solver finds
                // those by looking, so only the named ones are worth listing.
                if (name.Length == 0 && automationId.Length == 0) continue;
                WinRect bounds = element.Current.BoundingRectangle;
                var button = new Dictionary<string, object>();
                button["id"] = Register(element, window);
                button["name"] = Clip(name, 80);
                if (automationId.Length > 0) button["aid"] = automationId;
                if (className.Length > 0) button["cls"] = Clip(className, 120);
                button["rect"] = RectOf(bounds);
                button["enabled"] = CachedFlag(element, AutomationElement.IsEnabledProperty, true);
                button["visible"] = Shown(element, bounds, area);
                buttons.Add(button);
                continue;
            }
            if (role == "text" && name.Length > 0 && name != last && words.Length < 600)
            {
                if (words.Length > 0) words.Append(' ');
                words.Append(name);
                last = name;
            }
        }
        widget["buttons"] = buttons;
        widget["text"] = Clip(words.ToString(), 600);
    }

    static int Register(AutomationElement element, IntPtr root)
    {
        int id = ++counter;
        elements[id] = element;
        elementRoots[id] = root;
        return id;
    }

    static object[] RectOf(WinRect bounds)
    {
        if (bounds.IsEmpty) return new object[] { 0, 0, 0, 0 };
        return new object[] { (int)Math.Round(bounds.X), (int)Math.Round(bounds.Y), (int)Math.Round(bounds.Width), (int)Math.Round(bounds.Height) };
    }

    /// <summary>On screen for real: not marked off screen, not collapsed to nothing, and inside the window rather than parked far outside it.</summary>
    static bool Shown(AutomationElement element, WinRect bounds, WinRect area)
    {
        if (bounds.IsEmpty || bounds.Width < 8 || bounds.Height < 8) return false;
        if (CachedFlag(element, AutomationElement.IsOffscreenProperty)) return false;
        return bounds.IntersectsWith(area);
    }

    static string ToggleOf(AutomationElement element)
    {
        if (!CachedFlag(element, AutomationElement.IsTogglePatternAvailableProperty)) return "";
        object toggle = Cached(element, TogglePattern.ToggleStateProperty);
        if (!(toggle is ToggleState)) return "";
        var value = (ToggleState)toggle;
        return value == ToggleState.On ? "checked" : value == ToggleState.Off ? "unchecked" : "mixed";
    }

    static string RoleOf(AutomationElement element)
    {
        object type = Cached(element, AutomationElement.ControlTypeProperty);
        var control = type as ControlType;
        if (control == null) return "element";
        // "ControlType.MenuItem" -> "menu item"
        string raw = control.ProgrammaticName;
        int dot = raw.LastIndexOf('.');
        if (dot >= 0) raw = raw.Substring(dot + 1);
        var words = new StringBuilder();
        for (int index = 0; index < raw.Length; index++)
        {
            char letter = raw[index];
            if (index > 0 && char.IsUpper(letter)) words.Append(' ');
            words.Append(char.ToLowerInvariant(letter));
        }
        string role = words.ToString();
        return role == "hyperlink" ? "link" : role;
    }

    static object Cached(AutomationElement element, AutomationProperty property)
    {
        try
        {
            return element.GetCachedPropertyValue(property);
        }
        catch (Exception)
        {
            return null;
        }
    }

    static string CachedText(AutomationElement element, AutomationProperty property)
    {
        var value = Cached(element, property) as string;
        return value == null ? "" : value.Replace('\r', ' ').Replace('\n', ' ').Trim();
    }

    static bool CachedFlag(AutomationElement element, AutomationProperty property, bool fallback = false)
    {
        object value = Cached(element, property);
        return value is bool ? (bool)value : fallback;
    }

    static string Clip(string text, int length)
    {
        return text.Length <= length ? text : text.Substring(0, length) + "…";
    }

    static AutomationElement Lookup(int id)
    {
        AutomationElement element;
        if (!elements.TryGetValue(id, out element)) throw new Stop("unknown-element", "There is no element " + id + " in the last read. Read the screen again.");
        return element;
    }

    /* ---------------------------------------------------------------- *
     * Aiming
     * ---------------------------------------------------------------- */

    /// <summary>
    /// Where an element is to be clicked, checked: its window brought to the
    /// front, scrolled into view if it has to be, and a hit test at the point
    /// confirming that the click would land on it and not on something
    /// covering it. Or a point given outright, with its window.
    /// </summary>
    static Dictionary<string, object> Target(Dictionary<string, object> request)
    {
        RequireDriving();
        var answer = new Dictionary<string, object>();
        int id = Number(request, "element", 0);
        int x;
        int y;

        if (id > 0)
        {
            AutomationElement element = Lookup(id);
            IntPtr root = elementRoots[id];
            Allowed(root);
            if (Native.IsWindow(root) && Native.GetForegroundWindow() != root) BringForward(root);
            Guard();

            if (element.Current.IsOffscreen)
            {
                object scroll;
                if (element.TryGetCurrentPattern(ScrollItemPattern.Pattern, out scroll))
                {
                    ((ScrollItemPattern)scroll).ScrollIntoView();
                    Thread.Sleep(200);
                }
            }

            WinRect bounds = element.Current.BoundingRectangle;
            if (bounds.IsEmpty || bounds.Width < 1 || bounds.Height < 1)
            {
                throw new Stop("no-place", "Element " + id + " has no place on screen: it is hidden, collapsed or scrolled away.");
            }
            WinPoint point;
            if (!element.TryGetClickablePoint(out point))
            {
                point = new WinPoint(bounds.X + bounds.Width / 2, bounds.Y + bounds.Height / 2);
            }
            x = (int)Math.Round(point.X);
            y = (int)Math.Round(point.Y);

            AutomationElement hit = At(x, y);
            if (hit != null && !Related(hit, element))
            {
                // The clickable point can be a corner another element overlaps;
                // the middle is the next best guess before giving up.
                int middleX = (int)Math.Round(bounds.X + bounds.Width / 2);
                int middleY = (int)Math.Round(bounds.Y + bounds.Height / 2);
                AutomationElement middle = At(middleX, middleY);
                if (middle != null && Related(middle, element))
                {
                    x = middleX;
                    y = middleY;
                }
                else
                {
                    throw new Stop("covered", "Element " + id + " is covered by " + Summary(hit) + ". Close or move that first, or read the screen again.");
                }
            }
            answer["rect"] = new object[] { (int)bounds.X, (int)bounds.Y, (int)bounds.Width, (int)bounds.Height };
        }
        else
        {
            x = Number(request, "x", int.MinValue);
            y = Number(request, "y", int.MinValue);
            if (x == int.MinValue || y == int.MinValue) throw new Stop("bad-request", "Give an element id, or x and y.");
            // A point in a screenshot of a window: that window to the front
            // first, so the point lands on what the screenshot showed, and
            // where the window is now, so the caller can tell if it moved.
            IntPtr owner = Handle(request, "hwnd");
            if (owner != IntPtr.Zero)
            {
                if (!Native.IsWindow(owner)) throw new Stop("gone", "The window in the screenshot is gone. Take another.");
                Allowed(owner);
                if (Native.GetForegroundWindow() != owner) BringForward(owner);
                Guard();
                answer["frame"] = Bounds(owner);
            }
        }

        IntPtr at = RootAt(x, y);
        Allowed(at);
        answer["x"] = x;
        answer["y"] = y;
        if (at != IntPtr.Zero) answer["window"] = Describe(at);
        return answer;
    }

    /* ---------------------------------------------------------------- *
     * Seeing: pictures
     * ---------------------------------------------------------------- */

    /// <summary>A window's edges as drawn: GetWindowRect counts the invisible resize border, DWM does not.</summary>
    static object[] Bounds(IntPtr window)
    {
        Native.RECT rect;
        if (Native.DwmGetWindowAttribute(window, 9, out rect, Marshal.SizeOf(typeof(Native.RECT))) != 0)
        {
            Native.GetWindowRect(window, out rect);
        }
        return new object[] { rect.Left, rect.Top, rect.Right - rect.Left, rect.Bottom - rect.Top };
    }

    /// <summary>The whole monitor a window is on.</summary>
    static object[] MonitorOf(IntPtr window)
    {
        IntPtr monitor = Native.MonitorFromWindow(window, 2);
        var info = new Native.MONITORINFO();
        info.cbSize = Marshal.SizeOf(typeof(Native.MONITORINFO));
        Native.GetMonitorInfo(monitor, ref info);
        return new object[] { info.rcMonitor.Left, info.rcMonitor.Top, info.rcMonitor.Right - info.rcMonitor.Left, info.rcMonitor.Bottom - info.rcMonitor.Top };
    }

    /// <summary>
    /// A picture of part of the screen: a window as drawn, the monitor it is
    /// on, or a region, shrunk to what the model is sent (the long edge and the
    /// pixel count both capped). Whatever is excluded from capture stays out,
    /// which is the overlays here and Acestes when it asks. The answer says
    /// where the picture came from and at what scale, so a point in it can be
    /// found on the screen again.
    /// </summary>
    static Dictionary<string, object> Capture(Dictionary<string, object> request)
    {
        int x;
        int y;
        int width;
        int height;
        IntPtr window = Handle(request, "hwnd");
        object raw;
        var region = request.TryGetValue("region", out raw) ? raw as System.Collections.IList : null;
        if (region != null && region.Count == 4)
        {
            x = Convert.ToInt32(region[0]);
            y = Convert.ToInt32(region[1]);
            width = Convert.ToInt32(region[2]);
            height = Convert.ToInt32(region[3]);
        }
        else
        {
            if (window == IntPtr.Zero || !Native.IsWindow(window)) throw new Stop("gone", "That window is gone. List the windows again.");
            Allowed(window);
            object[] box = Flag(request, "monitor") ? MonitorOf(window) : Bounds(window);
            x = (int)box[0];
            y = (int)box[1];
            width = (int)box[2];
            height = (int)box[3];
        }

        // Only what is on a screen can be copied.
        int left = Native.GetSystemMetrics(76);
        int top = Native.GetSystemMetrics(77);
        int right = left + Native.GetSystemMetrics(78);
        int bottom = top + Native.GetSystemMetrics(79);
        int x2 = Math.Min(right, x + width);
        int y2 = Math.Min(bottom, y + height);
        x = Math.Max(left, x);
        y = Math.Max(top, y);
        width = x2 - x;
        height = y2 - y;
        if (width < 4 || height < 4) throw new Stop("off-screen", "That is not on any screen.");

        bool jpeg = Text(request, "format") == "jpeg";
        int maxLong = Math.Max(256, Number(request, "maxLong", 1568));
        double maxPixels = Math.Max(65536, Number(request, "maxPixels", 1150000));
        double scale = Math.Min(1.0, Math.Min((double)maxLong / Math.Max(width, height), Math.Sqrt(maxPixels / ((double)width * height))));
        int outWidth = Math.Max(1, (int)Math.Round(width * scale));
        int outHeight = Math.Max(1, (int)Math.Round(height * scale));

        string data;
        using (var shot = new Bitmap(width, height, PixelFormat.Format24bppRgb))
        {
            using (var g = Graphics.FromImage(shot))
            {
                g.CopyFromScreen(x, y, 0, 0, new Size(width, height), CopyPixelOperation.SourceCopy);
            }
            using (var small = scale < 1.0 ? Shrink(shot, outWidth, outHeight) : null)
            using (var stream = new MemoryStream())
            {
                if (jpeg)
                {
                    // For a captcha service, which caps what it takes: a grid
                    // of photos is several times smaller this way.
                    var quality = new EncoderParameters(1);
                    quality.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 88L);
                    (small ?? shot).Save(stream, JpegCodec(), quality);
                }
                else
                {
                    (small ?? shot).Save(stream, ImageFormat.Png);
                }
                data = Convert.ToBase64String(stream.ToArray());
            }
        }

        var answer = new Dictionary<string, object>();
        answer["data"] = data;
        answer["mediaType"] = jpeg ? "image/jpeg" : "image/png";
        answer["width"] = outWidth;
        answer["height"] = outHeight;
        answer["region"] = new object[] { x, y, width, height };
        answer["scale"] = scale;
        return answer;
    }

    static ImageCodecInfo JpegCodec()
    {
        foreach (var codec in ImageCodecInfo.GetImageEncoders())
        {
            if (codec.FormatID == ImageFormat.Jpeg.Guid) return codec;
        }
        throw new Stop("failed", "This Windows has no JPEG encoder.");
    }

    static Bitmap Shrink(Bitmap source, int width, int height)
    {
        var small = new Bitmap(width, height, PixelFormat.Format24bppRgb);
        using (var g = Graphics.FromImage(small))
        {
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            g.SmoothingMode = SmoothingMode.HighQuality;
            g.DrawImage(source, new Rectangle(0, 0, width, height));
        }
        return small;
    }

    static AutomationElement At(int x, int y)
    {
        try
        {
            return AutomationElement.FromPoint(new WinPoint(x, y));
        }
        catch (Exception)
        {
            return null;
        }
    }

    /// <summary>The same element, or one inside the other: a label in a button is still the button.</summary>
    static bool Related(AutomationElement hit, AutomationElement target)
    {
        try
        {
            if (Automation.Compare(hit, target)) return true;
            TreeWalker walker = TreeWalker.RawViewWalker;
            AutomationElement step = hit;
            for (int level = 0; level < 15 && step != null; level++)
            {
                step = walker.GetParent(step);
                if (step != null && Automation.Compare(step, target)) return true;
            }
            // A hit on one of the target's own containers is a hit on the
            // target: a browser's hit test can stop at the element holding a
            // frame (a captcha's iframe) rather than go into it. Only up to
            // the page itself, though: a document, pane or window that
            // answered could be hiding whatever really sits on top.
            step = target;
            for (int level = 0; level < 10 && step != null; level++)
            {
                step = walker.GetParent(step);
                if (step == null) break;
                ControlType type = step.Current.ControlType;
                if (level >= 3 && (type == ControlType.Document || type == ControlType.Pane || type == ControlType.Window)) break;
                if (Automation.Compare(step, hit)) return true;
            }
        }
        catch (Exception)
        {
            return true; // cannot tell; the click will say what it hit
        }
        return false;
    }

    static string Summary(AutomationElement element)
    {
        try
        {
            AutomationElement step = element;
            for (int level = 0; level < 4 && step != null; level++)
            {
                string name = step.Current.Name;
                string role = step.Current.ControlType.ProgrammaticName.Replace("ControlType.", "").ToLowerInvariant();
                if (!string.IsNullOrEmpty(name)) return role + " \"" + Clip(name.Trim(), 80) + "\"";
                step = TreeWalker.ControlViewWalker.GetParent(step);
            }
        }
        catch (Exception)
        {
        }
        return "something without a name";
    }

    /* ---------------------------------------------------------------- *
     * Moving, clicking, typing
     * ---------------------------------------------------------------- */

    static Dictionary<string, object> Click(Dictionary<string, object> request)
    {
        RequireDriving();
        int x = Number(request, "x", 0);
        int y = Number(request, "y", 0);
        string button = Text(request, "button");
        int count = Math.Max(1, Math.Min(3, Number(request, "count", 1)));
        int glide = Number(request, "glide", 300);
        var modifiers = Combo(Text(request, "modifiers"), true);
        bool natural = Flag(request, "natural");

        ShowOutline(request);
        if (natural)
        {
            Reach(x, y, glide);
            // A hand arrives, then presses.
            Thread.Sleep(60 + Chance.Next(160));
        }
        else
        {
            Glide(x, y, glide);
        }
        Guard();
        Allowed(RootAt(x, y));

        foreach (var key in modifiers) KeyEvent(key, false);
        uint down = button == "right" ? 0x0008u : button == "middle" ? 0x0020u : 0x0002u;
        uint up = button == "right" ? 0x0010u : button == "middle" ? 0x0040u : 0x0004u;
        for (int index = 0; index < count; index++)
        {
            MouseEvent(down, 0);
            Thread.Sleep(natural ? 55 + Chance.Next(75) : 25);
            MouseEvent(up, 0);
            if (index < count - 1) Thread.Sleep(70);
        }
        for (int index = modifiers.Count - 1; index >= 0; index--) KeyEvent(modifiers[index], true);

        Ui(delegate { overlay.Ripple(x, y); overlay.FadeOutline(); });
        Thread.Sleep(Number(request, "settle", 120));
        return After(x, y);
    }

    static Dictionary<string, object> Scroll(Dictionary<string, object> request)
    {
        RequireDriving();
        int x = Number(request, "x", 0);
        int y = Number(request, "y", 0);
        string direction = Text(request, "direction");
        int amount = Math.Max(1, Math.Min(30, Number(request, "amount", 3)));

        ShowOutline(request);
        Glide(x, y, Number(request, "glide", 300));
        Allowed(RootAt(x, y));
        bool sideways = direction == "left" || direction == "right";
        int delta = direction == "down" || direction == "left" ? -120 : 120;
        for (int notch = 0; notch < amount; notch++)
        {
            Guard();
            MouseEvent(sideways ? 0x01000u : 0x0800u, delta);
            Thread.Sleep(40);
        }
        Ui(delegate { overlay.FadeOutline(); });
        Thread.Sleep(100);
        return After(x, y);
    }

    static Dictionary<string, object> Drag(Dictionary<string, object> request)
    {
        RequireDriving();
        int x = Number(request, "x", 0);
        int y = Number(request, "y", 0);
        int toX = Number(request, "toX", 0);
        int toY = Number(request, "toY", 0);
        int glide = Number(request, "glide", 300);

        Glide(x, y, glide);
        Allowed(RootAt(x, y));
        MouseEvent(0x0002, 0);
        try
        {
            Thread.Sleep(50);
            // Slower with the button down: a drag is the move people watch.
            Glide(toX, toY, glide * 2);
            Allowed(RootAt(toX, toY));
            Thread.Sleep(50);
        }
        finally
        {
            // Never left holding the button, whatever stopped the move.
            MouseEvent(0x0004, 0);
        }
        Ui(delegate { overlay.Ripple(toX, toY); });
        Thread.Sleep(100);
        return After(toX, toY);
    }

    static Dictionary<string, object> TypeText(Dictionary<string, object> request)
    {
        RequireDriving();
        string text = Text(request, "text");
        int perSecond = Math.Max(5, Math.Min(400, Number(request, "cps", 30)));
        int pause = 1000 / perSecond;
        IntPtr front = Native.GetForegroundWindow();
        Allowed(front);

        for (int index = 0; index < text.Length; index++)
        {
            Guard();
            // Typing into whatever took the focus meanwhile is worse than stopping.
            if (Native.GetForegroundWindow() != front)
            {
                throw new Stop("focus-moved", "The window in front changed while typing, after " + index + " of " + text.Length + " characters.");
            }
            char letter = text[index];
            if (letter == '\r') continue;
            if (letter == '\n') KeyTap(0x0D);
            else if (letter == '\t') KeyTap(0x09);
            else
            {
                UnicodeEvent(letter, false);
                UnicodeEvent(letter, true);
            }
            Thread.Sleep(pause);
        }
        var answer = new Dictionary<string, object>();
        answer["typed"] = text.Length;
        answer["window"] = Describe(front);
        return answer;
    }

    static Dictionary<string, object> PressKeys(Dictionary<string, object> request)
    {
        RequireDriving();
        IntPtr front = Native.GetForegroundWindow();
        Allowed(front);
        var keys = Combo(Text(request, "keys"), false);
        if (keys.Count == 0) throw new Stop("bad-request", "Name the keys, like \"ctrl+s\" or \"enter\".");
        int repeat = Math.Max(1, Math.Min(50, Number(request, "repeat", 1)));
        for (int time = 0; time < repeat; time++)
        {
            Guard();
            foreach (var key in keys) KeyEvent(key, false);
            Thread.Sleep(20);
            for (int index = keys.Count - 1; index >= 0; index--) KeyEvent(keys[index], true);
            Thread.Sleep(40);
        }
        Thread.Sleep(80);
        var answer = new Dictionary<string, object>();
        IntPtr now = Native.GetForegroundWindow();
        if (now != IntPtr.Zero) answer["window"] = Describe(now);
        return answer;
    }

    /// <summary>What the cursor is on now, and which window is in front: how the agent knows the click landed.</summary>
    static Dictionary<string, object> After(int x, int y)
    {
        var answer = new Dictionary<string, object>();
        AutomationElement under = At(x, y);
        if (under != null) answer["under"] = Summary(under);
        IntPtr front = Native.GetForegroundWindow();
        if (front != IntPtr.Zero) answer["window"] = Describe(front);
        return answer;
    }

    static void ShowOutline(Dictionary<string, object> request)
    {
        object raw;
        if (!request.TryGetValue("rect", out raw)) return;
        var values = raw as System.Collections.IList;
        if (values == null || values.Count != 4) return;
        int x = Convert.ToInt32(values[0]);
        int y = Convert.ToInt32(values[1]);
        int width = Convert.ToInt32(values[2]);
        int height = Convert.ToInt32(values[3]);
        Ui(delegate { overlay.Outline(x, y, width, height); });
    }

    /// <summary>
    /// The real cursor, eased in and out along a shallow bow, so it reads as a
    /// hand reaching rather than a ruler. Longer trips take a little longer,
    /// within reason. Checked for a stop at every step.
    /// </summary>
    static void Glide(int x, int y, int duration)
    {
        Native.POINT from;
        Native.GetCursorPos(out from);
        double dx = x - from.X;
        double dy = y - from.Y;
        double distance = Math.Sqrt(dx * dx + dy * dy);
        if (distance < 3 || duration <= 0)
        {
            MoveTo(x, y);
            return;
        }

        double scale = Math.Max(0.45, Math.Min(1.35, Math.Sqrt(distance / 700.0)));
        int total = (int)(duration * scale);
        int frames = Math.Max(4, total / 10);
        double normalX = -dy / distance;
        double normalY = dx / distance;
        double bow = Math.Min(40.0, distance * 0.08) * (((x + y) & 1) == 0 ? 1 : -1);

        var clock = Stopwatch.StartNew();
        for (int frame = 1; frame <= frames; frame++)
        {
            Guard();
            double t = (double)frame / frames;
            double eased = t < 0.5 ? 4 * t * t * t : 1 - Math.Pow(-2 * t + 2, 3) / 2;
            double arc = Math.Sin(Math.PI * t) * bow;
            MoveTo((int)Math.Round(from.X + dx * eased + normalX * arc), (int)Math.Round(from.Y + dy * eased + normalY * arc));
            int due = (int)(total * t) - (int)clock.ElapsedMilliseconds;
            if (due > 0) Thread.Sleep(due);
        }
        MoveTo(x, y);
    }

    static readonly Random Chance = new Random();

    /// <summary>
    /// The cursor as a hand moves it, for the widgets that judge a person by
    /// how the pointer arrives (a captcha's checkbox): a curve that differs
    /// every time, quick off the mark and slow to settle, a slight tremor on
    /// the way, and on a longer reach a small overshoot put right. Checked for
    /// a stop at every step, like Glide.
    /// </summary>
    static void Reach(int x, int y, int duration, bool correcting = false)
    {
        Native.POINT from;
        Native.GetCursorPos(out from);
        double dx = x - from.X;
        double dy = y - from.Y;
        double distance = Math.Sqrt(dx * dx + dy * dy);
        if (distance < 2 || duration <= 0)
        {
            MoveTo(x, y);
            return;
        }

        int aimX = x;
        int aimY = y;
        bool overshoot = !correcting && distance > 180 && Chance.NextDouble() < 0.55;
        if (overshoot)
        {
            double past = 3 + Chance.NextDouble() * Math.Min(14, distance * 0.025);
            aimX = (int)Math.Round(x + dx / distance * past + (Chance.NextDouble() - 0.5) * 4);
            aimY = (int)Math.Round(y + dy / distance * past + (Chance.NextDouble() - 0.5) * 4);
        }
        double ax = aimX - from.X;
        double ay = aimY - from.Y;
        double normalX = -dy / distance;
        double normalY = dx / distance;
        double spread = Math.Min(90, distance * (0.08 + Chance.NextDouble() * 0.17));
        double side = Chance.NextDouble() < 0.5 ? -1 : 1;
        double f1 = 0.2 + Chance.NextDouble() * 0.2;
        double f2 = 0.6 + Chance.NextDouble() * 0.2;
        double b1 = spread * side * (0.5 + Chance.NextDouble() * 0.5);
        double b2 = spread * side * (Chance.NextDouble() - 0.3) * 0.8;
        double c1x = from.X + ax * f1 + normalX * b1;
        double c1y = from.Y + ay * f1 + normalY * b1;
        double c2x = from.X + ax * f2 + normalX * b2;
        double c2y = from.Y + ay * f2 + normalY * b2;

        double scale = Math.Max(0.5, Math.Min(1.4, Math.Sqrt(distance / 650.0)));
        int total = (int)(duration * scale * (0.85 + Chance.NextDouble() * 0.35));
        if (correcting) total = Math.Max(60, total / 3);
        int frames = Math.Max(6, total / 9);

        var clock = Stopwatch.StartNew();
        for (int frame = 1; frame <= frames; frame++)
        {
            Guard();
            double t = (double)frame / frames;
            double u = Math.Pow(t, 0.8);
            double s = u * u * u * (10 - 15 * u + 6 * u * u);
            double r = 1 - s;
            double px = r * r * r * from.X + 3 * r * r * s * c1x + 3 * r * s * s * c2x + s * s * s * aimX;
            double py = r * r * r * from.Y + 3 * r * r * s * c1y + 3 * r * s * s * c2y + s * s * s * aimY;
            double shake = frame < frames ? r * 0.9 : 0;
            px += (Chance.NextDouble() - 0.5) * 2 * shake;
            py += (Chance.NextDouble() - 0.5) * 2 * shake;
            MoveTo((int)Math.Round(px), (int)Math.Round(py));
            int due = (int)(total * t) - (int)clock.ElapsedMilliseconds;
            if (due > 0) Thread.Sleep(due);
        }
        MoveTo(aimX, aimY);
        if (overshoot)
        {
            Thread.Sleep(40 + Chance.Next(90));
            Reach(x, y, duration, true);
        }
    }

    static void MoveTo(int x, int y)
    {
        int left = Native.GetSystemMetrics(76);
        int top = Native.GetSystemMetrics(77);
        int width = Math.Max(2, Native.GetSystemMetrics(78));
        int height = Math.Max(2, Native.GetSystemMetrics(79));
        var input = new Native.INPUT { type = 0 };
        input.U.mi.dx = (int)Math.Round((x - left) * 65535.0 / (width - 1));
        input.U.mi.dy = (int)Math.Round((y - top) * 65535.0 / (height - 1));
        input.U.mi.dwFlags = 0x0001 | 0x8000 | 0x4000;
        input.U.mi.dwExtraInfo = Mark;
        Send(input);
        lastX = x;
        lastY = y;
    }

    static void MouseEvent(uint flags, int data)
    {
        var input = new Native.INPUT { type = 0 };
        input.U.mi.dwFlags = flags;
        input.U.mi.mouseData = unchecked((uint)data);
        input.U.mi.dwExtraInfo = Mark;
        Send(input);
    }

    static readonly HashSet<ushort> Extended = new HashSet<ushort>
    {
        0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2D, 0x2E, 0x5B, 0x5C, 0x5D, 0x6F, 0x90, 0xA3, 0xA5,
    };

    static void KeyEvent(ushort key, bool up)
    {
        var input = new Native.INPUT { type = 1 };
        input.U.ki.wVk = key;
        input.U.ki.wScan = (ushort)Native.MapVirtualKey(key, 0);
        input.U.ki.dwFlags = (up ? 0x0002u : 0u) | (Extended.Contains(key) ? 0x0001u : 0u);
        input.U.ki.dwExtraInfo = Mark;
        Send(input);
    }

    static void KeyTap(ushort key)
    {
        KeyEvent(key, false);
        Thread.Sleep(15);
        KeyEvent(key, true);
    }

    static void UnicodeEvent(char letter, bool up)
    {
        var input = new Native.INPUT { type = 1 };
        input.U.ki.wScan = letter;
        input.U.ki.dwFlags = 0x0004u | (up ? 0x0002u : 0u);
        input.U.ki.dwExtraInfo = Mark;
        Send(input);
    }

    static void Send(Native.INPUT input)
    {
        Native.SendInput(1, new[] { input }, Marshal.SizeOf(typeof(Native.INPUT)));
    }

    static readonly Dictionary<string, ushort> Named = new Dictionary<string, ushort>
    {
        { "ctrl", 0x11 }, { "control", 0x11 }, { "shift", 0x10 }, { "alt", 0x12 }, { "option", 0x12 },
        { "win", 0x5B }, { "windows", 0x5B }, { "super", 0x5B }, { "meta", 0x5B }, { "cmd", 0x5B },
        { "enter", 0x0D }, { "return", 0x0D }, { "tab", 0x09 }, { "esc", 0x1B }, { "escape", 0x1B },
        { "space", 0x20 }, { "backspace", 0x08 }, { "delete", 0x2E }, { "del", 0x2E }, { "insert", 0x2D },
        { "home", 0x24 }, { "end", 0x23 }, { "pageup", 0x21 }, { "pgup", 0x21 }, { "pagedown", 0x22 },
        { "pgdn", 0x22 }, { "up", 0x26 }, { "down", 0x28 }, { "left", 0x25 }, { "right", 0x27 },
        { "printscreen", 0x2C }, { "capslock", 0x14 }, { "menu", 0x5D }, { "apps", 0x5D },
        { "plus", 0xBB }, { "minus", 0xBD },
    };

    /// <summary>"ctrl+shift+s" as virtual keys, modifiers first as written.</summary>
    static List<ushort> Combo(string text, bool modifiersOnly)
    {
        var keys = new List<ushort>();
        foreach (var raw in text.ToLowerInvariant().Split('+'))
        {
            string part = raw.Trim();
            if (part.Length == 0) continue;
            ushort key;
            if (Named.TryGetValue(part, out key))
            {
                keys.Add(key);
                continue;
            }
            int number;
            if (part.Length > 1 && part[0] == 'f' && int.TryParse(part.Substring(1), out number) && number >= 1 && number <= 24)
            {
                keys.Add((ushort)(0x6F + number));
                continue;
            }
            if (part.Length == 1 && !modifiersOnly)
            {
                short scan = Native.VkKeyScan(part[0]);
                if (scan == -1) throw new Stop("bad-request", "There is no key for \"" + part + "\" on this keyboard layout.");
                if ((scan & 0x0100) != 0) keys.Add(0x10);
                if ((scan & 0x0200) != 0) keys.Add(0x11);
                if ((scan & 0x0400) != 0) keys.Add(0x12);
                keys.Add((ushort)(scan & 0xFF));
                continue;
            }
            throw new Stop("bad-request", "Unknown key \"" + part + "\".");
        }
        return keys;
    }

    /* ---------------------------------------------------------------- *
     * Reading requests
     * ---------------------------------------------------------------- */

    static string Text(Dictionary<string, object> request, string key)
    {
        object value;
        return request.TryGetValue(key, out value) && value != null ? Convert.ToString(value) : "";
    }

    static int Number(Dictionary<string, object> request, string key, int fallback)
    {
        object value;
        if (!request.TryGetValue(key, out value) || value == null) return fallback;
        try
        {
            return Convert.ToInt32(value);
        }
        catch (Exception)
        {
            return fallback;
        }
    }

    static bool Flag(Dictionary<string, object> request, string key)
    {
        object value;
        return request.TryGetValue(key, out value) && value is bool && (bool)value;
    }

    static IntPtr Handle(Dictionary<string, object> request, string key)
    {
        object value;
        if (!request.TryGetValue(key, out value) || value == null) return IntPtr.Zero;
        try
        {
            return new IntPtr(Convert.ToInt64(value));
        }
        catch (Exception)
        {
            return IntPtr.Zero;
        }
    }
}

/// <summary>
/// What the person watching sees besides the cursor: an outline on the
/// target, a ripple where the click lands, and a badge saying who is driving.
/// Layered windows with per-pixel alpha, click-through, never activated, and
/// excluded from capture, so the agent never sees its own markers.
/// </summary>
class Overlay
{
    public enum Tone { Driving, Paused, Stopped }

    static readonly Color Accent = Color.FromArgb(47, 123, 246);

    readonly Layer outline = new Layer();
    readonly Layer ripple = new Layer();
    readonly Layer badge = new Layer();
    readonly System.Windows.Forms.Timer rippleTimer = new System.Windows.Forms.Timer();
    readonly System.Windows.Forms.Timer fadeTimer = new System.Windows.Forms.Timer();
    int rippleFrame;
    int rippleX;
    int rippleY;
    int fadeStep;

    public Overlay()
    {
        rippleTimer.Interval = 22;
        rippleTimer.Tick += delegate { RippleFrame(); };
        fadeTimer.Interval = 30;
        fadeTimer.Tick += delegate { FadeFrame(); };
    }

    static float ScaleAt(int x, int y)
    {
        try
        {
            IntPtr monitor = Native.MonitorFromPoint(new Native.POINT { X = x, Y = y }, 2);
            uint dpiX;
            uint dpiY;
            if (Native.GetDpiForMonitor(monitor, 0, out dpiX, out dpiY) == 0) return dpiX / 96f;
        }
        catch (Exception)
        {
        }
        return 1f;
    }

    static GraphicsPath Rounded(RectangleF box, float radius)
    {
        var path = new GraphicsPath();
        float d = Math.Min(radius * 2, Math.Min(box.Width, box.Height));
        path.AddArc(box.X, box.Y, d, d, 180, 90);
        path.AddArc(box.Right - d, box.Y, d, d, 270, 90);
        path.AddArc(box.Right - d, box.Bottom - d, d, d, 0, 90);
        path.AddArc(box.X, box.Bottom - d, d, d, 90, 90);
        path.CloseFigure();
        return path;
    }

    public void Outline(int x, int y, int width, int height)
    {
        fadeTimer.Stop();
        float scale = ScaleAt(x + width / 2, y + height / 2);
        int margin = (int)Math.Ceiling(6 * scale);
        int w = Math.Max(4, width + margin * 2);
        int h = Math.Max(4, height + margin * 2);
        using (var bitmap = new Bitmap(w, h, PixelFormat.Format32bppArgb))
        {
            using (var g = Graphics.FromImage(bitmap))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                float stroke = 2.5f * scale;
                var box = new RectangleF(margin - 3 * scale, margin - 3 * scale, width + 6 * scale, height + 6 * scale);
                using (var path = Rounded(box, 6 * scale))
                using (var fill = new SolidBrush(Color.FromArgb(34, Accent)))
                using (var pen = new Pen(Color.FromArgb(235, Accent), stroke))
                {
                    g.FillPath(fill, path);
                    g.DrawPath(pen, path);
                }
            }
            outline.Show(bitmap, x - margin, y - margin, 255);
        }
    }

    public void FadeOutline()
    {
        if (!outline.Visible) return;
        fadeStep = 0;
        fadeTimer.Start();
    }

    void FadeFrame()
    {
        fadeStep++;
        int alpha = 255 - fadeStep * 40;
        if (alpha <= 0)
        {
            fadeTimer.Stop();
            outline.Hide();
            return;
        }
        outline.SetAlpha((byte)alpha);
    }

    public void Ripple(int x, int y)
    {
        rippleX = x;
        rippleY = y;
        rippleFrame = 0;
        rippleTimer.Start();
        RippleFrame();
    }

    void RippleFrame()
    {
        const int Frames = 14;
        if (rippleFrame > Frames)
        {
            rippleTimer.Stop();
            ripple.Hide();
            return;
        }
        float scale = ScaleAt(rippleX, rippleY);
        float t = rippleFrame / (float)Frames;
        int size = (int)Math.Ceiling(64 * scale);
        using (var bitmap = new Bitmap(size, size, PixelFormat.Format32bppArgb))
        {
            using (var g = Graphics.FromImage(bitmap))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                float radius = (5 + 21 * (1 - (1 - t) * (1 - t))) * scale;
                int alpha = (int)(230 * (1 - t));
                float c = size / 2f;
                using (var pen = new Pen(Color.FromArgb(alpha, Accent), 2.5f * scale))
                {
                    g.DrawEllipse(pen, c - radius, c - radius, radius * 2, radius * 2);
                }
                if (t < 0.4f)
                {
                    float dot = 4 * scale;
                    using (var fill = new SolidBrush(Color.FromArgb((int)(220 * (1 - t / 0.4f)), Accent)))
                    {
                        g.FillEllipse(fill, c - dot, c - dot, dot * 2, dot * 2);
                    }
                }
            }
            ripple.Show(bitmap, rippleX - size / 2, rippleY - size / 2, 255);
        }
        rippleFrame++;
    }

    public void Badge(string text, Tone tone)
    {
        Screen screen = Screen.PrimaryScreen;
        Rectangle area = screen.WorkingArea;
        float scale = ScaleAt(area.X + area.Width / 2, area.Y + 4);
        using (var font = new Font("Segoe UI Semibold", 13f * scale, FontStyle.Regular, GraphicsUnit.Pixel))
        {
            SizeF measured;
            using (var probe = new Bitmap(1, 1))
            using (var g = Graphics.FromImage(probe))
            {
                measured = g.MeasureString(text, font);
            }
            int height = (int)Math.Ceiling(32 * scale);
            int dot = (int)Math.Ceiling(8 * scale);
            int pad = (int)Math.Ceiling(14 * scale);
            int width = (int)Math.Ceiling(measured.Width) + pad * 2 + dot + (int)(8 * scale);
            using (var bitmap = new Bitmap(width, height, PixelFormat.Format32bppArgb))
            {
                using (var g = Graphics.FromImage(bitmap))
                {
                    g.SmoothingMode = SmoothingMode.AntiAlias;
                    g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
                    using (var path = Rounded(new RectangleF(0.5f, 0.5f, width - 1, height - 1), height / 2f))
                    using (var fill = new SolidBrush(Color.FromArgb(238, 22, 22, 30)))
                    {
                        g.FillPath(fill, path);
                    }
                    Color signal = tone == Tone.Driving ? Accent : tone == Tone.Paused ? Color.FromArgb(245, 158, 11) : Color.FromArgb(239, 68, 68);
                    using (var brush = new SolidBrush(signal))
                    {
                        g.FillEllipse(brush, pad, (height - dot) / 2f, dot, dot);
                    }
                    using (var brush = new SolidBrush(Color.FromArgb(245, 245, 247)))
                    {
                        g.DrawString(text, font, brush, pad + dot + 8 * scale, (height - measured.Height) / 2f);
                    }
                }
                badge.Show(bitmap, area.X + (area.Width - width) / 2, area.Y + (int)(10 * scale), 255);
            }
        }
    }

    public void HideAll()
    {
        rippleTimer.Stop();
        fadeTimer.Stop();
        outline.Hide();
        ripple.Hide();
        badge.Hide();
    }
}

/// <summary>A click-through, never-activated, capture-excluded window showing one bitmap with per-pixel alpha.</summary>
class Layer : NativeWindow
{
    Bitmap last;
    int lastX;
    int lastY;
    public bool Visible;

    public Layer()
    {
        var parameters = new CreateParams();
        parameters.Caption = "";
        parameters.Style = unchecked((int)0x80000000);
        // layered, transparent to the mouse, topmost, off the taskbar, never activated
        parameters.ExStyle = 0x00080000 | 0x00000020 | 0x00000008 | 0x00000080 | 0x08000000;
        parameters.Width = 1;
        parameters.Height = 1;
        CreateHandle(parameters);
        // WDA_EXCLUDEFROMCAPTURE: gone from screenshots, there on screen.
        if (!DesktopHelper.Capturable) Native.SetWindowDisplayAffinity(Handle, 0x11);
    }

    public void Show(Bitmap bitmap, int x, int y, byte alpha)
    {
        if (last != null) last.Dispose();
        last = (Bitmap)bitmap.Clone();
        lastX = x;
        lastY = y;
        Paint(alpha);
        if (!Visible)
        {
            Native.ShowWindow(Handle, 4);
            Visible = true;
        }
    }

    public void SetAlpha(byte alpha)
    {
        if (last != null) Paint(alpha);
    }

    void Paint(byte alpha)
    {
        IntPtr screen = Native.GetDC(IntPtr.Zero);
        IntPtr memory = Native.CreateCompatibleDC(screen);
        IntPtr bits = last.GetHbitmap(Color.FromArgb(0));
        IntPtr previous = Native.SelectObject(memory, bits);
        try
        {
            var size = new Native.SIZE { cx = last.Width, cy = last.Height };
            var source = new Native.POINT { X = 0, Y = 0 };
            var destination = new Native.POINT { X = lastX, Y = lastY };
            var blend = new Native.BLENDFUNCTION { BlendOp = 0, BlendFlags = 0, SourceConstantAlpha = alpha, AlphaFormat = 1 };
            Native.UpdateLayeredWindow(Handle, screen, ref destination, ref size, memory, ref source, 0, ref blend, 2);
        }
        finally
        {
            Native.SelectObject(memory, previous);
            Native.DeleteObject(bits);
            Native.DeleteDC(memory);
            Native.ReleaseDC(IntPtr.Zero, screen);
        }
    }

    public void Hide()
    {
        if (!Visible) return;
        Native.ShowWindow(Handle, 0);
        Visible = false;
    }
}

static class Native
{
    [StructLayout(LayoutKind.Sequential)]
    public struct POINT
    {
        public int X;
        public int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MONITORINFO
    {
        public int cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public uint dwFlags;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct SIZE
    {
        public int cx;
        public int cy;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    public struct BLENDFUNCTION
    {
        public byte BlendOp;
        public byte BlendFlags;
        public byte SourceConstantAlpha;
        public byte AlphaFormat;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT
    {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT
    {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Explicit)]
    public struct InputUnion
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT
    {
        public uint type;
        public InputUnion U;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MSLLHOOKSTRUCT
    {
        public POINT pt;
        public uint mouseData;
        public uint flags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct KBDLLHOOKSTRUCT
    {
        public uint vkCode;
        public uint scanCode;
        public uint flags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    public delegate bool EnumProc(IntPtr window, IntPtr parameter);
    public delegate IntPtr HookProc(int code, IntPtr message, IntPtr data);

    [DllImport("user32.dll")] public static extern IntPtr SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint count, INPUT[] inputs, int size);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint mapType);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern short VkKeyScan(char letter);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr window);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr window, StringBuilder text, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextLength(IntPtr window);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr window, StringBuilder text, int max);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out RECT rect);
    [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr window, uint command);
    [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr window, int index);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc proc, IntPtr parameter);
    [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc proc, IntPtr parameter);
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr window, uint flags);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint attach, uint to, bool on);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out int value, int size);
    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out RECT value, int size);
    [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);
    [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);
    [DllImport("user32.dll")] public static extern bool SetWindowDisplayAffinity(IntPtr window, uint affinity);
    [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr SetWindowsHookEx(int id, HookProc proc, IntPtr module, uint thread);
    [DllImport("user32.dll")] public static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")] public static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr message, IntPtr data);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr GetModuleHandle(string name);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("advapi32.dll", SetLastError = true)] public static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] public static extern bool GetTokenInformation(IntPtr token, int kind, out int value, int length, out int returned);
    [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool UpdateLayeredWindow(IntPtr window, IntPtr destination, ref POINT position, ref SIZE size, IntPtr source, ref POINT sourcePosition, int key, ref BLENDFUNCTION blend, int flags);
    [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr window);
    [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr window, IntPtr context);
    [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleDC(IntPtr context);
    [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr context);
    [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr context, IntPtr handle);
    [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr handle);
    [DllImport("user32.dll")] public static extern IntPtr MonitorFromPoint(POINT point, uint flags);
    [DllImport("shcore.dll")] public static extern int GetDpiForMonitor(IntPtr monitor, int kind, out uint dpiX, out uint dpiY);
}
