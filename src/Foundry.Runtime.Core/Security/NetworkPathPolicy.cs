namespace Foundry.Runtime;

/// <summary>Reject network/device namespaces before any filesystem probe (decision 8).</summary>
public static class NetworkPathPolicy
{
    private static bool Separator(char value) => value is '\\' or '/';
    public static bool IsNetworkOrDevicePath(string value)
        => value.Length >= 2 && Separator(value[0]) && Separator(value[1])
            || value.Length >= 4 && Separator(value[0]) && value[1] == '?' && value[2] == '?' && Separator(value[3]);
}
