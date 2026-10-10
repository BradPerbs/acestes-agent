// Seeing, for the desktop helper (DesktopHelper.cs): a window's controls as
// numbered elements, what is under a point, the text of a page, and captchas,
// all through UI Automation.
//
// The native UI Automation of UIAutomationCore.dll, not the managed
// System.Windows.Automation, which Microsoft no longer develops. The native one
// can be told to give up on an app that stopped answering after seconds, where
// the managed one waited until the app gave up on the whole helper; and it
// knows what newer Windows reports (headings, landmarks, dialogs). Its bindings
// are made at build time from the type library inside Windows itself (see
// tools/UiaInterop.cs and scripts/build-desktop-helper.js) and compiled into the
// exe, so the helper still needs nothing that is not already on the machine.
//
// A read is one call: the window's on-screen controls come back at once, every
// property cached, and are walked here. Asking control by control cost a round
// trip to the app per control, and was two to four times slower on Chrome,
// Teams and Viber. An app that will not hand over its tree in one piece
// (WhatsApp's will not) is still walked control by control.

using System;
using System.Collections.Generic;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using UIAutomationClient;

static partial class DesktopHelper
{
    /* ---------------------------------------------------------------- *
     * UI Automation itself
     * ---------------------------------------------------------------- */

    /// <summary>The property, pattern and control type ids used here, as in UIAutomationClient.h.</summary>
    static class Id
    {
        public const int RuntimeId = 30000, BoundingRectangle = 30001, ProcessId = 30002, ControlType = 30003,
            Name = 30005, AcceleratorKey = 30006, HasKeyboardFocus = 30008, IsEnabled = 30010, AutomationId = 30011,
            ClassName = 30012, IsPassword = 30019, IsOffscreen = 30022, CanExpand = 30028, CanInvoke = 30031,
            HasRange = 30033, CanSelect = 30036, CanToggle = 30041, HasValue = 30043, Value = 30045,
            ValueIsReadOnly = 30046, RangeValue = 30047, RangeMinimum = 30049, RangeMaximum = 30050,
            ScrollPercent = 30055, ScrollViewSize = 30056, ScrollsVertically = 30058, ExpandCollapseState = 30070,
            IsSelected = 30079, ToggleState = 30086, LandmarkType = 30157, LocalizedLandmarkType = 30158,
            HeadingLevel = 30173, IsDialog = 30174;

        public const int ValuePattern = 10002, TextPattern = 10014, ScrollItemPattern = 10017;

        public const int Image = 50006, Document = 50030, Window = 50032, Pane = 50033;

        // HeadingLevel1 is 80051; HeadingLevel_None is 80050.
        public const int HeadingNone = 80050;
    }

    // CUIAutomation8, which can be told how long to wait for an app; CUIAutomation where there is no 8.
    static readonly Guid AutomationClass = new Guid("e22ad333-b25f-460c-83d0-0581107395c9");
    static readonly Guid AutomationClassBefore8 = new Guid("ff48dba4-60ef-4201-aa87-54103eef594e");

    // Everything a read shows, cached with every control so the walk asks the app nothing.
    static readonly int[] ReadProperties =
    {
        Id.RuntimeId, Id.BoundingRectangle, Id.ControlType, Id.Name, Id.AcceleratorKey, Id.HasKeyboardFocus,
        Id.IsEnabled, Id.IsPassword, Id.IsOffscreen, Id.CanExpand, Id.CanInvoke, Id.HasRange, Id.CanSelect,
        Id.CanToggle, Id.HasValue, Id.Value, Id.ValueIsReadOnly, Id.RangeValue, Id.RangeMinimum, Id.RangeMaximum,
        Id.ScrollPercent, Id.ScrollViewSize, Id.ScrollsVertically, Id.ExpandCollapseState, Id.IsSelected,
        Id.ToggleState, Id.LandmarkType, Id.LocalizedLandmarkType, Id.HeadingLevel, Id.IsDialog,
    };

    // What a captcha scan looks at in a frame and its buttons.
    static readonly int[] ScanProperties =
    {
        Id.RuntimeId, Id.BoundingRectangle, Id.ControlType, Id.Name, Id.IsEnabled, Id.IsOffscreen, Id.HasValue,
        Id.Value, Id.IsPassword, Id.CanToggle, Id.ToggleState, Id.AutomationId, Id.ClassName,
    };

    // What a hit test needs of what it hit.
    static readonly int[] PointProperties = { Id.RuntimeId, Id.ControlType, Id.Name, Id.ProcessId };

    static IUIAutomation automation;
    static IUIAutomationCondition controlView;
    static IUIAutomationCacheRequest onScreenTree;
    static IUIAutomationCacheRequest wholeTree;
    static IUIAutomationCacheRequest oneControl;
    static IUIAutomationCacheRequest scanControl;
    static IUIAutomationCacheRequest atPoint;

    /// <summary>UI Automation, made on first use, on the worker thread that every request is handled on.</summary>
    static IUIAutomation Uia()
    {
        if (automation != null) return automation;
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
            // An app that has stopped answering is given up on in seconds:
            // two to reach it, ten for it to answer one request.
            timed.ConnectionTimeout = 2000;
            timed.TransactionTimeout = 10000;
        }
        controlView = made.ControlViewCondition;
        IUIAutomationCondition onScreen = made.CreateAndCondition(controlView, made.CreatePropertyCondition(Id.IsOffscreen, false));
        onScreenTree = Request(made, TreeScope.TreeScope_Subtree, onScreen, ReadProperties);
        wholeTree = Request(made, TreeScope.TreeScope_Subtree, controlView, ReadProperties);
        oneControl = Request(made, TreeScope.TreeScope_Element, controlView, ReadProperties);
        scanControl = Request(made, TreeScope.TreeScope_Element, controlView, ScanProperties);
        atPoint = Request(made, TreeScope.TreeScope_Element, made.RawViewCondition, PointProperties);
        automation = made;
        return made;
    }

    static IUIAutomationCacheRequest Request(IUIAutomation made, TreeScope scope, IUIAutomationCondition filter, int[] properties)
    {
        IUIAutomationCacheRequest request = made.CreateCacheRequest();
        foreach (int property in properties)
        {
            try
            {
                request.AddProperty(property);
            }
            catch (Exception)
            {
                // A property this Windows does not know yet (IsDialog is 1809's): left out.
            }
        }
        request.TreeScope = scope;
        request.TreeFilter = filter;
        return request;
    }

    // UIA_E_TIMEOUT: an app that did not answer within the time set above.
    const int TimedOut = unchecked((int)0x80131505);

    /// <summary>An element or an app that is not there any more, as UI Automation and COM say it.</summary>
    static bool Vanished(COMException error)
    {
        switch (error.ErrorCode)
        {
            case unchecked((int)0x80040201): // UIA_E_ELEMENTNOTAVAILABLE
            case unchecked((int)0x80010108): // RPC_E_DISCONNECTED
            case unchecked((int)0x800706BA): // RPC_S_SERVER_UNAVAILABLE
            case unchecked((int)0x800401FD): // CO_E_OBJNOTCONNECTED
            case unchecked((int)0x80070578): // ERROR_INVALID_WINDOW_HANDLE
                return true;
            default:
                return false;
        }
    }

    /// <summary>Whether a failure means the walk should be tried control by control: not when the app is gone or hung.</summary>
    static bool WorthWalking(COMException error)
    {
        return !Vanished(error) && error.ErrorCode != TimedOut;
    }

    /* ---------------------------------------------------------------- *
     * The numbers
     * ---------------------------------------------------------------- */

    /// <summary>
    /// One agent's numbers. Several conversations can share the desktop, each
    /// working in its own window, and one reading its window must not renumber
    /// what another is about to click. Every request names its owner, and the
    /// worker opens that owner's book before handling it; it handles one
    /// request at a time, so one open book at a time is safe.
    ///
    /// A control keeps its number from read to read, known again by its UI
    /// Automation runtime id. When every read numbered from 1, a number the
    /// agent still held from an earlier read could name a different control
    /// (a "Select" button in one read, a menu's "Minimize" in the next), and
    /// nothing could tell. Now an old number is the same control or none: one
    /// whose control has gone fails as gone, rather than landing elsewhere.
    /// </summary>
    class Book
    {
        public readonly Dictionary<int, IUIAutomationElement> Elements = new Dictionary<int, IUIAutomationElement>();
        public readonly Dictionary<int, IntPtr> Roots = new Dictionary<int, IntPtr>();
        // A control's key (runtime id and role) to its number, and back.
        public readonly Dictionary<string, int> Numbers = new Dictionary<string, int>();
        public readonly Dictionary<int, string> Keys = new Dictionary<int, string>();
        // A number to the read that last saw its control.
        public readonly Dictionary<int, int> Seen = new Dictionary<int, int>();
        public int Counter;
        public int Reads;
    }

    static readonly Dictionary<string, Book> Books = new Dictionary<string, Book>();
    static Book book = new Book();

    static void Open(string owner)
    {
        if (!Books.TryGetValue(owner, out book))
        {
            book = new Book();
            Books[owner] = book;
        }
    }

    // How many reads a number outlives its control's last sighting: long
    // enough for any number the agent may still hold, short enough that a long
    // session does not keep hold of every control it ever saw.
    const int KeepReads = 8;

    /// <summary>The numbers of controls not seen for a while, let go.</summary>
    static void Prune()
    {
        var old = new List<int>();
        foreach (var pair in book.Seen)
        {
            if (book.Reads - pair.Value >= KeepReads) old.Add(pair.Key);
        }
        foreach (int id in old)
        {
            book.Elements.Remove(id);
            book.Roots.Remove(id);
            book.Seen.Remove(id);
            string key;
            if (book.Keys.TryGetValue(id, out key))
            {
                book.Keys.Remove(id);
                book.Numbers.Remove(key);
            }
        }
    }

    /// <summary>A conversation gone: its numbers go with it.</summary>
    static Dictionary<string, object> Forget(string owner)
    {
        Books.Remove(owner);
        return new Dictionary<string, object>();
    }

    static int Register(IUIAutomationElement element, IntPtr root)
    {
        return Register(element, root, KeyOf(element, RoleOf(CachedInt(element, Id.ControlType, 0))));
    }

    /// <summary>
    /// A control's number: the one it already has in this book, found by its
    /// key, or the next one. Either way it now points at the control as just
    /// read. A control with no key gets a number of its own every time.
    /// </summary>
    static int Register(IUIAutomationElement element, IntPtr root, string key)
    {
        int id;
        if (key == null || !book.Numbers.TryGetValue(key, out id))
        {
            id = ++book.Counter;
            if (key != null)
            {
                book.Numbers[key] = id;
                book.Keys[id] = key;
            }
        }
        book.Elements[id] = element;
        book.Roots[id] = root;
        book.Seen[id] = book.Reads;
        return id;
    }

    /// <summary>
    /// What a control is known by from one read to the next: its runtime id,
    /// with its role as a guard against an app that hands one id out twice.
    /// Null when it has no id to give.
    /// </summary>
    static string KeyOf(IUIAutomationElement element, string role)
    {
        var runtime = Cached(element, Id.RuntimeId) as int[];
        if (runtime == null)
        {
            try
            {
                runtime = element.GetRuntimeId();
            }
            catch (Exception)
            {
                return null;
            }
        }
        if (runtime == null || runtime.Length == 0) return null;
        var key = new StringBuilder(role);
        foreach (int part in runtime) key.Append('.').Append(part);
        return key.ToString();
    }

    static IUIAutomationElement Lookup(int id)
    {
        IUIAutomationElement element;
        if (!book.Elements.TryGetValue(id, out element)) throw new Stop("unknown-element", "There is no element " + id + " in your recent reads. Read the screen again.");
        return element;
    }

    /* ---------------------------------------------------------------- *
     * Reading a window
     * ---------------------------------------------------------------- */

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

    static readonly string[] Roles =
    {
        "button", "calendar", "check box", "combo box", "edit", "link", "image", "list item", "list", "menu",
        "menu bar", "menu item", "progress bar", "radio button", "scroll bar", "slider", "spinner", "status bar",
        "tab", "tab item", "text", "tool bar", "tool tip", "tree", "tree item", "custom", "group", "thumb",
        "data grid", "data item", "document", "split button", "window", "pane", "header", "header item", "table",
        "title bar", "separator", "semantic zoom", "app bar",
    };

    /// <summary>A control type as a word: UIA_ButtonControlTypeId (50000) is "button", and so on in order.</summary>
    static string RoleOf(int type)
    {
        int index = type - 50000;
        return index >= 0 && index < Roles.Length ? Roles[index] : "element";
    }

    /// <summary>A control to number on a picture: its number, and where it is on the screen.</summary>
    class Tag
    {
        public int Id;
        public Rectangle Box;
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
        // What this read has listed: a control's key to its name.
        public readonly Dictionary<string, string> Listed = new Dictionary<string, string>();
        // Set for a numbered picture: the controls to box and label.
        public List<Tag> Tags;
    }

    /// <summary>Where a walk starts: a window or an element, and whether its subtree came whole.</summary>
    class Root
    {
        public IUIAutomationElement Element;
        public IntPtr Window;
        public bool Whole;
    }

    static Dictionary<string, object> Tree(Dictionary<string, object> request)
    {
        int limit = Math.Max(20, Math.Min(1500, Number(request, "maxNodes", 500)));
        IntPtr window = Handle(request, "hwnd");
        var state = new WalkState
        {
            Limit = limit,
            // What is scrolled away is counted, not listed: most of a long page
            // is off screen, and listing it made every read several times the
            // size of what the person can see. A minimised window is all off
            // screen, so there it is listed after all.
            Offscreen = Flag(request, "offscreen") || (window != IntPtr.Zero && Native.IsIconic(window)),
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
        }

        var nodes = new List<object>();
        window = ReadWindow(window, Number(request, "under", 0), state, nodes);

        var answer = new Dictionary<string, object>();
        answer["window"] = Describe(window);
        if (state.Find != null)
        {
            if (state.Found != null) answer["found"] = state.Found;
            return answer;
        }
        answer["nodes"] = nodes;
        answer["truncated"] = state.Truncated;
        return answer;
    }

    /// <summary>
    /// A window and whatever the same program has open over it (a menu, a
    /// dialog, a dropdown: windows of their own, which a read of the main
    /// window alone would not show), or the part of one under an element
    /// already read. Walked into nodes; the window read is returned.
    /// </summary>
    static IntPtr ReadWindow(IntPtr window, int under, WalkState state, List<object> nodes)
    {
        var roots = new List<Root>();
        if (under > 0)
        {
            IUIAutomationElement start = Lookup(under);
            window = book.Roots[under];
            roots.Add(Grow(start, window, state));
        }
        else
        {
            if (window == IntPtr.Zero || !Native.IsWindow(window)) throw new Stop("gone", "That window is gone. List the windows again.");
            uint pid = PidOf(window);
            if (Protected.Contains(pid)) throw new Stop("protected", "That is the Acestes window itself, which the agent may not read.");
            IntPtr main = window;
            var popups = new List<IntPtr>();
            Native.EnumWindows(delegate(IntPtr other, IntPtr unused)
            {
                if (other == main || (Native.IsWindowVisible(other) && PidOf(other) == pid && Popup(other, main))) popups.Add(other);
                return true;
            }, IntPtr.Zero);
            foreach (IntPtr each in popups)
            {
                try
                {
                    roots.Add(Grow(each, state));
                }
                catch (COMException)
                {
                    // A popup that closed meanwhile, or will not be read: the
                    // window itself must be, so only its failure goes back.
                    if (each == main) throw;
                }
            }
        }

        if (state.Register) book.Reads++;
        foreach (Root root in roots)
        {
            if (state.Truncated) break;
            Walk(root.Element, root.Window, root.Whole, 0, 0, nodes, state, "");
        }
        if (state.Register) Prune();
        return window;
    }

    /// <summary>A window's controls in one call, or its top alone to be walked control by control when the app will not.</summary>
    static Root Grow(IntPtr window, WalkState state)
    {
        IUIAutomation uia = Uia();
        var root = new Root { Window = window, Whole = true };
        try
        {
            root.Element = uia.ElementFromHandleBuildCache(window, state.Offscreen ? wholeTree : onScreenTree);
        }
        catch (COMException error)
        {
            if (!WorthWalking(error)) throw;
            root.Element = uia.ElementFromHandleBuildCache(window, oneControl);
            root.Whole = false;
        }
        return root;
    }

    /// <summary>The same for the part of a window under an element already read.</summary>
    static Root Grow(IUIAutomationElement element, IntPtr window, WalkState state)
    {
        var root = new Root { Window = window, Whole = true };
        try
        {
            root.Element = element.BuildUpdatedCache(state.Offscreen ? wholeTree : onScreenTree);
        }
        catch (COMException error)
        {
            if (!WorthWalking(error)) throw;
            root.Element = element.BuildUpdatedCache(oneControl);
            root.Whole = false;
        }
        return root;
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

    /// <summary>A control's children: from the cache when its subtree came whole, from the app otherwise.</summary>
    static IUIAutomationElementArray ChildrenOf(IUIAutomationElement element, bool whole)
    {
        return whole
            ? element.GetCachedChildren()
            : element.FindAllBuildCache(TreeScope.TreeScope_Children, controlView, oneControl);
    }

    static void Walk(IUIAutomationElement element, IntPtr root, bool whole, int depth, int shown, List<object> nodes, WalkState state, string above)
    {
        if (state.Truncated) return;
        if (++state.Visited > MaxVisited || nodes.Count >= state.Limit)
        {
            state.Truncated = true;
            return;
        }

        string role = RoleOf(CachedInt(element, Id.ControlType, 0));
        if (Skipped.Contains(role)) return;
        string name = CachedText(element, Id.Name);

        if (state.Find != null)
        {
            string value = CachedFlag(element, Id.IsPassword) ? "" : CachedText(element, Id.Value);
            bool named = name.IndexOf(state.Find, StringComparison.OrdinalIgnoreCase) >= 0
                || value.IndexOf(state.Find, StringComparison.OrdinalIgnoreCase) >= 0;
            if (named && (state.FindRole.Length == 0 || state.FindRole == role || state.FindRole == Shown(element, role)))
            {
                state.Found = new Dictionary<string, object>();
                state.Found["r"] = Shown(element, role);
                state.Found["n"] = Clip(name.Length > 0 ? name : value, 120);
                state.Truncated = true;
                return;
            }
        }

        // An unnamed thing that merely offers an action is usually a wrapper
        // around the real control, which is kept on its own account. Anything
        // that scrolls is kept, to say there is more of it; so is a page's
        // landmark, which says what part of the page this is.
        bool actionable = role != "title bar" && name.Length > 0 && (CachedFlag(element, Id.CanInvoke)
            || CachedFlag(element, Id.CanToggle) || CachedFlag(element, Id.CanExpand) || CachedFlag(element, Id.CanSelect));
        bool keep = Interactive.Contains(role)
            || (Containers.Contains(role) && (name.Length > 0 || depth == 0))
            // A label inside a link or a button mostly repeats its name.
            || (role == "text" && name.Length > 0 && above.IndexOf(name, StringComparison.OrdinalIgnoreCase) < 0)
            || actionable
            || Scrolls(element)
            || CachedInt(element, Id.LandmarkType, 0) != 0;

        int childShown = shown;
        if (keep && state.Register)
        {
            string key = KeyOf(element, role);
            if (key != null)
            {
                string before;
                if (state.Listed.TryGetValue(key, out before))
                {
                    // Reached a second time (a Win32 title bar is, once a menu
                    // has been open): the same control, listed once, with
                    // what is inside it.
                    if (before == name) return;
                    // A different control under the same id, from an app that
                    // breaks the rule that ids are unique: a number of its own.
                    key = null;
                }
                else
                {
                    state.Listed[key] = name;
                }
            }
            int id = Register(element, root, key);
            nodes.Add(Node(element, id, shown, role, name));
            childShown = shown + 1;
            if (state.Tags != null && ((Interactive.Contains(role) && role != "document") || actionable))
            {
                Rectangle box;
                if (CachedBox(element, out box) && !CachedFlag(element, Id.IsOffscreen)) state.Tags.Add(new Tag { Id = id, Box = box });
            }
        }
        if (depth >= MaxDepth) return;

        IUIAutomationElementArray children;
        try
        {
            children = ChildrenOf(element, whole);
        }
        catch (COMException)
        {
            return;
        }
        int count = children == null ? 0 : children.Length;
        int walked = 0;
        int hidden = 0;
        int more = 0;
        string inside = keep && name.Length > 0 ? name : above;
        for (int index = 0; index < count && !state.Truncated; index++)
        {
            IUIAutomationElement child = children.GetElement(index);
            // Off-screen children are skipped before the cap is counted, so a
            // long list scrolled past its first eighty still shows what is in
            // view. (A whole on-screen read has none: they were never sent.)
            if (!state.Offscreen && CachedFlag(child, Id.IsOffscreen))
            {
                hidden++;
                continue;
            }
            if (walked >= MaxChildren)
            {
                more++;
                continue;
            }
            walked++;
            Walk(child, root, whole, depth + 1, childShown, nodes, state, inside);
        }
        if (hidden > 0 && !state.Truncated && state.Register)
        {
            var away = new Dictionary<string, object>();
            away["d"] = childShown;
            away["offscreen"] = hidden;
            nodes.Add(away);
        }
        if (more > 0 && !state.Truncated && state.Register)
        {
            var rest = new Dictionary<string, object>();
            rest["d"] = childShown;
            rest["more"] = more;
            nodes.Add(rest);
        }
    }

    /// <summary>Whether a control scrolls up and down with more than fits in it.</summary>
    static bool Scrolls(IUIAutomationElement element)
    {
        return CachedFlag(element, Id.ScrollsVertically) && CachedDouble(element, Id.ScrollViewSize, 100) < 99.5;
    }

    /// <summary>
    /// The role as the agent reads it: a dialog, a heading and its level, or a
    /// page's landmark (navigation, main, search, form) where the app says so,
    /// rather than the bare control type each of those is built from.
    /// </summary>
    static string Shown(IUIAutomationElement element, string role)
    {
        if (CachedFlag(element, Id.IsDialog)) return "dialog";
        int heading = CachedInt(element, Id.HeadingLevel, Id.HeadingNone);
        if (heading > Id.HeadingNone && heading <= Id.HeadingNone + 9) return "heading " + (heading - Id.HeadingNone);
        int landmark = CachedInt(element, Id.LandmarkType, 0);
        if (landmark != 0)
        {
            string localized = CachedText(element, Id.LocalizedLandmarkType);
            if (localized.Length > 0) return localized.ToLowerInvariant();
            switch (landmark)
            {
                case 80001: return "form";
                case 80002: return "main";
                case 80003: return "navigation";
                case 80004: return "search";
                default: return "region";
            }
        }
        return role;
    }

    static Dictionary<string, object> Node(IUIAutomationElement element, int id, int depth, string role, string name)
    {
        var node = new Dictionary<string, object>();
        node["id"] = id;
        node["d"] = depth;
        node["r"] = Shown(element, role);
        if (name.Length > 0) node["n"] = Clip(name, 120);

        // The start of a long value, and how long it is: a page or a
        // document is read whole with the text command, not in every tree.
        // A link's value is its address, which was most of the value text in
        // a page's tree and is not what anyone clicks by.
        bool password = CachedFlag(element, Id.IsPassword);
        if (!password && role != "link" && CachedFlag(element, Id.HasValue))
        {
            string value = CachedText(element, Id.Value);
            if (value.Length > 0 && value != name)
            {
                node["v"] = Clip(value, 150);
                if (value.Length > 150) node["len"] = value.Length;
            }
        }
        // A slider or a progress bar says where it stands, and between what.
        if (!node.ContainsKey("v") && CachedFlag(element, Id.HasRange))
        {
            object at = Cached(element, Id.RangeValue);
            if (at is double)
            {
                string range = Figure((double)at);
                object low = Cached(element, Id.RangeMinimum);
                object high = Cached(element, Id.RangeMaximum);
                if (low is double && high is double) range += " (" + Figure((double)low) + " to " + Figure((double)high) + ")";
                node["v"] = range;
            }
        }

        var states = new List<string>();
        if (!CachedFlag(element, Id.IsEnabled, true)) states.Add("disabled");
        if (CachedFlag(element, Id.HasKeyboardFocus)) states.Add("focused");
        if (CachedFlag(element, Id.IsOffscreen)) states.Add("offscreen");
        if (password) states.Add("password");
        if (CachedFlag(element, Id.CanToggle))
        {
            object toggle = Cached(element, Id.ToggleState);
            if (toggle is int) states.Add((int)toggle == 1 ? "checked" : (int)toggle == 0 ? "unchecked" : "mixed");
        }
        if (CachedFlag(element, Id.CanExpand))
        {
            object expand = Cached(element, Id.ExpandCollapseState);
            if (expand is int)
            {
                if ((int)expand == 1) states.Add("expanded");
                else if ((int)expand == 0) states.Add("collapsed");
                else if ((int)expand == 2) states.Add("partly expanded");
            }
        }
        if (CachedFlag(element, Id.CanSelect) && CachedFlag(element, Id.IsSelected)) states.Add("selected");
        if (role == "edit" && CachedFlag(element, Id.ValueIsReadOnly)) states.Add("read-only");
        if (Scrolls(element))
        {
            double percent = CachedDouble(element, Id.ScrollPercent, -1);
            if (percent <= 0.5) states.Add("more below");
            else if (percent >= 99.5) states.Add("more above");
            else states.Add("more above and below");
        }
        string shortcut = CachedText(element, Id.AcceleratorKey);
        if (shortcut.Length > 0) states.Add("shortcut " + Clip(shortcut, 30));
        if (states.Count > 0) node["s"] = string.Join(", ", states.ToArray());
        return node;
    }

    static string Figure(double value)
    {
        return Math.Abs(value - Math.Round(value)) < 0.0001
            ? ((long)Math.Round(value)).ToString(System.Globalization.CultureInfo.InvariantCulture)
            : value.ToString("0.##", System.Globalization.CultureInfo.InvariantCulture);
    }

    /* ---------------------------------------------------------------- *
     * Reading the words
     * ---------------------------------------------------------------- */

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
        IUIAutomationElement element;
        if (id > 0)
        {
            element = Lookup(id);
        }
        else
        {
            IntPtr window = Handle(request, "hwnd");
            if (window == IntPtr.Zero || !Native.IsWindow(window)) throw new Stop("gone", "That window is gone. List the windows again.");
            if (Protected.Contains(PidOf(window))) throw new Stop("protected", "That is the Acestes window itself, which the agent may not read.");
            element = Uia().ElementFromHandle(window);
        }
        if (element.CurrentIsPassword != 0) throw new Stop("password", "That is a password field. Its text is not read.");

        string text = null;
        try
        {
            var pattern = element.GetCurrentPattern(Id.TextPattern) as IUIAutomationTextPattern;
            if (pattern != null) text = pattern.DocumentRange.GetText(MaxText);
        }
        catch (COMException)
        {
        }
        if (string.IsNullOrEmpty(text))
        {
            try
            {
                var pattern = element.GetCurrentPattern(Id.ValuePattern) as IUIAutomationValuePattern;
                if (pattern != null) text = pattern.CurrentValue;
            }
            catch (COMException)
            {
            }
        }
        if (string.IsNullOrEmpty(text)) text = Flatten(element);

        var answer = new Dictionary<string, object>();
        answer["text"] = text ?? "";
        answer["length"] = (text ?? "").Length;
        return answer;
    }

    /// <summary>Every named thing inside, in reading order, one per line, repeats dropped.</summary>
    static string Flatten(IUIAutomationElement root)
    {
        IUIAutomationElementArray all = root.FindAllBuildCache(TreeScope.TreeScope_Descendants, controlView, oneControl);
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
    /// numbered in the same book as the reads, so the agent can act on it, and
    /// a control it has already read keeps its number. Also any image named as
    /// a captcha, for the kind that is a picture of letters beside a field.
    /// </summary>
    static Dictionary<string, object> Captchas(Dictionary<string, object> request)
    {
        IntPtr window = Handle(request, "hwnd");
        if (window == IntPtr.Zero || !Native.IsWindow(window)) throw new Stop("gone", "That window is gone. List the windows again.");
        if (Protected.Contains(PidOf(window))) throw new Stop("protected", "That is the Acestes window itself, which the agent may not read.");
        IUIAutomation uia = Uia();
        IUIAutomationElement root = uia.ElementFromHandle(window);
        if (root == null) throw new Stop("gone", "That window cannot be read.");
        object[] bounds = Bounds(window);
        var area = new Rectangle((int)bounds[0], (int)bounds[1], Math.Max(1, (int)bounds[2]), Math.Max(1, (int)bounds[3]));

        IUIAutomationCondition condition = uia.CreateOrCondition(
            uia.CreatePropertyCondition(Id.HasValue, true),
            uia.CreatePropertyCondition(Id.ControlType, Id.Image));
        IUIAutomationElementArray all = root.FindAllBuildCache(TreeScope.TreeScope_Descendants, condition, scanControl);

        var widgets = new List<object>();
        var images = new List<object>();
        int count = all == null ? 0 : all.Length;
        for (int index = 0; index < count; index++)
        {
            IUIAutomationElement element = all.GetElement(index);
            string role = RoleOf(CachedInt(element, Id.ControlType, 0));
            Rectangle box;
            CachedBox(element, out box);
            if (role == "image")
            {
                string name = CachedText(element, Id.Name);
                // The word on its own: "captcha", "CAPTCHA image", but not a
                // solver's logo ("2Captcha") on a page about them.
                if (images.Count >= 5 || !System.Text.RegularExpressions.Regex.IsMatch(name, @"\bcaptcha\b", System.Text.RegularExpressions.RegexOptions.IgnoreCase)) continue;
                var image = new Dictionary<string, object>();
                image["id"] = Register(element, window);
                image["name"] = Clip(name, 80);
                image["rect"] = RectOf(box);
                image["visible"] = Visible(element, box, area);
                images.Add(image);
                continue;
            }
            // A link's value is its address, and a field's is whatever was
            // typed: neither is a frame.
            if (role == "link" || role == "edit" || role == "combo box") continue;
            string url = CachedText(element, Id.Value);
            if (!url.StartsWith("http", StringComparison.OrdinalIgnoreCase)) continue;
            string[] kind = CaptchaKind(url);
            if (kind == null || widgets.Count >= 8) continue;

            var widget = new Dictionary<string, object>();
            widget["kind"] = kind[0];
            widget["part"] = kind[1];
            widget["url"] = Clip(url, 300);
            widget["id"] = Register(element, window);
            widget["rect"] = RectOf(box);
            widget["visible"] = Visible(element, box, area);
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
    static void Inside(IUIAutomationElement frame, IntPtr window, Rectangle area, Dictionary<string, object> widget)
    {
        IUIAutomationElementArray inner;
        try
        {
            inner = frame.FindAllBuildCache(TreeScope.TreeScope_Descendants, controlView, scanControl);
        }
        catch (COMException)
        {
            return;
        }
        var buttons = new List<object>();
        var words = new StringBuilder();
        string last = null;
        int count = inner == null ? 0 : Math.Min(inner.Length, 400);
        for (int index = 0; index < count; index++)
        {
            IUIAutomationElement element = inner.GetElement(index);
            string role = RoleOf(CachedInt(element, Id.ControlType, 0));
            string name = CachedText(element, Id.Name);
            Rectangle box;
            CachedBox(element, out box);
            if (role == "check box")
            {
                if (widget.ContainsKey("checkbox")) continue;
                var check = new Dictionary<string, object>();
                check["id"] = Register(element, window);
                check["name"] = Clip(name, 80);
                check["rect"] = RectOf(box);
                check["state"] = ToggleOf(element);
                check["visible"] = Visible(element, box, area);
                widget["checkbox"] = check;
                continue;
            }
            if (role == "button" && buttons.Count < 30)
            {
                string automationId = CachedText(element, Id.AutomationId);
                string className = CachedText(element, Id.ClassName);
                // An image tile is a button with no name: the solver finds
                // those by looking, so only the named ones are worth listing.
                if (name.Length == 0 && automationId.Length == 0) continue;
                var button = new Dictionary<string, object>();
                button["id"] = Register(element, window);
                button["name"] = Clip(name, 80);
                if (automationId.Length > 0) button["aid"] = automationId;
                if (className.Length > 0) button["cls"] = Clip(className, 120);
                button["rect"] = RectOf(box);
                button["enabled"] = CachedFlag(element, Id.IsEnabled, true);
                button["visible"] = Visible(element, box, area);
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

    static object[] RectOf(Rectangle box)
    {
        return new object[] { box.X, box.Y, box.Width, box.Height };
    }

    /// <summary>On screen for real: not marked off screen, not collapsed to nothing, and inside the window rather than parked far outside it.</summary>
    static bool Visible(IUIAutomationElement element, Rectangle box, Rectangle area)
    {
        if (box.IsEmpty || box.Width < 8 || box.Height < 8) return false;
        if (CachedFlag(element, Id.IsOffscreen)) return false;
        return box.IntersectsWith(area);
    }

    static string ToggleOf(IUIAutomationElement element)
    {
        if (!CachedFlag(element, Id.CanToggle)) return "";
        object toggle = Cached(element, Id.ToggleState);
        if (!(toggle is int)) return "";
        return (int)toggle == 1 ? "checked" : (int)toggle == 0 ? "unchecked" : "mixed";
    }

    /* ---------------------------------------------------------------- *
     * Cached properties
     * ---------------------------------------------------------------- */

    static object Cached(IUIAutomationElement element, int property)
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

    static string CachedText(IUIAutomationElement element, int property)
    {
        var value = Cached(element, property) as string;
        return value == null ? "" : value.Replace('\r', ' ').Replace('\n', ' ').Trim();
    }

    // What an app does not support comes back as a stand-in object, which is
    // none of these types, so it reads as the fallback.
    static bool CachedFlag(IUIAutomationElement element, int property, bool fallback = false)
    {
        object value = Cached(element, property);
        return value is bool ? (bool)value : fallback;
    }

    static int CachedInt(IUIAutomationElement element, int property, int fallback)
    {
        object value = Cached(element, property);
        return value is int ? (int)value : fallback;
    }

    static double CachedDouble(IUIAutomationElement element, int property, double fallback)
    {
        object value = Cached(element, property);
        return value is double ? (double)value : fallback;
    }

    static bool CachedBox(IUIAutomationElement element, out Rectangle box)
    {
        box = Rectangle.Empty;
        try
        {
            tagRECT rect = element.CachedBoundingRectangle;
            if (rect.right <= rect.left || rect.bottom <= rect.top) return false;
            box = Rectangle.FromLTRB(rect.left, rect.top, rect.right, rect.bottom);
            return true;
        }
        catch (Exception)
        {
            return false;
        }
    }

    static string Clip(string text, int length)
    {
        return text.Length <= length ? text : text.Substring(0, length) + "…";
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
            IUIAutomationElement element = Lookup(id);
            IntPtr root = book.Roots[id];
            Allowed(root);
            if (Native.IsWindow(root) && Native.GetForegroundWindow() != root && !Transient(root)) BringForward(root);
            Guard();

            if (element.CurrentIsOffscreen != 0)
            {
                try
                {
                    var scroll = element.GetCurrentPattern(Id.ScrollItemPattern) as IUIAutomationScrollItemPattern;
                    if (scroll != null)
                    {
                        scroll.ScrollIntoView();
                        Thread.Sleep(200);
                    }
                }
                catch (COMException error)
                {
                    if (Vanished(error)) throw;
                }
            }

            tagRECT bounds = element.CurrentBoundingRectangle;
            int width = bounds.right - bounds.left;
            int height = bounds.bottom - bounds.top;
            if (width < 1 || height < 1)
            {
                throw new Stop("no-place", "Element " + id + " has no place on screen: it is hidden, collapsed or scrolled away.");
            }
            tagPOINT point;
            int clickable = 0;
            try
            {
                clickable = element.GetClickablePoint(out point);
            }
            catch (COMException)
            {
                point = new tagPOINT();
            }
            if (clickable == 0)
            {
                point.x = bounds.left + width / 2;
                point.y = bounds.top + height / 2;
            }
            x = point.x;
            y = point.y;

            IUIAutomationElement hit = At(x, y);
            if (hit != null && !Related(hit, element) && !PassesThrough(hit, x, y))
            {
                // The clickable point can be a corner another element overlaps;
                // the middle is the next best guess before giving up.
                int middleX = bounds.left + width / 2;
                int middleY = bounds.top + height / 2;
                IUIAutomationElement middle = At(middleX, middleY);
                if (middle != null && (Related(middle, element) || PassesThrough(middle, middleX, middleY)))
                {
                    x = middleX;
                    y = middleY;
                }
                else
                {
                    throw new Stop("covered", "Element " + id + " is covered by " + Summary(hit) + ". Close or move that first, or read the screen again.");
                }
            }
            answer["rect"] = new object[] { bounds.left, bounds.top, width, height };
            // What is being aimed at, by name, for the card in the corner.
            answer["label"] = Summary(element);
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

    static IUIAutomationElement At(int x, int y)
    {
        try
        {
            var point = new tagPOINT();
            point.x = x;
            point.y = y;
            return Uia().ElementFromPointBuildCache(point, atPoint);
        }
        catch (Exception)
        {
            return null;
        }
    }

    /// <summary>
    /// A hit on Acestes's own corner card, which clicks go straight through:
    /// it covers nothing. What actually takes the click at that point is the
    /// window beneath, and if that is Acestes too, Allowed refuses it later.
    /// </summary>
    static bool PassesThrough(IUIAutomationElement hit, int x, int y)
    {
        int pid = CachedInt(hit, Id.ProcessId, 0);
        return pid != 0 && Protected.Contains((uint)pid) && !Protected.Contains(PidOf(RootAt(x, y)));
    }

    /// <summary>The same element, or one inside the other: a label in a button is still the button.</summary>
    static bool Related(IUIAutomationElement hit, IUIAutomationElement target)
    {
        try
        {
            IUIAutomation uia = Uia();
            if (uia.CompareElements(hit, target) != 0) return true;
            IUIAutomationTreeWalker walker = uia.RawViewWalker;
            IUIAutomationElement step = hit;
            for (int level = 0; level < 15 && step != null; level++)
            {
                step = walker.GetParentElement(step);
                if (step != null && uia.CompareElements(step, target) != 0) return true;
            }
            // A hit on one of the target's own containers is a hit on the
            // target: a browser's hit test can stop at the element holding a
            // frame (a captcha's iframe) rather than go into it. Only up to
            // the page itself, though: a document, pane or window that
            // answered could be hiding whatever really sits on top.
            step = target;
            for (int level = 0; level < 10 && step != null; level++)
            {
                step = walker.GetParentElement(step);
                if (step == null) break;
                int type = step.CurrentControlType;
                if (level >= 3 && (type == Id.Document || type == Id.Pane || type == Id.Window)) break;
                if (uia.CompareElements(step, hit) != 0) return true;
            }
        }
        catch (Exception)
        {
            return true; // cannot tell; the click will say what it hit
        }
        return false;
    }

    static string Summary(IUIAutomationElement element)
    {
        try
        {
            IUIAutomationTreeWalker walker = Uia().ControlViewWalker;
            IUIAutomationElement step = element;
            for (int level = 0; level < 4 && step != null; level++)
            {
                string name = step.CurrentName;
                if (!string.IsNullOrEmpty(name)) return RoleOf(step.CurrentControlType) + " \"" + Clip(name.Trim(), 80) + "\"";
                step = walker.GetParentElement(step);
            }
        }
        catch (Exception)
        {
        }
        return "something without a name";
    }

    /// <summary>The value of the control with the keyboard focus, to watch it fill; null when it has none.</summary>
    static IUIAutomationValuePattern FocusedValue()
    {
        try
        {
            IUIAutomationElement focused = Uia().GetFocusedElement();
            return focused == null ? null : focused.GetCurrentPattern(Id.ValuePattern) as IUIAutomationValuePattern;
        }
        catch (Exception)
        {
            return null;
        }
    }
}
