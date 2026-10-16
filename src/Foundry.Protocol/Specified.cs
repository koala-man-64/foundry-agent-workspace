namespace Foundry.Protocol;

/// <summary>Wire presence, including an explicitly present null, is independent of T's nullability.</summary>
public readonly record struct Specified<T>
{
    public bool IsPresent { get; }
    public T Value { get; }
    public Specified(T value) { IsPresent = true; Value = value; }
    public static implicit operator Specified<T>(T value) => new(value);
}

public interface IWireModel
{
    Dictionary<string, object?> ToWire();
}
