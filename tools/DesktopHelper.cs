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
//          elements, and what is under a point (DesktopTree.cs); pictures of
//          the screen, numbered like a read when asked; and whether a window
//          has stopped changing
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
using System.Windows.Forms;

/// <summary>An action that stopped on purpose, with a code the caller can act on.</summary>
class Stop : Exception
{
    public readonly string Code;

    public Stop(string code, string message) : base(message)
    {
        Code = code;
    }
}

static partial class DesktopHelper
{
    const string Version = "2";

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
    // The id of the request being handled, 0 between requests.
    static volatile int current;
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
            // A stop that names its request stops that one only: one meant for
            // an action that has just finished must not stop the next.
            if (Text(request, "cmd") == "cancel")
            {
                int target = Number(request, "target", 0);
                if (target == 0 || target == current) cancelled = true;
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
            string owner = Text(request, "owner");
            cancelled = false;
            current = Number(request, "id", 0);
            acting = Actions.Contains(Text(request, "cmd"));
            if (acting) Anchor();
            // A button one agent holds down would turn another agent's
            // move into a drag: let go of it before anyone else acts.
            if (acting && Held() && HeldBy() != owner) LetGo();
            Open(owner);
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
            catch (COMException error)
            {
                if (Vanished(error)) answer = Failure("gone", "That element is gone. Read the screen again.");
                else if (error.ErrorCode == TimedOut) answer = Failure("not-answering", "The app did not answer in time: it may be busy or hung. Try again in a moment, or take a screenshot.");
                else answer = Failure("failed", "UI Automation failed (0x" + error.ErrorCode.ToString("X8") + ").");
            }
            catch (Exception error)
            {
                answer = Failure("failed", error.Message);
            }
            acting = false;
            current = 0;
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
            case "move": return Move(request);
            case "button": return Button(request);
            case "letgo": return LetGo(request);
            case "settle": return Settle(request);
            case "clipboard": return ReadClipboard();
            case "drive": return Drive(request);
            case "place": return Place(request);
            case "forget": return Forget(Text(request, "whose"));
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
            // The turn is over: nothing is left held down for the person.
            LetGo();
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

    static readonly HashSet<string> Actions = new HashSet<string> { "focus", "launch", "target", "click", "type", "keys", "scroll", "drag", "place", "move", "button" };

    // How long after the person answers in Acestes (a click or a key there)
    // their hand is still settling: moving the mouse then is the tail of
    // that answer, not a reach to take over.
    const long GraceMs = 1500;
    static readonly Stopwatch Clock = Stopwatch.StartNew();
    static long graceUntil;

    static bool InGrace()
    {
        return Clock.ElapsedMilliseconds < Interlocked.Read(ref graceUntil);
    }

    static void StartGrace()
    {
        Interlocked.Exchange(ref graceUntil, Clock.ElapsedMilliseconds + GraceMs);
    }

    /// <summary>
    /// Where the person's hand is now is where a move is measured from. Set
    /// as each action starts, so a hand that went off to answer a card and
    /// rests somewhere else is not read, a pixel later, as a leap away from
    /// wherever the agent last left the cursor.
    /// </summary>
    static void Anchor()
    {
        Native.POINT point;
        if (!Native.GetCursorPos(out point)) return;
        lastX = point.X;
        lastY = point.Y;
    }

    /// <summary>
    /// The person's input, by the rule the badge promises. Clicking or typing
    /// into Acestes is the person answering the agent (a card, a question, a
    /// message), not taking over. Anywhere else it is. Moving the mouse only
    /// counts while an action is under way; between actions it is someone
    /// reaching for the Acestes window. For a moment after an answer in
    /// Acestes, moving does not count either: the hand that clicked Allow is
    /// still coming off the button.
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
                    if (InGrace())
                    {
                        // Settling, not reaching: measure from where it settles.
                        lastX = info.pt.X;
                        lastY = info.pt.Y;
                    }
                    // A hand resting on a mouse drifts a pixel or two; a hand
                    // reaching for it does not stop there.
                    else if (acting && Math.Abs(info.pt.X - lastX) + Math.Abs(info.pt.Y - lastY) > 8) TakeOver("mouse");
                }
                else if (Protected.Contains(PidOf(RootAt(info.pt.X, info.pt.Y))))
                {
                    StartGrace();
                }
                else
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
                if (down)
                {
                    if (Protected.Contains(PidOf(Native.GetForegroundWindow()))) StartGrace();
                    else TakeOver("keyboard");
                }
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
        LetGoLater();
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
        LetGoLater();
        var message = new Dictionary<string, object>();
        message["event"] = "escape";
        EmitLater(message);
    }

    /// <summary>From a hook: a button the agent held is let go, but not on the thread that has to answer Windows quickly.</summary>
    static void LetGoLater()
    {
        if (Held()) ThreadPool.QueueUserWorkItem(delegate { LetGo(); });
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

    /// <summary>
    /// A window moved and sized to part of a monitor's working area: a half,
    /// a quarter, the middle, or all of it. Several agents working side by
    /// side each get their own part of the screen, so reaching into one never
    /// covers another. The size asked for is the size seen: Windows 10 and
    /// later draw an invisible resize border around a window, which is added
    /// back so neighbours meet edge to edge.
    /// </summary>
    static Dictionary<string, object> Place(Dictionary<string, object> request)
    {
        RequireDriving();
        IntPtr window = Handle(request, "hwnd");
        if (window == IntPtr.Zero || !Native.IsWindow(window)) throw new Stop("gone", "That window is gone. List the windows again.");
        Allowed(window);

        string slot = Text(request, "slot").ToLowerInvariant();
        Rectangle area = ScreenFor(window, Text(request, "monitor")).WorkingArea;
        int halfWidth = area.Width / 2;
        int halfHeight = area.Height / 2;
        Rectangle target;
        switch (slot)
        {
            case "left": target = new Rectangle(area.X, area.Y, halfWidth, area.Height); break;
            case "right": target = new Rectangle(area.X + halfWidth, area.Y, area.Width - halfWidth, area.Height); break;
            case "top": target = new Rectangle(area.X, area.Y, area.Width, halfHeight); break;
            case "bottom": target = new Rectangle(area.X, area.Y + halfHeight, area.Width, area.Height - halfHeight); break;
            case "top-left": target = new Rectangle(area.X, area.Y, halfWidth, halfHeight); break;
            case "top-right": target = new Rectangle(area.X + halfWidth, area.Y, area.Width - halfWidth, halfHeight); break;
            case "bottom-left": target = new Rectangle(area.X, area.Y + halfHeight, halfWidth, area.Height - halfHeight); break;
            case "bottom-right": target = new Rectangle(area.X + halfWidth, area.Y + halfHeight, area.Width - halfWidth, area.Height - halfHeight); break;
            case "center": target = new Rectangle(area.X + area.Width / 8, area.Y + area.Height / 10, area.Width * 3 / 4, area.Height * 4 / 5); break;
            case "full": case "maximize": target = area; break;
            default: throw new Stop("bad-request", "Unknown place \"" + slot + "\".");
        }

        // A maximised or minimised window ignores a new size until restored.
        if (Native.IsIconic(window) || Native.IsZoomed(window))
        {
            Native.ShowWindow(window, 9);
            Thread.Sleep(150);
        }
        if (slot == "maximize")
        {
            Native.SetWindowPos(window, IntPtr.Zero, target.X, target.Y, target.Width, target.Height, 0x0004 | 0x0010);
            Native.ShowWindow(window, 3);
        }
        else
        {
            Native.RECT outer;
            Native.GetWindowRect(window, out outer);
            object[] seen = Bounds(window);
            int left = (int)seen[0] - outer.Left;
            int top = (int)seen[1] - outer.Top;
            int right = outer.Right - ((int)seen[0] + (int)seen[2]);
            int bottom = outer.Bottom - ((int)seen[1] + (int)seen[3]);
            Native.SetWindowPos(window, IntPtr.Zero,
                target.X - left, target.Y - top, target.Width + left + right, target.Height + top + bottom,
                0x0004 | 0x0010);
        }
        Thread.Sleep(120);

        var answer = new Dictionary<string, object>();
        answer["window"] = Describe(window);
        answer["bounds"] = Bounds(window);
        return answer;
    }

    /// <summary>The window's own monitor, the primary one, or the nth from the left.</summary>
    static Screen ScreenFor(IntPtr window, string monitor)
    {
        if (monitor == "primary") return Screen.PrimaryScreen;
        int number;
        if (int.TryParse(monitor, out number))
        {
            var screens = new List<Screen>(Screen.AllScreens);
            screens.Sort((a, b) => a.Bounds.X != b.Bounds.X ? a.Bounds.X.CompareTo(b.Bounds.X) : a.Bounds.Y.CompareTo(b.Bounds.Y));
            if (number < 1 || number > screens.Count) throw new Stop("bad-request", "There are " + screens.Count + " monitors; number them from 1, left to right.");
            return screens[number - 1];
        }
        return Screen.FromHandle(window);
    }

    /// <summary>
    /// A popup that opens over an app and closes as soon as anything else is
    /// activated: a menu, a dropdown list, a tooltip, a flyout. It is already
    /// over the window that opened it, and must be left where it is: Windows
    /// will not activate a menu, and the last resort of BringForward, a tap of
    /// Alt, is the very key that dismisses one, which made every menu item
    /// unclickable by number.
    /// </summary>
    static bool Transient(IntPtr window)
    {
        string type = ClassOf(window);
        if (type == "#32768" || type == "ComboLBox" || type == "tooltips_class32" || type == "Xaml_WindowedPopupClass") return true;
        int style = Native.GetWindowLong(window, -16);
        int extended = Native.GetWindowLong(window, -20);
        // WS_EX_NOACTIVATE: never meant to be the active window.
        if ((extended & 0x08000000) != 0) return true;
        // WS_POPUP with WS_EX_TOPMOST and WS_EX_TOOLWINDOW: how most dropdowns are made.
        if ((style & unchecked((int)0x80000000)) != 0 && (extended & 0x00000008) != 0 && (extended & 0x00000080) != 0) return true;
        // While an app has a menu open, nothing of its own is brought forward over it.
        IntPtr front = Native.GetForegroundWindow();
        return front != IntPtr.Zero && PidOf(front) == PidOf(window) && InMenu();
    }

    /// <summary>Whether the thread in front is in a menu: a menu bar's, a popup's or the system menu.</summary>
    static bool InMenu()
    {
        var info = new Native.GUITHREADINFO();
        info.cbSize = Marshal.SizeOf(typeof(Native.GUITHREADINFO));
        if (!Native.GetGUIThreadInfo(0, ref info)) return false;
        // GUI_INMENUMODE, GUI_SYSTEMMENUMODE, GUI_POPUPMENUMODE
        return (info.flags & 0x1Cu) != 0;
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

        // A numbered picture: the window read afresh first, so every number
        // drawn is one the agent can act on now, and the read goes back with
        // the picture. The model sees where things are and still clicks by
        // number, rather than guessing at pixels.
        WalkState numbered = null;
        List<object> nodes = null;
        if (Flag(request, "marks") && region == null)
        {
            numbered = new WalkState
            {
                Limit = Math.Max(20, Math.Min(1500, Number(request, "maxNodes", 300))),
                Register = true,
                Tags = new List<Tag>(),
            };
            nodes = new List<object>();
            ReadWindow(window, 0, numbered, nodes);
            // A number is drawn only where the control shows: where another
            // app's window lies over it, the picture shows that window, and a
            // number there would name something the picture does not show.
            // Acestes is left out of pictures, so what it covers still shows.
            uint pid = PidOf(window);
            numbered.Tags.RemoveAll(delegate(Tag tag)
            {
                uint over = PidOf(RootAt(tag.Box.X + tag.Box.Width / 2, tag.Box.Y + tag.Box.Height / 2));
                return over != pid && !Protected.Contains(over);
            });
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
        int drawn = 0;
        using (var shot = new Bitmap(width, height, PixelFormat.Format24bppRgb))
        {
            using (var g = Graphics.FromImage(shot))
            {
                g.CopyFromScreen(x, y, 0, 0, new Size(width, height), CopyPixelOperation.SourceCopy);
            }
            using (var small = scale < 1.0 ? Shrink(shot, outWidth, outHeight) : null)
            using (var stream = new MemoryStream())
            {
                // Drawn at the size the model sees, so the numbers stay sharp.
                if (numbered != null) drawn = DrawTags(small ?? shot, numbered.Tags, x, y, scale);
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
        if (numbered != null)
        {
            answer["window"] = Describe(window);
            answer["nodes"] = nodes;
            answer["truncated"] = numbered.Truncated;
            answer["marked"] = drawn;
        }
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

    // The colours numbers are drawn in, in turn, so that neighbouring boxes
    // tell apart. Each dark enough for white digits.
    static readonly Color[] TagColors =
    {
        Color.FromArgb(220, 38, 38), Color.FromArgb(21, 128, 61), Color.FromArgb(37, 99, 235), Color.FromArgb(194, 65, 12),
        Color.FromArgb(126, 34, 206), Color.FromArgb(15, 118, 110), Color.FromArgb(190, 24, 93), Color.FromArgb(67, 56, 202),
    };

    // A picture with more numbers than this is mostly numbers; the read that
    // comes with it lists every one.
    const int MaxTags = 150;

    /// <summary>
    /// Each control in a numbered picture boxed, with its number on a tag at a
    /// corner: the box's top left, or failing that just above it, its top
    /// right or its left, wherever it does not sit on a tag already drawn.
    /// Returns how many were drawn.
    /// </summary>
    static int DrawTags(Bitmap picture, List<Tag> tags, int left, int top, double scale)
    {
        int drawn = 0;
        var frame = new RectangleF(0, 0, picture.Width, picture.Height);
        var placed = new List<RectangleF>();
        using (var g = Graphics.FromImage(picture))
        using (var font = new Font("Segoe UI", 11f, FontStyle.Bold, GraphicsUnit.Pixel))
        using (var format = (StringFormat)StringFormat.GenericTypographic.Clone())
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
            foreach (Tag tag in tags)
            {
                if (drawn >= MaxTags) break;
                var box = new RectangleF((float)((tag.Box.X - left) * scale), (float)((tag.Box.Y - top) * scale),
                    (float)(tag.Box.Width * scale), (float)(tag.Box.Height * scale));
                if (box.Width < 3 || box.Height < 3 || !box.IntersectsWith(frame)) continue;
                Color color = TagColors[tag.Id % TagColors.Length];
                using (var pen = new Pen(Color.FromArgb(220, color), 1.5f))
                {
                    g.DrawRectangle(pen, box.X, box.Y, box.Width, box.Height);
                }
                string label = tag.Id.ToString(System.Globalization.CultureInfo.InvariantCulture);
                float width = g.MeasureString(label, font, PointF.Empty, format).Width + 6;
                const float Height = 15;
                RectangleF chosen = RectangleF.Empty;
                foreach (PointF corner in new[] { new PointF(box.X, box.Y), new PointF(box.X, box.Y - Height), new PointF(box.Right - width, box.Y), new PointF(box.X - width, box.Y) })
                {
                    var spot = new RectangleF(Math.Max(0, Math.Min(frame.Width - width, corner.X)), Math.Max(0, Math.Min(frame.Height - Height, corner.Y)), width, Height);
                    if (!placed.Exists(other => other.IntersectsWith(spot)))
                    {
                        chosen = spot;
                        break;
                    }
                }
                if (chosen.IsEmpty) chosen = new RectangleF(Math.Max(0, Math.Min(frame.Width - width, box.X)), Math.Max(0, Math.Min(frame.Height - Height, box.Y)), width, Height);
                using (var fill = new SolidBrush(Color.FromArgb(235, color)))
                using (var ink = new SolidBrush(Color.White))
                {
                    g.FillRectangle(fill, chosen);
                    g.DrawString(label, font, ink, chosen.X + 3, chosen.Y + 1, format);
                }
                placed.Add(chosen);
                drawn++;
            }
        }
        return drawn;
    }

    /* ---------------------------------------------------------------- *
     * Seeing: when a window is still
     * ---------------------------------------------------------------- */

    const int ThumbWidth = 96;
    const int ThumbHeight = 64;

    /// <summary>
    /// Until a window stops changing on screen, for at most `max` ms, so that
    /// whatever an action set off (a dialog opening, a page loading, a menu
    /// sliding out) has finished before anyone looks. Watched as a small grey
    /// thumbnail, taken every 70 ms: two alike, but for a caret's blink, and it
    /// is still. Acestes's own windows are left out of it, since its chat keeps
    /// moving while an agent works and may lie over the window.
    /// </summary>
    static Dictionary<string, object> Settle(Dictionary<string, object> request)
    {
        IntPtr window = Handle(request, "hwnd");
        int max = Math.Max(100, Math.Min(5000, Number(request, "max", 1500)));
        var clock = Stopwatch.StartNew();
        int[] last = null;
        bool still = false;
        while (true)
        {
            IntPtr target = window != IntPtr.Zero && Native.IsWindow(window) && !Native.IsIconic(window) ? window : Native.GetForegroundWindow();
            int[] now = Thumbnail(target);
            if (now == null) break;
            if (last != null && Alike(last, now))
            {
                still = true;
                break;
            }
            last = now;
            if (clock.ElapsedMilliseconds >= max) break;
            Thread.Sleep(70);
        }
        var answer = new Dictionary<string, object>();
        answer["settled"] = still;
        answer["ms"] = (int)clock.ElapsedMilliseconds;
        return answer;
    }

    /// <summary>A window's pixels averaged down into a small grey thumbnail, with -1 wherever an Acestes window lies over it. Null when it is on no screen.</summary>
    static int[] Thumbnail(IntPtr window)
    {
        if (window == IntPtr.Zero) return null;
        object[] edges = Bounds(window);
        var area = new Rectangle((int)edges[0], (int)edges[1], (int)edges[2], (int)edges[3]);
        area.Intersect(new Rectangle(Native.GetSystemMetrics(76), Native.GetSystemMetrics(77), Native.GetSystemMetrics(78), Native.GetSystemMetrics(79)));
        if (area.Width < 8 || area.Height < 8) return null;

        var grey = new int[ThumbWidth * ThumbHeight];
        using (var small = new Bitmap(ThumbWidth, ThumbHeight, PixelFormat.Format32bppRgb))
        {
            using (var g = Graphics.FromImage(small))
            {
                IntPtr into = g.GetHdc();
                IntPtr from = Native.GetDC(IntPtr.Zero);
                try
                {
                    // HALFTONE: each thumbnail pixel the average of what it covers.
                    Native.SetStretchBltMode(into, 4);
                    Native.SetBrushOrgEx(into, 0, 0, IntPtr.Zero);
                    Native.StretchBlt(into, 0, 0, ThumbWidth, ThumbHeight, from, area.X, area.Y, area.Width, area.Height, 0x00CC0020);
                }
                finally
                {
                    Native.ReleaseDC(IntPtr.Zero, from);
                    g.ReleaseHdc(into);
                }
            }
            BitmapData bits = small.LockBits(new Rectangle(0, 0, ThumbWidth, ThumbHeight), ImageLockMode.ReadOnly, PixelFormat.Format32bppRgb);
            try
            {
                var row = new byte[bits.Stride];
                for (int y = 0; y < ThumbHeight; y++)
                {
                    Marshal.Copy(new IntPtr(bits.Scan0.ToInt64() + (long)y * bits.Stride), row, 0, bits.Stride);
                    for (int x = 0; x < ThumbWidth; x++)
                    {
                        int at = x * 4;
                        grey[y * ThumbWidth + x] = (row[at] * 29 + row[at + 1] * 150 + row[at + 2] * 77) >> 8;
                    }
                }
            }
            finally
            {
                small.UnlockBits(bits);
            }
        }

        foreach (IntPtr other in ProtectedWindows())
        {
            object[] bounds = Bounds(other);
            var cover = new Rectangle((int)bounds[0], (int)bounds[1], (int)bounds[2], (int)bounds[3]);
            cover.Intersect(area);
            if (cover.Width <= 0 || cover.Height <= 0) continue;
            int x0 = (cover.Left - area.Left) * ThumbWidth / area.Width;
            int x1 = ((cover.Right - area.Left) * ThumbWidth + area.Width - 1) / area.Width;
            int y0 = (cover.Top - area.Top) * ThumbHeight / area.Height;
            int y1 = ((cover.Bottom - area.Top) * ThumbHeight + area.Height - 1) / area.Height;
            for (int y = Math.Max(0, y0); y < Math.Min(ThumbHeight, y1); y++)
            {
                for (int x = Math.Max(0, x0); x < Math.Min(ThumbWidth, x1); x++) grey[y * ThumbWidth + x] = -1;
            }
        }
        return grey;
    }

    /// <summary>The visible top-level windows of the protected processes: Acestes, and this helper's own overlays.</summary>
    static List<IntPtr> ProtectedWindows()
    {
        var found = new List<IntPtr>();
        Native.EnumWindows(delegate(IntPtr window, IntPtr unused)
        {
            if (Native.IsWindowVisible(window) && Protected.Contains(PidOf(window))) found.Add(window);
            return true;
        }, IntPtr.Zero);
        return found;
    }

    /// <summary>Two thumbnails alike: at most two pixels changed by more than a shade, which is all a blinking caret changes.</summary>
    static bool Alike(int[] before, int[] after)
    {
        int changed = 0;
        for (int index = 0; index < before.Length; index++)
        {
            if (before[index] < 0 || after[index] < 0) continue;
            if (Math.Abs(before[index] - after[index]) > 12 && ++changed > 2) return false;
        }
        return true;
    }

    /* ---------------------------------------------------------------- *
     * Seeing: the clipboard
     * ---------------------------------------------------------------- */

    /// <summary>
    /// What is on the clipboard: its text, the files copied, and whether it
    /// holds a picture. Never what a password manager put there: they mark
    /// their copies to be kept out of clipboard history and monitoring, and a
    /// copy marked so is refused whole. Read on a thread of its own, since the
    /// clipboard wants a thread that waits on nothing else.
    /// </summary>
    static Dictionary<string, object> ReadClipboard()
    {
        var answer = new Dictionary<string, object>();
        Exception failure = null;
        var reader = new Thread(delegate()
        {
            for (int attempt = 0; attempt < 5; attempt++)
            {
                try
                {
                    failure = null;
                    IDataObject data = Clipboard.GetDataObject();
                    if (data == null) return;
                    if (Concealed(data))
                    {
                        answer["private"] = true;
                        return;
                    }
                    string text = data.GetData(DataFormats.UnicodeText) as string ?? data.GetData(DataFormats.Text) as string;
                    if (text != null) answer["text"] = text;
                    var files = data.GetData(DataFormats.FileDrop) as string[];
                    if (files != null && files.Length > 0) answer["files"] = files;
                    if (data.GetDataPresent(DataFormats.Bitmap) || data.GetDataPresent(DataFormats.Dib)) answer["image"] = true;
                    return;
                }
                catch (ExternalException error)
                {
                    // Another app has it open this very moment.
                    failure = error;
                    Thread.Sleep(50);
                }
            }
        });
        reader.SetApartmentState(ApartmentState.STA);
        reader.IsBackground = true;
        reader.Start();
        if (!reader.Join(5000)) throw new Stop("busy", "The clipboard did not answer. Try again in a moment.");
        if (failure != null) throw new Stop("busy", "Another app is holding the clipboard. Try again in a moment.");
        return answer;
    }

    /// <summary>A copy its maker asked to keep private: out of clipboard history, the cloud clipboard, and anything watching.</summary>
    static bool Concealed(IDataObject data)
    {
        if (data.GetDataPresent("ExcludeClipboardContentFromMonitorProcessing")) return true;
        if (data.GetDataPresent("Clipboard Viewer Ignore")) return true;
        foreach (string format in new[] { "CanIncludeInClipboardHistory", "CanUploadToCloudClipboard" })
        {
            if (!data.GetDataPresent(format)) continue;
            var stream = data.GetData(format) as MemoryStream;
            if (stream == null) continue;
            byte[] bytes = stream.ToArray();
            if (bytes.Length >= 4 && BitConverter.ToInt32(bytes, 0) == 0) return true;
        }
        return false;
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
        int glide = Number(request, "glide", 300);
        List<Native.POINT> path = PathOf(request);
        if (path != null) return Trace(path, glide);

        int x = Number(request, "x", 0);
        int y = Number(request, "y", 0);
        int toX = Number(request, "toX", 0);
        int toY = Number(request, "toY", 0);

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

    /// <summary>A drag's path, as [[x, y], ...] in screen pixels; null when it has none.</summary>
    static List<Native.POINT> PathOf(Dictionary<string, object> request)
    {
        object raw;
        var points = request.TryGetValue("path", out raw) ? raw as System.Collections.IList : null;
        if (points == null) return null;
        var path = new List<Native.POINT>();
        foreach (object each in points)
        {
            var pair = each as System.Collections.IList;
            if (pair == null || pair.Count != 2) throw new Stop("bad-request", "Each point of a path is [x, y].");
            path.Add(new Native.POINT { X = Convert.ToInt32(pair[0]), Y = Convert.ToInt32(pair[1]) });
        }
        if (path.Count < 2) throw new Stop("bad-request", "A path needs two points at least.");
        return path;
    }

    /// <summary>
    /// A drag through every point of a path, in straight lines from one to the
    /// next at an even speed, the way a hand draws: a signature, a shape in
    /// Paint, a slider dragged and then dragged back. Unlike Glide it does not
    /// ease or bow, since the shape is the point. The button is let go at the
    /// end, or wherever it was stopped.
    /// </summary>
    static Dictionary<string, object> Trace(List<Native.POINT> path, int glide)
    {
        foreach (Native.POINT point in path) Allowed(RootAt(point.X, point.Y));
        double length = 0;
        for (int index = 1; index < path.Count; index++) length += Distance(path[index - 1], path[index]);
        // About a pixel a millisecond at the usual pace, within reason.
        int duration = (int)Math.Max(300, Math.Min(8000, length * glide / 300.0));

        Glide(path[0].X, path[0].Y, glide);
        Guard();
        MouseEvent(0x0002, 0);
        Native.timeBeginPeriod(1);
        try
        {
            Thread.Sleep(50);
            var clock = Stopwatch.StartNew();
            double travelled = 0;
            for (int index = 1; index < path.Count; index++)
            {
                Native.POINT from = path[index - 1];
                Native.POINT to = path[index];
                double segment = Distance(from, to);
                int steps = Math.Max(1, (int)Math.Ceiling(segment / 6));
                for (int step = 1; step <= steps; step++)
                {
                    Guard();
                    double t = (double)step / steps;
                    MoveTo((int)Math.Round(from.X + (to.X - from.X) * t), (int)Math.Round(from.Y + (to.Y - from.Y) * t));
                    double due = length > 0 ? (travelled + segment * t) / length * duration : 0;
                    int ahead = (int)(due - clock.Elapsed.TotalMilliseconds);
                    if (ahead > 0) Thread.Sleep(ahead);
                }
                travelled += segment;
            }
            Thread.Sleep(50);
        }
        finally
        {
            MouseEvent(0x0004, 0);
            Native.timeEndPeriod(1);
        }
        Native.POINT end = path[path.Count - 1];
        Ui(delegate { overlay.Ripple(end.X, end.Y); });
        Thread.Sleep(100);
        return After(end.X, end.Y);
    }

    static double Distance(Native.POINT a, Native.POINT b)
    {
        double dx = b.X - a.X;
        double dy = b.Y - a.Y;
        return Math.Sqrt(dx * dx + dy * dy);
    }

    /// <summary>The cursor to a place and left there: a hover, for tooltips, menus that open on it, and buttons that only show under it.</summary>
    static Dictionary<string, object> Move(Dictionary<string, object> request)
    {
        RequireDriving();
        int x = Number(request, "x", 0);
        int y = Number(request, "y", 0);
        ShowOutline(request);
        Glide(x, y, Number(request, "glide", 300));
        Guard();
        Allowed(RootAt(x, y));
        Ui(delegate { overlay.FadeOutline(); });
        return After(x, y);
    }

    // Mouse buttons an agent pressed and has not let go yet, as the flags that
    // let them go, and whose they are.
    static readonly object HeldLock = new object();
    static uint heldUps;
    static string heldBy = "";

    static bool Held()
    {
        lock (HeldLock) return heldUps != 0;
    }

    static string HeldBy()
    {
        lock (HeldLock) return heldBy;
    }

    /// <summary>
    /// A mouse button pressed, or let go, by itself: for a press held while
    /// something else happens, or a gesture made in parts. Moves there first
    /// when given a place. A button left down is let go at the end of the
    /// turn, when the person takes over, or before another agent acts.
    /// </summary>
    static Dictionary<string, object> Button(Dictionary<string, object> request)
    {
        RequireDriving();
        string which = Text(request, "button");
        bool down = Flag(request, "down");
        uint press = which == "right" ? 0x0008u : which == "middle" ? 0x0020u : 0x0002u;
        uint release = which == "right" ? 0x0010u : which == "middle" ? 0x0040u : 0x0004u;
        if (request.ContainsKey("x") && request.ContainsKey("y"))
        {
            ShowOutline(request);
            Glide(Number(request, "x", 0), Number(request, "y", 0), Number(request, "glide", 300));
            Guard();
        }
        Native.POINT at;
        Native.GetCursorPos(out at);
        Allowed(RootAt(at.X, at.Y));
        if (down)
        {
            MouseEvent(press, 0);
            lock (HeldLock)
            {
                heldUps |= release;
                heldBy = Text(request, "owner");
            }
        }
        else
        {
            MouseEvent(release, 0);
            lock (HeldLock)
            {
                heldUps &= ~release;
                if (heldUps == 0) heldBy = "";
            }
            Ui(delegate { overlay.Ripple(at.X, at.Y); });
        }
        Ui(delegate { overlay.FadeOutline(); });
        Thread.Sleep(80);
        return After(at.X, at.Y);
    }

    /// <summary>Every button an agent left down, let go: one agent's when it names an owner, anyone's otherwise.</summary>
    static Dictionary<string, object> LetGo(Dictionary<string, object> request)
    {
        string owner = Text(request, "owner");
        if (owner.Length == 0 || HeldBy() == owner) LetGo();
        return new Dictionary<string, object>();
    }

    static void LetGo()
    {
        uint ups;
        lock (HeldLock)
        {
            ups = heldUps;
            heldUps = 0;
            heldBy = "";
        }
        foreach (uint flag in new[] { 0x0004u, 0x0010u, 0x0040u })
        {
            if ((ups & flag) != 0) MouseEvent(flag, 0);
        }
    }

    // The most keys a second typing goes at, as in the Mac helper. computer.js
    // reckons the time it allows a long text by the same figure.
    const int MaxCps = 400;

    static Dictionary<string, object> TypeText(Dictionary<string, object> request)
    {
        RequireDriving();
        string text = Text(request, "text");
        int perSecond = Math.Max(5, Math.Min(MaxCps, Number(request, "cps", 30)));
        double pause = 1000.0 / perSecond;
        IntPtr front = Native.GetForegroundWindow();
        Allowed(front);

        // Each key is timed against a clock, with a sleep only while ahead of
        // it. A sleep is never shorter than a tick of the system timer, 15.6 ms
        // unless the process asks for finer, so one sleep per key held typing
        // near 64 keys a second whatever the pace, and long text outran the
        // time the app allowed it. The timer is made fine while typing, too, so
        // a quick pace comes out even rather than in bursts.
        Native.timeBeginPeriod(1);
        var clock = Stopwatch.StartNew();
        double due = 0;
        int index = 0;
        try
        {
            for (; index < text.Length; index++)
            {
                Guard();
                // Typing into whatever took the focus meanwhile is worse than stopping.
                if (Native.GetForegroundWindow() != front) throw new Stop("focus-moved", "The window in front changed while typing.");
                char letter = text[index];
                if (letter == '\r') continue;
                if (letter == '\n') KeyTap(0x0D);
                else if (letter == '\t') KeyTap(0x09);
                else
                {
                    UnicodeEvent(letter, false);
                    UnicodeEvent(letter, true);
                }
                // The same average pace, never the same gap twice: a metronome
                // reads as a machine, a rhythm as someone typing.
                double spread;
                lock (Chance) spread = 0.55 + Chance.NextDouble() * 0.9;
                due += pause * spread;
                int ahead = (int)(due - clock.Elapsed.TotalMilliseconds);
                if (ahead > 0) Thread.Sleep(ahead);
            }
            if (perSecond > 100) CatchUp();
        }
        catch (Stop stop)
        {
            // Whatever stopped it, how much went in is what the agent needs next.
            throw new Stop(stop.Code, stop.Message + " " + index + " of " + text.Length + " characters were typed.");
        }
        finally
        {
            Native.timeEndPeriod(1);
        }
        var answer = new Dictionary<string, object>();
        answer["typed"] = text.Length;
        answer["window"] = Describe(front);
        return answer;
    }

    /// <summary>
    /// After fast typing, until the control with the focus has taken in what
    /// it was sent. An app can fall behind keys that arrive hundreds a second:
    /// Character Map was 115 short of 1,350 when typing at 400 a second ended,
    /// and level half a second later, so a read straight after showed a field
    /// missing text that was still on its way. The value is watched until it
    /// holds still, for two seconds at most; a control with no value to watch
    /// gets a moment instead.
    /// </summary>
    static void CatchUp()
    {
        var value = FocusedValue();
        if (value == null)
        {
            Thread.Sleep(400);
            return;
        }
        int last = -1;
        var clock = Stopwatch.StartNew();
        while (clock.ElapsedMilliseconds < 2000)
        {
            int length;
            try
            {
                length = (value.CurrentValue ?? "").Length;
            }
            catch (Exception)
            {
                return;
            }
            if (length == last) return;
            last = length;
            Thread.Sleep(120);
        }
    }

    static Dictionary<string, object> PressKeys(Dictionary<string, object> request)
    {
        RequireDriving();
        IntPtr front = Native.GetForegroundWindow();
        Allowed(front);
        var keys = Combo(Text(request, "keys"), false);
        if (keys.Count == 0) throw new Stop("bad-request", "Name the keys, like \"ctrl+s\" or \"enter\".");
        int hold = Math.Max(0, Math.Min(10000, Number(request, "hold", 0)));
        if (hold > 0)
        {
            // Held down for a while: a game's arrow, a key that does something
            // only while it is down. Windows does not repeat a key a program
            // presses, so held text keys type once.
            foreach (var key in keys) KeyEvent(key, false);
            try
            {
                var clock = Stopwatch.StartNew();
                while (clock.ElapsedMilliseconds < hold)
                {
                    Guard();
                    Thread.Sleep((int)Math.Min(50, Math.Max(1, hold - clock.ElapsedMilliseconds)));
                }
            }
            finally
            {
                // Never left holding a key, whatever stopped the wait.
                for (int index = keys.Count - 1; index >= 0; index--) KeyEvent(keys[index], true);
            }
        }
        int repeat = hold > 0 ? 0 : Math.Max(1, Math.Min(50, Number(request, "repeat", 1)));
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
        var under = At(x, y);
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
    public struct GUITHREADINFO
    {
        public int cbSize;
        public uint flags;
        public IntPtr hwndActive;
        public IntPtr hwndFocus;
        public IntPtr hwndCapture;
        public IntPtr hwndMenuOwner;
        public IntPtr hwndMoveSize;
        public IntPtr hwndCaret;
        public RECT rcCaret;
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
    [DllImport("user32.dll")] public static extern bool GetGUIThreadInfo(uint thread, ref GUITHREADINFO info);
    [DllImport("winmm.dll")] public static extern uint timeBeginPeriod(uint period);
    [DllImport("winmm.dll")] public static extern uint timeEndPeriod(uint period);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr window);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr window);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
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
    [DllImport("gdi32.dll")] public static extern int SetStretchBltMode(IntPtr context, int mode);
    [DllImport("gdi32.dll")] public static extern bool SetBrushOrgEx(IntPtr context, int x, int y, IntPtr previous);
    [DllImport("gdi32.dll")] public static extern bool StretchBlt(IntPtr destination, int x, int y, int width, int height, IntPtr source, int sourceX, int sourceY, int sourceWidth, int sourceHeight, uint operation);
    [DllImport("user32.dll")] public static extern IntPtr MonitorFromPoint(POINT point, uint flags);
    [DllImport("shcore.dll")] public static extern int GetDpiForMonitor(IntPtr monitor, int kind, out uint dpiX, out uint dpiY);
}
