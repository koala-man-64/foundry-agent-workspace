using Microsoft.Win32;

namespace Foundry.Spikes.Toast;

/// <summary>
/// The spike's per-user app identity: an AUMID registered under HKCU, as the plan's host registers its own (section 3).
/// Run-S6.ps1 removes it afterwards, together with anything Windows created for it.
/// </summary>
internal static class Registration
{
    /// <summary>A test-only identity, distinct from the Electron app's <c>com.rudy.foundryagentworkspace</c> and the product's.</summary>
    public const string Aumid = "Foundry.Spikes.S6Toast";
    public const string DisplayName = "Foundry S6 toast spike";

    /// <summary>A value only the spike writes; Run-S6.ps1 deletes the key only when it finds it.</summary>
    public const string Marker = "FoundrySpike";

    public static string AppKey => $@"Software\Classes\AppUserModelId\{Aumid}";

    public static void Register()
    {
        using var key = Registry.CurrentUser.CreateSubKey(AppKey, writable: true);
        key.SetValue("DisplayName", DisplayName, RegistryValueKind.String);
        key.SetValue(Marker, "S6", RegistryValueKind.String);
        _ = Native.SetAppUserModelId(Aumid);
    }
}
