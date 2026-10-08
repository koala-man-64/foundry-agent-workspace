using System.Windows;

namespace Foundry.Desktop;

/// <summary>Placeholder shell until P3 builds the WebView2 host. It is not shipped before cutover.</summary>
public partial class App : Application
{
    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        // Exit rather than leave a windowless process running.
        Shutdown(2);
    }
}
