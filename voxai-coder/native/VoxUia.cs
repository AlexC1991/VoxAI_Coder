// voxai-uia.exe: Windows UI Automation for VoxAI Coder's desktop control (the controls in a window, by name).
// Ported from Byte (Desktop3D, native/ByteUia.cs) without its teach-mode recorder (low-level keyboard and
// mouse hooks) and its game focus guard, which VoxAI does not use. Adds per-monitor DPI awareness.
//
// One JSON request per line on stdin, one JSON reply per line on stdout, each with the request's "seq".
//   {"cmd":"list","hwnd":123,"find":"","max":60}   -> {"window":"...","elements":[{id,type,name,value,rect:[x,y,w,h],focused,enabled,can:[...]}]}
//   {"cmd":"act","id":7,"action":"invoke"}          -> {"done":"invoke"} or {"click":[x,y]} when only a click will do
//   {"cmd":"act","id":7,"action":"set_text","text":"hi"} -> {"done":"set"} or {"type":true} (focused: the host types)
//   {"cmd":"focused"}                               -> {"type":"Edit","name":"Message"}
// Never reads a password box's contents and never writes to one. Rects are physical screen pixels.
// Built from source by scripts/build-uia.js with the C# compiler that ships with Windows (.NET Framework 4).

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Automation;
using System.Runtime.InteropServices;

static class ByteUia
{
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 8000000 };
    static readonly Dictionary<int, AutomationElement> ById = new Dictionary<int, AutomationElement>();
    // ids stay the same for the same control across lists of one window, so the model can act on several controls
    // from one list (right-click folder 4, then 5, then 7) without listing again after every step
    static readonly Dictionary<string, int> IdByRuntime = new Dictionary<string, int>();
    static readonly Dictionary<int, string> NameById = new Dictionary<int, string>();   // to find a control again after a redraw
    static int nextId = 1;
    static IntPtr listRoot = IntPtr.Zero;   // the window of the last list (Byte's own pointer posts into it)

    static readonly HashSet<ControlType> Interactive = new HashSet<ControlType> {
        ControlType.Button, ControlType.Edit, ControlType.CheckBox, ControlType.RadioButton, ControlType.ComboBox,
        ControlType.ListItem, ControlType.MenuItem, ControlType.TabItem, ControlType.Hyperlink, ControlType.TreeItem,
        ControlType.Slider, ControlType.SplitButton, ControlType.Spinner, ControlType.DataItem, ControlType.Document,
        ControlType.Menu, ControlType.MenuBar };

    [STAThread]
    static void Main()
    {
        // Real pixels on a scaled display, matching the app's input and screenshots.
        try { Native.SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { }
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
        // Chromium (Chrome, Brave, Edge, Electron) only builds a page's accessibility tree when a UI Automation
        // client is listening for events: listen for focus changes (and do nothing with them) so web pages show up.
        Automation.AddAutomationFocusChangedEventHandler((s, e) => { });
        string line;
        while ((line = Console.ReadLine()) != null)
        {
            if (line.Length == 0) continue;
            object seq = null;
            Dictionary<string, object> reply;
            try
            {
                var req = Json.Deserialize<Dictionary<string, object>>(line);
                req.TryGetValue("seq", out seq);
                reply = Handle(req);
            }
            catch (Exception e)
            {
                var inner = e.InnerException ?? e;
                string message = string.IsNullOrWhiteSpace(e.Message) ? inner.GetType().Name + " (the window changed: list it again)" : e.Message;
                reply = new Dictionary<string, object> { { "error", message }, { "kind", inner.GetType().Name }, { "code", "0x" + inner.HResult.ToString("X8") } };
            }
            reply["seq"] = seq;
            Write(reply);
        }
    }

    static readonly object OutLock = new object();
    /** One JSON line on stdout: a reply, or (while teaching) an event the recorder saw. */
    public static void Write(Dictionary<string, object> line)
    {
        lock (OutLock) { Console.WriteLine(Json.Serialize(line)); Console.Out.Flush(); }
    }

    static string Str(Dictionary<string, object> req, string key)
    {
        object v;
        return req.TryGetValue(key, out v) && v != null ? Convert.ToString(v) : "";
    }

    static int Int(Dictionary<string, object> req, string key, int fallback)
    {
        object v;
        if (!req.TryGetValue(key, out v) || v == null) return fallback;
        try { return Convert.ToInt32(v); } catch { return fallback; }
    }

    // "near": [x, y, w, h] in screen pixels: only controls overlapping that area (what a hover just revealed)
    static Rect Near(Dictionary<string, object> req)
    {
        object v;
        if (!req.TryGetValue("near", out v) || v == null) return Rect.Empty;
        try
        {
            var a = (System.Collections.IList)v;
            if (a.Count != 4) return Rect.Empty;
            double w = Convert.ToDouble(a[2]), h = Convert.ToDouble(a[3]);
            return w > 0 && h > 0 ? new Rect(Convert.ToDouble(a[0]), Convert.ToDouble(a[1]), w, h) : Rect.Empty;
        }
        catch { return Rect.Empty; }
    }

    static Dictionary<string, object> Handle(Dictionary<string, object> req)
    {
        switch (Str(req, "cmd"))
        {
            case "list": return List(new IntPtr(Convert.ToInt64(req["hwnd"])), Str(req, "find"), Int(req, "max", 60), Str(req, "only") == "menu", Near(req));
            case "act": return Act(Int(req, "id", 0), Str(req, "action"), Str(req, "text"));
            case "focused": return Focused();
            case "ping": return new Dictionary<string, object> { { "pong", true } };
            default: throw new Exception("unknown command");
        }
    }

    static string Clip(string s, int n)
    {
        if (string.IsNullOrEmpty(s)) return "";
        s = s.Replace("\r", " ").Replace("\n", " ").Trim();
        return s.Length > n ? s.Substring(0, n - 1) + "…" : s;
    }

    static string TypeName(ControlType t) { return t.ProgrammaticName.Replace("ControlType.", ""); }

    static Dictionary<string, object> Describe(AutomationElement e, int id)
    {
        var c = e.Current;
        Rect r = c.BoundingRectangle;
        var can = new List<string>();
        object p;
        if (e.TryGetCurrentPattern(InvokePattern.Pattern, out p)) can.Add("invoke");
        if (e.TryGetCurrentPattern(TogglePattern.Pattern, out p)) can.Add("toggle");
        if (e.TryGetCurrentPattern(SelectionItemPattern.Pattern, out p)) can.Add("select");
        if (e.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out p)) can.Add("expand");
        string value = "";
        if (!c.IsPassword && e.TryGetCurrentPattern(ValuePattern.Pattern, out p))
        {
            var vp = (ValuePattern)p;
            if (!vp.Current.IsReadOnly) can.Add("type");
            try { value = Clip(vp.Current.Value, 60); } catch { }
        }
        return new Dictionary<string, object> {
            { "id", id }, { "type", TypeName(c.ControlType) }, { "name", Clip(c.Name, 60) }, { "value", value },
            { "password", c.IsPassword }, { "focused", c.HasKeyboardFocus }, { "enabled", c.IsEnabled },
            // Chromium (Discord, browsers, Electron apps): pressing through UI Automation makes the app jump to the front,
            // Byte's own pointer doesn't. Byte picks its own pointer for these while the user plays.
            { "web", (c.FrameworkId ?? "") == "Chrome" },
            { "rect", new[] { (int)r.X, (int)r.Y, (int)r.Width, (int)r.Height } }, { "can", can } };
    }

    // The visible controls of a window, best first: the focused one, text boxes, then named buttons, links and items.
    static Dictionary<string, object> List(IntPtr hwnd, string find, int max, bool menu, Rect near)
    {
        if (hwnd != listRoot || ById.Count > 3000) { ById.Clear(); IdByRuntime.Clear(); NameById.Clear(); nextId = 1; }
        listRoot = hwnd;
        var root = AutomationElement.FromHandle(hwnd);
        Dictionary<string, object> result;
        try { result = Walk(root, find, max, menu, near); }
        catch (ElementNotAvailableException)   // the window redrew right then: once more, a moment later
        {
            System.Threading.Thread.Sleep(300);
            result = Walk(root, find, max, menu, near);
        }
        // a Chromium window that has only just noticed us: its page's controls arrive a moment later
        if (!menu && near.IsEmpty && ((List<object>)result["elements"]).Count < 8 && (root.Current.ClassName ?? "").StartsWith("Chrome_WidgetWin"))
        {
            System.Threading.Thread.Sleep(900);
            result = Walk(root, find, max, menu, near);
        }
        // a classic Windows app's right-click menu is its own window (class #32768), not inside the app's window
        if (menu && ((List<object>)result["elements"]).Count == 0)
        {
            var popups = AutomationElement.RootElement.FindAll(TreeScope.Children,
                new PropertyCondition(AutomationElement.ClassNameProperty, "#32768"));
            foreach (AutomationElement popup in popups)
            {
                var more = Walk(popup, find, max, true, Rect.Empty);
                ((List<object>)result["elements"]).AddRange((List<object>)more["elements"]);
            }
        }
        return result;
    }

    static int IdFor(AutomationElement el)
    {
        // by UI Automation's runtime id, or, for an app that redraws its controls as new ones (same kind, same name,
        // same place), by what and where it is
        string key, place = "", name = null;
        try { key = string.Join(".", el.GetRuntimeId()); } catch { key = "x" + nextId; }
        try
        {
            var c = el.Current;
            name = c.Name;
            Rect r = c.BoundingRectangle;
            place = "@" + c.ControlType.Id + "|" + c.Name + "|" + (int)(r.X / 4) + "," + (int)(r.Y / 4) + "," + (int)(r.Width / 4) + "," + (int)(r.Height / 4);
        }
        catch { }
        int id;
        if (!IdByRuntime.TryGetValue(key, out id) && (place.Length == 0 || !IdByRuntime.TryGetValue(place, out id))) id = nextId++;
        IdByRuntime[key] = id;
        if (place.Length > 0) IdByRuntime[place] = id;
        ById[id] = el;
        if (name != null) NameById[id] = name;
        return id;
    }

    // A listed control that has gone (the app redrew it: React pages, Byte's own Control Center every second):
    // list its window again, narrowed to its name, so the same id points at the redrawn control.
    static AutomationElement Fresh(int id, AutomationElement e)
    {
        try { var probe = e.Current.ControlType; return e; }
        catch (ElementNotAvailableException) { }
        string name;
        if (listRoot == IntPtr.Zero || !NameById.TryGetValue(id, out name)) return null;
        try { Walk(AutomationElement.FromHandle(listRoot), name, 40, false, Rect.Empty); } catch { return null; }
        AutomationElement again;
        if (!ById.TryGetValue(id, out again) || again == e) return null;
        try { var probe = again.Current.ControlType; return again; } catch { return null; }
    }

    static Dictionary<string, object> Walk(AutomationElement root, string find, int max, bool menu, Rect near)
    {
        Rect win = root.Current.BoundingRectangle;
        var watch = Stopwatch.StartNew();
        var found = new List<KeyValuePair<int, AutomationElement>>();   // rank, element
        // What the window says: static text (a calculator's display, a label, a status line). Not
        // controls, so it is not numbered; without it a model that cannot see images could not read
        // a result at all. (VoxAI addition.)
        var texts = new List<object>();
        var seenText = new HashSet<string>();
        var queue = new Queue<KeyValuePair<AutomationElement, int>>();
        queue.Enqueue(new KeyValuePair<AutomationElement, int>(root, 0));
        var walker = TreeWalker.ControlViewWalker;
        string needle = (find ?? "").Trim().ToLowerInvariant();
        int seen = 0;
        while (queue.Count > 0 && seen < 4000 && watch.ElapsedMilliseconds < 2500)
        {
            var item = queue.Dequeue();
            var el = item.Key;
            seen++;
            AutomationElement.AutomationElementInformation c;
            try { c = el.Current; } catch { continue; }
            if (!menu && item.Value > 0 && !c.IsOffscreen && c.ControlType == ControlType.Text && texts.Count < 60)
            {
                string t = Clip(c.Name, 160);
                Rect tr = c.BoundingRectangle;
                if (t.Length > 0 && !tr.IsEmpty && tr.IntersectsWith(win) && (near.IsEmpty || tr.IntersectsWith(near))
                    && (needle.Length == 0 || t.ToLowerInvariant().Contains(needle)) && seenText.Add(t)) texts.Add(t);
            }
            if (item.Value > 0 && !c.IsOffscreen && (menu ? c.ControlType == ControlType.MenuItem : Interactive.Contains(c.ControlType)))
            {
                Rect r = c.BoundingRectangle;
                bool visible = !r.IsEmpty && r.Width > 1 && r.Height > 1 && r.IntersectsWith(win) && (near.IsEmpty || r.IntersectsWith(near));
                string name = c.Name ?? "";
                bool matches = needle.Length == 0 || name.ToLowerInvariant().Contains(needle)
                    || TypeName(c.ControlType).ToLowerInvariant().Contains(needle);
                if (visible && matches || menu && matches && !r.IsEmpty)
                {
                    int rank = c.HasKeyboardFocus ? 0
                        : c.ControlType == ControlType.Edit || c.ControlType == ControlType.ComboBox ? 1
                        : name.Length > 0 && c.ControlType != ControlType.Document ? 2 : 3;
                    if (rank < 3 || needle.Length > 0) found.Add(new KeyValuePair<int, AutomationElement>(rank, el));
                }
            }
            if (item.Value >= 40) continue;
            try
            {
                for (var child = walker.GetFirstChild(el); child != null; child = walker.GetNextSibling(child))
                    queue.Enqueue(new KeyValuePair<AutomationElement, int>(child, item.Value + 1));
            }
            catch { }
        }
        found.Sort((a, b) => a.Key.CompareTo(b.Key));   // stable enough: rank first, tree order within
        var list = new List<object>();
        foreach (var f in found)
        {
            if (list.Count >= Math.Max(1, Math.Min(max, 150))) break;
            try { list.Add(Describe(f.Value, IdFor(f.Value))); } catch { }
        }
        return new Dictionary<string, object> {
            { "window", Clip(root.Current.Name, 80) }, { "elements", list }, { "texts", texts }, { "seen", seen }, { "ms", watch.ElapsedMilliseconds },
            { "complete", queue.Count == 0 } };
    }

    static Dictionary<string, object> ClickInstead(AutomationElement e)
    {
        Rect r = e.Current.BoundingRectangle;
        return new Dictionary<string, object> { { "click", new[] { (int)(r.X + r.Width / 2), (int)(r.Y + r.Height / 2) } } };
    }

    static Dictionary<string, object> Act(int id, string action, string text)
    {
        AutomationElement e;
        if (!ById.TryGetValue(id, out e)) throw new Exception("no element [" + id + "] in the last list: call list_elements again");
        e = Fresh(id, e);
        if (e == null) throw new Exception("[" + id + "] isn't there any more (the window changed): list it again");
        var c = e.Current;
        if (!c.IsEnabled) throw new Exception("[" + id + "] is disabled");
        object p;
        if (action == "set_text")
        {
            if (c.IsPassword) throw new Exception("that is a password box: the user types passwords themselves");
            // web pages (Chromium) want real keystrokes: their apps (React, Lexical...) ignore a value set from outside
            bool web = (c.FrameworkId ?? "") == "Chrome";
            if (!web && e.TryGetCurrentPattern(ValuePattern.Pattern, out p) && !((ValuePattern)p).Current.IsReadOnly)
            {
                try
                {
                    ((ValuePattern)p).SetValue(text);
                    return new Dictionary<string, object> { { "done", "set" } };
                }
                catch { /* some web text boxes refuse: focus and type instead */ }
            }
            try { e.SetFocus(); } catch { return ClickInstead(e); }
            return new Dictionary<string, object> { { "type", true } };
        }
        if (action == "set_text_quiet")
        {
            // game mode: no focus change, no keystrokes. Set the value (web boxes too) and check it stuck.
            if (c.IsPassword) throw new Exception("that is a password box: the user types passwords themselves");
            if (e.TryGetCurrentPattern(ValuePattern.Pattern, out p) && !((ValuePattern)p).Current.IsReadOnly)
            {
                try
                {
                    var vp = (ValuePattern)p;
                    vp.SetValue(text);
                    System.Threading.Thread.Sleep(80);
                    string now = vp.Current.Value ?? "";
                    if (now.Contains(text.Trim())) return new Dictionary<string, object> { { "done", "set" } };
                }
                catch { }
            }
            return new Dictionary<string, object> { { "type", true } };
        }
        if (action == "bg_click" || action == "bg_rclick" || action == "bg_hover" || action == "bg_type")
        {
            // Byte's own pointer: mouse and key messages posted to that one window. The user's real mouse and keyboard,
            // and which window is in front, are left alone. Apps built on Chromium (Discord, Electron apps, browsers)
            // take these even in the background; some other apps ignore them.
            if (c.IsPassword && action == "bg_type") throw new Exception("that is a password box: the user types passwords themselves");
            Rect r = c.BoundingRectangle;
            var screenPt = new Native.POINT { x = (int)(r.X + r.Width / 2), y = (int)(r.Y + r.Height / 2) };
            IntPtr target = Native.ChildAt(listRoot, screenPt);
            if (target == IntPtr.Zero) throw new Exception("couldn't find that control's window");
            var client = screenPt;
            Native.ScreenToClient(target, ref client);
            IntPtr pos = Native.MakeLParam(client.x, client.y);
            Native.PostMessage(target, Native.WM_MOUSEMOVE, IntPtr.Zero, pos);
            if (action == "bg_hover") return new Dictionary<string, object> { { "done", "hover" } };
            System.Threading.Thread.Sleep(40);
            if (action == "bg_rclick")   // a right-click: the app opens its menu (Discord's "Mark As Read" is in one)
            {
                Native.PostMessage(target, Native.WM_RBUTTONDOWN, new IntPtr(Native.MK_RBUTTON), pos);
                System.Threading.Thread.Sleep(30);
                Native.PostMessage(target, Native.WM_RBUTTONUP, IntPtr.Zero, pos);
                return new Dictionary<string, object> { { "done", "menu" } };
            }
            Native.PostMessage(target, Native.WM_LBUTTONDOWN, new IntPtr(Native.MK_LBUTTON), pos);
            System.Threading.Thread.Sleep(30);
            Native.PostMessage(target, Native.WM_LBUTTONUP, IntPtr.Zero, pos);
            if (action == "bg_click") return new Dictionary<string, object> { { "done", "click" } };
            System.Threading.Thread.Sleep(120);   // the box has the page's focus now: the characters go to it
            foreach (char ch in text)
            {
                if (ch == '\n') { Native.PostKey(target, 0x0D, '\r'); continue; }
                Native.PostMessage(target, Native.WM_CHAR, new IntPtr(ch), new IntPtr(1));
                System.Threading.Thread.Sleep(8);
            }
            return new Dictionary<string, object> { { "done", "typed" } };
        }
        if (action == "bg_key")
        {
            IntPtr target = Native.ChildAt(listRoot, Native.Center(c.BoundingRectangle));
            int vk = text == "enter" ? 0x0D : text == "escape" ? 0x1B : text == "tab" ? 0x09 : 0;
            if (vk == 0 || target == IntPtr.Zero) throw new Exception("only enter, escape and tab can be sent in the background");
            Native.PostKey(target, vk, vk == 0x0D ? '\r' : vk == 0x09 ? '\t' : '\u001b');
            return new Dictionary<string, object> { { "done", "key" } };
        }
        if (action == "focus")
        {
            try { e.SetFocus(); return new Dictionary<string, object> { { "done", "focus" } }; } catch { return ClickInstead(e); }
        }
        // invoke: the control's own action if it has one, else a click in its middle
        try
        {
            if (e.TryGetCurrentPattern(InvokePattern.Pattern, out p)) { ((InvokePattern)p).Invoke(); return new Dictionary<string, object> { { "done", "invoke" } }; }
            if (e.TryGetCurrentPattern(TogglePattern.Pattern, out p)) { ((TogglePattern)p).Toggle(); return new Dictionary<string, object> { { "done", "toggle" } }; }
            if (e.TryGetCurrentPattern(SelectionItemPattern.Pattern, out p)) { ((SelectionItemPattern)p).Select(); return new Dictionary<string, object> { { "done", "select" } }; }
            if (e.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out p)) { ((ExpandCollapsePattern)p).Expand(); return new Dictionary<string, object> { { "done", "expand" } }; }
        }
        catch { }
        // a label or icon inside something pressable (a card, a row): press that instead of clicking pixels
        try
        {
            var mid = Native.Center(c.BoundingRectangle);
            var walker = TreeWalker.ControlViewWalker;
            var up = walker.GetParent(e);
            for (int i = 0; i < 3 && up != null; i++, up = walker.GetParent(up))
            {
                var uc = up.Current;
                if (uc.ControlType == ControlType.Window || uc.ControlType == ControlType.Document || uc.ControlType == ControlType.Pane) break;
                if (!uc.BoundingRectangle.Contains(new Point(mid.x, mid.y))) break;
                if (up.TryGetCurrentPattern(InvokePattern.Pattern, out p)) { ((InvokePattern)p).Invoke(); return new Dictionary<string, object> { { "done", "invoke" } }; }
            }
        }
        catch { }
        return ClickInstead(e);
    }

    static Dictionary<string, object> Focused()
    {
        var e = AutomationElement.FocusedElement;
        if (e == null) return new Dictionary<string, object> { { "type", "" }, { "name", "" } };
        var c = e.Current;
        return new Dictionary<string, object> { { "type", TypeName(c.ControlType) }, { "name", Clip(c.Name, 60) }, { "password", c.IsPassword } };
    }
}

static class Native
{
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    public const uint WM_MOUSEMOVE = 0x0200, WM_LBUTTONDOWN = 0x0201, WM_LBUTTONUP = 0x0202, WM_RBUTTONDOWN = 0x0204, WM_RBUTTONUP = 0x0205,
        WM_KEYDOWN = 0x0100, WM_KEYUP = 0x0101, WM_CHAR = 0x0102;
    public const int MK_LBUTTON = 0x0001, MK_RBUTTON = 0x0002;
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x; public int y; }
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool ScreenToClient(IntPtr hWnd, ref POINT p);
    [DllImport("user32.dll")] static extern IntPtr ChildWindowFromPointEx(IntPtr parent, POINT p, uint flags);

    public static IntPtr MakeLParam(int x, int y) { return new IntPtr((y << 16) | (x & 0xFFFF)); }
    public static POINT Center(System.Windows.Rect r) { return new POINT { x = (int)(r.X + r.Width / 2), y = (int)(r.Y + r.Height / 2) }; }

    /** The deepest child of `root` under a screen point, looking only inside root (not at what covers it on screen). */
    public static IntPtr ChildAt(IntPtr root, POINT screenPt)
    {
        IntPtr hwnd = root;
        for (int depth = 0; depth < 12 && hwnd != IntPtr.Zero; depth++)
        {
            var p = screenPt;
            ScreenToClient(hwnd, ref p);
            IntPtr child = ChildWindowFromPointEx(hwnd, p, 0x0001 | 0x0004);   // skip invisible and transparent
            if (child == IntPtr.Zero || child == hwnd) return hwnd;
            hwnd = child;
        }
        return hwnd;
    }

    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int left, top, right, bottom; }
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint attach, uint to, bool on);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vk);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT r);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int cmd);

    static uint Pid(IntPtr hwnd) { uint pid; GetWindowThreadProcessId(hwnd, out pid); return pid; }
    public static bool SameProcess(IntPtr a, IntPtr b) { return a != IntPtr.Zero && b != IntPtr.Zero && Pid(a) == Pid(b); }

    public static string ProcessName(IntPtr hwnd)
    {
        try { return Process.GetProcessById((int)Pid(hwnd)).ProcessName; } catch { return "an app"; }
    }

    static bool Down(int vk) { return (GetAsyncKeyState(vk) & 0x8000) != 0; }

    /** The user moving to `fg` themselves: Alt-Tab or the Windows key, or a click inside it. */
    public static bool UserSwitching(IntPtr fg)
    {
        if (Down(0x12) || Down(0x5B) || Down(0x5C)) return true;
        POINT cur; RECT r;
        if (!GetCursorPos(out cur) || !GetWindowRect(fg, out r)) return false;
        bool inside = cur.x >= r.left && cur.x < r.right && cur.y >= r.top && cur.y < r.bottom;
        return inside && (Down(0x01) || Down(0x02));
    }

    /** Give the foreground back to `keep` (sharing the thief's input state for a moment, which Windows requires). */
    public static bool TakeBack(IntPtr keep, IntPtr thief)
    {
        uint pid;
        uint theirs = GetWindowThreadProcessId(thief, out pid), mine = GetCurrentThreadId();
        bool attached = theirs != 0 && theirs != mine && AttachThreadInput(mine, theirs, true);
        try
        {
            if (IsIconic(keep)) ShowWindow(keep, 9);   // SW_RESTORE: an exclusive-fullscreen game minimises when it loses focus
            SetForegroundWindow(keep);
        }
        finally { if (attached) AttachThreadInput(mine, theirs, false); }
        System.Threading.Thread.Sleep(15);
        return GetForegroundWindow() == keep;
    }

    public static void PostKey(IntPtr target, int vk, char ch)
    {
        PostMessage(target, WM_KEYDOWN, new IntPtr(vk), new IntPtr(1));
        PostMessage(target, WM_CHAR, new IntPtr(ch), new IntPtr(1));
        PostMessage(target, WM_KEYUP, new IntPtr(vk), new IntPtr(unchecked((int)0xC0000001)));
    }
}
