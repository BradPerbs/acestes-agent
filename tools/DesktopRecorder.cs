// Teach mode, the helper's half: watching what a PERSON does and reporting it,
// rather than the agent doing anything. See docs/teach-mode.md, src/main/ai/teach.js.
//
// The app turns this on with the `record` command and off again. While it is on,
// the helper reports what the person does on their own screen as event lines, so
// the agent can later learn the workflow:
//
//   window   the foreground window changed to one in scope
//   page     a browser's title changed (a navigation)
//   content  the visible text of a window, once it has settled
//   click    the person clicked a control
//   field    the person left an editable control whose value changed
//   login    the person left a CHANGED password field (site and username, never the password)
//   select   a combo or list selection changed
//   keys     a shortcut or a special key (ctrl+s, enter, tab, esc, f5...)
//
// Two rules are absolute, because a background process that lifts passwords out
// of login forms is a credential stealer whatever it is for:
//
//   A password field (UIA IsPassword true) is never read. Its value never
//   reaches a line, and there is no character buffer anywhere in here. When the
//   person leaves a changed password field, a `login` line carries the site and
//   the username beside it, nothing more.
//
//   Keystrokes are not logged. The keyboard hook recognises only a few non-text
//   keys (Enter, Tab, Esc, the F-keys, and anything held with Ctrl, Alt or Win)
//   as `keys` events. It keeps a bare count of ordinary keypresses, with no idea
//   which keys they were, only so it can tell that a password field was typed
//   into; it never records a character.
//
// Threading. The worker that answers requests must never block, so recording
// runs apart from it. The recorder is an MTA thread with its own IUIAutomation
// instance and its own work queue; the worker only flips flags and starts or
// stops it. The low-level mouse and keyboard hooks and the two WinEvent hooks
// live on the UI thread that runs Application.Run (their callbacks are cheap:
// they post the point, the key or the window to the recorder's queue and
// return). The focus-changed handler is registered on the recorder thread, as
// UI Automation wants. All the reading, and every line emitted, happens on the
// recorder thread.

using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using UIAutomationClient;

static partial class DesktopHelper
{
    /* ---------------------------------------------------------------- *
     * State
     * ---------------------------------------------------------------- */

    // On while a recording is under way. Read by the hooks; the Drive command
    // refuses the desktop while it is set, and this refuses while driving.
    static volatile bool recordingOn;
    static volatile bool recPaused;
    // The foreground window, kept by the WinEvent hook so the name-change hook
    // can tell a browser's title change from any other. IntPtr writes are atomic
    // on the x64 build this ships as.
    static IntPtr recForeground;
    static volatile bool recForegroundIsBrowser;
    // Time since record-on, stamped onto every line.
    static Stopwatch recClock;
    // Lowercase process names in scope; empty means every app.
    static HashSet<string> recApps;
    static string recLabel = "Recording your work";
    static string recPausedLabel = "Recording paused";

    static Thread recThread;
    static BlockingCollection<RecJob> recQueue;
    static ManualResetEventSlim recFlushed;
    static Timer recContentTimer;
    static Timer recPageTimer;

    // A count of ordinary keypresses. Never which keys: only whether a password
    // field was typed into between gaining and losing focus. No character is
    // ever kept.
    static long typeActivity;

    // The recorder thread's own UI Automation, separate from the worker's.
    static IUIAutomation recAutomation;
    static IUIAutomationCondition recControlView;
    static IUIAutomationCacheRequest recPointReq;
    static IUIAutomationCacheRequest recReadReq;
    static IUIAutomationCacheRequest recUrlReq;
    static IUIAutomationCondition recDocCond;
    static IUIAutomationCondition recEditCond;
    static RecFocusHandler recFocusHandler;

    // The field the focus is in now, kept so its value can be compared when the
    // focus leaves it. Touched only on the recorder thread, so no lock.
    static IUIAutomationElement trackedField;
    static string trackedValue;
    static bool trackedIsPwd;
    static string trackedRole = "";
    static string trackedApp = "";
    static string trackedWindow = "";
    static string trackedUser = "";
    static long trackedKeyMark;

    static IntPtr recMouseHook;
    static IntPtr recKeyboardHook;
    static IntPtr recForegroundHookH;
    static IntPtr recNameHookH;
    // Held so the collector never takes a callback Windows still calls.
    static readonly Native.HookProc RecMouseProc = OnRecordMouse;
    static readonly Native.HookProc RecKeyboardProc = OnRecordKeyboard;
    static readonly Native.WinEventDelegate RecForegroundProc = OnRecordForeground;
    static readonly Native.WinEventDelegate RecNameProc = OnRecordName;

    // The browsers a page's URL is read from. Lowercase process names.
    static readonly HashSet<string> Browsers = new HashSet<string>
    {
        "chrome.exe", "msedge.exe", "brave.exe", "firefox.exe", "opera.exe", "vivaldi.exe",
    };

    // What a hit test keeps of what was clicked.
    static readonly int[] RecPointProperties =
    {
        Id.RuntimeId, Id.ControlType, Id.Name, Id.IsPassword, Id.AutomationId, Id.ClassName, Id.ProcessId,
    };

    // What a window's text read keeps of each control.
    static readonly int[] RecReadProperties = { Id.ControlType, Id.Name, Id.Value, Id.IsPassword, Id.HasValue };

    // What a URL read keeps of a document or an address bar.
    static readonly int[] RecUrlProperties = { Id.ControlType, Id.Name, Id.Value };

    // UIA_EditControlTypeId: edit is the fifth control type, after button,
    // calendar, check box and combo box.
    const int EditControlType = 50004;

    const int JobForeground = 1, JobPage = 2, JobContent = 3, JobClick = 4,
        JobFocus = 5, JobEnter = 6, JobKeys = 7, JobStop = 8;

    /// <summary>A piece of work for the recorder thread, left by a hook or a timer.</summary>
    class RecJob
    {
        public int Kind;
        public long T;
        public IntPtr Hwnd;
        public int X;
        public int Y;
        public string Button;
        public IUIAutomationElement Element;
        public uint KeyVk;
        public int KeyMods;
    }

    /* ---------------------------------------------------------------- *
     * The command
     * ---------------------------------------------------------------- */

    /// <summary>
    /// Start, pause or stop recording. `{on:true,apps,label,paused}` starts,
    /// `{pause:true|false}` pauses, `{on:false}` stops. Recording and driving are
    /// exclusive, so a start is refused while the agent drives.
    /// </summary>
    static Dictionary<string, object> Record(Dictionary<string, object> request)
    {
        if (request.ContainsKey("pause")) return RecordPause(Flag(request, "pause"));
        if (Flag(request, "on")) return RecordStart(request);
        return RecordStop();
    }

    static Dictionary<string, object> RecordStart(Dictionary<string, object> request)
    {
        if (driving) throw new Stop("driving", "The agent is driving the desktop. Stop driving before recording.");
        if (recordingOn) throw new Stop("busy", "A recording is already under way.");

        recApps = new HashSet<string>();
        object raw;
        if (request.TryGetValue("apps", out raw))
        {
            var list = raw as System.Collections.IList;
            if (list != null)
            {
                foreach (object each in list)
                {
                    if (each == null) continue;
                    string name = Convert.ToString(each).ToLowerInvariant().Trim();
                    if (name.Length > 0) recApps.Add(name);
                }
            }
        }
        recLabel = Text(request, "label");
        if (recLabel.Length == 0) recLabel = "Recording your work";
        recPausedLabel = Text(request, "paused");
        if (recPausedLabel.Length == 0) recPausedLabel = "Recording paused";

        trackedField = null;
        trackedValue = null;
        trackedIsPwd = false;
        Interlocked.Exchange(ref typeActivity, 0);
        recForeground = IntPtr.Zero;
        recForegroundIsBrowser = false;
        recPaused = false;
        recClock = Stopwatch.StartNew();
        recQueue = new BlockingCollection<RecJob>();
        recContentTimer = new Timer(RecContentDue, null, Timeout.Infinite, Timeout.Infinite);
        recPageTimer = new Timer(RecPageDue, null, Timeout.Infinite, Timeout.Infinite);
        recordingOn = true;

        recThread = new Thread(RecordLoop);
        recThread.IsBackground = true;
        recThread.SetApartmentState(ApartmentState.MTA);
        recThread.Start();

        Ui(delegate
        {
            RecInstallHooks();
            overlay.Badge(recLabel, Overlay.Tone.Recording);
        });

        // The window already in front when recording begins, so its context and
        // its text are the first thing captured.
        IntPtr front = Native.GetForegroundWindow();
        if (front != IntPtr.Zero)
        {
            recForeground = front;
            var job = new RecJob();
            job.Kind = JobForeground;
            job.T = 0;
            job.Hwnd = front;
            RecPost(job);
        }
        return new Dictionary<string, object>();
    }

    static Dictionary<string, object> RecordPause(bool on)
    {
        recPaused = on;
        if (recordingOn)
        {
            Ui(delegate { overlay.Badge(on ? recPausedLabel : recLabel, Overlay.Tone.Recording); });
        }
        var answer = new Dictionary<string, object>();
        answer["paused"] = on;
        return answer;
    }

    static Dictionary<string, object> RecordStop()
    {
        if (!recordingOn)
        {
            // Nothing is recording, but make sure no hook or badge is left over.
            Ui(delegate
            {
                RecRemoveHooks();
                overlay.HideAll();
            });
            return new Dictionary<string, object>();
        }

        // Stop the hooks posting, then ask the recorder to flush the field the
        // focus is still in, so its line is out before this answers ok.
        recordingOn = false;
        recPaused = false;
        var flushed = new ManualResetEventSlim(false);
        recFlushed = flushed;
        var stop = new RecJob();
        stop.Kind = JobStop;
        stop.T = RecNow();
        RecPost(stop);
        flushed.Wait(2000);

        if (recContentTimer != null) { recContentTimer.Dispose(); recContentTimer = null; }
        if (recPageTimer != null) { recPageTimer.Dispose(); recPageTimer = null; }

        Ui(delegate
        {
            RecRemoveHooks();
            overlay.HideAll();
        });

        Thread ending = recThread;
        if (ending != null) ending.Join(2000);
        recThread = null;
        recQueue = null;
        recClock = null;
        return new Dictionary<string, object>();
    }

    /* ---------------------------------------------------------------- *
     * The recorder thread
     * ---------------------------------------------------------------- */

    static void RecordLoop()
    {
        try
        {
            IUIAutomation made;
            try
            {
                made = (IUIAutomation)Activator.CreateInstance(Type.GetTypeFromCLSID(AutomationClass));
            }
            catch (Exception)
            {
                made = (IUIAutomation)Activator.CreateInstance(Type.GetTypeFromCLSID(AutomationClassBefore8));
            }
            var timed = made as IUIAutomation2;
            if (timed != null)
            {
                try
                {
                    timed.ConnectionTimeout = 2000;
                    timed.TransactionTimeout = 10000;
                }
                catch (Exception)
                {
                }
            }
            recAutomation = made;
            recControlView = made.ControlViewCondition;
            recPointReq = Request(made, TreeScope.TreeScope_Element, made.RawViewCondition, RecPointProperties);
            recReadReq = Request(made, TreeScope.TreeScope_Element, recControlView, RecReadProperties);
            recUrlReq = Request(made, TreeScope.TreeScope_Element, recControlView, RecUrlProperties);
            recDocCond = made.CreatePropertyCondition(Id.ControlType, Id.Document);
            recEditCond = made.CreatePropertyCondition(Id.ControlType, EditControlType);
            recFocusHandler = new RecFocusHandler();
            try
            {
                made.AddFocusChangedEventHandler(null, recFocusHandler);
            }
            catch (Exception)
            {
                // Without focus events there are no field or login lines, but the
                // rest of the recording still works.
            }
        }
        catch (Exception error)
        {
            var message = new Dictionary<string, object>();
            message["event"] = "error";
            message["error"] = "The recorder could not start UI Automation: " + error.Message;
            Emit(message);
            var f = recFlushed;
            if (f != null) f.Set();
            return;
        }

        BlockingCollection<RecJob> queue = recQueue;
        if (queue != null)
        {
            foreach (var job in queue.GetConsumingEnumerable())
            {
                try
                {
                    if (job.Kind == JobStop)
                    {
                        RecCommitField(true);
                        var f = recFlushed;
                        if (f != null) f.Set();
                        break;
                    }
                    RecDispatch(job);
                }
                catch (Exception)
                {
                    // One bad job never ends the recording.
                }
            }
        }

        try
        {
            if (recAutomation != null && recFocusHandler != null) recAutomation.RemoveFocusChangedEventHandler(recFocusHandler);
        }
        catch (Exception)
        {
        }
        try
        {
            if (recAutomation != null) recAutomation.RemoveAllEventHandlers();
        }
        catch (Exception)
        {
        }
        recFocusHandler = null;
        recAutomation = null;
        trackedField = null;
    }

    static void RecDispatch(RecJob job)
    {
        if (recPaused) return;
        switch (job.Kind)
        {
            case JobForeground: RecForegroundChanged(job); break;
            case JobPage: RecPageChanged(job); break;
            case JobContent: RecReadContent(job); break;
            case JobClick: RecClicked(job); break;
            case JobFocus: RecFocusMoved(job.Element); break;
            case JobEnter: RecCommitField(false); break;
            case JobKeys: RecKeys(job); break;
        }
    }

    /* ---------------------------------------------------------------- *
     * Windows, pages and content
     * ---------------------------------------------------------------- */

    static void RecForegroundChanged(RecJob job)
    {
        IntPtr window = job.Hwnd;
        string app;
        string title;
        if (!RecInScope(window, out app, out title))
        {
            // Out of scope: the person's own screen, a gap, nothing recorded.
            recForegroundIsBrowser = false;
            return;
        }
        recForeground = window;
        bool browser = Browsers.Contains(app);
        recForegroundIsBrowser = browser;

        var line = RecLine(job.T, "window", app, title);
        if (browser)
        {
            string url = RecBrowserUrl(window);
            if (url.Length > 0) line["url"] = url;
        }
        RecEmit(line);
        RecScheduleContent();
    }

    static void RecPageChanged(RecJob job)
    {
        IntPtr window = recForeground;
        string app;
        string title;
        if (!RecInScope(window, out app, out title)) return;
        if (!Browsers.Contains(app)) return;

        var line = RecLine(job.T, "page", app, title);
        string url = RecBrowserUrl(window);
        if (url.Length > 0) line["url"] = url;
        if (title.Length > 0) line["title"] = title;
        RecEmit(line);
        RecScheduleContent();
    }

    static void RecReadContent(RecJob job)
    {
        IntPtr window = job.Hwnd != IntPtr.Zero ? job.Hwnd : recForeground;
        string app;
        string title;
        if (!RecInScope(window, out app, out title)) return;
        string text = RecContent(window);
        if (text == null || text.Trim().Length == 0) return;
        var line = RecLine(job.T, "content", app, title);
        line["text"] = text;
        RecEmit(line);
    }

    static void RecScheduleContent()
    {
        Timer timer = recContentTimer;
        if (timer == null) return;
        try
        {
            timer.Change(400, Timeout.Infinite);
        }
        catch (Exception)
        {
        }
    }

    static void RecContentDue(object state)
    {
        if (!recordingOn || recPaused) return;
        var job = new RecJob();
        job.Kind = JobContent;
        job.T = RecNow();
        job.Hwnd = recForeground;
        RecPost(job);
    }

    static void RecPageDue(object state)
    {
        if (!recordingOn || recPaused) return;
        var job = new RecJob();
        job.Kind = JobPage;
        job.T = RecNow();
        RecPost(job);
    }

    /* ---------------------------------------------------------------- *
     * Clicks
     * ---------------------------------------------------------------- */

    static void RecClicked(RecJob job)
    {
        IntPtr root = RootAt(job.X, job.Y);
        string app;
        string title;
        if (root == IntPtr.Zero || !RecInScope(root, out app, out title))
        {
            // A click outside scope still leaves a field the person had changed,
            // so flush it, then record nothing about the click itself.
            RecCommitField(false);
            return;
        }

        // A web button that submits a form often does not move the focus, so the
        // field the person just changed is read before the click is recorded.
        RecCommitField(false);

        IUIAutomationElement element = RecElementAt(job.X, job.Y);
        var line = RecLine(job.T, "click", app, title);
        line["button"] = job.Button;
        var target = new Dictionary<string, object>();
        if (element != null)
        {
            string role = RoleOf(CachedInt(element, Id.ControlType, 0));
            target["role"] = role;
            target["name"] = Clip(CachedText(element, Id.Name), 120);
            target["path"] = RecPath(element);
        }
        else
        {
            target["role"] = "";
            target["name"] = "";
            target["path"] = new List<object>();
        }
        line["target"] = target;
        RecEmit(line);
    }

    /* ---------------------------------------------------------------- *
     * Fields, logins and selections
     * ---------------------------------------------------------------- */

    /// <summary>The focus moved: commit the field it left, and start watching the one it reached.</summary>
    static void RecFocusMoved(IUIAutomationElement element)
    {
        RecCommitField(true);
        if (element == null) return;

        string role;
        bool isPwd;
        try
        {
            role = RoleOf(element.CurrentControlType);
            isPwd = element.CurrentIsPassword != 0;
        }
        catch (Exception)
        {
            return;
        }
        bool editable = isPwd || role == "edit" || role == "document" || role == "combo box" || RecHasEditableValue(element);
        if (!editable)
        {
            trackedField = null;
            return;
        }

        IntPtr front = Native.GetForegroundWindow();
        string app;
        string title;
        if (!RecInScope(front, out app, out title))
        {
            trackedField = null;
            return;
        }

        trackedField = element;
        trackedRole = role;
        trackedIsPwd = isPwd;
        trackedApp = app;
        trackedWindow = title;
        if (isPwd)
        {
            // A password field is never read. All that is kept is the username
            // beside it and a mark of how much had been typed, so leaving it can
            // tell whether it was filled in.
            trackedUser = RecNearestUser(element);
            trackedKeyMark = Interlocked.Read(ref typeActivity);
            trackedValue = null;
        }
        else
        {
            string value = RecValue(element);
            trackedValue = value == null ? "" : value;
        }
    }

    /// <summary>
    /// The tracked field, read again: a `field` or `select` line if an ordinary
    /// value changed, a `login` line if a password field was typed into, nothing
    /// otherwise. `clear` drops the field (the focus left it); without it the
    /// field stays watched (a click or Enter read it without moving focus).
    /// </summary>
    static void RecCommitField(bool clear)
    {
        IUIAutomationElement element = trackedField;
        if (element == null) return;
        if (recPaused)
        {
            if (clear) trackedField = null;
            return;
        }
        try
        {
            if (trackedIsPwd)
            {
                long now = Interlocked.Read(ref typeActivity);
                if (now != trackedKeyMark)
                {
                    var line = RecLine(RecNow(), "login", trackedApp, trackedWindow);
                    var target = new Dictionary<string, object>();
                    target["role"] = trackedRole;
                    target["name"] = Clip(RecNameOf(element), 120);
                    line["target"] = target;
                    line["site"] = trackedWindow;
                    line["user"] = trackedUser == null ? "" : trackedUser;
                    if (Browsers.Contains(trackedApp))
                    {
                        string url = RecBrowserUrl(Native.GetForegroundWindow());
                        if (url.Length > 0) line["url"] = url;
                    }
                    // So the main process drops any value whatever happens: a
                    // login line never carries one.
                    line["password"] = true;
                    RecEmit(line);
                }
                trackedKeyMark = now;
            }
            else
            {
                string value = RecValue(element);
                if (value == null) value = "";
                if (value != trackedValue)
                {
                    string type = trackedRole == "combo box" ? "select" : "field";
                    var line = RecLine(RecNow(), type, trackedApp, trackedWindow);
                    var target = new Dictionary<string, object>();
                    target["role"] = trackedRole;
                    target["name"] = Clip(RecNameOf(element), 120);
                    target["path"] = RecPath(element);
                    line["target"] = target;
                    line["value"] = value;
                    RecEmit(line);
                    trackedValue = value;
                }
            }
        }
        catch (Exception)
        {
        }
        if (clear) trackedField = null;
    }

    /// <summary>Whether a control takes a value a person can change: a value pattern that is not read-only.</summary>
    static bool RecHasEditableValue(IUIAutomationElement element)
    {
        try
        {
            var value = element.GetCurrentPattern(Id.ValuePattern) as IUIAutomationValuePattern;
            if (value == null) return false;
            return value.CurrentIsReadOnly == 0;
        }
        catch (Exception)
        {
            return false;
        }
    }

    /// <summary>A control's value, by the value pattern or the text pattern, capped. Never called on a password field.</summary>
    static string RecValue(IUIAutomationElement element)
    {
        try
        {
            var value = element.GetCurrentPattern(Id.ValuePattern) as IUIAutomationValuePattern;
            if (value != null)
            {
                string text = value.CurrentValue;
                return Clip(text == null ? "" : text, 4000);
            }
        }
        catch (Exception)
        {
        }
        try
        {
            var text = element.GetCurrentPattern(Id.TextPattern) as IUIAutomationTextPattern;
            if (text != null)
            {
                string got = text.DocumentRange.GetText(4000);
                return Clip(got == null ? "" : got, 4000);
            }
        }
        catch (Exception)
        {
        }
        return null;
    }

    static string RecNameOf(IUIAutomationElement element)
    {
        try
        {
            string name = element.CurrentName;
            return name == null ? "" : name.Trim();
        }
        catch (Exception)
        {
            return "";
        }
    }

    /// <summary>Up to three named ancestors of a control, nearest first: the path the agent reads it by.</summary>
    static List<object> RecPath(IUIAutomationElement element)
    {
        var path = new List<object>();
        try
        {
            IUIAutomationTreeWalker walker = recAutomation.ControlViewWalker;
            IUIAutomationElement step = walker.GetParentElement(element);
            int depth = 0;
            while (step != null && depth < 3)
            {
                string name = RecNameOf(step);
                if (name.Length > 0) path.Add(Clip(name, 80));
                step = walker.GetParentElement(step);
                depth++;
            }
        }
        catch (Exception)
        {
        }
        return path;
    }

    /// <summary>
    /// The value of the nearest editable field before a password field, as the
    /// username that goes with it: the preceding siblings at the password's level
    /// and a step or two up, each looked into one level. Never a password.
    /// </summary>
    static string RecNearestUser(IUIAutomationElement password)
    {
        try
        {
            IUIAutomationTreeWalker walker = recAutomation.ControlViewWalker;
            IUIAutomationElement node = password;
            for (int up = 0; up < 3 && node != null; up++)
            {
                IUIAutomationElement sibling = walker.GetPreviousSiblingElement(node);
                int scanned = 0;
                while (sibling != null && scanned < 8)
                {
                    string value = RecEditValueIn(sibling, walker);
                    if (value != null && value.Length > 0) return Clip(value, 120);
                    sibling = walker.GetPreviousSiblingElement(sibling);
                    scanned++;
                }
                node = walker.GetParentElement(node);
            }
        }
        catch (Exception)
        {
        }
        return "";
    }

    /// <summary>An element's value, or the first editable value one level inside it: an edit that is not a password.</summary>
    static string RecEditValueIn(IUIAutomationElement element, IUIAutomationTreeWalker walker)
    {
        string direct = RecPlainEditValue(element);
        if (direct != null) return direct;
        try
        {
            IUIAutomationElement child = walker.GetFirstChildElement(element);
            int count = 0;
            while (child != null && count < 10)
            {
                string value = RecPlainEditValue(child);
                if (value != null) return value;
                child = walker.GetNextSiblingElement(child);
                count++;
            }
        }
        catch (Exception)
        {
        }
        return null;
    }

    /// <summary>The value of a non-password edit control, trimmed; null if it is not one or is empty.</summary>
    static string RecPlainEditValue(IUIAutomationElement element)
    {
        try
        {
            if (element.CurrentControlType != EditControlType) return null;
            if (element.CurrentIsPassword != 0) return null;
            var value = element.GetCurrentPattern(Id.ValuePattern) as IUIAutomationValuePattern;
            if (value == null) return null;
            string text = value.CurrentValue;
            if (text == null) return null;
            text = text.Trim();
            return text.Length > 0 ? text : null;
        }
        catch (Exception)
        {
            return null;
        }
    }

    /* ---------------------------------------------------------------- *
     * Keys
     * ---------------------------------------------------------------- */

    static void RecKeys(RecJob job)
    {
        string combo = RecKeysString(job.KeyVk, job.KeyMods);
        if (combo.Length == 0) return;
        IntPtr front = Native.GetForegroundWindow();
        string app;
        string title;
        if (!RecInScope(front, out app, out title)) return;
        var line = RecLine(job.T, "keys", app, title);
        line["keys"] = combo;
        RecEmit(line);
    }

    /// <summary>
    /// A key down the person pressed. A shortcut (anything with Ctrl, Alt or Win)
    /// or a special key (Enter, Tab, Esc, an F-key, an arrow, a page key) becomes
    /// a `keys` event. Enter without a modifier also reads the focused field.
    /// Ordinary keys are only counted, never kept.
    /// </summary>
    static void HandleRecKeyDown(uint vk)
    {
        bool ctrl = (Native.GetAsyncKeyState(0x11) & 0x8000) != 0;
        bool alt = (Native.GetAsyncKeyState(0x12) & 0x8000) != 0;
        bool win = (Native.GetAsyncKeyState(0x5B) & 0x8000) != 0 || (Native.GetAsyncKeyState(0x5C) & 0x8000) != 0;
        bool shift = (Native.GetAsyncKeyState(0x10) & 0x8000) != 0;
        bool combo = ctrl || alt || win;

        if ((combo || RecSpecialKey(vk)) && !RecModifierVk(vk))
        {
            int mods = (ctrl ? 1 : 0) | (alt ? 2 : 0) | (win ? 4 : 0) | (shift ? 8 : 0);
            var job = new RecJob();
            job.Kind = JobKeys;
            job.T = RecNow();
            job.KeyVk = vk;
            job.KeyMods = mods;
            RecPost(job);
        }
        if (vk == 0x0D && !combo)
        {
            var job = new RecJob();
            job.Kind = JobEnter;
            job.T = RecNow();
            RecPost(job);
        }
        if (!combo && RecTextishKey(vk)) Interlocked.Increment(ref typeActivity);
    }

    static string RecKeysString(uint vk, int mods)
    {
        string main = RecMainKeyName(vk);
        if (main.Length == 0) return "";
        var text = new StringBuilder();
        if ((mods & 1) != 0) text.Append("ctrl+");
        if ((mods & 2) != 0) text.Append("alt+");
        if ((mods & 4) != 0) text.Append("win+");
        if ((mods & 8) != 0) text.Append("shift+");
        text.Append(main);
        return text.ToString();
    }

    static string RecMainKeyName(uint vk)
    {
        switch (vk)
        {
            case 0x0D: return "enter";
            case 0x09: return "tab";
            case 0x1B: return "esc";
            case 0x08: return "backspace";
            case 0x2E: return "delete";
            case 0x2D: return "insert";
            case 0x20: return "space";
            case 0x24: return "home";
            case 0x23: return "end";
            case 0x21: return "pageup";
            case 0x22: return "pagedown";
            case 0x25: return "left";
            case 0x26: return "up";
            case 0x27: return "right";
            case 0x28: return "down";
            case 0xBB: return "plus";
            case 0xBD: return "minus";
            case 0xBC: return "comma";
            case 0xBE: return "period";
            case 0xBF: return "slash";
            case 0xDC: return "backslash";
            case 0xBA: return "semicolon";
        }
        if (vk >= 0x70 && vk <= 0x87) return "f" + (int)(vk - 0x6F);
        if (vk >= 0x41 && vk <= 0x5A) return ((char)('a' + (int)(vk - 0x41))).ToString();
        if (vk >= 0x30 && vk <= 0x39) return ((char)vk).ToString();
        if (vk >= 0x60 && vk <= 0x69) return ((char)('0' + (int)(vk - 0x60))).ToString();
        return "";
    }

    /// <summary>A non-text key worth an event on its own: Enter, Tab, Esc, an F-key, an arrow or a page key.</summary>
    static bool RecSpecialKey(uint vk)
    {
        if (vk == 0x0D || vk == 0x09 || vk == 0x1B) return true;
        if (vk >= 0x70 && vk <= 0x87) return true;
        if (vk >= 0x21 && vk <= 0x28) return true;
        if (vk == 0x2D || vk == 0x2E) return true;
        return false;
    }

    static bool RecModifierVk(uint vk)
    {
        return vk == 0x10 || vk == 0x11 || vk == 0x12 || vk == 0x5B || vk == 0x5C || vk == 0x14
            || (vk >= 0xA0 && vk <= 0xA5);
    }

    /// <summary>A key that produces a character, counted so a password field's change can be told, never kept.</summary>
    static bool RecTextishKey(uint vk)
    {
        if (vk >= 0x30 && vk <= 0x5A) return true;
        if (vk == 0x20 || vk == 0x08) return true;
        if (vk >= 0x60 && vk <= 0x6F) return true;
        if (vk >= 0xBA && vk <= 0xC0) return true;
        if (vk >= 0xDB && vk <= 0xDF) return true;
        return false;
    }

    /* ---------------------------------------------------------------- *
     * Reading the screen, for the recorder's own automation
     * ---------------------------------------------------------------- */

    static IUIAutomationElement RecElementAt(int x, int y)
    {
        try
        {
            var point = new tagPOINT();
            point.x = x;
            point.y = y;
            return recAutomation.ElementFromPointBuildCache(point, recPointReq);
        }
        catch (Exception)
        {
            return null;
        }
    }

    /// <summary>A window's visible text, as the text command reads it: the text pattern, the value, or every named thing. Capped at 8,000.</summary>
    static string RecContent(IntPtr window)
    {
        IUIAutomationElement root;
        try
        {
            root = recAutomation.ElementFromHandle(window);
        }
        catch (Exception)
        {
            return "";
        }
        if (root == null) return "";

        string text = null;
        try
        {
            var pattern = root.GetCurrentPattern(Id.TextPattern) as IUIAutomationTextPattern;
            if (pattern != null) text = pattern.DocumentRange.GetText(8000);
        }
        catch (Exception)
        {
        }
        if (string.IsNullOrEmpty(text))
        {
            try
            {
                var pattern = root.GetCurrentPattern(Id.ValuePattern) as IUIAutomationValuePattern;
                if (pattern != null) text = pattern.CurrentValue;
            }
            catch (Exception)
            {
            }
        }
        if (string.IsNullOrEmpty(text)) text = RecFlatten(root);
        if (text == null) text = "";
        return Clip(text, 8000);
    }

    /// <summary>Every named thing inside a window, in reading order, one per line, repeats dropped. Never a password field.</summary>
    static string RecFlatten(IUIAutomationElement root)
    {
        IUIAutomationElementArray all;
        try
        {
            all = root.FindAllBuildCache(TreeScope.TreeScope_Descendants, recControlView, recReadReq);
        }
        catch (Exception)
        {
            return "";
        }
        var lines = new List<string>();
        string last = null;
        int total = 0;
        int count = all == null ? 0 : all.Length;
        for (int index = 0; index < count; index++)
        {
            IUIAutomationElement element = all.GetElement(index);
            if (CachedFlag(element, Id.IsPassword)) continue;
            string role = RoleOf(CachedInt(element, Id.ControlType, 0));
            if (Skipped.Contains(role)) continue;
            string name = CachedText(element, Id.Name);
            string value = role != "link" && CachedFlag(element, Id.HasValue) ? CachedText(element, Id.Value) : "";
            string line = value.Length > 0 && value != name ? (name.Length > 0 ? name + ": " + value : value) : name;
            if (line.Length == 0 || line == last) continue;
            lines.Add(line);
            last = line;
            total += line.Length + 1;
            if (total > 8000) break;
        }
        return string.Join("\n", lines.ToArray());
    }

    /// <summary>A browser's address, from the document's value or the address bar, when it reads as a URL. Empty if none does.</summary>
    static string RecBrowserUrl(IntPtr window)
    {
        try
        {
            IUIAutomationElement root = recAutomation.ElementFromHandle(window);
            if (root == null) return "";
            try
            {
                IUIAutomationElementArray docs = root.FindAllBuildCache(TreeScope.TreeScope_Descendants, recDocCond, recUrlReq);
                int count = docs == null ? 0 : docs.Length;
                for (int index = 0; index < count && index < 4; index++)
                {
                    string value = CachedText(docs.GetElement(index), Id.Value);
                    if (RecLooksUrl(value)) return Clip(value, 2048);
                }
            }
            catch (Exception)
            {
            }
            try
            {
                IUIAutomationElementArray edits = root.FindAllBuildCache(TreeScope.TreeScope_Descendants, recEditCond, recUrlReq);
                int count = edits == null ? 0 : edits.Length;
                for (int index = 0; index < count && index < 10; index++)
                {
                    string value = CachedText(edits.GetElement(index), Id.Value);
                    if (RecLooksUrl(value)) return Clip(value, 2048);
                }
            }
            catch (Exception)
            {
            }
        }
        catch (Exception)
        {
        }
        return "";
    }

    static bool RecLooksUrl(string text)
    {
        if (text == null) return false;
        return text.StartsWith("http://", StringComparison.OrdinalIgnoreCase)
            || text.StartsWith("https://", StringComparison.OrdinalIgnoreCase);
    }

    /* ---------------------------------------------------------------- *
     * Shared helpers
     * ---------------------------------------------------------------- */

    static long RecNow()
    {
        Stopwatch clock = recClock;
        return clock == null ? 0 : clock.ElapsedMilliseconds;
    }

    static void RecPost(RecJob job)
    {
        BlockingCollection<RecJob> queue = recQueue;
        if (queue == null) return;
        try
        {
            queue.Add(job);
        }
        catch (Exception)
        {
            // The queue was finished as recording stopped: the job is dropped.
        }
    }

    /// <summary>A window in scope: its process is in the apps list (or the list is empty) and it is not Acestes itself.</summary>
    static bool RecInScope(IntPtr window, out string app, out string title)
    {
        app = "";
        title = "";
        if (window == IntPtr.Zero || !Native.IsWindow(window)) return false;
        uint pid = PidOf(window);
        if (pid == 0 || Protected.Contains(pid)) return false;
        string name = ProcessOf(window, pid).ToLowerInvariant();
        if (recApps != null && recApps.Count > 0 && !recApps.Contains(name)) return false;
        app = name;
        title = TitleOf(window);
        return true;
    }

    /// <summary>A line with the fields every event shares: the time, the type, and the app and window where they apply.</summary>
    static Dictionary<string, object> RecLine(long t, string type, string app, string window)
    {
        var line = new Dictionary<string, object>();
        line["t"] = (int)t;
        line["type"] = type;
        if (app != null && app.Length > 0) line["app"] = app;
        if (window != null && window.Length > 0) line["window"] = window;
        return line;
    }

    static void RecEmit(Dictionary<string, object> line)
    {
        var message = new Dictionary<string, object>();
        message["event"] = "rec";
        message["line"] = line;
        Emit(message);
    }

    /// <summary>Posted by the focus-changed handler, which runs on a UI Automation thread: queue the work and return.</summary>
    internal static void OnRecFocusEvent(IUIAutomationElement sender)
    {
        if (!recordingOn) return;
        var job = new RecJob();
        job.Kind = JobFocus;
        job.T = RecNow();
        job.Element = sender;
        RecPost(job);
    }

    /* ---------------------------------------------------------------- *
     * The hooks
     * ---------------------------------------------------------------- */

    static void RecInstallHooks()
    {
        IntPtr module = Native.GetModuleHandle(null);
        if (recMouseHook == IntPtr.Zero) recMouseHook = Native.SetWindowsHookEx(14, RecMouseProc, module, 0);
        if (recKeyboardHook == IntPtr.Zero) recKeyboardHook = Native.SetWindowsHookEx(13, RecKeyboardProc, module, 0);
        // WINEVENT_OUTOFCONTEXT (0): the callbacks reach this thread's message loop.
        if (recForegroundHookH == IntPtr.Zero) recForegroundHookH = Native.SetWinEventHook(0x0003, 0x0003, IntPtr.Zero, RecForegroundProc, 0, 0, 0);
        if (recNameHookH == IntPtr.Zero) recNameHookH = Native.SetWinEventHook(0x800C, 0x800C, IntPtr.Zero, RecNameProc, 0, 0, 0);
    }

    static void RecRemoveHooks()
    {
        if (recMouseHook != IntPtr.Zero) { Native.UnhookWindowsHookEx(recMouseHook); recMouseHook = IntPtr.Zero; }
        if (recKeyboardHook != IntPtr.Zero) { Native.UnhookWindowsHookEx(recKeyboardHook); recKeyboardHook = IntPtr.Zero; }
        if (recForegroundHookH != IntPtr.Zero) { Native.UnhookWinEvent(recForegroundHookH); recForegroundHookH = IntPtr.Zero; }
        if (recNameHookH != IntPtr.Zero) { Native.UnhookWinEvent(recNameHookH); recNameHookH = IntPtr.Zero; }
    }

    static IntPtr OnRecordMouse(int code, IntPtr message, IntPtr data)
    {
        if (code >= 0 && recordingOn && !recPaused)
        {
            var info = (Native.MSLLHOOKSTRUCT)Marshal.PtrToStructure(data, typeof(Native.MSLLHOOKSTRUCT));
            // The agent's own input carries the mark; this is only the person's.
            if (info.dwExtraInfo != Mark)
            {
                int kind = message.ToInt32();
                string button = kind == 0x0201 ? "left" : kind == 0x0204 ? "right" : kind == 0x0207 ? "middle" : null;
                if (button != null)
                {
                    var job = new RecJob();
                    job.Kind = JobClick;
                    job.T = RecNow();
                    job.X = info.pt.X;
                    job.Y = info.pt.Y;
                    job.Button = button;
                    RecPost(job);
                }
            }
        }
        return Native.CallNextHookEx(IntPtr.Zero, code, message, data);
    }

    static IntPtr OnRecordKeyboard(int code, IntPtr message, IntPtr data)
    {
        if (code >= 0 && recordingOn && !recPaused)
        {
            var info = (Native.KBDLLHOOKSTRUCT)Marshal.PtrToStructure(data, typeof(Native.KBDLLHOOKSTRUCT));
            if (info.dwExtraInfo != Mark)
            {
                int kind = message.ToInt32();
                bool down = kind == 0x0100 || kind == 0x0104;
                if (down) HandleRecKeyDown(info.vkCode);
            }
        }
        return Native.CallNextHookEx(IntPtr.Zero, code, message, data);
    }

    static void OnRecordForeground(IntPtr hook, uint eventType, IntPtr window, int idObject, int idChild, uint thread, uint time)
    {
        if (!recordingOn) return;
        // EVENT_SYSTEM_FOREGROUND for the window itself (OBJID_WINDOW is 0).
        if (eventType != 0x0003 || idObject != 0 || window == IntPtr.Zero) return;
        recForeground = window;
        recForegroundIsBrowser = false;
        if (recPaused) return;
        var job = new RecJob();
        job.Kind = JobForeground;
        job.T = RecNow();
        job.Hwnd = window;
        RecPost(job);
    }

    static void OnRecordName(IntPtr hook, uint eventType, IntPtr window, int idObject, int idChild, uint thread, uint time)
    {
        if (!recordingOn || recPaused) return;
        // A title change of the window in front, and only a browser's, debounced.
        if (eventType != 0x800C || idObject != 0) return;
        if (window != recForeground || !recForegroundIsBrowser) return;
        Timer timer = recPageTimer;
        if (timer == null) return;
        try
        {
            timer.Change(500, Timeout.Infinite);
        }
        catch (Exception)
        {
        }
    }
}

/// <summary>
/// The sink UI Automation calls when the keyboard focus moves. It does nothing
/// but hand the new element to the recorder thread and return at once, as a
/// UI Automation event handler must.
/// </summary>
class RecFocusHandler : IUIAutomationFocusChangedEventHandler
{
    public void HandleFocusChangedEvent(IUIAutomationElement sender)
    {
        DesktopHelper.OnRecFocusEvent(sender);
    }
}
