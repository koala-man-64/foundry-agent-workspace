using System.Globalization;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Interop;
using System.Windows.Media;
using Windows.UI.Notifications;

namespace Foundry.Spikes.Toast;

/// <summary>
/// The interactive part of spike S6. Each step shows a toast with WinRT's <c>ToastNotificationManager</c> under the
/// spike's HKCU-registered AUMID, as the plan's host will (section 3). On the in-process <c>Activated</c> event it does
/// what <c>index.ts:63</c> does: show and focus the window. It records every toast event, whether the window really
/// came to the front, and Rudy's answers to the yes/no questions, under the results folder.
/// </summary>
internal sealed class ToastSpike
{
    private static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    private readonly string label;
    private readonly string results;
    private readonly ToastNotifier notifier;
    private readonly List<ToastNotification> toasts = []; // Held so their event handlers stay alive.
    private readonly List<StepView> steps = [];
    private readonly DateTimeOffset started = DateTimeOffset.Now;
    private bool finished;

    public ToastSpike(string label, string results)
    {
        this.label = label;
        this.results = results;
        Registration.Register();
        notifier = ToastNotificationManager.CreateToastNotifier(Registration.Aumid);
        Window = new Window
        {
            Title = $"{Registration.DisplayName} · {label}",
            Width = 760, Height = 900,
            WindowStartupLocation = WindowStartupLocation.CenterScreen,
            Background = Brushes.WhiteSmoke,
        };
        Window.Closed += (_, _) => Finish();
        Record("start", new
        {
            label,
            executable = Environment.ProcessPath,
            aumid = Registration.Aumid,
            notifier = Setting(),
            notifications = Native.NotificationState(),
            windows = Environment.OSVersion.Version.ToString(),
        });
        Window.Content = new ScrollViewer { Content = Build() };
    }

    public Window Window { get; }

    private nint Handle => new WindowInteropHelper(Window).Handle;

    private StackPanel Build()
    {
        var panel = new StackPanel { Margin = new Thickness(16) };
        panel.Children.Add(new TextBlock { Text = $"S6 toast activation · {label} exe", FontSize = 20, FontWeight = FontWeights.SemiBold });
        panel.Children.Add(new TextBlock
        {
            Text = $"Running from {Environment.ProcessPath}\nApp ID {Registration.Aumid} · notifier {Setting()} · Windows says: {Native.NotificationState()}",
            TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 4, 0, 8), Foreground = Brushes.DimGray,
        });
        panel.Children.Add(new TextBlock
        {
            Text = "Do the steps in order. Press Start, follow the instructions, then answer the questions. Notes are optional.",
            TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 0, 0, 8),
        });
        AddStep(panel, "banner-minimized", "1. Click the banner while this window is minimized",
            "Press Start. This window minimizes itself, then a banner appears. Click the banner's text (not its close button). Expected: this window comes back to the front by itself.",
            ["Did the banner appear?", "Did this window come to the front by itself?"], step =>
            {
                // Minimized before the banner exists, so even a quick click is a valid trial.
                Window.WindowState = WindowState.Minimized;
                Later(TimeSpan.FromSeconds(1), () => Show(step, "Click this banner."));
            });
        AddStep(panel, "banner-background", "2. Click the banner while another window is in front",
            "Press Start, then within 5 seconds click another window (File Explorer, or a browser) so this one is behind it. A banner appears after 5 seconds. Click it. Expected: this window comes to the front.",
            ["Did the banner appear?", "Did this window come to the front by itself?"], step =>
            {
                step.Status("Click another window now; the banner comes in 5 seconds.");
                Later(TimeSpan.FromSeconds(5), () => Show(step, "Click this banner."));
            });
        AddStep(panel, "notification-center", "3. Click the toast in Notification Center",
            "Press Start. A banner appears: do not click it. Wait until it slides away by itself (this step's status then says the banner timed out). Click another window, open Notification Center (Windows+N, or click the clock) and click this toast there. Expected: this window comes to the front.",
            ["Was the toast in Notification Center?", "Did this window come to the front by itself?"], step => Show(step, "Do not click this banner. Wait for it to slide away, then click it in Notification Center."));
        AddStep(panel, "taskbar-flash", "4. The fallback: a taskbar flash",
            "Press Start, then within 5 seconds click another window. After 5 seconds this window's taskbar button should flash until you click it.",
            ["Did the taskbar button flash?"], step =>
            {
                step.Status("Click another window now; the flash starts in 5 seconds.");
                Later(TimeSpan.FromSeconds(5), () =>
                {
                    var inFront = Native.GetForegroundWindow() == Handle;
                    Native.FlashTaskbar(Handle);
                    step.Fact(inFront ? "flashed while this window was in front, so it may not show; start again after clicking another window" : "flash started while another window was in front");
                    Record("flash", new { step = step.Id, inFront });
                });
            });
        AddStep(panel, "app-closed", "5. Click a toast after the app has closed",
            "Press Start. A toast appears and this app closes 3 seconds later. Run-S6.ps1 then asks you to click the toast in Notification Center and to say what happened.",
            [], step =>
            {
                Show(step, "This app has closed. Click this toast in Notification Center when Run-S6.ps1 asks.");
                Later(TimeSpan.FromSeconds(3), () => Window.Close());
            });
        var close = new Button { Content = "Finish without step 5", Margin = new Thickness(0, 12, 0, 0), Padding = new Thickness(12, 4, 12, 4), HorizontalAlignment = HorizontalAlignment.Left };
        close.Click += (_, _) => Window.Close();
        panel.Children.Add(close);
        return panel;
    }

    private void AddStep(Panel panel, string id, string title, string instructions, string[] questions, Action<StepView> start)
    {
        var step = new StepView(id, title, instructions, questions, Record);
        step.Start += () => start(step);
        steps.Add(step);
        panel.Children.Add(step.Element);
    }

    /// <summary>Show a toast whose launch string names the step and a fresh nonce, and track what happens to it.</summary>
    private void Show(StepView step, string text)
    {
        var nonce = Guid.NewGuid().ToString("N")[..12];
        var launch = $"s6;label={label};step={step.Id};nonce={nonce}";
        var xml = new Windows.Data.Xml.Dom.XmlDocument();
        xml.LoadXml($"<toast launch=\"{launch}\"><visual><binding template=\"ToastGeneric\"><text>Foundry S6: {step.Title}</text><text>{text}</text></binding></visual></toast>");
        var toast = new ToastNotification(xml) { Tag = step.Id, Group = "s6", ExpirationTime = DateTimeOffset.Now.AddHours(2) };
        var shownAt = DateTimeOffset.Now;
        toast.Activated += (_, args) => Window.Dispatcher.InvokeAsync(() => OnActivated(step, nonce, shownAt, (args as ToastActivatedEventArgs)?.Arguments));
        toast.Dismissed += (_, args) => Window.Dispatcher.InvokeAsync(() =>
        {
            step.Fact(args.Reason == ToastDismissalReason.TimedOut ? "banner timed out (now in Notification Center)" : $"toast dismissed: {args.Reason}");
            Record("dismissed", new { step = step.Id, nonce, reason = args.Reason.ToString() });
        });
        toast.Failed += (_, args) => Window.Dispatcher.InvokeAsync(() =>
        {
            step.Fact($"Windows failed to show the toast: {args.ErrorCode.Message}");
            Record("failed", new { step = step.Id, nonce, error = args.ErrorCode.Message, hresult = args.ErrorCode.HResult });
        });
        toasts.Add(toast);
        try
        {
            notifier.Show(toast);
        }
        catch (Exception error) when (error is System.Runtime.InteropServices.COMException or UnauthorizedAccessException or ArgumentException)
        {
            step.Fact($"Windows refused to show the toast: {error.Message}");
            Record("show-failed", new { step = step.Id, nonce, error = error.Message, hresult = error.HResult });
            return;
        }
        step.Fact($"toast shown at {shownAt.ToString("HH:mm:ss", CultureInfo.InvariantCulture)}");
        Record("shown", new { step = step.Id, nonce, launch, notifier = Setting(), notifications = Native.NotificationState() });
    }

    /// <summary>What index.ts:63 does on a click: show and focus the window. Then measure whether it really came to the front.</summary>
    private void OnActivated(StepView step, string nonce, DateTimeOffset shownAt, string? arguments)
    {
        var before = Window.WindowState;
        var wasInFront = Native.GetForegroundWindow() == Handle;
        Window.Show();
        if (Window.WindowState == WindowState.Minimized)
        {
            Window.WindowState = WindowState.Normal;
        }
        var activateReturned = Window.Activate();
        var matches = arguments is not null && arguments.Contains($"nonce={nonce}", StringComparison.Ordinal);
        step.Status($"Activated {(DateTimeOffset.Now - shownAt).TotalSeconds:0.0} s after the toast was shown{(matches ? "" : $", with unexpected arguments '{arguments}'")}. Checking whether this window is in front…");
        Later(TimeSpan.FromMilliseconds(800), () =>
        {
            var foreground = Native.GetForegroundWindow();
            var inFront = foreground == Handle;
            // When Windows kept another window in front, name it: the evidence for what refused the foreground.
            var holder = inFront ? null : Native.ProcessName(foreground);
            step.Fact(wasInFront
                ? "the window was already in front when the toast was clicked, so this trial does not count: click another window first and start the step again"
                : string.Create(CultureInfo.InvariantCulture, $"activated {(DateTimeOffset.Now - shownAt).TotalSeconds:0.0} s after showing{(matches ? "" : " with unexpected arguments")}; window {(inFront ? "IN FRONT" : $"NOT in front ({holder ?? "no window"} is)")} (measured)"));
            Record("activated", new { step = step.Id, nonce, arguments, argumentsMatch = matches, stateBefore = before.ToString(), wasInFront, activateReturned, inFrontAfter800ms = inFront, foregroundProcess = holder, secondsAfterShown = (DateTimeOffset.Now - shownAt).TotalSeconds });
        });
    }

    /// <summary>The notifier's setting (enabled, or disabled by the user, the app's setting or policy), or why it is unknown.</summary>
    private string Setting()
    {
        try
        {
            return notifier.Setting.ToString();
        }
        catch (Exception error) when (error is System.Runtime.InteropServices.COMException or UnauthorizedAccessException)
        {
            return $"unknown ({error.Message.Trim()})";
        }
    }

    private static void Later(TimeSpan delay, Action action)
    {
        var timer = new System.Windows.Threading.DispatcherTimer { Interval = delay };
        timer.Tick += (_, _) =>
        {
            timer.Stop();
            action();
        };
        timer.Start();
    }

    private void Record(string kind, object data)
    {
        var line = JsonSerializer.Serialize(new { time = DateTimeOffset.Now, kind, data }, Json);
        File.AppendAllText(Path.Combine(results, $"phase-{label}.jsonl"), line + Environment.NewLine);
    }

    /// <summary>Write the phase summary that Run-S6.ps1 folds into the run's summary.</summary>
    private void Finish()
    {
        if (finished)
        {
            return;
        }
        finished = true;
        Record("finish", new { });
        var text = new StringBuilder();
        text.AppendLine(CultureInfo.InvariantCulture, $"## Phase: {label} exe").AppendLine();
        text.AppendLine(CultureInfo.InvariantCulture, $"Started {started:yyyy-MM-dd HH:mm:ss zzz} from `{Environment.ProcessPath}`. Notifier setting at the end: {Setting()}.").AppendLine();
        text.AppendLine("| Step | What happened (measured) | Rudy's answers | Notes |");
        text.AppendLine("|---|---|---|---|");
        foreach (var step in steps)
        {
            text.AppendLine(CultureInfo.InvariantCulture, $"| {step.Title} | {Cell(step.Facts)} | {Cell(step.Answers)} | {Cell(step.Notes)} |");
        }
        File.WriteAllText(Path.Combine(results, $"phase-{label}.md"), text.ToString());
    }

    private static string Cell(string text) => string.IsNullOrWhiteSpace(text) ? "-" : text.Replace("|", "/", StringComparison.Ordinal).ReplaceLineEndings(" ");

    /// <summary>One step's controls: Start, live status, yes/no questions and a note.</summary>
    private sealed class StepView
    {
        private readonly TextBlock status = new() { TextWrapping = TextWrapping.Wrap, Foreground = Brushes.DarkSlateBlue, Margin = new Thickness(0, 4, 0, 4) };
        private readonly TextBox notes = new() { AcceptsReturn = true, MinHeight = 36, TextWrapping = TextWrapping.Wrap };
        private readonly Dictionary<string, string> answers = [];
        private readonly List<string> facts = [];

        public StepView(string id, string title, string instructions, string[] questions, Action<string, object> record)
        {
            Id = id;
            Title = title;
            var panel = new StackPanel();
            panel.Children.Add(new TextBlock { Text = title, FontWeight = FontWeights.SemiBold, FontSize = 15 });
            panel.Children.Add(new TextBlock { Text = instructions, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 2, 0, 6) });
            var start = new Button { Content = "Start", Padding = new Thickness(14, 3, 14, 3), HorizontalAlignment = HorizontalAlignment.Left };
            start.Click += (_, _) =>
            {
                record("start-step", new { step = id });
                Start?.Invoke();
            };
            panel.Children.Add(start);
            panel.Children.Add(status);
            foreach (var question in questions)
            {
                var row = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 2, 0, 2) };
                row.Children.Add(new TextBlock { Text = question, Width = 330, VerticalAlignment = VerticalAlignment.Center });
                foreach (var answer in new[] { "Yes", "No" })
                {
                    var button = new Button { Content = answer, Padding = new Thickness(10, 1, 10, 1), Margin = new Thickness(4, 0, 0, 0) };
                    button.Click += (_, _) =>
                    {
                        answers[question] = answer;
                        foreach (var sibling in row.Children.OfType<Button>())
                        {
                            sibling.FontWeight = ReferenceEquals(sibling, button) ? FontWeights.Bold : FontWeights.Normal;
                        }
                        record("answer", new { step = id, question, answer });
                    };
                    row.Children.Add(button);
                }
                panel.Children.Add(row);
            }
            panel.Children.Add(new TextBlock { Text = "Notes", Foreground = Brushes.DimGray, Margin = new Thickness(0, 4, 0, 0) });
            panel.Children.Add(notes);
            notes.LostFocus += (_, _) => record("note", new { step = id, text = notes.Text });
            Element = new Border { Child = panel, BorderBrush = Brushes.Silver, BorderThickness = new Thickness(1), Padding = new Thickness(10), Margin = new Thickness(0, 0, 0, 10), Background = Brushes.White };
        }

        public event Action? Start;

        public string Id { get; }

        public string Title { get; }

        public UIElement Element { get; }

        public string Facts => string.Join("; ", facts);

        public string Answers => string.Join("; ", answers.Select(pair => $"{pair.Key} {pair.Value}"));

        public string Notes => notes.Text;

        public void Status(string text) => status.Text = text;

        /// <summary>Something measured, kept for the summary and shown as the status.</summary>
        public void Fact(string text)
        {
            facts.Add(text);
            status.Text = string.Join("; ", facts.TakeLast(3));
        }
    }
}
