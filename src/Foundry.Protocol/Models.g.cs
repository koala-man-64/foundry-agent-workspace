// Generated from the frozen TypeScript contract types. Regenerate explicitly with P1_WRITE_MODELS=1.
#nullable enable
namespace Foundry.Protocol.Models;

public abstract record BridgeWorkspaceBrowserInput : IWireModel
{
    public abstract Dictionary<string, object?> ToWire();
}

public sealed record BridgeWorkspaceBrowserInputVariant1 : BridgeWorkspaceBrowserInput
{
    public required string Kind { get; init; }
    public override Dictionary<string, object?> ToWire() => new()
    {
        ["kind"] = Kind
    };
}

public sealed record BridgeWorkspaceBrowserInputVariant2 : BridgeWorkspaceBrowserInput
{
    public required string Kind { get; init; }
    public override Dictionary<string, object?> ToWire() => new()
    {
        ["kind"] = Kind
    };
}

public sealed record BridgeWorkspaceBrowserInputVariant3 : BridgeWorkspaceBrowserInput
{
    public required string Kind { get; init; }
    public required string TabId { get; init; }
    public override Dictionary<string, object?> ToWire() => new()
    {
        ["kind"] = Kind,
        ["tabId"] = TabId
    };
}

public sealed record BridgeWorkspaceBrowserInputVariant4 : BridgeWorkspaceBrowserInput
{
    public required string Kind { get; init; }
    public required string TabId { get; init; }
    public override Dictionary<string, object?> ToWire() => new()
    {
        ["kind"] = Kind,
        ["tabId"] = TabId
    };
}

public sealed record BridgeWorkspaceBrowserInputVariant5 : BridgeWorkspaceBrowserInput
{
    public required string Kind { get; init; }
    public required string TabId { get; init; }
    public override Dictionary<string, object?> ToWire() => new()
    {
        ["kind"] = Kind,
        ["tabId"] = TabId
    };
}

public sealed record BridgeWorkspaceBrowserInputVariant6 : BridgeWorkspaceBrowserInput
{
    public required string Kind { get; init; }
    public required string TabId { get; init; }
    public override Dictionary<string, object?> ToWire() => new()
    {
        ["kind"] = Kind,
        ["tabId"] = TabId
    };
}

public sealed record BridgeWorkspaceBrowserInputVariant7 : BridgeWorkspaceBrowserInput
{
    public required string Kind { get; init; }
    public required string TabId { get; init; }
    public override Dictionary<string, object?> ToWire() => new()
    {
        ["kind"] = Kind,
        ["tabId"] = TabId
    };
}

public sealed record BridgeWorkspaceBrowserInputVariant8 : BridgeWorkspaceBrowserInput
{
    public required string Kind { get; init; }
    public required string TabId { get; init; }
    public override Dictionary<string, object?> ToWire() => new()
    {
        ["kind"] = Kind,
        ["tabId"] = TabId
    };
}

public sealed record BridgeWorkspaceBrowserInputVariant9 : BridgeWorkspaceBrowserInput
{
    public required string Kind { get; init; }
    public required string TabId { get; init; }
    public override Dictionary<string, object?> ToWire() => new()
    {
        ["kind"] = Kind,
        ["tabId"] = TabId
    };
}

public sealed record BridgeWorkspaceBrowserInputVariant10 : BridgeWorkspaceBrowserInput
{
    public required string Kind { get; init; }
    public required string TabId { get; init; }
    public required string Url { get; init; }
    public override Dictionary<string, object?> ToWire() => new()
    {
        ["kind"] = Kind,
        ["tabId"] = TabId,
        ["url"] = Url
    };
}

public sealed record BridgeWorkspaceBrowserInputVariant11 : BridgeWorkspaceBrowserInput
{
    public required string Kind { get; init; }
    public required BridgeWorkspaceBrowserInputVariant11Bounds Bounds { get; init; }
    public override Dictionary<string, object?> ToWire() => new()
    {
        ["kind"] = Kind,
        ["bounds"] = Bounds
    };
}

public sealed record BridgeWorkspaceBrowserInputVariant11Bounds : IWireModel
{
    public required double X { get; init; }
    public required double Y { get; init; }
    public required double Width { get; init; }
    public required double Height { get; init; }
    public required bool Visible { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["x"] = X,
        ["y"] = Y,
        ["width"] = Width,
        ["height"] = Height,
        ["visible"] = Visible
    };
}

public sealed record BridgeWorkspaceBrowserInputVariant12 : BridgeWorkspaceBrowserInput
{
    public required string Kind { get; init; }
    public required string TabId { get; init; }
    public required string TaskId { get; init; }
    public override Dictionary<string, object?> ToWire() => new()
    {
        ["kind"] = Kind,
        ["tabId"] = TabId,
        ["taskId"] = TaskId
    };
}

public sealed record BridgeWorkspaceBrowserInputVariant13 : BridgeWorkspaceBrowserInput
{
    public required string Kind { get; init; }
    public required string TabId { get; init; }
    public required string Confirm { get; init; }
    public override Dictionary<string, object?> ToWire() => new()
    {
        ["kind"] = Kind,
        ["tabId"] = TabId,
        ["confirm"] = Confirm
    };
}

public sealed record BridgeWorkspaceBrowserInputVariant14 : BridgeWorkspaceBrowserInput
{
    public required string Kind { get; init; }
    public required string Confirm { get; init; }
    public override Dictionary<string, object?> ToWire() => new()
    {
        ["kind"] = Kind,
        ["confirm"] = Confirm
    };
}

public sealed record BridgeWorkspaceSaveCredentialInput : IWireModel
{
    public required string ProfileId { get; init; }
    public required string Value { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["profileId"] = ProfileId,
        ["value"] = Value
    };
}

public sealed record BridgeWorkspaceSetNotificationsInput : IWireModel
{
    public required bool Enabled { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["enabled"] = Enabled
    };
}

public sealed record FrameBrowserHostInput : IWireModel
{
    public required string Jsonrpc { get; init; }
    public required string Id { get; init; }
    public required string Method { get; init; }
    public required FrameBrowserHostInputParams Params { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["jsonrpc"] = Jsonrpc,
        ["id"] = Id,
        ["method"] = Method,
        ["params"] = Params
    };
}

public abstract record FrameBrowserHostInputParams : IWireModel
{
    public abstract Dictionary<string, object?> ToWire();
}

public sealed record FrameBrowserHostInputParamsVariant1 : FrameBrowserHostInputParams
{
    public required string Kind { get; init; }
    public required string TaskId { get; init; }
    public override Dictionary<string, object?> ToWire() => new()
    {
        ["kind"] = Kind,
        ["taskId"] = TaskId
    };
}

public sealed record FrameBrowserHostInputParamsVariant2 : FrameBrowserHostInputParams
{
    public required string Kind { get; init; }
    public required string TaskId { get; init; }
    public required string TabId { get; init; }
    public override Dictionary<string, object?> ToWire() => new()
    {
        ["kind"] = Kind,
        ["taskId"] = TaskId,
        ["tabId"] = TabId
    };
}

public sealed record FrameBrowserHostInputParamsVariant3 : FrameBrowserHostInputParams
{
    public required string Kind { get; init; }
    public required string TaskId { get; init; }
    public required FrameBrowserHostInputParamsVariant3Action Action { get; init; }
    public override Dictionary<string, object?> ToWire() => new()
    {
        ["kind"] = Kind,
        ["taskId"] = TaskId,
        ["action"] = Action
    };
}

public abstract record FrameBrowserHostInputParamsVariant3Action : IWireModel
{
    public abstract Dictionary<string, object?> ToWire();
}

public sealed record FrameBrowserHostInputParamsVariant3ActionVariant1 : FrameBrowserHostInputParamsVariant3Action
{
    public required string Kind { get; init; }
    public required string TabId { get; init; }
    public required string Url { get; init; }
    public override Dictionary<string, object?> ToWire() => new()
    {
        ["kind"] = Kind,
        ["tabId"] = TabId,
        ["url"] = Url
    };
}

public sealed record FrameBrowserHostInputParamsVariant3ActionVariant2 : FrameBrowserHostInputParamsVariant3Action
{
    public required string Kind { get; init; }
    public required string TabId { get; init; }
    public required string SnapshotId { get; init; }
    public required string NodeId { get; init; }
    public override Dictionary<string, object?> ToWire() => new()
    {
        ["kind"] = Kind,
        ["tabId"] = TabId,
        ["snapshotId"] = SnapshotId,
        ["nodeId"] = NodeId
    };
}

public sealed record FrameBrowserHostInputParamsVariant3ActionVariant3 : FrameBrowserHostInputParamsVariant3Action
{
    public required string Kind { get; init; }
    public required string TabId { get; init; }
    public required string SnapshotId { get; init; }
    public required string NodeId { get; init; }
    public required string Text { get; init; }
    public override Dictionary<string, object?> ToWire() => new()
    {
        ["kind"] = Kind,
        ["tabId"] = TabId,
        ["snapshotId"] = SnapshotId,
        ["nodeId"] = NodeId,
        ["text"] = Text
    };
}

public sealed record FrameBrowserHostInputParamsVariant3ActionVariant4 : FrameBrowserHostInputParamsVariant3Action
{
    public required string Kind { get; init; }
    public required string TabId { get; init; }
    public required string SnapshotId { get; init; }
    public required string NodeId { get; init; }
    public required string Value { get; init; }
    public override Dictionary<string, object?> ToWire() => new()
    {
        ["kind"] = Kind,
        ["tabId"] = TabId,
        ["snapshotId"] = SnapshotId,
        ["nodeId"] = NodeId,
        ["value"] = Value
    };
}

public sealed record FrameBrowserHostInputParamsVariant3ActionVariant5 : FrameBrowserHostInputParamsVariant3Action
{
    public required string Kind { get; init; }
    public required string TabId { get; init; }
    public required string SnapshotId { get; init; }
    public required string NodeId { get; init; }
    public required string Key { get; init; }
    public override Dictionary<string, object?> ToWire() => new()
    {
        ["kind"] = Kind,
        ["tabId"] = TabId,
        ["snapshotId"] = SnapshotId,
        ["nodeId"] = NodeId,
        ["key"] = Key
    };
}

public sealed record FrameBrowserHostInputParamsVariant3ActionVariant6 : FrameBrowserHostInputParamsVariant3Action
{
    public required string Kind { get; init; }
    public required string TabId { get; init; }
    public required string SnapshotId { get; init; }
    public required string Direction { get; init; }
    public required double Pixels { get; init; }
    public override Dictionary<string, object?> ToWire() => new()
    {
        ["kind"] = Kind,
        ["tabId"] = TabId,
        ["snapshotId"] = SnapshotId,
        ["direction"] = Direction,
        ["pixels"] = Pixels
    };
}

public sealed record FrameBrowserHostInputParamsVariant4 : FrameBrowserHostInputParams
{
    public required string Kind { get; init; }
    public required string TaskId { get; init; }
    public required string PreparedId { get; init; }
    public override Dictionary<string, object?> ToWire() => new()
    {
        ["kind"] = Kind,
        ["taskId"] = TaskId,
        ["preparedId"] = PreparedId
    };
}

public sealed record FrameBrowserHostInputParamsVariant5 : FrameBrowserHostInputParams
{
    public required string Kind { get; init; }
    public required string TaskId { get; init; }
    public override Dictionary<string, object?> ToWire() => new()
    {
        ["kind"] = Kind,
        ["taskId"] = TaskId
    };
}

public sealed record FrameBrowserHostInputParamsVariant6 : FrameBrowserHostInputParams
{
    public required string Kind { get; init; }
    public required string TaskId { get; init; }
    public required string TabId { get; init; }
    public override Dictionary<string, object?> ToWire() => new()
    {
        ["kind"] = Kind,
        ["taskId"] = TaskId,
        ["tabId"] = TabId
    };
}

public sealed record FrameBrowserHostResultInput : IWireModel
{
    public required string Jsonrpc { get; init; }
    public required string Id { get; init; }
    public required string Method { get; init; }
    public Specified<object?> Result { get; init; }
    public Specified<FrameBrowserHostResultInputError> Error { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["jsonrpc"] = Jsonrpc,
        ["id"] = Id,
        ["method"] = Method,
        ["result"] = Result.IsPresent ? (object?)Result.Value : Undefined.Value,
        ["error"] = Error.IsPresent ? (object?)Error.Value : Undefined.Value
    };
}

public sealed record FrameBrowserHostResultInputResultValueItem : IWireModel
{
    public required string Id { get; init; }
    public required string Title { get; init; }
    public required string Url { get; init; }
    public required bool Loading { get; init; }
    public required bool CanGoBack { get; init; }
    public required bool CanGoForward { get; init; }
    public required double Generation { get; init; }
    public required string? AttachedTaskId { get; init; }
    public required string? AuthorizedOrigin { get; init; }
    public required bool Sharing { get; init; }
    public required string? Error { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["id"] = Id,
        ["title"] = Title,
        ["url"] = Url,
        ["loading"] = Loading,
        ["canGoBack"] = CanGoBack,
        ["canGoForward"] = CanGoForward,
        ["generation"] = Generation,
        ["attachedTaskId"] = AttachedTaskId,
        ["authorizedOrigin"] = AuthorizedOrigin,
        ["sharing"] = Sharing,
        ["error"] = Error
    };
}

public sealed record FrameBrowserHostResultInputResultValue : IWireModel
{
    public required string Id { get; init; }
    public required string TabId { get; init; }
    public required double Generation { get; init; }
    public required string Origin { get; init; }
    public required string Url { get; init; }
    public required string Text { get; init; }
    public required IReadOnlyList<FrameBrowserHostResultInputResultValueNodesItem> Nodes { get; init; }
    public required bool Truncated { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["id"] = Id,
        ["tabId"] = TabId,
        ["generation"] = Generation,
        ["origin"] = Origin,
        ["url"] = Url,
        ["text"] = Text,
        ["nodes"] = Nodes,
        ["truncated"] = Truncated
    };
}

public sealed record FrameBrowserHostResultInputResultValueNodesItem : IWireModel
{
    public required string Id { get; init; }
    public required string Role { get; init; }
    public required string Name { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["id"] = Id,
        ["role"] = Role,
        ["name"] = Name
    };
}

public sealed record FrameBrowserHostResultInputResultValue2 : IWireModel
{
    public required string Id { get; init; }
    public required string TaskId { get; init; }
    public required string TabId { get; init; }
    public required string AttachmentId { get; init; }
    public required double Generation { get; init; }
    public required string Origin { get; init; }
    public required FrameBrowserHostResultInputResultValue2Action Action { get; init; }
    public required string Summary { get; init; }
    public required string CreatedAt { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["id"] = Id,
        ["taskId"] = TaskId,
        ["tabId"] = TabId,
        ["attachmentId"] = AttachmentId,
        ["generation"] = Generation,
        ["origin"] = Origin,
        ["action"] = Action,
        ["summary"] = Summary,
        ["createdAt"] = CreatedAt
    };
}

public abstract record FrameBrowserHostResultInputResultValue2Action : IWireModel
{
    public abstract Dictionary<string, object?> ToWire();
}

public sealed record FrameBrowserHostResultInputResultValue2ActionVariant1 : FrameBrowserHostResultInputResultValue2Action
{
    public required string Kind { get; init; }
    public required string TabId { get; init; }
    public required string Url { get; init; }
    public override Dictionary<string, object?> ToWire() => new()
    {
        ["kind"] = Kind,
        ["tabId"] = TabId,
        ["url"] = Url
    };
}

public sealed record FrameBrowserHostResultInputResultValue2ActionVariant2 : FrameBrowserHostResultInputResultValue2Action
{
    public required string Kind { get; init; }
    public required string TabId { get; init; }
    public required string SnapshotId { get; init; }
    public required string NodeId { get; init; }
    public override Dictionary<string, object?> ToWire() => new()
    {
        ["kind"] = Kind,
        ["tabId"] = TabId,
        ["snapshotId"] = SnapshotId,
        ["nodeId"] = NodeId
    };
}

public sealed record FrameBrowserHostResultInputResultValue2ActionVariant3 : FrameBrowserHostResultInputResultValue2Action
{
    public required string Kind { get; init; }
    public required string TabId { get; init; }
    public required string SnapshotId { get; init; }
    public required string NodeId { get; init; }
    public required string Text { get; init; }
    public override Dictionary<string, object?> ToWire() => new()
    {
        ["kind"] = Kind,
        ["tabId"] = TabId,
        ["snapshotId"] = SnapshotId,
        ["nodeId"] = NodeId,
        ["text"] = Text
    };
}

public sealed record FrameBrowserHostResultInputResultValue2ActionVariant4 : FrameBrowserHostResultInputResultValue2Action
{
    public required string Kind { get; init; }
    public required string TabId { get; init; }
    public required string SnapshotId { get; init; }
    public required string NodeId { get; init; }
    public required string Value { get; init; }
    public override Dictionary<string, object?> ToWire() => new()
    {
        ["kind"] = Kind,
        ["tabId"] = TabId,
        ["snapshotId"] = SnapshotId,
        ["nodeId"] = NodeId,
        ["value"] = Value
    };
}

public sealed record FrameBrowserHostResultInputResultValue2ActionVariant5 : FrameBrowserHostResultInputResultValue2Action
{
    public required string Kind { get; init; }
    public required string TabId { get; init; }
    public required string SnapshotId { get; init; }
    public required string NodeId { get; init; }
    public required string Key { get; init; }
    public override Dictionary<string, object?> ToWire() => new()
    {
        ["kind"] = Kind,
        ["tabId"] = TabId,
        ["snapshotId"] = SnapshotId,
        ["nodeId"] = NodeId,
        ["key"] = Key
    };
}

public sealed record FrameBrowserHostResultInputResultValue2ActionVariant6 : FrameBrowserHostResultInputResultValue2Action
{
    public required string Kind { get; init; }
    public required string TabId { get; init; }
    public required string SnapshotId { get; init; }
    public required string Direction { get; init; }
    public required double Pixels { get; init; }
    public override Dictionary<string, object?> ToWire() => new()
    {
        ["kind"] = Kind,
        ["tabId"] = TabId,
        ["snapshotId"] = SnapshotId,
        ["direction"] = Direction,
        ["pixels"] = Pixels
    };
}

public sealed record FrameBrowserHostResultInputResultValue3 : IWireModel
{
    public required string Status { get; init; }
    public required string Detail { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["status"] = Status,
        ["detail"] = Detail
    };
}

public sealed record FrameBrowserHostResultInputResultValue4 : IWireModel
{
    public required string TabId { get; init; }
    public required double Generation { get; init; }
    public required string Origin { get; init; }
    public required string InspectedAt { get; init; }
    public Specified<bool> TabAvailable { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["tabId"] = TabId,
        ["generation"] = Generation,
        ["origin"] = Origin,
        ["inspectedAt"] = InspectedAt,
        ["tabAvailable"] = TabAvailable.IsPresent ? (object?)TabAvailable.Value : Undefined.Value
    };
}

public sealed record FrameBrowserHostResultInputError : IWireModel
{
    public required string Code { get; init; }
    public required string Message { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["code"] = Code,
        ["message"] = Message
    };
}

public sealed record FrameBrowserInvalidatedInput : IWireModel
{
    public required string Jsonrpc { get; init; }
    public required string Method { get; init; }
    public required FrameBrowserInvalidatedInputParams Params { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["jsonrpc"] = Jsonrpc,
        ["method"] = Method,
        ["params"] = Params
    };
}

public sealed record FrameBrowserInvalidatedInputParams : IWireModel
{
    public required string TaskId { get; init; }
    public required string TabId { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["taskId"] = TaskId,
        ["tabId"] = TabId
    };
}

public sealed record FrameRpcRequestInput : IWireModel
{
    public required string Jsonrpc { get; init; }
    public required string Id { get; init; }
    public required string Method { get; init; }
    public required object? Params { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["jsonrpc"] = Jsonrpc,
        ["id"] = Id,
        ["method"] = Method,
        ["params"] = Params
    };
}

public abstract record FrameRpcResponseInput : IWireModel
{
    public abstract Dictionary<string, object?> ToWire();
}

public sealed record FrameRpcResponseInputVariant1 : FrameRpcResponseInput
{
    public required string Jsonrpc { get; init; }
    public required string Id { get; init; }
    public required object? Result { get; init; }
    public override Dictionary<string, object?> ToWire() => new()
    {
        ["jsonrpc"] = Jsonrpc,
        ["id"] = Id,
        ["result"] = Result
    };
}

public sealed record FrameRpcResponseInputVariant2 : FrameRpcResponseInput
{
    public required string Jsonrpc { get; init; }
    public required string Id { get; init; }
    public required FrameRpcResponseInputVariant2Error Error { get; init; }
    public override Dictionary<string, object?> ToWire() => new()
    {
        ["jsonrpc"] = Jsonrpc,
        ["id"] = Id,
        ["error"] = Error
    };
}

public sealed record FrameRpcResponseInputVariant2Error : IWireModel
{
    public required double Code { get; init; }
    public required string Message { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["code"] = Code,
        ["message"] = Message
    };
}

public sealed record FrameRuntimeCredentialInput : IWireModel
{
    public required string Jsonrpc { get; init; }
    public required string Id { get; init; }
    public required string Method { get; init; }
    public required FrameRuntimeCredentialInputParams Params { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["jsonrpc"] = Jsonrpc,
        ["id"] = Id,
        ["method"] = Method,
        ["params"] = Params
    };
}

public sealed record FrameRuntimeCredentialInputParams : IWireModel
{
    public required string Id { get; init; }
    public required string Value { get; init; }
    public required string Binding { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["id"] = Id,
        ["value"] = Value,
        ["binding"] = Binding
    };
}

public sealed record FrameWorkspaceEventInput : IWireModel
{
    public required string Jsonrpc { get; init; }
    public required string Method { get; init; }
    public required FrameWorkspaceEventInputParams Params { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["jsonrpc"] = Jsonrpc,
        ["method"] = Method,
        ["params"] = Params
    };
}

public sealed record FrameWorkspaceEventInputParams : IWireModel
{
    public required double Sequence { get; init; }
    public required string Type { get; init; }
    public Specified<string> TaskId { get; init; }
    public Specified<string> RootTaskId { get; init; }
    public Specified<double> Version { get; init; }
    public Specified<string> Source { get; init; }
    public Specified<bool> Legacy { get; init; }
    public required object? Data { get; init; }
    public required string CreatedAt { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["sequence"] = Sequence,
        ["type"] = Type,
        ["taskId"] = TaskId.IsPresent ? (object?)TaskId.Value : Undefined.Value,
        ["rootTaskId"] = RootTaskId.IsPresent ? (object?)RootTaskId.Value : Undefined.Value,
        ["version"] = Version.IsPresent ? (object?)Version.Value : Undefined.Value,
        ["source"] = Source.IsPresent ? (object?)Source.Value : Undefined.Value,
        ["legacy"] = Legacy.IsPresent ? (object?)Legacy.Value : Undefined.Value,
        ["data"] = Data,
        ["createdAt"] = CreatedAt
    };
}

public sealed record RpcApprovalContentInput : IWireModel
{
    public required string TaskId { get; init; }
    public required string ApprovalId { get; init; }
    public required string Field { get; init; }
    public Specified<double> Offset { get; init; }
    public Specified<double> MaxBytes { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["taskId"] = TaskId,
        ["approvalId"] = ApprovalId,
        ["field"] = Field,
        ["offset"] = Offset.IsPresent ? (object?)Offset.Value : Undefined.Value,
        ["maxBytes"] = MaxBytes.IsPresent ? (object?)MaxBytes.Value : Undefined.Value
    };
}

public sealed record RpcApprovalDecideInput : IWireModel
{
    public required string TaskId { get; init; }
    public required string ApprovalId { get; init; }
    public required string Nonce { get; init; }
    public required string Decision { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["taskId"] = TaskId,
        ["approvalId"] = ApprovalId,
        ["nonce"] = Nonce,
        ["decision"] = Decision
    };
}

public sealed record RpcApprovalGetInput : IWireModel
{
    public required string TaskId { get; init; }
    public required string ApprovalId { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["taskId"] = TaskId,
        ["approvalId"] = ApprovalId
    };
}

public sealed record RpcApprovalReconcileInput : IWireModel
{
    public required string TaskId { get; init; }
    public required string ApprovalId { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["taskId"] = TaskId,
        ["approvalId"] = ApprovalId
    };
}

public sealed record RpcArtifactChunkInput : IWireModel
{
    public required string PreviewId { get; init; }
    public required double Offset { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["previewId"] = PreviewId,
        ["offset"] = Offset
    };
}

public sealed record RpcArtifactPreviewInput : IWireModel
{
    public required string TaskId { get; init; }
    public required string Path { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["taskId"] = TaskId,
        ["path"] = Path
    };
}

public sealed record RpcAutomationDraftDismissInput : IWireModel
{
    public required string DraftId { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["draftId"] = DraftId
    };
}

public sealed record RpcAutomationDraftPrepareInput : IWireModel
{
    public required string DraftId { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["draftId"] = DraftId
    };
}

public sealed record RpcAutomationListInput : IWireModel
{

    public Dictionary<string, object?> ToWire() => new()
    {

    };
}

public sealed record RpcAutomationQueryInput : IWireModel
{
    public required string Kind { get; init; }
    public Specified<double> Before { get; init; }
    public Specified<double> Limit { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["kind"] = Kind,
        ["before"] = Before.IsPresent ? (object?)Before.Value : Undefined.Value,
        ["limit"] = Limit.IsPresent ? (object?)Limit.Value : Undefined.Value
    };
}

public sealed record RpcAutomationRulePreviewInput : IWireModel
{
    public required string RuleId { get; init; }
    public required string TaskId { get; init; }
    public required string EventType { get; init; }
    public Specified<string> ApprovalState { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["ruleId"] = RuleId,
        ["taskId"] = TaskId,
        ["eventType"] = EventType,
        ["approvalState"] = ApprovalState.IsPresent ? (object?)ApprovalState.Value : Undefined.Value
    };
}

public sealed record RpcAutomationRuleRemoveInput : IWireModel
{
    public required string RuleId { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["ruleId"] = RuleId
    };
}

public sealed record RpcAutomationRuleSaveInput : IWireModel
{
    public required string Id { get; init; }
    public required double Version { get; init; }
    public required string Name { get; init; }
    public required bool Enabled { get; init; }
    public required IReadOnlyList<string> Triggers { get; init; }
    public required string? ProjectPath { get; init; }
    public Specified<string> TaskId { get; init; }
    public Specified<RpcAutomationRuleSaveInputConditions> Conditions { get; init; }
    public required string Action { get; init; }
    public required string Title { get; init; }
    public required string Body { get; init; }
    public Specified<RpcAutomationRuleSaveInputProposal> Proposal { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["id"] = Id,
        ["version"] = Version,
        ["name"] = Name,
        ["enabled"] = Enabled,
        ["triggers"] = Triggers,
        ["projectPath"] = ProjectPath,
        ["taskId"] = TaskId.IsPresent ? (object?)TaskId.Value : Undefined.Value,
        ["conditions"] = Conditions.IsPresent ? (object?)Conditions.Value : Undefined.Value,
        ["action"] = Action,
        ["title"] = Title,
        ["body"] = Body,
        ["proposal"] = Proposal.IsPresent ? (object?)Proposal.Value : Undefined.Value
    };
}

public sealed record RpcAutomationRuleSaveInputConditions : IWireModel
{
    public Specified<string> Status { get; init; }
    public Specified<string> Mode { get; init; }
    public Specified<string> ApprovalState { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["status"] = Status.IsPresent ? (object?)Status.Value : Undefined.Value,
        ["mode"] = Mode.IsPresent ? (object?)Mode.Value : Undefined.Value,
        ["approvalState"] = ApprovalState.IsPresent ? (object?)ApprovalState.Value : Undefined.Value
    };
}

public sealed record RpcAutomationRuleSaveInputProposal : IWireModel
{
    public required string Tool { get; init; }
    public required IReadOnlyDictionary<string, object?> Arguments { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["tool"] = Tool,
        ["arguments"] = Arguments
    };
}

public sealed record RpcAutomationScheduleRemoveInput : IWireModel
{
    public required string ScheduleId { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["scheduleId"] = ScheduleId
    };
}

public sealed record RpcAutomationScheduleSaveInput : IWireModel
{
    public required string Id { get; init; }
    public required string Name { get; init; }
    public required bool Enabled { get; init; }
    public required string? ProjectPath { get; init; }
    public required string? TaskId { get; init; }
    public required string Kind { get; init; }
    public required string Title { get; init; }
    public required string Body { get; init; }
    public required string Cadence { get; init; }
    public required string LocalTime { get; init; }
    public required string TimeZone { get; init; }
    public required string StartAt { get; init; }
    public Specified<string> StartDate { get; init; }
    public required double? WeekDay { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["id"] = Id,
        ["name"] = Name,
        ["enabled"] = Enabled,
        ["projectPath"] = ProjectPath,
        ["taskId"] = TaskId,
        ["kind"] = Kind,
        ["title"] = Title,
        ["body"] = Body,
        ["cadence"] = Cadence,
        ["localTime"] = LocalTime,
        ["timeZone"] = TimeZone,
        ["startAt"] = StartAt,
        ["startDate"] = StartDate.IsPresent ? (object?)StartDate.Value : Undefined.Value,
        ["weekDay"] = WeekDay
    };
}

public sealed record RpcAutomationScheduleTickInput : IWireModel
{

    public Dictionary<string, object?> ToWire() => new()
    {

    };
}

public sealed record RpcAutomationScriptGrantInput : IWireModel
{
    public required string RevisionId { get; init; }
    public required string ExpiresAt { get; init; }
    public Specified<double> MaxRunsPer24h { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["revisionId"] = RevisionId,
        ["expiresAt"] = ExpiresAt,
        ["maxRunsPer24h"] = MaxRunsPer24h.IsPresent ? (object?)MaxRunsPer24h.Value : Undefined.Value
    };
}

public sealed record RpcAutomationScriptRegisterInput : IWireModel
{
    public required string Id { get; init; }
    public required string Name { get; init; }
    public required string Language { get; init; }
    public required string Source { get; init; }
    public required IReadOnlyList<string> Triggers { get; init; }
    public required string? ProjectPath { get; init; }
    public Specified<IReadOnlyList<string>> Arguments { get; init; }
    public required string Cwd { get; init; }
    public required IReadOnlyList<string> InputFields { get; init; }
    public Specified<double> TimeoutMs { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["id"] = Id,
        ["name"] = Name,
        ["language"] = Language,
        ["source"] = Source,
        ["triggers"] = Triggers,
        ["projectPath"] = ProjectPath,
        ["arguments"] = Arguments.IsPresent ? (object?)Arguments.Value : Undefined.Value,
        ["cwd"] = Cwd,
        ["inputFields"] = InputFields,
        ["timeoutMs"] = TimeoutMs.IsPresent ? (object?)TimeoutMs.Value : Undefined.Value
    };
}

public sealed record RpcAutomationScriptRevokeInput : IWireModel
{
    public required string RevisionId { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["revisionId"] = RevisionId
    };
}

public sealed record RpcAutomationScriptSourceInput : IWireModel
{
    public required string RevisionId { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["revisionId"] = RevisionId
    };
}

public sealed record RpcBrowserAcknowledgeUnknownInput : IWireModel
{
    public required string TaskId { get; init; }
    public required string ApprovalId { get; init; }
    public required string Confirm { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["taskId"] = TaskId,
        ["approvalId"] = ApprovalId,
        ["confirm"] = Confirm
    };
}

public sealed record RpcChannelGetInput : IWireModel
{
    public required string TaskId { get; init; }
    public Specified<double> Before { get; init; }
    public Specified<string> AfterTaskId { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["taskId"] = TaskId,
        ["before"] = Before.IsPresent ? (object?)Before.Value : Undefined.Value,
        ["afterTaskId"] = AfterTaskId.IsPresent ? (object?)AfterTaskId.Value : Undefined.Value
    };
}

public sealed record RpcChannelSendInput : IWireModel
{
    public required string TaskId { get; init; }
    public required string RequestId { get; init; }
    public Specified<string?> RecipientTaskId { get; init; }
    public required string Content { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["taskId"] = TaskId,
        ["requestId"] = RequestId,
        ["recipientTaskId"] = RecipientTaskId.IsPresent ? (object?)RecipientTaskId.Value : Undefined.Value,
        ["content"] = Content
    };
}

public sealed record RpcContinuityGetInput : IWireModel
{
    public required string TaskId { get; init; }
    public Specified<double> Before { get; init; }
    public Specified<string> LineageAfter { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["taskId"] = TaskId,
        ["before"] = Before.IsPresent ? (object?)Before.Value : Undefined.Value,
        ["lineageAfter"] = LineageAfter.IsPresent ? (object?)LineageAfter.Value : Undefined.Value
    };
}

public sealed record RpcDecisionSaveInput : IWireModel
{
    public required string TaskId { get; init; }
    public required string Title { get; init; }
    public required string Rationale { get; init; }
    public Specified<IReadOnlyList<string>> MessageIds { get; init; }
    public Specified<IReadOnlyList<string>> EvidenceIds { get; init; }
    public Specified<string?> SupersedesId { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["taskId"] = TaskId,
        ["title"] = Title,
        ["rationale"] = Rationale,
        ["messageIds"] = MessageIds.IsPresent ? (object?)MessageIds.Value : Undefined.Value,
        ["evidenceIds"] = EvidenceIds.IsPresent ? (object?)EvidenceIds.Value : Undefined.Value,
        ["supersedesId"] = SupersedesId.IsPresent ? (object?)SupersedesId.Value : Undefined.Value
    };
}

public sealed record RpcDiagnosticsExportInput : IWireModel
{

    public Dictionary<string, object?> ToWire() => new()
    {

    };
}

public sealed record RpcFeaturesGetInput : IWireModel
{

    public Dictionary<string, object?> ToWire() => new()
    {

    };
}

public sealed record RpcFeaturesSetInput : IWireModel
{
    public required string Feature { get; init; }
    public required bool Enabled { get; init; }
    public Specified<string> Reason { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["feature"] = Feature,
        ["enabled"] = Enabled,
        ["reason"] = Reason.IsPresent ? (object?)Reason.Value : Undefined.Value
    };
}

public sealed record RpcFilesListInput : IWireModel
{
    public required string TaskId { get; init; }
    public Specified<string> Path { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["taskId"] = TaskId,
        ["path"] = Path.IsPresent ? (object?)Path.Value : Undefined.Value
    };
}

public sealed record RpcFilesReadInput : IWireModel
{
    public required string TaskId { get; init; }
    public required string Path { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["taskId"] = TaskId,
        ["path"] = Path
    };
}

public sealed record RpcMcpGetConfigInput : IWireModel
{
    public required string ServerId { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["serverId"] = ServerId
    };
}

public sealed record RpcMcpListInput : IWireModel
{
    public Specified<string> After { get; init; }
    public Specified<double> Limit { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["after"] = After.IsPresent ? (object?)After.Value : Undefined.Value,
        ["limit"] = Limit.IsPresent ? (object?)Limit.Value : Undefined.Value
    };
}

public sealed record RpcMcpRemoveInput : IWireModel
{
    public required string ServerId { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["serverId"] = ServerId
    };
}

public sealed record RpcMcpSaveInput : IWireModel
{
    public required string Id { get; init; }
    public required string Key { get; init; }
    public required string Name { get; init; }
    public required string Command { get; init; }
    public Specified<IReadOnlyList<string>> Arguments { get; init; }
    public Specified<string> Cwd { get; init; }
    public Specified<IReadOnlyDictionary<string, string>> Environment { get; init; }
    public Specified<bool> Enabled { get; init; }
    public Specified<IReadOnlyList<string>> ReadOnlyTools { get; init; }
    public Specified<double> CallTimeoutMs { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["id"] = Id,
        ["key"] = Key,
        ["name"] = Name,
        ["command"] = Command,
        ["arguments"] = Arguments.IsPresent ? (object?)Arguments.Value : Undefined.Value,
        ["cwd"] = Cwd.IsPresent ? (object?)Cwd.Value : Undefined.Value,
        ["environment"] = Environment.IsPresent ? (object?)Environment.Value : Undefined.Value,
        ["enabled"] = Enabled.IsPresent ? (object?)Enabled.Value : Undefined.Value,
        ["readOnlyTools"] = ReadOnlyTools.IsPresent ? (object?)ReadOnlyTools.Value : Undefined.Value,
        ["callTimeoutMs"] = CallTimeoutMs.IsPresent ? (object?)CallTimeoutMs.Value : Undefined.Value
    };
}

public sealed record RpcMcpUpdateInput : IWireModel
{
    public required string ServerId { get; init; }
    public Specified<bool> Enabled { get; init; }
    public Specified<IReadOnlyList<string>> ReadOnlyTools { get; init; }
    public Specified<bool> Reconnect { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["serverId"] = ServerId,
        ["enabled"] = Enabled.IsPresent ? (object?)Enabled.Value : Undefined.Value,
        ["readOnlyTools"] = ReadOnlyTools.IsPresent ? (object?)ReadOnlyTools.Value : Undefined.Value,
        ["reconnect"] = Reconnect.IsPresent ? (object?)Reconnect.Value : Undefined.Value
    };
}

public sealed record RpcOrchestrationCancelChildInput : IWireModel
{
    public required string RootTaskId { get; init; }
    public required string ChildTaskId { get; init; }
    public required double Generation { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["rootTaskId"] = RootTaskId,
        ["childTaskId"] = ChildTaskId,
        ["generation"] = Generation
    };
}

public sealed record RpcOrchestrationCancelRootInput : IWireModel
{
    public required string RootTaskId { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["rootTaskId"] = RootTaskId
    };
}

public sealed record RpcOrchestrationChildInput : IWireModel
{
    public required string RootTaskId { get; init; }
    public required string ChildTaskId { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["rootTaskId"] = RootTaskId,
        ["childTaskId"] = ChildTaskId
    };
}

public sealed record RpcOrchestrationDecideInput : IWireModel
{
    public required string RootTaskId { get; init; }
    public required string TaskId { get; init; }
    public required string ApprovalId { get; init; }
    public required string Nonce { get; init; }
    public required string? AssignmentId { get; init; }
    public required double Generation { get; init; }
    public required string Fingerprint { get; init; }
    public required string Decision { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["rootTaskId"] = RootTaskId,
        ["taskId"] = TaskId,
        ["approvalId"] = ApprovalId,
        ["nonce"] = Nonce,
        ["assignmentId"] = AssignmentId,
        ["generation"] = Generation,
        ["fingerprint"] = Fingerprint,
        ["decision"] = Decision
    };
}

public sealed record RpcOrchestrationGetInput : IWireModel
{
    public required string RootTaskId { get; init; }
    public Specified<double> RunsCursor { get; init; }
    public Specified<double> EventsBefore { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["rootTaskId"] = RootTaskId,
        ["runsCursor"] = RunsCursor.IsPresent ? (object?)RunsCursor.Value : Undefined.Value,
        ["eventsBefore"] = EventsBefore.IsPresent ? (object?)EventsBefore.Value : Undefined.Value
    };
}

public sealed record RpcOrchestrationPrepareContinueInput : IWireModel
{
    public required string RootTaskId { get; init; }
    public required string OperationId { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["rootTaskId"] = RootTaskId,
        ["operationId"] = OperationId
    };
}

public sealed record RpcOrchestrationReconcileInput : IWireModel
{
    public required string RootTaskId { get; init; }
    public required string OperationId { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["rootTaskId"] = RootTaskId,
        ["operationId"] = OperationId
    };
}

public sealed record RpcOrchestrationResumeInput : IWireModel
{
    public required string RootTaskId { get; init; }
    public required string Content { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["rootTaskId"] = RootTaskId,
        ["content"] = Content
    };
}

public sealed record RpcOrchestrationReviseAssignmentInput : IWireModel
{
    public required string RootTaskId { get; init; }
    public required string AssignmentId { get; init; }
    public required string Objective { get; init; }
    public required IReadOnlyList<string> Acceptance { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["rootTaskId"] = RootTaskId,
        ["assignmentId"] = AssignmentId,
        ["objective"] = Objective,
        ["acceptance"] = Acceptance
    };
}

public sealed record RpcProfileProbeInput : IWireModel
{
    public required string ProfileId { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["profileId"] = ProfileId
    };
}

public sealed record RpcProfileReadInput : IWireModel
{
    public required string ProfileId { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["profileId"] = ProfileId
    };
}

public sealed record RpcProfileSaveInput : IWireModel
{
    public required string Id { get; init; }
    public required string Name { get; init; }
    public required string ApiKind { get; init; }
    public required string Endpoint { get; init; }
    public required string Deployment { get; init; }
    public Specified<string> CredentialRef { get; init; }
    public required double ContextLimit { get; init; }
    public required double OutputLimit { get; init; }
    public Specified<string> Effort { get; init; }
    public Specified<string> VerifiedAt { get; init; }
    public Specified<string> VerificationFingerprint { get; init; }
    public Specified<RpcProfileSaveInputCapabilities> Capabilities { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["id"] = Id,
        ["name"] = Name,
        ["apiKind"] = ApiKind,
        ["endpoint"] = Endpoint,
        ["deployment"] = Deployment,
        ["credentialRef"] = CredentialRef.IsPresent ? (object?)CredentialRef.Value : Undefined.Value,
        ["contextLimit"] = ContextLimit,
        ["outputLimit"] = OutputLimit,
        ["effort"] = Effort.IsPresent ? (object?)Effort.Value : Undefined.Value,
        ["verifiedAt"] = VerifiedAt.IsPresent ? (object?)VerifiedAt.Value : Undefined.Value,
        ["verificationFingerprint"] = VerificationFingerprint.IsPresent ? (object?)VerificationFingerprint.Value : Undefined.Value,
        ["capabilities"] = Capabilities.IsPresent ? (object?)Capabilities.Value : Undefined.Value
    };
}

public sealed record RpcProfileSaveInputCapabilities : IWireModel
{
    public required bool Streaming { get; init; }
    public required bool Tools { get; init; }
    public required bool Continuation { get; init; }
    public required bool Cancellation { get; init; }
    public required bool Usage { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["streaming"] = Streaming,
        ["tools"] = Tools,
        ["continuation"] = Continuation,
        ["cancellation"] = Cancellation,
        ["usage"] = Usage
    };
}

public sealed record RpcProjectAddInput : IWireModel
{
    public required string Path { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["path"] = Path
    };
}

public sealed record RpcProjectUpdateInput : IWireModel
{
    public required string ProjectId { get; init; }
    public Specified<string> Name { get; init; }
    public Specified<bool> Hidden { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["projectId"] = ProjectId,
        ["name"] = Name.IsPresent ? (object?)Name.Value : Undefined.Value,
        ["hidden"] = Hidden.IsPresent ? (object?)Hidden.Value : Undefined.Value
    };
}

public sealed record RpcTaskApprovalsInput : IWireModel
{
    public required string TaskId { get; init; }
    public Specified<double> Limit { get; init; }
    public Specified<double> Before { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["taskId"] = TaskId,
        ["limit"] = Limit.IsPresent ? (object?)Limit.Value : Undefined.Value,
        ["before"] = Before.IsPresent ? (object?)Before.Value : Undefined.Value
    };
}

public sealed record RpcTaskCancelInput : IWireModel
{
    public required string TaskId { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["taskId"] = TaskId
    };
}

public sealed record RpcTaskCommitInput : IWireModel
{
    public required string TaskId { get; init; }
    public required string Message { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["taskId"] = TaskId,
        ["message"] = Message
    };
}

public sealed record RpcTaskCompactInput : IWireModel
{
    public required string TaskId { get; init; }
    public Specified<double> KeepRecent { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["taskId"] = TaskId,
        ["keepRecent"] = KeepRecent.IsPresent ? (object?)KeepRecent.Value : Undefined.Value
    };
}

public sealed record RpcTaskCompactionContentInput : IWireModel
{
    public required string TaskId { get; init; }
    public required string CompactionId { get; init; }
    public Specified<double> Offset { get; init; }
    public Specified<double> MaxBytes { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["taskId"] = TaskId,
        ["compactionId"] = CompactionId,
        ["offset"] = Offset.IsPresent ? (object?)Offset.Value : Undefined.Value,
        ["maxBytes"] = MaxBytes.IsPresent ? (object?)MaxBytes.Value : Undefined.Value
    };
}

public sealed record RpcTaskCompactionsInput : IWireModel
{
    public required string TaskId { get; init; }
    public Specified<double> Before { get; init; }
    public Specified<double> Limit { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["taskId"] = TaskId,
        ["before"] = Before.IsPresent ? (object?)Before.Value : Undefined.Value,
        ["limit"] = Limit.IsPresent ? (object?)Limit.Value : Undefined.Value
    };
}

public sealed record RpcTaskContinuationPreviewInput : IWireModel
{
    public required string TaskId { get; init; }
    public required IReadOnlyList<string> MessageIds { get; init; }
    public Specified<IReadOnlyList<string>> EvidenceIds { get; init; }
    public Specified<string> SourceCommit { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["taskId"] = TaskId,
        ["messageIds"] = MessageIds,
        ["evidenceIds"] = EvidenceIds.IsPresent ? (object?)EvidenceIds.Value : Undefined.Value,
        ["sourceCommit"] = SourceCommit.IsPresent ? (object?)SourceCommit.Value : Undefined.Value
    };
}

public sealed record RpcTaskContinueInput : IWireModel
{
    public required string PreviewId { get; init; }
    public required string Title { get; init; }
    public required string ProfileId { get; init; }
    public required double TokenBudget { get; init; }
    public Specified<string> Mode { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["previewId"] = PreviewId,
        ["title"] = Title,
        ["profileId"] = ProfileId,
        ["tokenBudget"] = TokenBudget,
        ["mode"] = Mode.IsPresent ? (object?)Mode.Value : Undefined.Value
    };
}

public sealed record RpcTaskCreateInput : IWireModel
{
    public required string Title { get; init; }
    public required string ProjectPath { get; init; }
    public required string ProfileId { get; init; }
    public Specified<double> TokenBudget { get; init; }
    public Specified<string> Mode { get; init; }
    public Specified<RpcTaskCreateInputCoordination> Coordination { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["title"] = Title,
        ["projectPath"] = ProjectPath,
        ["profileId"] = ProfileId,
        ["tokenBudget"] = TokenBudget.IsPresent ? (object?)TokenBudget.Value : Undefined.Value,
        ["mode"] = Mode.IsPresent ? (object?)Mode.Value : Undefined.Value,
        ["coordination"] = Coordination.IsPresent ? (object?)Coordination.Value : Undefined.Value
    };
}

public sealed record RpcTaskCreateInputCoordination : IWireModel
{
    public Specified<IReadOnlyList<string>> ChildProfileIds { get; init; }
    public required RpcTaskCreateInputCoordinationRequiredValidation RequiredValidation { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["childProfileIds"] = ChildProfileIds.IsPresent ? (object?)ChildProfileIds.Value : Undefined.Value,
        ["requiredValidation"] = RequiredValidation
    };
}

public sealed record RpcTaskCreateInputCoordinationRequiredValidation : IWireModel
{
    public required string Command { get; init; }
    public Specified<string> Cwd { get; init; }
    public Specified<double> TimeoutMs { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["command"] = Command,
        ["cwd"] = Cwd.IsPresent ? (object?)Cwd.Value : Undefined.Value,
        ["timeoutMs"] = TimeoutMs.IsPresent ? (object?)TimeoutMs.Value : Undefined.Value
    };
}

public sealed record RpcTaskDiffInput : IWireModel
{
    public required string TaskId { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["taskId"] = TaskId
    };
}

public sealed record RpcTaskExportTranscriptInput : IWireModel
{
    public required string TaskId { get; init; }
    public Specified<bool> IncludeChildren { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["taskId"] = TaskId,
        ["includeChildren"] = IncludeChildren.IsPresent ? (object?)IncludeChildren.Value : Undefined.Value
    };
}

public sealed record RpcTaskMessageContentInput : IWireModel
{
    public required string TaskId { get; init; }
    public required string MessageId { get; init; }
    public Specified<double> Offset { get; init; }
    public Specified<double> MaxBytes { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["taskId"] = TaskId,
        ["messageId"] = MessageId,
        ["offset"] = Offset.IsPresent ? (object?)Offset.Value : Undefined.Value,
        ["maxBytes"] = MaxBytes.IsPresent ? (object?)MaxBytes.Value : Undefined.Value
    };
}

public sealed record RpcTaskMessagesInput : IWireModel
{
    public required string TaskId { get; init; }
    public Specified<double> Before { get; init; }
    public Specified<double> Through { get; init; }
    public Specified<double> Limit { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["taskId"] = TaskId,
        ["before"] = Before.IsPresent ? (object?)Before.Value : Undefined.Value,
        ["through"] = Through.IsPresent ? (object?)Through.Value : Undefined.Value,
        ["limit"] = Limit.IsPresent ? (object?)Limit.Value : Undefined.Value
    };
}

public sealed record RpcTaskPushInput : IWireModel
{
    public required string TaskId { get; init; }
    public Specified<string> Remote { get; init; }
    public required string Confirm { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["taskId"] = TaskId,
        ["remote"] = Remote.IsPresent ? (object?)Remote.Value : Undefined.Value,
        ["confirm"] = Confirm
    };
}

public sealed record RpcTaskReadInput : IWireModel
{
    public required string TaskId { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["taskId"] = TaskId
    };
}

public sealed record RpcTaskReconcilePublicationInput : IWireModel
{
    public required string TaskId { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["taskId"] = TaskId
    };
}

public sealed record RpcTaskRetireInput : IWireModel
{
    public required string TaskId { get; init; }
    public required string Confirm { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["taskId"] = TaskId,
        ["confirm"] = Confirm
    };
}

public sealed record RpcTaskSendInput : IWireModel
{
    public required string TaskId { get; init; }
    public required string Content { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["taskId"] = TaskId,
        ["content"] = Content
    };
}

public sealed record RpcTaskSetArchivedInput : IWireModel
{
    public required string TaskId { get; init; }
    public required bool Archived { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["taskId"] = TaskId,
        ["archived"] = Archived
    };
}

public sealed record RpcTaskStartInput : IWireModel
{
    public required string RequestId { get; init; }
    public required string? ProjectId { get; init; }
    public required string Content { get; init; }
    public Specified<string> Title { get; init; }
    public required string ProfileId { get; init; }
    public required string Mode { get; init; }
    public Specified<double> TokenBudget { get; init; }
    public Specified<RpcTaskStartInputCoordination> Coordination { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["requestId"] = RequestId,
        ["projectId"] = ProjectId,
        ["content"] = Content,
        ["title"] = Title.IsPresent ? (object?)Title.Value : Undefined.Value,
        ["profileId"] = ProfileId,
        ["mode"] = Mode,
        ["tokenBudget"] = TokenBudget.IsPresent ? (object?)TokenBudget.Value : Undefined.Value,
        ["coordination"] = Coordination.IsPresent ? (object?)Coordination.Value : Undefined.Value
    };
}

public sealed record RpcTaskStartInputCoordination : IWireModel
{
    public Specified<IReadOnlyList<string>> ChildProfileIds { get; init; }
    public required RpcTaskStartInputCoordinationRequiredValidation RequiredValidation { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["childProfileIds"] = ChildProfileIds.IsPresent ? (object?)ChildProfileIds.Value : Undefined.Value,
        ["requiredValidation"] = RequiredValidation
    };
}

public sealed record RpcTaskStartInputCoordinationRequiredValidation : IWireModel
{
    public required string Command { get; init; }
    public Specified<string> Cwd { get; init; }
    public Specified<double> TimeoutMs { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["command"] = Command,
        ["cwd"] = Cwd.IsPresent ? (object?)Cwd.Value : Undefined.Value,
        ["timeoutMs"] = TimeoutMs.IsPresent ? (object?)TimeoutMs.Value : Undefined.Value
    };
}

public sealed record RpcTaskTimelineInput : IWireModel
{
    public required string TaskId { get; init; }
    public Specified<double> Before { get; init; }
    public Specified<double> Limit { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["taskId"] = TaskId,
        ["before"] = Before.IsPresent ? (object?)Before.Value : Undefined.Value,
        ["limit"] = Limit.IsPresent ? (object?)Limit.Value : Undefined.Value
    };
}

public sealed record RpcTaskUsageInput : IWireModel
{
    public required string TaskId { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["taskId"] = TaskId
    };
}

public sealed record RpcTaskUsageRecordsInput : IWireModel
{
    public required string TaskId { get; init; }
    public Specified<double> Before { get; init; }
    public Specified<double> Limit { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["taskId"] = TaskId,
        ["before"] = Before.IsPresent ? (object?)Before.Value : Undefined.Value,
        ["limit"] = Limit.IsPresent ? (object?)Limit.Value : Undefined.Value
    };
}

public sealed record RpcTemplatesListInput : IWireModel
{
    public Specified<string> After { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["after"] = After.IsPresent ? (object?)After.Value : Undefined.Value
    };
}

public sealed record RpcTemplatesRemoveInput : IWireModel
{
    public required string TemplateId { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["templateId"] = TemplateId
    };
}

public sealed record RpcTemplatesSaveInput : IWireModel
{
    public required string Id { get; init; }
    public required string Name { get; init; }
    public required string Prompt { get; init; }
    public required string Mode { get; init; }
    public required string ProfileId { get; init; }
    public required double TokenBudget { get; init; }
    public Specified<IReadOnlyList<string>> Scope { get; init; }
    public Specified<RpcTemplatesSaveInputCoordination> Coordination { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["id"] = Id,
        ["name"] = Name,
        ["prompt"] = Prompt,
        ["mode"] = Mode,
        ["profileId"] = ProfileId,
        ["tokenBudget"] = TokenBudget,
        ["scope"] = Scope.IsPresent ? (object?)Scope.Value : Undefined.Value,
        ["coordination"] = Coordination.IsPresent ? (object?)Coordination.Value : Undefined.Value
    };
}

public sealed record RpcTemplatesSaveInputCoordination : IWireModel
{
    public Specified<IReadOnlyList<string>> ChildProfileIds { get; init; }
    public required RpcTemplatesSaveInputCoordinationRequiredValidation RequiredValidation { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["childProfileIds"] = ChildProfileIds.IsPresent ? (object?)ChildProfileIds.Value : Undefined.Value,
        ["requiredValidation"] = RequiredValidation
    };
}

public sealed record RpcTemplatesSaveInputCoordinationRequiredValidation : IWireModel
{
    public required string Command { get; init; }
    public Specified<string> Cwd { get; init; }
    public Specified<double> TimeoutMs { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["command"] = Command,
        ["cwd"] = Cwd.IsPresent ? (object?)Cwd.Value : Undefined.Value,
        ["timeoutMs"] = TimeoutMs.IsPresent ? (object?)TimeoutMs.Value : Undefined.Value
    };
}

public sealed record RpcUsageBreakdownInput : IWireModel
{
    public Specified<RpcUsageBreakdownInputFilters> Filters { get; init; }
    public required string GroupBy { get; init; }
    public Specified<string> Sort { get; init; }
    public Specified<string> Cursor { get; init; }
    public Specified<double> Limit { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["filters"] = Filters.IsPresent ? (object?)Filters.Value : Undefined.Value,
        ["groupBy"] = GroupBy,
        ["sort"] = Sort.IsPresent ? (object?)Sort.Value : Undefined.Value,
        ["cursor"] = Cursor.IsPresent ? (object?)Cursor.Value : Undefined.Value,
        ["limit"] = Limit.IsPresent ? (object?)Limit.Value : Undefined.Value
    };
}

public sealed record RpcUsageBreakdownInputFilters : IWireModel
{
    public Specified<string> From { get; init; }
    public Specified<string> To { get; init; }
    public Specified<bool> IncludeDemo { get; init; }
    public Specified<string> TaskId { get; init; }
    public Specified<bool> IncludeChildren { get; init; }
    public Specified<string> ProfileId { get; init; }
    public Specified<string> ApiKind { get; init; }
    public Specified<string> Model { get; init; }
    public Specified<string> Effort { get; init; }
    public Specified<string> Purpose { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["from"] = From.IsPresent ? (object?)From.Value : Undefined.Value,
        ["to"] = To.IsPresent ? (object?)To.Value : Undefined.Value,
        ["includeDemo"] = IncludeDemo.IsPresent ? (object?)IncludeDemo.Value : Undefined.Value,
        ["taskId"] = TaskId.IsPresent ? (object?)TaskId.Value : Undefined.Value,
        ["includeChildren"] = IncludeChildren.IsPresent ? (object?)IncludeChildren.Value : Undefined.Value,
        ["profileId"] = ProfileId.IsPresent ? (object?)ProfileId.Value : Undefined.Value,
        ["apiKind"] = ApiKind.IsPresent ? (object?)ApiKind.Value : Undefined.Value,
        ["model"] = Model.IsPresent ? (object?)Model.Value : Undefined.Value,
        ["effort"] = Effort.IsPresent ? (object?)Effort.Value : Undefined.Value,
        ["purpose"] = Purpose.IsPresent ? (object?)Purpose.Value : Undefined.Value
    };
}

public sealed record RpcUsageRequestsInput : IWireModel
{
    public Specified<RpcUsageRequestsInputFilters> Filters { get; init; }
    public Specified<string> Cursor { get; init; }
    public Specified<double> Limit { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["filters"] = Filters.IsPresent ? (object?)Filters.Value : Undefined.Value,
        ["cursor"] = Cursor.IsPresent ? (object?)Cursor.Value : Undefined.Value,
        ["limit"] = Limit.IsPresent ? (object?)Limit.Value : Undefined.Value
    };
}

public sealed record RpcUsageRequestsInputFilters : IWireModel
{
    public Specified<string> From { get; init; }
    public Specified<string> To { get; init; }
    public Specified<bool> IncludeDemo { get; init; }
    public Specified<string> TaskId { get; init; }
    public Specified<bool> IncludeChildren { get; init; }
    public Specified<string> ProfileId { get; init; }
    public Specified<string> ApiKind { get; init; }
    public Specified<string> Model { get; init; }
    public Specified<string> Effort { get; init; }
    public Specified<string> Purpose { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["from"] = From.IsPresent ? (object?)From.Value : Undefined.Value,
        ["to"] = To.IsPresent ? (object?)To.Value : Undefined.Value,
        ["includeDemo"] = IncludeDemo.IsPresent ? (object?)IncludeDemo.Value : Undefined.Value,
        ["taskId"] = TaskId.IsPresent ? (object?)TaskId.Value : Undefined.Value,
        ["includeChildren"] = IncludeChildren.IsPresent ? (object?)IncludeChildren.Value : Undefined.Value,
        ["profileId"] = ProfileId.IsPresent ? (object?)ProfileId.Value : Undefined.Value,
        ["apiKind"] = ApiKind.IsPresent ? (object?)ApiKind.Value : Undefined.Value,
        ["model"] = Model.IsPresent ? (object?)Model.Value : Undefined.Value,
        ["effort"] = Effort.IsPresent ? (object?)Effort.Value : Undefined.Value,
        ["purpose"] = Purpose.IsPresent ? (object?)Purpose.Value : Undefined.Value
    };
}

public sealed record RpcUsageSummaryInput : IWireModel
{
    public Specified<RpcUsageSummaryInputFilters> Filters { get; init; }
    public Specified<string> TimeZone { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["filters"] = Filters.IsPresent ? (object?)Filters.Value : Undefined.Value,
        ["timeZone"] = TimeZone.IsPresent ? (object?)TimeZone.Value : Undefined.Value
    };
}

public sealed record RpcUsageSummaryInputFilters : IWireModel
{
    public Specified<string> From { get; init; }
    public Specified<string> To { get; init; }
    public Specified<bool> IncludeDemo { get; init; }
    public Specified<string> TaskId { get; init; }
    public Specified<bool> IncludeChildren { get; init; }
    public Specified<string> ProfileId { get; init; }
    public Specified<string> ApiKind { get; init; }
    public Specified<string> Model { get; init; }
    public Specified<string> Effort { get; init; }
    public Specified<string> Purpose { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["from"] = From.IsPresent ? (object?)From.Value : Undefined.Value,
        ["to"] = To.IsPresent ? (object?)To.Value : Undefined.Value,
        ["includeDemo"] = IncludeDemo.IsPresent ? (object?)IncludeDemo.Value : Undefined.Value,
        ["taskId"] = TaskId.IsPresent ? (object?)TaskId.Value : Undefined.Value,
        ["includeChildren"] = IncludeChildren.IsPresent ? (object?)IncludeChildren.Value : Undefined.Value,
        ["profileId"] = ProfileId.IsPresent ? (object?)ProfileId.Value : Undefined.Value,
        ["apiKind"] = ApiKind.IsPresent ? (object?)ApiKind.Value : Undefined.Value,
        ["model"] = Model.IsPresent ? (object?)Model.Value : Undefined.Value,
        ["effort"] = Effort.IsPresent ? (object?)Effort.Value : Undefined.Value,
        ["purpose"] = Purpose.IsPresent ? (object?)Purpose.Value : Undefined.Value
    };
}

public sealed record RpcWorkspaceActionsInput : IWireModel
{
    public Specified<double> Limit { get; init; }
    public Specified<RpcWorkspaceActionsInputCursor> Cursor { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["limit"] = Limit.IsPresent ? (object?)Limit.Value : Undefined.Value,
        ["cursor"] = Cursor.IsPresent ? (object?)Cursor.Value : Undefined.Value
    };
}

public sealed record RpcWorkspaceActionsInputCursor : IWireModel
{
    public required double Tier { get; init; }
    public required string At { get; init; }
    public required string Id { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["tier"] = Tier,
        ["at"] = At,
        ["id"] = Id
    };
}

public sealed record RpcWorkspaceEventsInput : IWireModel
{
    public Specified<double> After { get; init; }
    public Specified<double> Limit { get; init; }
    public Specified<string> TaskId { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["after"] = After.IsPresent ? (object?)After.Value : Undefined.Value,
        ["limit"] = Limit.IsPresent ? (object?)Limit.Value : Undefined.Value,
        ["taskId"] = TaskId.IsPresent ? (object?)TaskId.Value : Undefined.Value
    };
}

public sealed record RpcWorkspacePreferencesSaveInput : IWireModel
{
    public Specified<string> ProfileId { get; init; }
    public Specified<string> Mode { get; init; }
    public Specified<IReadOnlyList<string>> CollapsedProjectIds { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["profileId"] = ProfileId.IsPresent ? (object?)ProfileId.Value : Undefined.Value,
        ["mode"] = Mode.IsPresent ? (object?)Mode.Value : Undefined.Value,
        ["collapsedProjectIds"] = CollapsedProjectIds.IsPresent ? (object?)CollapsedProjectIds.Value : Undefined.Value
    };
}

public sealed record RpcWorkspaceProfilesInput : IWireModel
{
    public Specified<string> After { get; init; }
    public Specified<double> Limit { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["after"] = After.IsPresent ? (object?)After.Value : Undefined.Value,
        ["limit"] = Limit.IsPresent ? (object?)Limit.Value : Undefined.Value
    };
}

public sealed record RpcWorkspaceProjectsInput : IWireModel
{
    public Specified<string> After { get; init; }
    public Specified<double> Limit { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["after"] = After.IsPresent ? (object?)After.Value : Undefined.Value,
        ["limit"] = Limit.IsPresent ? (object?)Limit.Value : Undefined.Value
    };
}

public sealed record RpcWorkspaceSchemaInput : IWireModel
{

    public Dictionary<string, object?> ToWire() => new()
    {

    };
}

public sealed record RpcWorkspaceSearchInput : IWireModel
{
    public required string Query { get; init; }
    public Specified<string> Visibility { get; init; }
    public Specified<double> Limit { get; init; }
    public Specified<RpcWorkspaceSearchInputCursor> Cursor { get; init; }
    public Specified<string> ProjectPath { get; init; }
    public Specified<string> ProjectId { get; init; }
    public Specified<string> Mode { get; init; }
    public Specified<string> Status { get; init; }
    public Specified<string> From { get; init; }
    public Specified<string> To { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["query"] = Query,
        ["visibility"] = Visibility.IsPresent ? (object?)Visibility.Value : Undefined.Value,
        ["limit"] = Limit.IsPresent ? (object?)Limit.Value : Undefined.Value,
        ["cursor"] = Cursor.IsPresent ? (object?)Cursor.Value : Undefined.Value,
        ["projectPath"] = ProjectPath.IsPresent ? (object?)ProjectPath.Value : Undefined.Value,
        ["projectId"] = ProjectId.IsPresent ? (object?)ProjectId.Value : Undefined.Value,
        ["mode"] = Mode.IsPresent ? (object?)Mode.Value : Undefined.Value,
        ["status"] = Status.IsPresent ? (object?)Status.Value : Undefined.Value,
        ["from"] = From.IsPresent ? (object?)From.Value : Undefined.Value,
        ["to"] = To.IsPresent ? (object?)To.Value : Undefined.Value
    };
}

public sealed record RpcWorkspaceSearchInputCursor : IWireModel
{
    public required string Phase { get; init; }
    public Specified<RpcWorkspaceSearchInputCursorTitleAfter> TitleAfter { get; init; }
    public Specified<double> BeforeOrdinal { get; init; }
    public required double ThroughOrdinal { get; init; }
    public required double TaskThroughRowid { get; init; }
    public required string FilterHash { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["phase"] = Phase,
        ["titleAfter"] = TitleAfter.IsPresent ? (object?)TitleAfter.Value : Undefined.Value,
        ["beforeOrdinal"] = BeforeOrdinal.IsPresent ? (object?)BeforeOrdinal.Value : Undefined.Value,
        ["throughOrdinal"] = ThroughOrdinal,
        ["taskThroughRowid"] = TaskThroughRowid,
        ["filterHash"] = FilterHash
    };
}

public sealed record RpcWorkspaceSearchInputCursorTitleAfter : IWireModel
{
    public required string At { get; init; }
    public required string Id { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["at"] = At,
        ["id"] = Id
    };
}

public sealed record RpcWorkspaceSummaryInput : IWireModel
{

    public Dictionary<string, object?> ToWire() => new()
    {

    };
}

public sealed record RpcWorkspaceTasksInput : IWireModel
{
    public Specified<string> Visibility { get; init; }
    public Specified<string> Sort { get; init; }
    public Specified<double> Limit { get; init; }
    public Specified<RpcWorkspaceTasksInputCursor> Cursor { get; init; }
    public Specified<string> ProjectPath { get; init; }
    public Specified<string> ProjectId { get; init; }
    public Specified<string> Mode { get; init; }
    public Specified<string> Status { get; init; }
    public Specified<string> From { get; init; }
    public Specified<string> To { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["visibility"] = Visibility.IsPresent ? (object?)Visibility.Value : Undefined.Value,
        ["sort"] = Sort.IsPresent ? (object?)Sort.Value : Undefined.Value,
        ["limit"] = Limit.IsPresent ? (object?)Limit.Value : Undefined.Value,
        ["cursor"] = Cursor.IsPresent ? (object?)Cursor.Value : Undefined.Value,
        ["projectPath"] = ProjectPath.IsPresent ? (object?)ProjectPath.Value : Undefined.Value,
        ["projectId"] = ProjectId.IsPresent ? (object?)ProjectId.Value : Undefined.Value,
        ["mode"] = Mode.IsPresent ? (object?)Mode.Value : Undefined.Value,
        ["status"] = Status.IsPresent ? (object?)Status.Value : Undefined.Value,
        ["from"] = From.IsPresent ? (object?)From.Value : Undefined.Value,
        ["to"] = To.IsPresent ? (object?)To.Value : Undefined.Value
    };
}

public sealed record RpcWorkspaceTasksInputCursor : IWireModel
{
    public required string At { get; init; }
    public required string Id { get; init; }
    public required string HighWaterAt { get; init; }
    public required string HighWaterId { get; init; }
    public required string FilterHash { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["at"] = At,
        ["id"] = Id,
        ["highWaterAt"] = HighWaterAt,
        ["highWaterId"] = HighWaterId,
        ["filterHash"] = FilterHash
    };
}

public sealed record RpcWorkspaceUpgradeInput : IWireModel
{
    public required string Confirm { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["confirm"] = Confirm
    };
}

public sealed record RpcWorkspaceUsageTrendInput : IWireModel
{
    public required string GroupBy { get; init; }
    public Specified<string> From { get; init; }
    public Specified<string> To { get; init; }
    public Specified<string> ProfileId { get; init; }
    public Specified<string> TaskId { get; init; }
    public Specified<string> After { get; init; }
    public Specified<double> Limit { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["groupBy"] = GroupBy,
        ["from"] = From.IsPresent ? (object?)From.Value : Undefined.Value,
        ["to"] = To.IsPresent ? (object?)To.Value : Undefined.Value,
        ["profileId"] = ProfileId.IsPresent ? (object?)ProfileId.Value : Undefined.Value,
        ["taskId"] = TaskId.IsPresent ? (object?)TaskId.Value : Undefined.Value,
        ["after"] = After.IsPresent ? (object?)After.Value : Undefined.Value,
        ["limit"] = Limit.IsPresent ? (object?)Limit.Value : Undefined.Value
    };
}

public sealed record ChannelGetResult : IWireModel
{
    public required IReadOnlyList<ChannelGetResultParticipantsItem> Participants { get; init; }
    public required string? ParticipantsCursor { get; init; }
    public required IReadOnlyList<ChannelGetResultMessagesItem> Messages { get; init; }
    public required double? NextCursor { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["participants"] = Participants,
        ["participantsCursor"] = ParticipantsCursor,
        ["messages"] = Messages,
        ["nextCursor"] = NextCursor
    };
}

public sealed record ChannelGetResultParticipantsItem : IWireModel
{
    public required string TaskId { get; init; }
    public required string Title { get; init; }
    public required string Role { get; init; }
    public required string Status { get; init; }
    public required bool Available { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["taskId"] = TaskId,
        ["title"] = Title,
        ["role"] = Role,
        ["status"] = Status,
        ["available"] = Available
    };
}

public sealed record ChannelGetResultMessagesItem : IWireModel
{
    public required double Sequence { get; init; }
    public required string SenderTaskId { get; init; }
    public required string SenderTitle { get; init; }
    public required string Actor { get; init; }
    public required string? RecipientTaskId { get; init; }
    public required string Content { get; init; }
    public required string CreatedAt { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["sequence"] = Sequence,
        ["senderTaskId"] = SenderTaskId,
        ["senderTitle"] = SenderTitle,
        ["actor"] = Actor,
        ["recipientTaskId"] = RecipientTaskId,
        ["content"] = Content,
        ["createdAt"] = CreatedAt
    };
}

public sealed record UsageSummaryResult : IWireModel
{
    public required UsageSummaryResultTotals Totals { get; init; }
    public required IReadOnlyList<UsageSummaryResultDaysItem> Days { get; init; }
    public required bool DetailedTracking { get; init; }
    public Specified<bool> DaysTruncated { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["totals"] = Totals,
        ["days"] = Days,
        ["detailedTracking"] = DetailedTracking,
        ["daysTruncated"] = DaysTruncated.IsPresent ? (object?)DaysTruncated.Value : Undefined.Value
    };
}

public sealed record UsageSummaryResultTotals : IWireModel
{
    public required double Requests { get; init; }
    public required double AttemptedRequests { get; init; }
    public required double PendingRequests { get; init; }
    public required double KnownRequests { get; init; }
    public required double UnknownRequests { get; init; }
    public required double NotSentRequests { get; init; }
    public required double Input { get; init; }
    public required double Output { get; init; }
    public required double Total { get; init; }
    public required double? CacheRead { get; init; }
    public required double? CacheCreation { get; init; }
    public required double? Reasoning { get; init; }
    public required double CacheReadKnownRequests { get; init; }
    public required double CacheCreationKnownRequests { get; init; }
    public required double ReasoningKnownRequests { get; init; }
    public required double ReservedUnknown { get; init; }
    public required double ReservedPending { get; init; }
    public required double ReservedNotSent { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["requests"] = Requests,
        ["attemptedRequests"] = AttemptedRequests,
        ["pendingRequests"] = PendingRequests,
        ["knownRequests"] = KnownRequests,
        ["unknownRequests"] = UnknownRequests,
        ["notSentRequests"] = NotSentRequests,
        ["input"] = Input,
        ["output"] = Output,
        ["total"] = Total,
        ["cacheRead"] = CacheRead,
        ["cacheCreation"] = CacheCreation,
        ["reasoning"] = Reasoning,
        ["cacheReadKnownRequests"] = CacheReadKnownRequests,
        ["cacheCreationKnownRequests"] = CacheCreationKnownRequests,
        ["reasoningKnownRequests"] = ReasoningKnownRequests,
        ["reservedUnknown"] = ReservedUnknown,
        ["reservedPending"] = ReservedPending,
        ["reservedNotSent"] = ReservedNotSent
    };
}

public sealed record UsageSummaryResultDaysItem : IWireModel
{
    public required string Date { get; init; }
    public required UsageSummaryResultTotals Totals { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["date"] = Date,
        ["totals"] = Totals
    };
}

public sealed record UsageBreakdownResult : IWireModel
{
    public required IReadOnlyList<UsageBreakdownResultRowsItem> Rows { get; init; }
    public required string? NextCursor { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["rows"] = Rows,
        ["nextCursor"] = NextCursor
    };
}

public sealed record UsageBreakdownResultRowsItem : IWireModel
{
    public required string Key { get; init; }
    public required string Label { get; init; }
    public required UsageSummaryResultTotals Totals { get; init; }
    public required double SharePercent { get; init; }
    public required UsageBreakdownResultRowsItemFilters Filters { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["key"] = Key,
        ["label"] = Label,
        ["totals"] = Totals,
        ["sharePercent"] = SharePercent,
        ["filters"] = Filters
    };
}

public sealed record UsageBreakdownResultRowsItemFilters : IWireModel
{
    public Specified<string> From { get; init; }
    public Specified<string> To { get; init; }
    public Specified<bool> IncludeDemo { get; init; }
    public Specified<string> TaskId { get; init; }
    public Specified<bool> IncludeChildren { get; init; }
    public Specified<string> ProfileId { get; init; }
    public Specified<string> ApiKind { get; init; }
    public Specified<string> Model { get; init; }
    public Specified<string> Effort { get; init; }
    public Specified<string> Purpose { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["from"] = From.IsPresent ? (object?)From.Value : Undefined.Value,
        ["to"] = To.IsPresent ? (object?)To.Value : Undefined.Value,
        ["includeDemo"] = IncludeDemo.IsPresent ? (object?)IncludeDemo.Value : Undefined.Value,
        ["taskId"] = TaskId.IsPresent ? (object?)TaskId.Value : Undefined.Value,
        ["includeChildren"] = IncludeChildren.IsPresent ? (object?)IncludeChildren.Value : Undefined.Value,
        ["profileId"] = ProfileId.IsPresent ? (object?)ProfileId.Value : Undefined.Value,
        ["apiKind"] = ApiKind.IsPresent ? (object?)ApiKind.Value : Undefined.Value,
        ["model"] = Model.IsPresent ? (object?)Model.Value : Undefined.Value,
        ["effort"] = Effort.IsPresent ? (object?)Effort.Value : Undefined.Value,
        ["purpose"] = Purpose.IsPresent ? (object?)Purpose.Value : Undefined.Value
    };
}

public sealed record UsageRequestsResult : IWireModel
{
    public required IReadOnlyList<UsageRequestsResultRecordsItem> Records { get; init; }
    public required string? NextCursor { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["records"] = Records,
        ["nextCursor"] = NextCursor
    };
}

public sealed record UsageRequestsResultRecordsItem : IWireModel
{
    public required string RequestId { get; init; }
    public required string? TaskId { get; init; }
    public required string? RootTaskId { get; init; }
    public required string? ParentTaskId { get; init; }
    public required string? TaskTitle { get; init; }
    public Specified<string?> RootTaskTitle { get; init; }
    public required string? Role { get; init; }
    public required string Purpose { get; init; }
    public required string? ProfileId { get; init; }
    public required string? ProfileName { get; init; }
    public required string? ApiKind { get; init; }
    public required string? Deployment { get; init; }
    public required string? Effort { get; init; }
    public required bool AttributionKnown { get; init; }
    public required string? ReportedModel { get; init; }
    public required string? ResponseId { get; init; }
    public required string CreatedAt { get; init; }
    public required string? AttemptedAt { get; init; }
    public required string? FinishedAt { get; init; }
    public required string Outcome { get; init; }
    public required double ReservedTokens { get; init; }
    public required double? InputTokens { get; init; }
    public required double? OutputTokens { get; init; }
    public required double? CacheReadTokens { get; init; }
    public required double? CacheCreationTokens { get; init; }
    public required double? ReasoningTokens { get; init; }
    public required bool UsageKnown { get; init; }
    public required string? Reason { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["requestId"] = RequestId,
        ["taskId"] = TaskId,
        ["rootTaskId"] = RootTaskId,
        ["parentTaskId"] = ParentTaskId,
        ["taskTitle"] = TaskTitle,
        ["rootTaskTitle"] = RootTaskTitle.IsPresent ? (object?)RootTaskTitle.Value : Undefined.Value,
        ["role"] = Role,
        ["purpose"] = Purpose,
        ["profileId"] = ProfileId,
        ["profileName"] = ProfileName,
        ["apiKind"] = ApiKind,
        ["deployment"] = Deployment,
        ["effort"] = Effort,
        ["attributionKnown"] = AttributionKnown,
        ["reportedModel"] = ReportedModel,
        ["responseId"] = ResponseId,
        ["createdAt"] = CreatedAt,
        ["attemptedAt"] = AttemptedAt,
        ["finishedAt"] = FinishedAt,
        ["outcome"] = Outcome,
        ["reservedTokens"] = ReservedTokens,
        ["inputTokens"] = InputTokens,
        ["outputTokens"] = OutputTokens,
        ["cacheReadTokens"] = CacheReadTokens,
        ["cacheCreationTokens"] = CacheCreationTokens,
        ["reasoningTokens"] = ReasoningTokens,
        ["usageKnown"] = UsageKnown,
        ["reason"] = Reason
    };
}

public sealed record BrowserAcknowledgeUnknownResult : IWireModel
{
    public Specified<BrowserAcknowledgeUnknownResultBrowser> Browser { get; init; }
    public Specified<string> Origin { get; init; }
    public required string Id { get; init; }
    public required string TaskId { get; init; }
    public required string ToolCallId { get; init; }
    public required string Nonce { get; init; }
    public required string Tool { get; init; }
    public required string State { get; init; }
    public required string CreatedAt { get; init; }
    public required string Summary { get; init; }
    public Specified<string> Path { get; init; }
    public Specified<string> Before { get; init; }
    public Specified<string> After { get; init; }
    public Specified<string?> ExpectedHash { get; init; }
    public Specified<string> ResultingHash { get; init; }
    public Specified<string> Command { get; init; }
    public Specified<string> Cwd { get; init; }
    public Specified<string> Shell { get; init; }
    public Specified<IReadOnlyDictionary<string, string>> Environment { get; init; }
    public Specified<double> TimeoutMs { get; init; }
    public required string Fingerprint { get; init; }
    public Specified<BrowserAcknowledgeUnknownResultResult> Result { get; init; }
    public Specified<string> RootTaskId { get; init; }
    public Specified<string?> AssignmentId { get; init; }
    public Specified<double> Generation { get; init; }
    public Specified<string> TargetLabel { get; init; }
    public Specified<string> EvidenceId { get; init; }
    public Specified<BrowserAcknowledgeUnknownResultHandoff> Handoff { get; init; }
    public Specified<BrowserAcknowledgeUnknownResultMcp> Mcp { get; init; }
    public Specified<BrowserAcknowledgeUnknownResultIntegration> Integration { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["browser"] = Browser.IsPresent ? (object?)Browser.Value : Undefined.Value,
        ["origin"] = Origin.IsPresent ? (object?)Origin.Value : Undefined.Value,
        ["id"] = Id,
        ["taskId"] = TaskId,
        ["toolCallId"] = ToolCallId,
        ["nonce"] = Nonce,
        ["tool"] = Tool,
        ["state"] = State,
        ["createdAt"] = CreatedAt,
        ["summary"] = Summary,
        ["path"] = Path.IsPresent ? (object?)Path.Value : Undefined.Value,
        ["before"] = Before.IsPresent ? (object?)Before.Value : Undefined.Value,
        ["after"] = After.IsPresent ? (object?)After.Value : Undefined.Value,
        ["expectedHash"] = ExpectedHash.IsPresent ? (object?)ExpectedHash.Value : Undefined.Value,
        ["resultingHash"] = ResultingHash.IsPresent ? (object?)ResultingHash.Value : Undefined.Value,
        ["command"] = Command.IsPresent ? (object?)Command.Value : Undefined.Value,
        ["cwd"] = Cwd.IsPresent ? (object?)Cwd.Value : Undefined.Value,
        ["shell"] = Shell.IsPresent ? (object?)Shell.Value : Undefined.Value,
        ["environment"] = Environment.IsPresent ? (object?)Environment.Value : Undefined.Value,
        ["timeoutMs"] = TimeoutMs.IsPresent ? (object?)TimeoutMs.Value : Undefined.Value,
        ["fingerprint"] = Fingerprint,
        ["result"] = Result.IsPresent ? (object?)Result.Value : Undefined.Value,
        ["rootTaskId"] = RootTaskId.IsPresent ? (object?)RootTaskId.Value : Undefined.Value,
        ["assignmentId"] = AssignmentId.IsPresent ? (object?)AssignmentId.Value : Undefined.Value,
        ["generation"] = Generation.IsPresent ? (object?)Generation.Value : Undefined.Value,
        ["targetLabel"] = TargetLabel.IsPresent ? (object?)TargetLabel.Value : Undefined.Value,
        ["evidenceId"] = EvidenceId.IsPresent ? (object?)EvidenceId.Value : Undefined.Value,
        ["handoff"] = Handoff.IsPresent ? (object?)Handoff.Value : Undefined.Value,
        ["mcp"] = Mcp.IsPresent ? (object?)Mcp.Value : Undefined.Value,
        ["integration"] = Integration.IsPresent ? (object?)Integration.Value : Undefined.Value
    };
}

public sealed record BrowserAcknowledgeUnknownResultBrowser : IWireModel
{
    public required BrowserAcknowledgeUnknownResultBrowserPrepared Prepared { get; init; }
    public Specified<BrowserAcknowledgeUnknownResultBrowserAcknowledgment> Acknowledgment { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["prepared"] = Prepared,
        ["acknowledgment"] = Acknowledgment.IsPresent ? (object?)Acknowledgment.Value : Undefined.Value
    };
}

public sealed record BrowserAcknowledgeUnknownResultBrowserPrepared : IWireModel
{
    public required string Id { get; init; }
    public required string TaskId { get; init; }
    public required string TabId { get; init; }
    public required string AttachmentId { get; init; }
    public required double Generation { get; init; }
    public required string Origin { get; init; }
    public required BrowserAcknowledgeUnknownResultBrowserPreparedAction Action { get; init; }
    public required string Summary { get; init; }
    public required string CreatedAt { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["id"] = Id,
        ["taskId"] = TaskId,
        ["tabId"] = TabId,
        ["attachmentId"] = AttachmentId,
        ["generation"] = Generation,
        ["origin"] = Origin,
        ["action"] = Action,
        ["summary"] = Summary,
        ["createdAt"] = CreatedAt
    };
}

public abstract record BrowserAcknowledgeUnknownResultBrowserPreparedAction : IWireModel
{
    public abstract Dictionary<string, object?> ToWire();
}

public sealed record BrowserAcknowledgeUnknownResultBrowserPreparedActionVariant1 : BrowserAcknowledgeUnknownResultBrowserPreparedAction
{
    public required string Kind { get; init; }
    public required string TabId { get; init; }
    public required string Url { get; init; }
    public override Dictionary<string, object?> ToWire() => new()
    {
        ["kind"] = Kind,
        ["tabId"] = TabId,
        ["url"] = Url
    };
}

public sealed record BrowserAcknowledgeUnknownResultBrowserPreparedActionVariant2 : BrowserAcknowledgeUnknownResultBrowserPreparedAction
{
    public required string TabId { get; init; }
    public required string SnapshotId { get; init; }
    public required string NodeId { get; init; }
    public required string Kind { get; init; }
    public override Dictionary<string, object?> ToWire() => new()
    {
        ["tabId"] = TabId,
        ["snapshotId"] = SnapshotId,
        ["nodeId"] = NodeId,
        ["kind"] = Kind
    };
}

public sealed record BrowserAcknowledgeUnknownResultBrowserPreparedActionVariant3 : BrowserAcknowledgeUnknownResultBrowserPreparedAction
{
    public required string Text { get; init; }
    public required string TabId { get; init; }
    public required string SnapshotId { get; init; }
    public required string NodeId { get; init; }
    public required string Kind { get; init; }
    public override Dictionary<string, object?> ToWire() => new()
    {
        ["text"] = Text,
        ["tabId"] = TabId,
        ["snapshotId"] = SnapshotId,
        ["nodeId"] = NodeId,
        ["kind"] = Kind
    };
}

public sealed record BrowserAcknowledgeUnknownResultBrowserPreparedActionVariant4 : BrowserAcknowledgeUnknownResultBrowserPreparedAction
{
    public required string Value { get; init; }
    public required string TabId { get; init; }
    public required string SnapshotId { get; init; }
    public required string NodeId { get; init; }
    public required string Kind { get; init; }
    public override Dictionary<string, object?> ToWire() => new()
    {
        ["value"] = Value,
        ["tabId"] = TabId,
        ["snapshotId"] = SnapshotId,
        ["nodeId"] = NodeId,
        ["kind"] = Kind
    };
}

public sealed record BrowserAcknowledgeUnknownResultBrowserPreparedActionVariant5 : BrowserAcknowledgeUnknownResultBrowserPreparedAction
{
    public required string Key { get; init; }
    public required string TabId { get; init; }
    public required string SnapshotId { get; init; }
    public required string NodeId { get; init; }
    public required string Kind { get; init; }
    public override Dictionary<string, object?> ToWire() => new()
    {
        ["key"] = Key,
        ["tabId"] = TabId,
        ["snapshotId"] = SnapshotId,
        ["nodeId"] = NodeId,
        ["kind"] = Kind
    };
}

public sealed record BrowserAcknowledgeUnknownResultBrowserPreparedActionVariant6 : BrowserAcknowledgeUnknownResultBrowserPreparedAction
{
    public required string Kind { get; init; }
    public required string TabId { get; init; }
    public required string SnapshotId { get; init; }
    public required string Direction { get; init; }
    public required double Pixels { get; init; }
    public override Dictionary<string, object?> ToWire() => new()
    {
        ["kind"] = Kind,
        ["tabId"] = TabId,
        ["snapshotId"] = SnapshotId,
        ["direction"] = Direction,
        ["pixels"] = Pixels
    };
}

public sealed record BrowserAcknowledgeUnknownResultBrowserAcknowledgment : IWireModel
{
    public required string TabId { get; init; }
    public required double Generation { get; init; }
    public required string Origin { get; init; }
    public required string InspectedAt { get; init; }
    public Specified<bool> TabAvailable { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["tabId"] = TabId,
        ["generation"] = Generation,
        ["origin"] = Origin,
        ["inspectedAt"] = InspectedAt,
        ["tabAvailable"] = TabAvailable.IsPresent ? (object?)TabAvailable.Value : Undefined.Value
    };
}

public sealed record BrowserAcknowledgeUnknownResultResult : IWireModel
{
    public required string Content { get; init; }
    public required bool IsError { get; init; }
    public Specified<double> ExitCode { get; init; }
    public Specified<bool> CleanupVerified { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["content"] = Content,
        ["isError"] = IsError,
        ["exitCode"] = ExitCode.IsPresent ? (object?)ExitCode.Value : Undefined.Value,
        ["cleanupVerified"] = CleanupVerified.IsPresent ? (object?)CleanupVerified.Value : Undefined.Value
    };
}

public sealed record BrowserAcknowledgeUnknownResultHandoff : IWireModel
{
    public required string OperationId { get; init; }
    public required string Branch { get; init; }
    public required string ExpectedHead { get; init; }
    public required IReadOnlyList<string> Paths { get; init; }
    public required string ManifestSha256 { get; init; }
    public required string Message { get; init; }
    public required string Patch { get; init; }
    public required bool PatchTruncated { get; init; }
    public required string GitPath { get; init; }
    public required string GitSha256 { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["operationId"] = OperationId,
        ["branch"] = Branch,
        ["expectedHead"] = ExpectedHead,
        ["paths"] = Paths,
        ["manifestSha256"] = ManifestSha256,
        ["message"] = Message,
        ["patch"] = Patch,
        ["patchTruncated"] = PatchTruncated,
        ["gitPath"] = GitPath,
        ["gitSha256"] = GitSha256
    };
}

public sealed record BrowserAcknowledgeUnknownResultMcp : IWireModel
{
    public required string ServerId { get; init; }
    public required string ServerKey { get; init; }
    public required string ServerName { get; init; }
    public required string Tool { get; init; }
    public required string Arguments { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["serverId"] = ServerId,
        ["serverKey"] = ServerKey,
        ["serverName"] = ServerName,
        ["tool"] = Tool,
        ["arguments"] = Arguments
    };
}

public sealed record BrowserAcknowledgeUnknownResultIntegration : IWireModel
{
    public required string OperationId { get; init; }
    public required string Kind { get; init; }
    public required string ResultId { get; init; }
    public required string AssignmentId { get; init; }
    public required string SourceSha { get; init; }
    public required string ExpectedHead { get; init; }
    public required string ExpectedTree { get; init; }
    public required string ManifestSha256 { get; init; }
    public required string? ResolvedTree { get; init; }
    public required IReadOnlyList<string> ChangedPaths { get; init; }
    public required string Patch { get; init; }
    public required bool PatchTruncated { get; init; }
    public required string GitPath { get; init; }
    public required string GitSha256 { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["operationId"] = OperationId,
        ["kind"] = Kind,
        ["resultId"] = ResultId,
        ["assignmentId"] = AssignmentId,
        ["sourceSha"] = SourceSha,
        ["expectedHead"] = ExpectedHead,
        ["expectedTree"] = ExpectedTree,
        ["manifestSha256"] = ManifestSha256,
        ["resolvedTree"] = ResolvedTree,
        ["changedPaths"] = ChangedPaths,
        ["patch"] = Patch,
        ["patchTruncated"] = PatchTruncated,
        ["gitPath"] = GitPath,
        ["gitSha256"] = GitSha256
    };
}

public sealed record ProjectAddResult : IWireModel
{
    public required string Id { get; init; }
    public required string Name { get; init; }
    public required string Path { get; init; }
    public required bool Hidden { get; init; }
    public required string Kind { get; init; }
    public Specified<string> UnavailableReason { get; init; }
    public required string CreatedAt { get; init; }
    public required string UpdatedAt { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["id"] = Id,
        ["name"] = Name,
        ["path"] = Path,
        ["hidden"] = Hidden,
        ["kind"] = Kind,
        ["unavailableReason"] = UnavailableReason.IsPresent ? (object?)UnavailableReason.Value : Undefined.Value,
        ["createdAt"] = CreatedAt,
        ["updatedAt"] = UpdatedAt
    };
}

public sealed record WorkspacePreferencesSaveResult : IWireModel
{
    public required string ProfileId { get; init; }
    public required string Mode { get; init; }
    public required IReadOnlyList<string> CollapsedProjectIds { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["profileId"] = ProfileId,
        ["mode"] = Mode,
        ["collapsedProjectIds"] = CollapsedProjectIds
    };
}

public abstract record TaskStartResult : IWireModel
{
    public abstract Dictionary<string, object?> ToWire();
}

public sealed record TaskStartResultVariant1 : TaskStartResult
{
    public Specified<string> WorkspaceKind { get; init; }
    public required string ProjectPath { get; init; }
    public required string WorktreePath { get; init; }
    public required string Branch { get; init; }
    public required string BaseCommit { get; init; }
    public required string Id { get; init; }
    public required string Title { get; init; }
    public Specified<string> ProjectId { get; init; }
    public required string ProfileId { get; init; }
    public required string Status { get; init; }
    public required string CreatedAt { get; init; }
    public required string UpdatedAt { get; init; }
    public required double TokenBudget { get; init; }
    public required double UsedTokens { get; init; }
    public Specified<string> Mode { get; init; }
    public Specified<string> RetiredAt { get; init; }
    public Specified<string> ArchivedAt { get; init; }
    public Specified<string> RootTaskId { get; init; }
    public Specified<string> ParentTaskId { get; init; }
    public Specified<string> Role { get; init; }
    public Specified<string> AssignmentId { get; init; }
    public Specified<TaskStartResultVariant1Coordination> Coordination { get; init; }
    public override Dictionary<string, object?> ToWire() => new()
    {
        ["workspaceKind"] = WorkspaceKind.IsPresent ? (object?)WorkspaceKind.Value : Undefined.Value,
        ["projectPath"] = ProjectPath,
        ["worktreePath"] = WorktreePath,
        ["branch"] = Branch,
        ["baseCommit"] = BaseCommit,
        ["id"] = Id,
        ["title"] = Title,
        ["projectId"] = ProjectId.IsPresent ? (object?)ProjectId.Value : Undefined.Value,
        ["profileId"] = ProfileId,
        ["status"] = Status,
        ["createdAt"] = CreatedAt,
        ["updatedAt"] = UpdatedAt,
        ["tokenBudget"] = TokenBudget,
        ["usedTokens"] = UsedTokens,
        ["mode"] = Mode.IsPresent ? (object?)Mode.Value : Undefined.Value,
        ["retiredAt"] = RetiredAt.IsPresent ? (object?)RetiredAt.Value : Undefined.Value,
        ["archivedAt"] = ArchivedAt.IsPresent ? (object?)ArchivedAt.Value : Undefined.Value,
        ["rootTaskId"] = RootTaskId.IsPresent ? (object?)RootTaskId.Value : Undefined.Value,
        ["parentTaskId"] = ParentTaskId.IsPresent ? (object?)ParentTaskId.Value : Undefined.Value,
        ["role"] = Role.IsPresent ? (object?)Role.Value : Undefined.Value,
        ["assignmentId"] = AssignmentId.IsPresent ? (object?)AssignmentId.Value : Undefined.Value,
        ["coordination"] = Coordination.IsPresent ? (object?)Coordination.Value : Undefined.Value
    };
}

public sealed record TaskStartResultVariant1Coordination : IWireModel
{
    public required IReadOnlyList<string> ChildProfileIds { get; init; }
    public required TaskStartResultVariant1CoordinationRequiredValidation RequiredValidation { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["childProfileIds"] = ChildProfileIds,
        ["requiredValidation"] = RequiredValidation
    };
}

public sealed record TaskStartResultVariant1CoordinationRequiredValidation : IWireModel
{
    public required string Command { get; init; }
    public required string Cwd { get; init; }
    public required double TimeoutMs { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["command"] = Command,
        ["cwd"] = Cwd,
        ["timeoutMs"] = TimeoutMs
    };
}

public sealed record TaskStartResultVariant2 : TaskStartResult
{
    public required string WorkspaceKind { get; init; }
    public required string ProjectPath { get; init; }
    public Specified<object?> WorktreePath { get; init; }
    public Specified<object?> Branch { get; init; }
    public Specified<object?> BaseCommit { get; init; }
    public required string Mode { get; init; }
    public required string Id { get; init; }
    public required string Title { get; init; }
    public Specified<string> ProjectId { get; init; }
    public required string ProfileId { get; init; }
    public required string Status { get; init; }
    public required string CreatedAt { get; init; }
    public required string UpdatedAt { get; init; }
    public required double TokenBudget { get; init; }
    public required double UsedTokens { get; init; }
    public Specified<string> RetiredAt { get; init; }
    public Specified<string> ArchivedAt { get; init; }
    public Specified<string> RootTaskId { get; init; }
    public Specified<string> ParentTaskId { get; init; }
    public Specified<string> Role { get; init; }
    public Specified<string> AssignmentId { get; init; }
    public Specified<TaskStartResultVariant1Coordination> Coordination { get; init; }
    public override Dictionary<string, object?> ToWire() => new()
    {
        ["workspaceKind"] = WorkspaceKind,
        ["projectPath"] = ProjectPath,
        ["worktreePath"] = WorktreePath.IsPresent ? (object?)WorktreePath.Value : Undefined.Value,
        ["branch"] = Branch.IsPresent ? (object?)Branch.Value : Undefined.Value,
        ["baseCommit"] = BaseCommit.IsPresent ? (object?)BaseCommit.Value : Undefined.Value,
        ["mode"] = Mode,
        ["id"] = Id,
        ["title"] = Title,
        ["projectId"] = ProjectId.IsPresent ? (object?)ProjectId.Value : Undefined.Value,
        ["profileId"] = ProfileId,
        ["status"] = Status,
        ["createdAt"] = CreatedAt,
        ["updatedAt"] = UpdatedAt,
        ["tokenBudget"] = TokenBudget,
        ["usedTokens"] = UsedTokens,
        ["retiredAt"] = RetiredAt.IsPresent ? (object?)RetiredAt.Value : Undefined.Value,
        ["archivedAt"] = ArchivedAt.IsPresent ? (object?)ArchivedAt.Value : Undefined.Value,
        ["rootTaskId"] = RootTaskId.IsPresent ? (object?)RootTaskId.Value : Undefined.Value,
        ["parentTaskId"] = ParentTaskId.IsPresent ? (object?)ParentTaskId.Value : Undefined.Value,
        ["role"] = Role.IsPresent ? (object?)Role.Value : Undefined.Value,
        ["assignmentId"] = AssignmentId.IsPresent ? (object?)AssignmentId.Value : Undefined.Value,
        ["coordination"] = Coordination.IsPresent ? (object?)Coordination.Value : Undefined.Value
    };
}

public sealed record TaskStartResultVariant3 : TaskStartResult
{
    public required string WorkspaceKind { get; init; }
    public Specified<object?> ProjectPath { get; init; }
    public Specified<object?> WorktreePath { get; init; }
    public Specified<object?> Branch { get; init; }
    public Specified<object?> BaseCommit { get; init; }
    public required string Mode { get; init; }
    public required string Id { get; init; }
    public required string Title { get; init; }
    public Specified<string> ProjectId { get; init; }
    public required string ProfileId { get; init; }
    public required string Status { get; init; }
    public required string CreatedAt { get; init; }
    public required string UpdatedAt { get; init; }
    public required double TokenBudget { get; init; }
    public required double UsedTokens { get; init; }
    public Specified<string> RetiredAt { get; init; }
    public Specified<string> ArchivedAt { get; init; }
    public Specified<string> RootTaskId { get; init; }
    public Specified<string> ParentTaskId { get; init; }
    public Specified<string> Role { get; init; }
    public Specified<string> AssignmentId { get; init; }
    public Specified<TaskStartResultVariant1Coordination> Coordination { get; init; }
    public override Dictionary<string, object?> ToWire() => new()
    {
        ["workspaceKind"] = WorkspaceKind,
        ["projectPath"] = ProjectPath.IsPresent ? (object?)ProjectPath.Value : Undefined.Value,
        ["worktreePath"] = WorktreePath.IsPresent ? (object?)WorktreePath.Value : Undefined.Value,
        ["branch"] = Branch.IsPresent ? (object?)Branch.Value : Undefined.Value,
        ["baseCommit"] = BaseCommit.IsPresent ? (object?)BaseCommit.Value : Undefined.Value,
        ["mode"] = Mode,
        ["id"] = Id,
        ["title"] = Title,
        ["projectId"] = ProjectId.IsPresent ? (object?)ProjectId.Value : Undefined.Value,
        ["profileId"] = ProfileId,
        ["status"] = Status,
        ["createdAt"] = CreatedAt,
        ["updatedAt"] = UpdatedAt,
        ["tokenBudget"] = TokenBudget,
        ["usedTokens"] = UsedTokens,
        ["retiredAt"] = RetiredAt.IsPresent ? (object?)RetiredAt.Value : Undefined.Value,
        ["archivedAt"] = ArchivedAt.IsPresent ? (object?)ArchivedAt.Value : Undefined.Value,
        ["rootTaskId"] = RootTaskId.IsPresent ? (object?)RootTaskId.Value : Undefined.Value,
        ["parentTaskId"] = ParentTaskId.IsPresent ? (object?)ParentTaskId.Value : Undefined.Value,
        ["role"] = Role.IsPresent ? (object?)Role.Value : Undefined.Value,
        ["assignmentId"] = AssignmentId.IsPresent ? (object?)AssignmentId.Value : Undefined.Value,
        ["coordination"] = Coordination.IsPresent ? (object?)Coordination.Value : Undefined.Value
    };
}

public sealed record TaskCreateResult : IWireModel
{
    public Specified<string> WorkspaceKind { get; init; }
    public required string ProjectPath { get; init; }
    public required string WorktreePath { get; init; }
    public required string Branch { get; init; }
    public required string BaseCommit { get; init; }
    public required string Id { get; init; }
    public required string Title { get; init; }
    public Specified<string> ProjectId { get; init; }
    public required string ProfileId { get; init; }
    public required string Status { get; init; }
    public required string CreatedAt { get; init; }
    public required string UpdatedAt { get; init; }
    public required double TokenBudget { get; init; }
    public required double UsedTokens { get; init; }
    public Specified<string> Mode { get; init; }
    public Specified<string> RetiredAt { get; init; }
    public Specified<string> ArchivedAt { get; init; }
    public Specified<string> RootTaskId { get; init; }
    public Specified<string> ParentTaskId { get; init; }
    public Specified<string> Role { get; init; }
    public Specified<string> AssignmentId { get; init; }
    public Specified<TaskStartResultVariant1Coordination> Coordination { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["workspaceKind"] = WorkspaceKind.IsPresent ? (object?)WorkspaceKind.Value : Undefined.Value,
        ["projectPath"] = ProjectPath,
        ["worktreePath"] = WorktreePath,
        ["branch"] = Branch,
        ["baseCommit"] = BaseCommit,
        ["id"] = Id,
        ["title"] = Title,
        ["projectId"] = ProjectId.IsPresent ? (object?)ProjectId.Value : Undefined.Value,
        ["profileId"] = ProfileId,
        ["status"] = Status,
        ["createdAt"] = CreatedAt,
        ["updatedAt"] = UpdatedAt,
        ["tokenBudget"] = TokenBudget,
        ["usedTokens"] = UsedTokens,
        ["mode"] = Mode.IsPresent ? (object?)Mode.Value : Undefined.Value,
        ["retiredAt"] = RetiredAt.IsPresent ? (object?)RetiredAt.Value : Undefined.Value,
        ["archivedAt"] = ArchivedAt.IsPresent ? (object?)ArchivedAt.Value : Undefined.Value,
        ["rootTaskId"] = RootTaskId.IsPresent ? (object?)RootTaskId.Value : Undefined.Value,
        ["parentTaskId"] = ParentTaskId.IsPresent ? (object?)ParentTaskId.Value : Undefined.Value,
        ["role"] = Role.IsPresent ? (object?)Role.Value : Undefined.Value,
        ["assignmentId"] = AssignmentId.IsPresent ? (object?)AssignmentId.Value : Undefined.Value,
        ["coordination"] = Coordination.IsPresent ? (object?)Coordination.Value : Undefined.Value
    };
}

public sealed record TaskSendResult : IWireModel
{
    public required bool Accepted { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["accepted"] = Accepted
    };
}

public sealed record ProfileSaveResult : IWireModel
{
    public required string Id { get; init; }
    public required string Name { get; init; }
    public required string ApiKind { get; init; }
    public required string Endpoint { get; init; }
    public required string Deployment { get; init; }
    public required double ContextLimit { get; init; }
    public required double OutputLimit { get; init; }
    public Specified<string> CredentialRef { get; init; }
    public Specified<string> Effort { get; init; }
    public Specified<string> VerifiedAt { get; init; }
    public Specified<string> VerificationFingerprint { get; init; }
    public Specified<ProfileSaveResultCapabilities> Capabilities { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["id"] = Id,
        ["name"] = Name,
        ["apiKind"] = ApiKind,
        ["endpoint"] = Endpoint,
        ["deployment"] = Deployment,
        ["contextLimit"] = ContextLimit,
        ["outputLimit"] = OutputLimit,
        ["credentialRef"] = CredentialRef.IsPresent ? (object?)CredentialRef.Value : Undefined.Value,
        ["effort"] = Effort.IsPresent ? (object?)Effort.Value : Undefined.Value,
        ["verifiedAt"] = VerifiedAt.IsPresent ? (object?)VerifiedAt.Value : Undefined.Value,
        ["verificationFingerprint"] = VerificationFingerprint.IsPresent ? (object?)VerificationFingerprint.Value : Undefined.Value,
        ["capabilities"] = Capabilities.IsPresent ? (object?)Capabilities.Value : Undefined.Value
    };
}

public sealed record ProfileSaveResultCapabilities : IWireModel
{
    public required bool Streaming { get; init; }
    public required bool Tools { get; init; }
    public required bool Continuation { get; init; }
    public required bool Cancellation { get; init; }
    public required bool Usage { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["streaming"] = Streaming,
        ["tools"] = Tools,
        ["continuation"] = Continuation,
        ["cancellation"] = Cancellation,
        ["usage"] = Usage
    };
}

public sealed record ProfileProbeResult : IWireModel
{
    public required bool Ok { get; init; }
    public required ProfileProbeResultCapabilities Capabilities { get; init; }
    public required string Detail { get; init; }
    public required string Fingerprint { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["ok"] = Ok,
        ["capabilities"] = Capabilities,
        ["detail"] = Detail,
        ["fingerprint"] = Fingerprint
    };
}

public sealed record ProfileProbeResultCapabilities : IWireModel
{
    public required bool Streaming { get; init; }
    public required bool Tools { get; init; }
    public required bool Continuation { get; init; }
    public required bool Cancellation { get; init; }
    public required bool Usage { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["streaming"] = Streaming,
        ["tools"] = Tools,
        ["continuation"] = Continuation,
        ["cancellation"] = Cancellation,
        ["usage"] = Usage
    };
}

public sealed record FilesListResultItem : IWireModel
{
    public required string Path { get; init; }
    public required string Kind { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["path"] = Path,
        ["kind"] = Kind
    };
}

public sealed record FilesReadResult : IWireModel
{
    public required string Path { get; init; }
    public required string Content { get; init; }
    public required string Hash { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["path"] = Path,
        ["content"] = Content,
        ["hash"] = Hash
    };
}

public sealed record TaskDiffResult : IWireModel
{
    public required string Summary { get; init; }
    public required string Patch { get; init; }
    public required bool Truncated { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["summary"] = Summary,
        ["patch"] = Patch,
        ["truncated"] = Truncated
    };
}

public sealed record ApprovalDecideResult : IWireModel
{
    public required bool Accepted { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["accepted"] = Accepted
    };
}

public sealed record WorkspaceSchemaResult : IWireModel
{
    public required double Version { get; init; }
    public required double Current { get; init; }
    public required bool UpgradeRequired { get; init; }
    public required bool CoordinatedAvailable { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["version"] = Version,
        ["current"] = Current,
        ["upgradeRequired"] = UpgradeRequired,
        ["coordinatedAvailable"] = CoordinatedAvailable
    };
}

public sealed record WorkspaceUpgradeResult : IWireModel
{
    public required double Version { get; init; }
    public required string BackupPath { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["version"] = Version,
        ["backupPath"] = BackupPath
    };
}

public sealed record OrchestrationGetResult : IWireModel
{
    public required string RootTaskId { get; init; }
    public required TaskStartResultVariant1Coordination Config { get; init; }
    public required IReadOnlyList<OrchestrationGetResultRunsItem> Runs { get; init; }
    public required double? RunsCursor { get; init; }
    public required IReadOnlyList<OrchestrationGetResultAssignmentsItem> Assignments { get; init; }
    public required IReadOnlyList<OrchestrationGetResultResultsItem> Results { get; init; }
    public required IReadOnlyList<OrchestrationGetResultIntegrationsItem> Integrations { get; init; }
    public required IReadOnlyList<OrchestrationGetResultEvidenceItem> Evidence { get; init; }
    public required OrchestrationGetResultBudget Budget { get; init; }
    public required IReadOnlyList<OrchestrationGetResultEventsItem> Events { get; init; }
    public required double? EventsCursor { get; init; }
    public required OrchestrationGetResultCompletion Completion { get; init; }
    public required bool Truncated { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["rootTaskId"] = RootTaskId,
        ["config"] = Config,
        ["runs"] = Runs,
        ["runsCursor"] = RunsCursor,
        ["assignments"] = Assignments,
        ["results"] = Results,
        ["integrations"] = Integrations,
        ["evidence"] = Evidence,
        ["budget"] = Budget,
        ["events"] = Events,
        ["eventsCursor"] = EventsCursor,
        ["completion"] = Completion,
        ["truncated"] = Truncated
    };
}

public sealed record OrchestrationGetResultRunsItem : IWireModel
{
    public required string TaskId { get; init; }
    public required string RootTaskId { get; init; }
    public required string? ParentTaskId { get; init; }
    public required string Role { get; init; }
    public required string? AssignmentId { get; init; }
    public required string Lifecycle { get; init; }
    public required string? WaitReason { get; init; }
    public required string? Outcome { get; init; }
    public required double Generation { get; init; }
    public required bool CancelRequested { get; init; }
    public required string Title { get; init; }
    public required string ProfileId { get; init; }
    public required string WorktreePath { get; init; }
    public required string Branch { get; init; }
    public required string BaseCommit { get; init; }
    public required string CreatedAt { get; init; }
    public required string UpdatedAt { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["taskId"] = TaskId,
        ["rootTaskId"] = RootTaskId,
        ["parentTaskId"] = ParentTaskId,
        ["role"] = Role,
        ["assignmentId"] = AssignmentId,
        ["lifecycle"] = Lifecycle,
        ["waitReason"] = WaitReason,
        ["outcome"] = Outcome,
        ["generation"] = Generation,
        ["cancelRequested"] = CancelRequested,
        ["title"] = Title,
        ["profileId"] = ProfileId,
        ["worktreePath"] = WorktreePath,
        ["branch"] = Branch,
        ["baseCommit"] = BaseCommit,
        ["createdAt"] = CreatedAt,
        ["updatedAt"] = UpdatedAt
    };
}

public sealed record OrchestrationGetResultAssignmentsItem : IWireModel
{
    public required string Id { get; init; }
    public required string RootTaskId { get; init; }
    public required double Revision { get; init; }
    public required string? SupersedesId { get; init; }
    public required string Key { get; init; }
    public required IReadOnlyList<string> DependsOn { get; init; }
    public required string CreatedBy { get; init; }
    public required string State { get; init; }
    public required string? ChildTaskId { get; init; }
    public required string? BaseCommit { get; init; }
    public required string? BaseTree { get; init; }
    public required string? WaitReason { get; init; }
    public required string CreatedAt { get; init; }
    public required string UpdatedAt { get; init; }
    public required string Objective { get; init; }
    public required IReadOnlyList<string> Acceptance { get; init; }
    public required IReadOnlyList<string> ReadPaths { get; init; }
    public required IReadOnlyList<string> WritePaths { get; init; }
    public required string ProfileId { get; init; }
    public required string ProfileFingerprint { get; init; }
    public required double Allocation { get; init; }
    public required TaskStartResultVariant1CoordinationRequiredValidation? Validation { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["id"] = Id,
        ["rootTaskId"] = RootTaskId,
        ["revision"] = Revision,
        ["supersedesId"] = SupersedesId,
        ["key"] = Key,
        ["dependsOn"] = DependsOn,
        ["createdBy"] = CreatedBy,
        ["state"] = State,
        ["childTaskId"] = ChildTaskId,
        ["baseCommit"] = BaseCommit,
        ["baseTree"] = BaseTree,
        ["waitReason"] = WaitReason,
        ["createdAt"] = CreatedAt,
        ["updatedAt"] = UpdatedAt,
        ["objective"] = Objective,
        ["acceptance"] = Acceptance,
        ["readPaths"] = ReadPaths,
        ["writePaths"] = WritePaths,
        ["profileId"] = ProfileId,
        ["profileFingerprint"] = ProfileFingerprint,
        ["allocation"] = Allocation,
        ["validation"] = Validation
    };
}

public sealed record OrchestrationGetResultResultsItem : IWireModel
{
    public required string Id { get; init; }
    public required string RootTaskId { get; init; }
    public required string AssignmentId { get; init; }
    public required string ChildTaskId { get; init; }
    public required double Revision { get; init; }
    public required string BaseCommit { get; init; }
    public required string Commit { get; init; }
    public required string Tree { get; init; }
    public required IReadOnlyList<string> ChangedPaths { get; init; }
    public required string ManifestSha256 { get; init; }
    public required IReadOnlyList<string> EvidenceIds { get; init; }
    public required string Summary { get; init; }
    public required string Unresolved { get; init; }
    public required string CreatedAt { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["id"] = Id,
        ["rootTaskId"] = RootTaskId,
        ["assignmentId"] = AssignmentId,
        ["childTaskId"] = ChildTaskId,
        ["revision"] = Revision,
        ["baseCommit"] = BaseCommit,
        ["commit"] = Commit,
        ["tree"] = Tree,
        ["changedPaths"] = ChangedPaths,
        ["manifestSha256"] = ManifestSha256,
        ["evidenceIds"] = EvidenceIds,
        ["summary"] = Summary,
        ["unresolved"] = Unresolved,
        ["createdAt"] = CreatedAt
    };
}

public sealed record OrchestrationGetResultIntegrationsItem : IWireModel
{
    public required string Id { get; init; }
    public required string RootTaskId { get; init; }
    public required string ResultId { get; init; }
    public required string AssignmentId { get; init; }
    public required string Kind { get; init; }
    public required string? ParentOperationId { get; init; }
    public required string State { get; init; }
    public required string? ApprovalId { get; init; }
    public required string ExpectedHead { get; init; }
    public required string ExpectedTree { get; init; }
    public required string SourceSha { get; init; }
    public required string ManifestSha256 { get; init; }
    public required string? ResolvedTree { get; init; }
    public required OrchestrationGetResultIntegrationsItemObserved? Observed { get; init; }
    public required string CreatedAt { get; init; }
    public required string UpdatedAt { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["id"] = Id,
        ["rootTaskId"] = RootTaskId,
        ["resultId"] = ResultId,
        ["assignmentId"] = AssignmentId,
        ["kind"] = Kind,
        ["parentOperationId"] = ParentOperationId,
        ["state"] = State,
        ["approvalId"] = ApprovalId,
        ["expectedHead"] = ExpectedHead,
        ["expectedTree"] = ExpectedTree,
        ["sourceSha"] = SourceSha,
        ["manifestSha256"] = ManifestSha256,
        ["resolvedTree"] = ResolvedTree,
        ["observed"] = Observed,
        ["createdAt"] = CreatedAt,
        ["updatedAt"] = UpdatedAt
    };
}

public sealed record OrchestrationGetResultIntegrationsItemObserved : IWireModel
{
    public Specified<string> Commit { get; init; }
    public Specified<string> Tree { get; init; }
    public Specified<string?> CherryPickHead { get; init; }
    public Specified<IReadOnlyList<string>> UnmergedPaths { get; init; }
    public Specified<string> Detail { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["commit"] = Commit.IsPresent ? (object?)Commit.Value : Undefined.Value,
        ["tree"] = Tree.IsPresent ? (object?)Tree.Value : Undefined.Value,
        ["cherryPickHead"] = CherryPickHead.IsPresent ? (object?)CherryPickHead.Value : Undefined.Value,
        ["unmergedPaths"] = UnmergedPaths.IsPresent ? (object?)UnmergedPaths.Value : Undefined.Value,
        ["detail"] = Detail.IsPresent ? (object?)Detail.Value : Undefined.Value
    };
}

public sealed record OrchestrationGetResultEvidenceItem : IWireModel
{
    public required string Id { get; init; }
    public required string RootTaskId { get; init; }
    public required string RunTaskId { get; init; }
    public required string ApprovalId { get; init; }
    public required string Kind { get; init; }
    public required string Command { get; init; }
    public required string Cwd { get; init; }
    public required string Head { get; init; }
    public required string Tree { get; init; }
    public required string? Branch { get; init; }
    public required bool Clean { get; init; }
    public required string StateFingerprint { get; init; }
    public required double? ExitCode { get; init; }
    public required bool CleanupVerified { get; init; }
    public required bool Passed { get; init; }
    public required string CreatedAt { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["id"] = Id,
        ["rootTaskId"] = RootTaskId,
        ["runTaskId"] = RunTaskId,
        ["approvalId"] = ApprovalId,
        ["kind"] = Kind,
        ["command"] = Command,
        ["cwd"] = Cwd,
        ["head"] = Head,
        ["tree"] = Tree,
        ["branch"] = Branch,
        ["clean"] = Clean,
        ["stateFingerprint"] = StateFingerprint,
        ["exitCode"] = ExitCode,
        ["cleanupVerified"] = CleanupVerified,
        ["passed"] = Passed,
        ["createdAt"] = CreatedAt
    };
}

public sealed record OrchestrationGetResultBudget : IWireModel
{
    public required double Cap { get; init; }
    public required double ProtectedCoordinator { get; init; }
    public required double Charged { get; init; }
    public required double InFlight { get; init; }
    public required double UnusedHolds { get; init; }
    public required double Unallocated { get; init; }
    public required double RetainedUnknown { get; init; }
    public required bool Overrun { get; init; }
    public required bool Warning { get; init; }
    public required IReadOnlyList<OrchestrationGetResultBudgetRunsItem> Runs { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["cap"] = Cap,
        ["protectedCoordinator"] = ProtectedCoordinator,
        ["charged"] = Charged,
        ["inFlight"] = InFlight,
        ["unusedHolds"] = UnusedHolds,
        ["unallocated"] = Unallocated,
        ["retainedUnknown"] = RetainedUnknown,
        ["overrun"] = Overrun,
        ["warning"] = Warning,
        ["runs"] = Runs
    };
}

public sealed record OrchestrationGetResultBudgetRunsItem : IWireModel
{
    public required string TaskId { get; init; }
    public required string Role { get; init; }
    public required double? Allocation { get; init; }
    public required double Charged { get; init; }
    public required double InFlight { get; init; }
    public required double UnusedHold { get; init; }
    public required bool Released { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["taskId"] = TaskId,
        ["role"] = Role,
        ["allocation"] = Allocation,
        ["charged"] = Charged,
        ["inFlight"] = InFlight,
        ["unusedHold"] = UnusedHold,
        ["released"] = Released
    };
}

public sealed record OrchestrationGetResultEventsItem : IWireModel
{
    public required double Sequence { get; init; }
    public required string Type { get; init; }
    public required object? Data { get; init; }
    public required string CreatedAt { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["sequence"] = Sequence,
        ["type"] = Type,
        ["data"] = Data,
        ["createdAt"] = CreatedAt
    };
}

public sealed record OrchestrationGetResultCompletion : IWireModel
{
    public required bool Complete { get; init; }
    public required string? CompletedAt { get; init; }
    public required IReadOnlyList<string> Blockers { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["complete"] = Complete,
        ["completedAt"] = CompletedAt,
        ["blockers"] = Blockers
    };
}

public sealed record OrchestrationChildResult : IWireModel
{
    public required OrchestrationGetResultRunsItem Run { get; init; }
    public required OrchestrationGetResultAssignmentsItem? Assignment { get; init; }
    public required IReadOnlyList<OrchestrationChildResultMessagesItem> Messages { get; init; }
    public required IReadOnlyList<OrchestrationChildResultApprovalsItem> Approvals { get; init; }
    public required IReadOnlyList<OrchestrationGetResultResultsItem> Results { get; init; }
    public required IReadOnlyList<OrchestrationGetResultEvidenceItem> Evidence { get; init; }
    public required bool Truncated { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["run"] = Run,
        ["assignment"] = Assignment,
        ["messages"] = Messages,
        ["approvals"] = Approvals,
        ["results"] = Results,
        ["evidence"] = Evidence,
        ["truncated"] = Truncated
    };
}

public sealed record OrchestrationChildResultMessagesItem : IWireModel
{
    public required string Id { get; init; }
    public required string Role { get; init; }
    public required string Content { get; init; }
    public required string Status { get; init; }
    public required string CreatedAt { get; init; }
    public required bool Truncated { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["id"] = Id,
        ["role"] = Role,
        ["content"] = Content,
        ["status"] = Status,
        ["createdAt"] = CreatedAt,
        ["truncated"] = Truncated
    };
}

public sealed record OrchestrationChildResultApprovalsItem : IWireModel
{
    public required string Id { get; init; }
    public required string TaskId { get; init; }
    public required string Tool { get; init; }
    public required string State { get; init; }
    public required string CreatedAt { get; init; }
    public Specified<string> Path { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["id"] = Id,
        ["taskId"] = TaskId,
        ["tool"] = Tool,
        ["state"] = State,
        ["createdAt"] = CreatedAt,
        ["path"] = Path.IsPresent ? (object?)Path.Value : Undefined.Value
    };
}

public sealed record OrchestrationCancelChildResult : IWireModel
{
    public required bool Accepted { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["accepted"] = Accepted
    };
}

public sealed record OrchestrationCancelRootResult : IWireModel
{
    public required bool Accepted { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["accepted"] = Accepted
    };
}

public sealed record OrchestrationResumeResult : IWireModel
{
    public required bool Accepted { get; init; }
    public required double Delivered { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["accepted"] = Accepted,
        ["delivered"] = Delivered
    };
}

public sealed record OrchestrationReviseAssignmentResult : IWireModel
{
    public required string AssignmentId { get; init; }
    public required double Revision { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["assignmentId"] = AssignmentId,
        ["revision"] = Revision
    };
}

public sealed record OrchestrationDecideResult : IWireModel
{
    public required bool Accepted { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["accepted"] = Accepted
    };
}

public sealed record OrchestrationReconcileResult : IWireModel
{
    public required string Kind { get; init; }
    public required string Detail { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["kind"] = Kind,
        ["detail"] = Detail
    };
}

public sealed record OrchestrationPrepareContinueResult : IWireModel
{
    public required string ApprovalId { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["approvalId"] = ApprovalId
    };
}

public sealed record TaskCompactResult : IWireModel
{
    public required string Id { get; init; }
    public required string TaskId { get; init; }
    public required double FromOrdinal { get; init; }
    public required double ToOrdinal { get; init; }
    public required IReadOnlyList<string> MessageIds { get; init; }
    public required string Summary { get; init; }
    public required double EstimatedTokensBefore { get; init; }
    public required double EstimatedTokensAfter { get; init; }
    public required string CreatedAt { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["id"] = Id,
        ["taskId"] = TaskId,
        ["fromOrdinal"] = FromOrdinal,
        ["toOrdinal"] = ToOrdinal,
        ["messageIds"] = MessageIds,
        ["summary"] = Summary,
        ["estimatedTokensBefore"] = EstimatedTokensBefore,
        ["estimatedTokensAfter"] = EstimatedTokensAfter,
        ["createdAt"] = CreatedAt
    };
}

public sealed record TaskUsageResult : IWireModel
{
    public required string TaskId { get; init; }
    public required double TokenBudget { get; init; }
    public required double UsedTokens { get; init; }
    public required double ContextLimit { get; init; }
    public required double OutputLimit { get; init; }
    public required double EstimatedContextTokens { get; init; }
    public required double ContextPercent { get; init; }
    public required double WarningPercent { get; init; }
    public required TaskUsageResultTotals Totals { get; init; }
    public required IReadOnlyList<TaskUsageResultRecordsItem> Records { get; init; }
    public required IReadOnlyList<TaskUsageResultCompactionsItem> Compactions { get; init; }
    public Specified<double?> RecordsNextBefore { get; init; }
    public Specified<double?> CompactionsNextBefore { get; init; }
    public Specified<UsageSummaryResultTotals> Metrics { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["taskId"] = TaskId,
        ["tokenBudget"] = TokenBudget,
        ["usedTokens"] = UsedTokens,
        ["contextLimit"] = ContextLimit,
        ["outputLimit"] = OutputLimit,
        ["estimatedContextTokens"] = EstimatedContextTokens,
        ["contextPercent"] = ContextPercent,
        ["warningPercent"] = WarningPercent,
        ["totals"] = Totals,
        ["records"] = Records,
        ["compactions"] = Compactions,
        ["recordsNextBefore"] = RecordsNextBefore.IsPresent ? (object?)RecordsNextBefore.Value : Undefined.Value,
        ["compactionsNextBefore"] = CompactionsNextBefore.IsPresent ? (object?)CompactionsNextBefore.Value : Undefined.Value,
        ["metrics"] = Metrics.IsPresent ? (object?)Metrics.Value : Undefined.Value
    };
}

public sealed record TaskUsageResultTotals : IWireModel
{
    public required double Requests { get; init; }
    public required double KnownRequests { get; init; }
    public required double UnknownRequests { get; init; }
    public required double Prompt { get; init; }
    public required double Completion { get; init; }
    public required double CacheRead { get; init; }
    public required double CacheCreation { get; init; }
    public required double ReservedUnknown { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["requests"] = Requests,
        ["knownRequests"] = KnownRequests,
        ["unknownRequests"] = UnknownRequests,
        ["prompt"] = Prompt,
        ["completion"] = Completion,
        ["cacheRead"] = CacheRead,
        ["cacheCreation"] = CacheCreation,
        ["reservedUnknown"] = ReservedUnknown
    };
}

public sealed record TaskUsageResultRecordsItem : IWireModel
{
    public required string Id { get; init; }
    public required string TaskId { get; init; }
    public required string RequestId { get; init; }
    public required double ReservedTokens { get; init; }
    public required double? PromptTokens { get; init; }
    public required double? CompletionTokens { get; init; }
    public required double? CacheReadTokens { get; init; }
    public required double? CacheCreationTokens { get; init; }
    public required bool UsageKnown { get; init; }
    public required string? Reason { get; init; }
    public required string CreatedAt { get; init; }
    public Specified<string> Outcome { get; init; }
    public Specified<string?> AttemptedAt { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["id"] = Id,
        ["taskId"] = TaskId,
        ["requestId"] = RequestId,
        ["reservedTokens"] = ReservedTokens,
        ["promptTokens"] = PromptTokens,
        ["completionTokens"] = CompletionTokens,
        ["cacheReadTokens"] = CacheReadTokens,
        ["cacheCreationTokens"] = CacheCreationTokens,
        ["usageKnown"] = UsageKnown,
        ["reason"] = Reason,
        ["createdAt"] = CreatedAt,
        ["outcome"] = Outcome.IsPresent ? (object?)Outcome.Value : Undefined.Value,
        ["attemptedAt"] = AttemptedAt.IsPresent ? (object?)AttemptedAt.Value : Undefined.Value
    };
}

public sealed record TaskUsageResultCompactionsItem : IWireModel
{
    public required string Id { get; init; }
    public required string TaskId { get; init; }
    public required double FromOrdinal { get; init; }
    public required double ToOrdinal { get; init; }
    public required double MessageCount { get; init; }
    public required string SummaryExcerpt { get; init; }
    public required bool SummaryTruncated { get; init; }
    public required double EstimatedTokensBefore { get; init; }
    public required double EstimatedTokensAfter { get; init; }
    public required string CreatedAt { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["id"] = Id,
        ["taskId"] = TaskId,
        ["fromOrdinal"] = FromOrdinal,
        ["toOrdinal"] = ToOrdinal,
        ["messageCount"] = MessageCount,
        ["summaryExcerpt"] = SummaryExcerpt,
        ["summaryTruncated"] = SummaryTruncated,
        ["estimatedTokensBefore"] = EstimatedTokensBefore,
        ["estimatedTokensAfter"] = EstimatedTokensAfter,
        ["createdAt"] = CreatedAt
    };
}

public sealed record DiagnosticsExportResult : IWireModel
{
    public required string Path { get; init; }
    public required double Bytes { get; init; }
    public required string Sha256 { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["path"] = Path,
        ["bytes"] = Bytes,
        ["sha256"] = Sha256
    };
}

public sealed record TaskCommitResult : IWireModel
{
    public required string Commit { get; init; }
    public required string Branch { get; init; }
    public required IReadOnlyList<string> ChangedPaths { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["commit"] = Commit,
        ["branch"] = Branch,
        ["changedPaths"] = ChangedPaths
    };
}

public sealed record TaskPushResult : IWireModel
{
    public required string Remote { get; init; }
    public required string Branch { get; init; }
    public required string Detail { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["remote"] = Remote,
        ["branch"] = Branch,
        ["detail"] = Detail
    };
}

public sealed record TaskReconcilePublicationResult : IWireModel
{
    public required bool Reconciled { get; init; }
    public required string Detail { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["reconciled"] = Reconciled,
        ["detail"] = Detail
    };
}

public sealed record TaskRetireResult : IWireModel
{
    public required string TaskId { get; init; }
    public required string Branch { get; init; }
    public required IReadOnlyList<string> RemovedWorktrees { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["taskId"] = TaskId,
        ["branch"] = Branch,
        ["removedWorktrees"] = RemovedWorktrees
    };
}

public sealed record McpListResult : IWireModel
{
    public required IReadOnlyList<McpListResultItemsItem> Items { get; init; }
    public required string? NextCursor { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["items"] = Items,
        ["nextCursor"] = NextCursor
    };
}

public sealed record McpListResultItemsItem : IWireModel
{
    public required double ArgumentCount { get; init; }
    public required double EnvironmentCount { get; init; }
    public required IReadOnlyList<string> EnvironmentNames { get; init; }
    public required IReadOnlyList<McpListResultItemsItemToolsItem> Tools { get; init; }
    public required string? ToolsListedAt { get; init; }
    public required McpListResultItemsItemServerInfo? ServerInfo { get; init; }
    public required string? LastError { get; init; }
    public required bool Running { get; init; }
    public required string Name { get; init; }
    public required string Command { get; init; }
    public required string Cwd { get; init; }
    public required string Id { get; init; }
    public required string Key { get; init; }
    public required bool Enabled { get; init; }
    public required IReadOnlyList<string> ReadOnlyTools { get; init; }
    public required double CallTimeoutMs { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["argumentCount"] = ArgumentCount,
        ["environmentCount"] = EnvironmentCount,
        ["environmentNames"] = EnvironmentNames,
        ["tools"] = Tools,
        ["toolsListedAt"] = ToolsListedAt,
        ["serverInfo"] = ServerInfo,
        ["lastError"] = LastError,
        ["running"] = Running,
        ["name"] = Name,
        ["command"] = Command,
        ["cwd"] = Cwd,
        ["id"] = Id,
        ["key"] = Key,
        ["enabled"] = Enabled,
        ["readOnlyTools"] = ReadOnlyTools,
        ["callTimeoutMs"] = CallTimeoutMs
    };
}

public sealed record McpListResultItemsItemToolsItem : IWireModel
{
    public required string Name { get; init; }
    public required string Description { get; init; }
    public required bool ReadOnlyHint { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["name"] = Name,
        ["description"] = Description,
        ["readOnlyHint"] = ReadOnlyHint
    };
}

public sealed record McpListResultItemsItemServerInfo : IWireModel
{
    public required string Name { get; init; }
    public required string Version { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["name"] = Name,
        ["version"] = Version
    };
}

public sealed record McpGetConfigResult : IWireModel
{
    public required string Id { get; init; }
    public required string Key { get; init; }
    public required string Name { get; init; }
    public required string Command { get; init; }
    public required IReadOnlyList<string> Arguments { get; init; }
    public required string Cwd { get; init; }
    public required IReadOnlyDictionary<string, string> Environment { get; init; }
    public required bool Enabled { get; init; }
    public required IReadOnlyList<string> ReadOnlyTools { get; init; }
    public required double CallTimeoutMs { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["id"] = Id,
        ["key"] = Key,
        ["name"] = Name,
        ["command"] = Command,
        ["arguments"] = Arguments,
        ["cwd"] = Cwd,
        ["environment"] = Environment,
        ["enabled"] = Enabled,
        ["readOnlyTools"] = ReadOnlyTools,
        ["callTimeoutMs"] = CallTimeoutMs
    };
}

public sealed record McpRemoveResult : IWireModel
{
    public required bool Removed { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["removed"] = Removed
    };
}

public sealed record WorkspaceSummaryResult : IWireModel
{
    public required IReadOnlyList<ProfileSaveResult> Profiles { get; init; }
    public required string? NextProfileAfter { get; init; }
    public required IReadOnlyList<ProjectAddResult> Projects { get; init; }
    public required string? NextProjectAfter { get; init; }
    public required WorkspacePreferencesSaveResult Preferences { get; init; }
    public required double LastSequence { get; init; }
    public required string Runtime { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["profiles"] = Profiles,
        ["nextProfileAfter"] = NextProfileAfter,
        ["projects"] = Projects,
        ["nextProjectAfter"] = NextProjectAfter,
        ["preferences"] = Preferences,
        ["lastSequence"] = LastSequence,
        ["runtime"] = Runtime
    };
}

public sealed record WorkspaceProfilesResult : IWireModel
{
    public required IReadOnlyList<ProfileSaveResult> Profiles { get; init; }
    public required string? NextAfter { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["profiles"] = Profiles,
        ["nextAfter"] = NextAfter
    };
}

public sealed record WorkspaceProjectsResult : IWireModel
{
    public required IReadOnlyList<ProjectAddResult> Projects { get; init; }
    public required string? NextAfter { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["projects"] = Projects,
        ["nextAfter"] = NextAfter
    };
}

public sealed record WorkspaceTasksResult : IWireModel
{
    public required IReadOnlyList<TaskStartResult> Tasks { get; init; }
    public required WorkspaceTasksResultNextCursor? NextCursor { get; init; }
    public required string Visibility { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["tasks"] = Tasks,
        ["nextCursor"] = NextCursor,
        ["visibility"] = Visibility
    };
}

public sealed record WorkspaceTasksResultNextCursor : IWireModel
{
    public required string At { get; init; }
    public required string Id { get; init; }
    public required string HighWaterAt { get; init; }
    public required string HighWaterId { get; init; }
    public required string FilterHash { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["at"] = At,
        ["id"] = Id,
        ["highWaterAt"] = HighWaterAt,
        ["highWaterId"] = HighWaterId,
        ["filterHash"] = FilterHash
    };
}

public sealed record WorkspaceSearchResult : IWireModel
{
    public required IReadOnlyList<WorkspaceSearchResultHitsItem> Hits { get; init; }
    public required WorkspaceSearchResultNextCursor? NextCursor { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["hits"] = Hits,
        ["nextCursor"] = NextCursor
    };
}

public sealed record WorkspaceSearchResultHitsItem : IWireModel
{
    public required string TaskId { get; init; }
    public required string RootTaskId { get; init; }
    public required string TaskTitle { get; init; }
    public Specified<string> MessageId { get; init; }
    public Specified<double> Ordinal { get; init; }
    public Specified<string> Role { get; init; }
    public required string Excerpt { get; init; }
    public required string CreatedAt { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["taskId"] = TaskId,
        ["rootTaskId"] = RootTaskId,
        ["taskTitle"] = TaskTitle,
        ["messageId"] = MessageId.IsPresent ? (object?)MessageId.Value : Undefined.Value,
        ["ordinal"] = Ordinal.IsPresent ? (object?)Ordinal.Value : Undefined.Value,
        ["role"] = Role.IsPresent ? (object?)Role.Value : Undefined.Value,
        ["excerpt"] = Excerpt,
        ["createdAt"] = CreatedAt
    };
}

public sealed record WorkspaceSearchResultNextCursor : IWireModel
{
    public required string Phase { get; init; }
    public required double ThroughOrdinal { get; init; }
    public required double TaskThroughRowid { get; init; }
    public required string FilterHash { get; init; }
    public Specified<WorkspaceSearchResultNextCursorTitleAfter> TitleAfter { get; init; }
    public Specified<double> BeforeOrdinal { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["phase"] = Phase,
        ["throughOrdinal"] = ThroughOrdinal,
        ["taskThroughRowid"] = TaskThroughRowid,
        ["filterHash"] = FilterHash,
        ["titleAfter"] = TitleAfter.IsPresent ? (object?)TitleAfter.Value : Undefined.Value,
        ["beforeOrdinal"] = BeforeOrdinal.IsPresent ? (object?)BeforeOrdinal.Value : Undefined.Value
    };
}

public sealed record WorkspaceSearchResultNextCursorTitleAfter : IWireModel
{
    public required string At { get; init; }
    public required string Id { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["at"] = At,
        ["id"] = Id
    };
}

public sealed record WorkspaceActionsResult : IWireModel
{
    public required IReadOnlyList<WorkspaceActionsResultItemsItem> Items { get; init; }
    public required bool HasMore { get; init; }
    public required WorkspaceActionsResultNextCursor? NextCursor { get; init; }
    public required WorkspaceActionsResultCounts Counts { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["items"] = Items,
        ["hasMore"] = HasMore,
        ["nextCursor"] = NextCursor,
        ["counts"] = Counts
    };
}

public sealed record WorkspaceActionsResultItemsItem : IWireModel
{
    public required string Id { get; init; }
    public required string? TaskId { get; init; }
    public Specified<string> SourceTaskId { get; init; }
    public required string TaskTitle { get; init; }
    public required bool Archived { get; init; }
    public required double Tier { get; init; }
    public required string Kind { get; init; }
    public required string State { get; init; }
    public required string SourceId { get; init; }
    public required string CreatedAt { get; init; }
    public required string Detail { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["id"] = Id,
        ["taskId"] = TaskId,
        ["sourceTaskId"] = SourceTaskId.IsPresent ? (object?)SourceTaskId.Value : Undefined.Value,
        ["taskTitle"] = TaskTitle,
        ["archived"] = Archived,
        ["tier"] = Tier,
        ["kind"] = Kind,
        ["state"] = State,
        ["sourceId"] = SourceId,
        ["createdAt"] = CreatedAt,
        ["detail"] = Detail
    };
}

public sealed record WorkspaceActionsResultNextCursor : IWireModel
{
    public required double Tier { get; init; }
    public required string At { get; init; }
    public required string Id { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["tier"] = Tier,
        ["at"] = At,
        ["id"] = Id
    };
}

public sealed record WorkspaceActionsResultCounts : IWireModel
{
    public required double NeedsDecision { get; init; }
    public required double InProgress { get; init; }
    public required double Recent { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["needsDecision"] = NeedsDecision,
        ["inProgress"] = InProgress,
        ["recent"] = Recent
    };
}

public sealed record WorkspaceEventsResult : IWireModel
{
    public required IReadOnlyList<WorkspaceEventsResultEventsItem> Events { get; init; }
    public required double? NextAfter { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["events"] = Events,
        ["nextAfter"] = NextAfter
    };
}

public sealed record WorkspaceEventsResultEventsItem : IWireModel
{
    public required double Sequence { get; init; }
    public required string Type { get; init; }
    public Specified<string> TaskId { get; init; }
    public Specified<string> RootTaskId { get; init; }
    public required object? Data { get; init; }
    public required string CreatedAt { get; init; }
    public Specified<double> Version { get; init; }
    public Specified<string> Source { get; init; }
    public Specified<bool> Legacy { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["sequence"] = Sequence,
        ["type"] = Type,
        ["taskId"] = TaskId.IsPresent ? (object?)TaskId.Value : Undefined.Value,
        ["rootTaskId"] = RootTaskId.IsPresent ? (object?)RootTaskId.Value : Undefined.Value,
        ["data"] = Data,
        ["createdAt"] = CreatedAt,
        ["version"] = Version.IsPresent ? (object?)Version.Value : Undefined.Value,
        ["source"] = Source.IsPresent ? (object?)Source.Value : Undefined.Value,
        ["legacy"] = Legacy.IsPresent ? (object?)Legacy.Value : Undefined.Value
    };
}

public sealed record WorkspaceUsageTrendResult : IWireModel
{
    public required string GroupBy { get; init; }
    public required IReadOnlyList<WorkspaceUsageTrendResultBucketsItem> Buckets { get; init; }
    public required string? NextAfter { get; init; }
    public required string TimeZone { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["groupBy"] = GroupBy,
        ["buckets"] = Buckets,
        ["nextAfter"] = NextAfter,
        ["timeZone"] = TimeZone
    };
}

public sealed record WorkspaceUsageTrendResultBucketsItem : IWireModel
{
    public required string Key { get; init; }
    public required double Requests { get; init; }
    public required double KnownRequests { get; init; }
    public required double UnknownRequests { get; init; }
    public required double PendingRequests { get; init; }
    public required double NotSentRequests { get; init; }
    public required double ObservedPrompt { get; init; }
    public required double ObservedCompletion { get; init; }
    public required double CacheRead { get; init; }
    public required double CacheCreation { get; init; }
    public required double ReservedUnknown { get; init; }
    public required double ReservedPending { get; init; }
    public required double ReservedNotSent { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["key"] = Key,
        ["requests"] = Requests,
        ["knownRequests"] = KnownRequests,
        ["unknownRequests"] = UnknownRequests,
        ["pendingRequests"] = PendingRequests,
        ["notSentRequests"] = NotSentRequests,
        ["observedPrompt"] = ObservedPrompt,
        ["observedCompletion"] = ObservedCompletion,
        ["cacheRead"] = CacheRead,
        ["cacheCreation"] = CacheCreation,
        ["reservedUnknown"] = ReservedUnknown,
        ["reservedPending"] = ReservedPending,
        ["reservedNotSent"] = ReservedNotSent
    };
}

public sealed record TaskTimelineResult : IWireModel
{
    public required IReadOnlyList<WorkspaceEventsResultEventsItem> Events { get; init; }
    public required double? NextBefore { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["events"] = Events,
        ["nextBefore"] = NextBefore
    };
}

public sealed record TaskReadResult : IWireModel
{
    public required TaskStartResult Task { get; init; }
    public required double CompactionCount { get; init; }
    public required double PendingApprovals { get; init; }
    public required double UnknownOutcomes { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["task"] = Task,
        ["compactionCount"] = CompactionCount,
        ["pendingApprovals"] = PendingApprovals,
        ["unknownOutcomes"] = UnknownOutcomes
    };
}

public sealed record TaskMessagesResult : IWireModel
{
    public required IReadOnlyList<TaskMessagesResultItemsItem> Items { get; init; }
    public required double? NextBefore { get; init; }
    public required double Through { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["items"] = Items,
        ["nextBefore"] = NextBefore,
        ["through"] = Through
    };
}

public sealed record TaskMessagesResultItemsItem : IWireModel
{
    public required TaskMessagesResultItemsItemMessage Message { get; init; }
    public required double Ordinal { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["message"] = Message,
        ["ordinal"] = Ordinal
    };
}

public sealed record TaskMessagesResultItemsItemMessage : IWireModel
{
    public required string Id { get; init; }
    public required string TaskId { get; init; }
    public required string Role { get; init; }
    public required string Content { get; init; }
    public required string CreatedAt { get; init; }
    public required string Status { get; init; }
    public Specified<bool> Truncated { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["id"] = Id,
        ["taskId"] = TaskId,
        ["role"] = Role,
        ["content"] = Content,
        ["createdAt"] = CreatedAt,
        ["status"] = Status,
        ["truncated"] = Truncated.IsPresent ? (object?)Truncated.Value : Undefined.Value
    };
}

public sealed record TaskMessageContentResult : IWireModel
{
    public required string MessageId { get; init; }
    public required string Content { get; init; }
    public required double Offset { get; init; }
    public required double? NextOffset { get; init; }
    public required double TotalBytes { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["messageId"] = MessageId,
        ["content"] = Content,
        ["offset"] = Offset,
        ["nextOffset"] = NextOffset,
        ["totalBytes"] = TotalBytes
    };
}

public sealed record TaskUsageRecordsResult : IWireModel
{
    public required IReadOnlyList<TaskUsageResultRecordsItem> Records { get; init; }
    public required double? NextBefore { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["records"] = Records,
        ["nextBefore"] = NextBefore
    };
}

public sealed record TaskCompactionsResult : IWireModel
{
    public required IReadOnlyList<TaskUsageResultCompactionsItem> Compactions { get; init; }
    public required double? NextBefore { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["compactions"] = Compactions,
        ["nextBefore"] = NextBefore
    };
}

public sealed record TaskCompactionContentResult : IWireModel
{
    public required string CompactionId { get; init; }
    public required string Content { get; init; }
    public required double Offset { get; init; }
    public required double? NextOffset { get; init; }
    public required double TotalBytes { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["compactionId"] = CompactionId,
        ["content"] = Content,
        ["offset"] = Offset,
        ["nextOffset"] = NextOffset,
        ["totalBytes"] = TotalBytes
    };
}

public sealed record TaskApprovalsResult : IWireModel
{
    public required IReadOnlyList<OrchestrationChildResultApprovalsItem> Approvals { get; init; }
    public required double? NextBefore { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["approvals"] = Approvals,
        ["nextBefore"] = NextBefore
    };
}

public sealed record ApprovalGetResult : IWireModel
{
    public required BrowserAcknowledgeUnknownResult Approval { get; init; }
    public required IReadOnlyList<string> TruncatedFields { get; init; }
    public required double FullBytes { get; init; }
    public required bool Redacted { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["approval"] = Approval,
        ["truncatedFields"] = TruncatedFields,
        ["fullBytes"] = FullBytes,
        ["redacted"] = Redacted
    };
}

public sealed record ApprovalContentResult : IWireModel
{
    public required string ApprovalId { get; init; }
    public required string Field { get; init; }
    public required string Content { get; init; }
    public required double Offset { get; init; }
    public required double? NextOffset { get; init; }
    public required double TotalBytes { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["approvalId"] = ApprovalId,
        ["field"] = Field,
        ["content"] = Content,
        ["offset"] = Offset,
        ["nextOffset"] = NextOffset,
        ["totalBytes"] = TotalBytes
    };
}

public sealed record AutomationListResult : IWireModel
{
    public required IReadOnlyList<AutomationListResultRulesItem> Rules { get; init; }
    public required IReadOnlyList<AutomationListResultScriptsItem> Scripts { get; init; }
    public required IReadOnlyList<AutomationListResultSchedulesItem> Schedules { get; init; }
    public required IReadOnlyList<AutomationListResultDraftsItem> Drafts { get; init; }
    public required IReadOnlyList<AutomationListResultRunsItem> Runs { get; init; }
    public required bool Truncated { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["rules"] = Rules,
        ["scripts"] = Scripts,
        ["schedules"] = Schedules,
        ["drafts"] = Drafts,
        ["runs"] = Runs,
        ["truncated"] = Truncated
    };
}

public sealed record AutomationListResultRulesItem : IWireModel
{
    public required string Id { get; init; }
    public required double Version { get; init; }
    public required string Name { get; init; }
    public required bool Enabled { get; init; }
    public required IReadOnlyList<string> Triggers { get; init; }
    public required string? ProjectPath { get; init; }
    public required string Action { get; init; }
    public required string Title { get; init; }
    public required string Body { get; init; }
    public Specified<string> TaskId { get; init; }
    public Specified<AutomationListResultRulesItemConditions> Conditions { get; init; }
    public Specified<AutomationListResultRulesItemProposal> Proposal { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["id"] = Id,
        ["version"] = Version,
        ["name"] = Name,
        ["enabled"] = Enabled,
        ["triggers"] = Triggers,
        ["projectPath"] = ProjectPath,
        ["action"] = Action,
        ["title"] = Title,
        ["body"] = Body,
        ["taskId"] = TaskId.IsPresent ? (object?)TaskId.Value : Undefined.Value,
        ["conditions"] = Conditions.IsPresent ? (object?)Conditions.Value : Undefined.Value,
        ["proposal"] = Proposal.IsPresent ? (object?)Proposal.Value : Undefined.Value
    };
}

public sealed record AutomationListResultRulesItemConditions : IWireModel
{
    public Specified<string> Status { get; init; }
    public Specified<string> Mode { get; init; }
    public Specified<string> ApprovalState { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["status"] = Status.IsPresent ? (object?)Status.Value : Undefined.Value,
        ["mode"] = Mode.IsPresent ? (object?)Mode.Value : Undefined.Value,
        ["approvalState"] = ApprovalState.IsPresent ? (object?)ApprovalState.Value : Undefined.Value
    };
}

public sealed record AutomationListResultRulesItemProposal : IWireModel
{
    public required string Tool { get; init; }
    public required IReadOnlyDictionary<string, object?> Arguments { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["tool"] = Tool,
        ["arguments"] = Arguments
    };
}

public sealed record AutomationListResultScriptsItem : IWireModel
{
    public required AutomationListResultScriptsItemRegistration Registration { get; init; }
    public required AutomationListResultScriptsItemRevision Revision { get; init; }
    public required AutomationListResultScriptsItemGrant? Grant { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["registration"] = Registration,
        ["revision"] = Revision,
        ["grant"] = Grant
    };
}

public sealed record AutomationListResultScriptsItemRegistration : IWireModel
{
    public required string Name { get; init; }
    public required string Cwd { get; init; }
    public required double TimeoutMs { get; init; }
    public required string? ProjectPath { get; init; }
    public required string Id { get; init; }
    public required IReadOnlyList<string> Arguments { get; init; }
    public required IReadOnlyList<string> Triggers { get; init; }
    public required string Language { get; init; }
    public required IReadOnlyList<string> InputFields { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["name"] = Name,
        ["cwd"] = Cwd,
        ["timeoutMs"] = TimeoutMs,
        ["projectPath"] = ProjectPath,
        ["id"] = Id,
        ["arguments"] = Arguments,
        ["triggers"] = Triggers,
        ["language"] = Language,
        ["inputFields"] = InputFields
    };
}

public sealed record AutomationListResultScriptsItemRevision : IWireModel
{
    public required string Id { get; init; }
    public required string ScriptId { get; init; }
    public required string Sha256 { get; init; }
    public required string InterpreterPath { get; init; }
    public required string InterpreterSha256 { get; init; }
    public required string InterpreterVersion { get; init; }
    public required string SnapshotPath { get; init; }
    public required string ConfigSha256 { get; init; }
    public required string RegisteredAt { get; init; }
    public required bool Trusted { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["id"] = Id,
        ["scriptId"] = ScriptId,
        ["sha256"] = Sha256,
        ["interpreterPath"] = InterpreterPath,
        ["interpreterSha256"] = InterpreterSha256,
        ["interpreterVersion"] = InterpreterVersion,
        ["snapshotPath"] = SnapshotPath,
        ["configSha256"] = ConfigSha256,
        ["registeredAt"] = RegisteredAt,
        ["trusted"] = Trusted
    };
}

public sealed record AutomationListResultScriptsItemGrant : IWireModel
{
    public required string Id { get; init; }
    public required string GrantedAt { get; init; }
    public required string RevisionId { get; init; }
    public required string ExpiresAt { get; init; }
    public required double MaxRunsPer24h { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["id"] = Id,
        ["grantedAt"] = GrantedAt,
        ["revisionId"] = RevisionId,
        ["expiresAt"] = ExpiresAt,
        ["maxRunsPer24h"] = MaxRunsPer24h
    };
}

public sealed record AutomationListResultSchedulesItem : IWireModel
{
    public required string Id { get; init; }
    public required string Name { get; init; }
    public required bool Enabled { get; init; }
    public required string? ProjectPath { get; init; }
    public required string? TaskId { get; init; }
    public required string Kind { get; init; }
    public required string Title { get; init; }
    public required string Body { get; init; }
    public required string Cadence { get; init; }
    public required string LocalTime { get; init; }
    public required string TimeZone { get; init; }
    public required string StartAt { get; init; }
    public required double? WeekDay { get; init; }
    public Specified<string> StartDate { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["id"] = Id,
        ["name"] = Name,
        ["enabled"] = Enabled,
        ["projectPath"] = ProjectPath,
        ["taskId"] = TaskId,
        ["kind"] = Kind,
        ["title"] = Title,
        ["body"] = Body,
        ["cadence"] = Cadence,
        ["localTime"] = LocalTime,
        ["timeZone"] = TimeZone,
        ["startAt"] = StartAt,
        ["weekDay"] = WeekDay,
        ["startDate"] = StartDate.IsPresent ? (object?)StartDate.Value : Undefined.Value
    };
}

public sealed record AutomationListResultDraftsItem : IWireModel
{
    public required string Id { get; init; }
    public required string Source { get; init; }
    public required string SourceId { get; init; }
    public required string? TaskId { get; init; }
    public required string Kind { get; init; }
    public required string Title { get; init; }
    public required string Body { get; init; }
    public Specified<AutomationListResultRulesItemProposal> Proposal { get; init; }
    public required string State { get; init; }
    public Specified<string> ApprovalId { get; init; }
    public required string CreatedAt { get; init; }
    public Specified<AutomationListResultDraftsItemOccurrence> Occurrence { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["id"] = Id,
        ["source"] = Source,
        ["sourceId"] = SourceId,
        ["taskId"] = TaskId,
        ["kind"] = Kind,
        ["title"] = Title,
        ["body"] = Body,
        ["proposal"] = Proposal.IsPresent ? (object?)Proposal.Value : Undefined.Value,
        ["state"] = State,
        ["approvalId"] = ApprovalId.IsPresent ? (object?)ApprovalId.Value : Undefined.Value,
        ["createdAt"] = CreatedAt,
        ["occurrence"] = Occurrence.IsPresent ? (object?)Occurrence.Value : Undefined.Value
    };
}

public sealed record AutomationListResultDraftsItemOccurrence : IWireModel
{
    public required string Revision { get; init; }
    public required string LocalDate { get; init; }
    public required string LocalTime { get; init; }
    public required string TimeZone { get; init; }
    public required string DueAt { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["revision"] = Revision,
        ["localDate"] = LocalDate,
        ["localTime"] = LocalTime,
        ["timeZone"] = TimeZone,
        ["dueAt"] = DueAt
    };
}

public sealed record AutomationListResultRunsItem : IWireModel
{
    public required string Id { get; init; }
    public required string RuleId { get; init; }
    public required double RuleVersion { get; init; }
    public required double EventSequence { get; init; }
    public required string State { get; init; }
    public required string CreatedAt { get; init; }
    public required string UpdatedAt { get; init; }
    public Specified<string> Detail { get; init; }
    public Specified<AutomationListResultScriptsItemGrant> GrantSnapshot { get; init; }
    public Specified<AutomationListResultRunsItemPin> Pin { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["id"] = Id,
        ["ruleId"] = RuleId,
        ["ruleVersion"] = RuleVersion,
        ["eventSequence"] = EventSequence,
        ["state"] = State,
        ["createdAt"] = CreatedAt,
        ["updatedAt"] = UpdatedAt,
        ["detail"] = Detail.IsPresent ? (object?)Detail.Value : Undefined.Value,
        ["grantSnapshot"] = GrantSnapshot.IsPresent ? (object?)GrantSnapshot.Value : Undefined.Value,
        ["pin"] = Pin.IsPresent ? (object?)Pin.Value : Undefined.Value
    };
}

public sealed record AutomationListResultRunsItemPin : IWireModel
{
    public required string RevisionId { get; init; }
    public required string ScriptId { get; init; }
    public required string SourceSha256 { get; init; }
    public required string InterpreterSha256 { get; init; }
    public required string ConfigSha256 { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["revisionId"] = RevisionId,
        ["scriptId"] = ScriptId,
        ["sourceSha256"] = SourceSha256,
        ["interpreterSha256"] = InterpreterSha256,
        ["configSha256"] = ConfigSha256
    };
}

public sealed record AutomationQueryResult : IWireModel
{
    public required string Kind { get; init; }
    public required IReadOnlyList<AutomationQueryResultItemsItem> Items { get; init; }
    public required double? NextCursor { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["kind"] = Kind,
        ["items"] = Items,
        ["nextCursor"] = NextCursor
    };
}

public abstract record AutomationQueryResultItemsItem : IWireModel
{
    public abstract Dictionary<string, object?> ToWire();
}

public sealed record AutomationQueryResultItemsItemVariant1 : AutomationQueryResultItemsItem
{
    public required string Id { get; init; }
    public required double Version { get; init; }
    public required string Name { get; init; }
    public required bool Enabled { get; init; }
    public required IReadOnlyList<string> Triggers { get; init; }
    public required string? ProjectPath { get; init; }
    public required string Action { get; init; }
    public required string Title { get; init; }
    public required string Body { get; init; }
    public Specified<string> TaskId { get; init; }
    public Specified<AutomationListResultRulesItemConditions> Conditions { get; init; }
    public Specified<AutomationListResultRulesItemProposal> Proposal { get; init; }
    public override Dictionary<string, object?> ToWire() => new()
    {
        ["id"] = Id,
        ["version"] = Version,
        ["name"] = Name,
        ["enabled"] = Enabled,
        ["triggers"] = Triggers,
        ["projectPath"] = ProjectPath,
        ["action"] = Action,
        ["title"] = Title,
        ["body"] = Body,
        ["taskId"] = TaskId.IsPresent ? (object?)TaskId.Value : Undefined.Value,
        ["conditions"] = Conditions.IsPresent ? (object?)Conditions.Value : Undefined.Value,
        ["proposal"] = Proposal.IsPresent ? (object?)Proposal.Value : Undefined.Value
    };
}

public sealed record AutomationQueryResultItemsItemVariant2 : AutomationQueryResultItemsItem
{
    public required string Id { get; init; }
    public required string Name { get; init; }
    public required bool Enabled { get; init; }
    public required string? ProjectPath { get; init; }
    public required string? TaskId { get; init; }
    public required string Kind { get; init; }
    public required string Title { get; init; }
    public required string Body { get; init; }
    public required string Cadence { get; init; }
    public required string LocalTime { get; init; }
    public required string TimeZone { get; init; }
    public required string StartAt { get; init; }
    public required double? WeekDay { get; init; }
    public Specified<string> StartDate { get; init; }
    public override Dictionary<string, object?> ToWire() => new()
    {
        ["id"] = Id,
        ["name"] = Name,
        ["enabled"] = Enabled,
        ["projectPath"] = ProjectPath,
        ["taskId"] = TaskId,
        ["kind"] = Kind,
        ["title"] = Title,
        ["body"] = Body,
        ["cadence"] = Cadence,
        ["localTime"] = LocalTime,
        ["timeZone"] = TimeZone,
        ["startAt"] = StartAt,
        ["weekDay"] = WeekDay,
        ["startDate"] = StartDate.IsPresent ? (object?)StartDate.Value : Undefined.Value
    };
}

public sealed record AutomationQueryResultItemsItemVariant3 : AutomationQueryResultItemsItem
{
    public required string Id { get; init; }
    public required string Source { get; init; }
    public required string SourceId { get; init; }
    public required string? TaskId { get; init; }
    public required string Kind { get; init; }
    public required string Title { get; init; }
    public required string Body { get; init; }
    public Specified<AutomationListResultRulesItemProposal> Proposal { get; init; }
    public required string State { get; init; }
    public Specified<string> ApprovalId { get; init; }
    public required string CreatedAt { get; init; }
    public Specified<AutomationListResultDraftsItemOccurrence> Occurrence { get; init; }
    public override Dictionary<string, object?> ToWire() => new()
    {
        ["id"] = Id,
        ["source"] = Source,
        ["sourceId"] = SourceId,
        ["taskId"] = TaskId,
        ["kind"] = Kind,
        ["title"] = Title,
        ["body"] = Body,
        ["proposal"] = Proposal.IsPresent ? (object?)Proposal.Value : Undefined.Value,
        ["state"] = State,
        ["approvalId"] = ApprovalId.IsPresent ? (object?)ApprovalId.Value : Undefined.Value,
        ["createdAt"] = CreatedAt,
        ["occurrence"] = Occurrence.IsPresent ? (object?)Occurrence.Value : Undefined.Value
    };
}

public sealed record AutomationQueryResultItemsItemVariant4 : AutomationQueryResultItemsItem
{
    public required string Id { get; init; }
    public required string RuleId { get; init; }
    public required double RuleVersion { get; init; }
    public required double EventSequence { get; init; }
    public required string State { get; init; }
    public required string CreatedAt { get; init; }
    public required string UpdatedAt { get; init; }
    public Specified<string> Detail { get; init; }
    public Specified<AutomationListResultScriptsItemGrant> GrantSnapshot { get; init; }
    public Specified<AutomationListResultRunsItemPin> Pin { get; init; }
    public override Dictionary<string, object?> ToWire() => new()
    {
        ["id"] = Id,
        ["ruleId"] = RuleId,
        ["ruleVersion"] = RuleVersion,
        ["eventSequence"] = EventSequence,
        ["state"] = State,
        ["createdAt"] = CreatedAt,
        ["updatedAt"] = UpdatedAt,
        ["detail"] = Detail.IsPresent ? (object?)Detail.Value : Undefined.Value,
        ["grantSnapshot"] = GrantSnapshot.IsPresent ? (object?)GrantSnapshot.Value : Undefined.Value,
        ["pin"] = Pin.IsPresent ? (object?)Pin.Value : Undefined.Value
    };
}

public sealed record AutomationQueryResultItemsItemVariant5 : AutomationQueryResultItemsItem
{
    public required AutomationListResultScriptsItemRegistration Registration { get; init; }
    public required AutomationListResultScriptsItemRevision Revision { get; init; }
    public required AutomationListResultScriptsItemGrant? Grant { get; init; }
    public override Dictionary<string, object?> ToWire() => new()
    {
        ["registration"] = Registration,
        ["revision"] = Revision,
        ["grant"] = Grant
    };
}

public sealed record AutomationRulePreviewResult : IWireModel
{
    public required bool Matches { get; init; }
    public required string? Reason { get; init; }
    public required AutomationRulePreviewResultDraftPreview? DraftPreview { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["matches"] = Matches,
        ["reason"] = Reason,
        ["draftPreview"] = DraftPreview
    };
}

public sealed record AutomationRulePreviewResultDraftPreview : IWireModel
{
    public required string Title { get; init; }
    public required string Kind { get; init; }
    public required string Body { get; init; }
    public Specified<AutomationListResultRulesItemProposal> Proposal { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["title"] = Title,
        ["kind"] = Kind,
        ["body"] = Body,
        ["proposal"] = Proposal.IsPresent ? (object?)Proposal.Value : Undefined.Value
    };
}

public sealed record AutomationRuleRemoveResult : IWireModel
{
    public required bool Removed { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["removed"] = Removed
    };
}

public sealed record AutomationScriptSourceResult : IWireModel
{
    public required string Source { get; init; }
    public required AutomationListResultScriptsItemRevision Revision { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["source"] = Source,
        ["revision"] = Revision
    };
}

public sealed record AutomationScriptRevokeResult : IWireModel
{
    public required bool Revoked { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["revoked"] = Revoked
    };
}

public sealed record AutomationScheduleRemoveResult : IWireModel
{
    public required bool Removed { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["removed"] = Removed
    };
}

public sealed record AutomationScheduleTickResult : IWireModel
{
    public required double Created { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["created"] = Created
    };
}

public sealed record AutomationDraftDismissResult : IWireModel
{
    public required bool Dismissed { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["dismissed"] = Dismissed
    };
}

public sealed record AutomationDraftPrepareResult : IWireModel
{
    public required string ApprovalId { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["approvalId"] = ApprovalId
    };
}

public sealed record TemplatesListResult : IWireModel
{
    public required IReadOnlyList<TemplatesListResultItemsItem> Items { get; init; }
    public required string? NextAfter { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["items"] = Items,
        ["nextAfter"] = NextAfter
    };
}

public sealed record TemplatesListResultItemsItem : IWireModel
{
    public required string Id { get; init; }
    public required string Name { get; init; }
    public required string Prompt { get; init; }
    public required string Mode { get; init; }
    public required string ProfileId { get; init; }
    public required double TokenBudget { get; init; }
    public required IReadOnlyList<string> Scope { get; init; }
    public Specified<TaskStartResultVariant1Coordination> Coordination { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["id"] = Id,
        ["name"] = Name,
        ["prompt"] = Prompt,
        ["mode"] = Mode,
        ["profileId"] = ProfileId,
        ["tokenBudget"] = TokenBudget,
        ["scope"] = Scope,
        ["coordination"] = Coordination.IsPresent ? (object?)Coordination.Value : Undefined.Value
    };
}

public sealed record TemplatesRemoveResult : IWireModel
{
    public required bool Removed { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["removed"] = Removed
    };
}

public sealed record ContinuityGetResult : IWireModel
{
    public required IReadOnlyList<ContinuityGetResultDecisionsItem> Decisions { get; init; }
    public required IReadOnlyList<ContinuityGetResultLineageItem> Lineage { get; init; }
    public required double? NextBefore { get; init; }
    public required string? NextLineage { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["decisions"] = Decisions,
        ["lineage"] = Lineage,
        ["nextBefore"] = NextBefore,
        ["nextLineage"] = NextLineage
    };
}

public sealed record ContinuityGetResultDecisionsItem : IWireModel
{
    public required string Id { get; init; }
    public required string TaskId { get; init; }
    public required string Title { get; init; }
    public required string Rationale { get; init; }
    public required IReadOnlyList<string> MessageIds { get; init; }
    public required IReadOnlyList<string> EvidenceIds { get; init; }
    public required string? SupersedesId { get; init; }
    public required bool Superseded { get; init; }
    public required string CreatedAt { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["id"] = Id,
        ["taskId"] = TaskId,
        ["title"] = Title,
        ["rationale"] = Rationale,
        ["messageIds"] = MessageIds,
        ["evidenceIds"] = EvidenceIds,
        ["supersedesId"] = SupersedesId,
        ["superseded"] = Superseded,
        ["createdAt"] = CreatedAt
    };
}

public sealed record ContinuityGetResultLineageItem : IWireModel
{
    public required string SourceTaskId { get; init; }
    public required string TaskId { get; init; }
    public required string SourceCommit { get; init; }
    public required IReadOnlyList<string> MessageIds { get; init; }
    public Specified<IReadOnlyList<string>> EvidenceIds { get; init; }
    public required string ContextHash { get; init; }
    public required string CreatedAt { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["sourceTaskId"] = SourceTaskId,
        ["taskId"] = TaskId,
        ["sourceCommit"] = SourceCommit,
        ["messageIds"] = MessageIds,
        ["evidenceIds"] = EvidenceIds.IsPresent ? (object?)EvidenceIds.Value : Undefined.Value,
        ["contextHash"] = ContextHash,
        ["createdAt"] = CreatedAt
    };
}

public sealed record TaskContinuationPreviewResult : IWireModel
{
    public required string Id { get; init; }
    public required string SourceTaskId { get; init; }
    public required string SourceCommit { get; init; }
    public required IReadOnlyList<string> MessageIds { get; init; }
    public required IReadOnlyList<string> EvidenceIds { get; init; }
    public required string Context { get; init; }
    public required double Bytes { get; init; }
    public required IReadOnlyList<string> Warnings { get; init; }
    public required string ExpiresAt { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["id"] = Id,
        ["sourceTaskId"] = SourceTaskId,
        ["sourceCommit"] = SourceCommit,
        ["messageIds"] = MessageIds,
        ["evidenceIds"] = EvidenceIds,
        ["context"] = Context,
        ["bytes"] = Bytes,
        ["warnings"] = Warnings,
        ["expiresAt"] = ExpiresAt
    };
}

public sealed record ArtifactPreviewResult : IWireModel
{
    public required string Id { get; init; }
    public required string TaskId { get; init; }
    public required string Path { get; init; }
    public required string MimeType { get; init; }
    public required double Bytes { get; init; }
    public required string Sha256 { get; init; }
    public Specified<double> Width { get; init; }
    public Specified<double> Height { get; init; }
    public required string Content { get; init; }
    public required double? NextOffset { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["id"] = Id,
        ["taskId"] = TaskId,
        ["path"] = Path,
        ["mimeType"] = MimeType,
        ["bytes"] = Bytes,
        ["sha256"] = Sha256,
        ["width"] = Width.IsPresent ? (object?)Width.Value : Undefined.Value,
        ["height"] = Height.IsPresent ? (object?)Height.Value : Undefined.Value,
        ["content"] = Content,
        ["nextOffset"] = NextOffset
    };
}

public sealed record ArtifactChunkResult : IWireModel
{
    public required string Content { get; init; }
    public required double? NextOffset { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["content"] = Content,
        ["nextOffset"] = NextOffset
    };
}

public sealed record TaskExportTranscriptResult : IWireModel
{
    public required string Path { get; init; }
    public required IReadOnlyList<TaskExportTranscriptResultFilesItem> Files { get; init; }
    public required double MessageCount { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["path"] = Path,
        ["files"] = Files,
        ["messageCount"] = MessageCount
    };
}

public sealed record TaskExportTranscriptResultFilesItem : IWireModel
{
    public required string Name { get; init; }
    public required double Bytes { get; init; }
    public required string Sha256 { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["name"] = Name,
        ["bytes"] = Bytes,
        ["sha256"] = Sha256
    };
}

public sealed record FeaturesGetResult : IWireModel
{
    public required IReadOnlyList<FeaturesGetResultFeaturesItem> Features { get; init; }
    public required IReadOnlyList<FeaturesGetResultFeaturesItem> History { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["features"] = Features,
        ["history"] = History
    };
}

public sealed record FeaturesGetResultFeaturesItem : IWireModel
{
    public required string Feature { get; init; }
    public required bool Enabled { get; init; }
    public required string? Reason { get; init; }
    public required string? UpdatedAt { get; init; }
    public Dictionary<string, object?> ToWire() => new()
    {
        ["feature"] = Feature,
        ["enabled"] = Enabled,
        ["reason"] = Reason,
        ["updatedAt"] = UpdatedAt
    };
}

public static class ContractModelTypes
{
    public static IReadOnlyDictionary<string, Type> Inputs { get; } = new Dictionary<string, Type>
    {
        ["bridge workspace:browser"] = typeof(BridgeWorkspaceBrowserInput),
        ["bridge workspace:save-credential"] = typeof(BridgeWorkspaceSaveCredentialInput),
        ["bridge workspace:set-notifications"] = typeof(BridgeWorkspaceSetNotificationsInput),
        ["frame browser.host"] = typeof(FrameBrowserHostInput),
        ["frame browser.host.result"] = typeof(FrameBrowserHostResultInput),
        ["frame browser.invalidated"] = typeof(FrameBrowserInvalidatedInput),
        ["frame rpc request"] = typeof(FrameRpcRequestInput),
        ["frame rpc response"] = typeof(FrameRpcResponseInput),
        ["frame runtime.credential"] = typeof(FrameRuntimeCredentialInput),
        ["frame workspace.event"] = typeof(FrameWorkspaceEventInput),
        ["rpc approval.content"] = typeof(RpcApprovalContentInput),
        ["rpc approval.decide"] = typeof(RpcApprovalDecideInput),
        ["rpc approval.get"] = typeof(RpcApprovalGetInput),
        ["rpc approval.reconcile"] = typeof(RpcApprovalReconcileInput),
        ["rpc artifact.chunk"] = typeof(RpcArtifactChunkInput),
        ["rpc artifact.preview"] = typeof(RpcArtifactPreviewInput),
        ["rpc automation.draft.dismiss"] = typeof(RpcAutomationDraftDismissInput),
        ["rpc automation.draft.prepare"] = typeof(RpcAutomationDraftPrepareInput),
        ["rpc automation.list"] = typeof(RpcAutomationListInput),
        ["rpc automation.query"] = typeof(RpcAutomationQueryInput),
        ["rpc automation.rule.preview"] = typeof(RpcAutomationRulePreviewInput),
        ["rpc automation.rule.remove"] = typeof(RpcAutomationRuleRemoveInput),
        ["rpc automation.rule.save"] = typeof(RpcAutomationRuleSaveInput),
        ["rpc automation.schedule.remove"] = typeof(RpcAutomationScheduleRemoveInput),
        ["rpc automation.schedule.save"] = typeof(RpcAutomationScheduleSaveInput),
        ["rpc automation.schedule.tick"] = typeof(RpcAutomationScheduleTickInput),
        ["rpc automation.script.grant"] = typeof(RpcAutomationScriptGrantInput),
        ["rpc automation.script.register"] = typeof(RpcAutomationScriptRegisterInput),
        ["rpc automation.script.revoke"] = typeof(RpcAutomationScriptRevokeInput),
        ["rpc automation.script.source"] = typeof(RpcAutomationScriptSourceInput),
        ["rpc browser.acknowledgeUnknown"] = typeof(RpcBrowserAcknowledgeUnknownInput),
        ["rpc channel.get"] = typeof(RpcChannelGetInput),
        ["rpc channel.send"] = typeof(RpcChannelSendInput),
        ["rpc continuity.get"] = typeof(RpcContinuityGetInput),
        ["rpc decision.save"] = typeof(RpcDecisionSaveInput),
        ["rpc diagnostics.export"] = typeof(RpcDiagnosticsExportInput),
        ["rpc features.get"] = typeof(RpcFeaturesGetInput),
        ["rpc features.set"] = typeof(RpcFeaturesSetInput),
        ["rpc files.list"] = typeof(RpcFilesListInput),
        ["rpc files.read"] = typeof(RpcFilesReadInput),
        ["rpc mcp.getConfig"] = typeof(RpcMcpGetConfigInput),
        ["rpc mcp.list"] = typeof(RpcMcpListInput),
        ["rpc mcp.remove"] = typeof(RpcMcpRemoveInput),
        ["rpc mcp.save"] = typeof(RpcMcpSaveInput),
        ["rpc mcp.update"] = typeof(RpcMcpUpdateInput),
        ["rpc orchestration.cancelChild"] = typeof(RpcOrchestrationCancelChildInput),
        ["rpc orchestration.cancelRoot"] = typeof(RpcOrchestrationCancelRootInput),
        ["rpc orchestration.child"] = typeof(RpcOrchestrationChildInput),
        ["rpc orchestration.decide"] = typeof(RpcOrchestrationDecideInput),
        ["rpc orchestration.get"] = typeof(RpcOrchestrationGetInput),
        ["rpc orchestration.prepareContinue"] = typeof(RpcOrchestrationPrepareContinueInput),
        ["rpc orchestration.reconcile"] = typeof(RpcOrchestrationReconcileInput),
        ["rpc orchestration.resume"] = typeof(RpcOrchestrationResumeInput),
        ["rpc orchestration.reviseAssignment"] = typeof(RpcOrchestrationReviseAssignmentInput),
        ["rpc profile.probe"] = typeof(RpcProfileProbeInput),
        ["rpc profile.read"] = typeof(RpcProfileReadInput),
        ["rpc profile.save"] = typeof(RpcProfileSaveInput),
        ["rpc project.add"] = typeof(RpcProjectAddInput),
        ["rpc project.update"] = typeof(RpcProjectUpdateInput),
        ["rpc task.approvals"] = typeof(RpcTaskApprovalsInput),
        ["rpc task.cancel"] = typeof(RpcTaskCancelInput),
        ["rpc task.commit"] = typeof(RpcTaskCommitInput),
        ["rpc task.compact"] = typeof(RpcTaskCompactInput),
        ["rpc task.compactionContent"] = typeof(RpcTaskCompactionContentInput),
        ["rpc task.compactions"] = typeof(RpcTaskCompactionsInput),
        ["rpc task.continuationPreview"] = typeof(RpcTaskContinuationPreviewInput),
        ["rpc task.continue"] = typeof(RpcTaskContinueInput),
        ["rpc task.create"] = typeof(RpcTaskCreateInput),
        ["rpc task.diff"] = typeof(RpcTaskDiffInput),
        ["rpc task.exportTranscript"] = typeof(RpcTaskExportTranscriptInput),
        ["rpc task.messageContent"] = typeof(RpcTaskMessageContentInput),
        ["rpc task.messages"] = typeof(RpcTaskMessagesInput),
        ["rpc task.push"] = typeof(RpcTaskPushInput),
        ["rpc task.read"] = typeof(RpcTaskReadInput),
        ["rpc task.reconcilePublication"] = typeof(RpcTaskReconcilePublicationInput),
        ["rpc task.retire"] = typeof(RpcTaskRetireInput),
        ["rpc task.send"] = typeof(RpcTaskSendInput),
        ["rpc task.setArchived"] = typeof(RpcTaskSetArchivedInput),
        ["rpc task.start"] = typeof(RpcTaskStartInput),
        ["rpc task.timeline"] = typeof(RpcTaskTimelineInput),
        ["rpc task.usage"] = typeof(RpcTaskUsageInput),
        ["rpc task.usageRecords"] = typeof(RpcTaskUsageRecordsInput),
        ["rpc templates.list"] = typeof(RpcTemplatesListInput),
        ["rpc templates.remove"] = typeof(RpcTemplatesRemoveInput),
        ["rpc templates.save"] = typeof(RpcTemplatesSaveInput),
        ["rpc usage.breakdown"] = typeof(RpcUsageBreakdownInput),
        ["rpc usage.requests"] = typeof(RpcUsageRequestsInput),
        ["rpc usage.summary"] = typeof(RpcUsageSummaryInput),
        ["rpc workspace.actions"] = typeof(RpcWorkspaceActionsInput),
        ["rpc workspace.events"] = typeof(RpcWorkspaceEventsInput),
        ["rpc workspace.preferences.save"] = typeof(RpcWorkspacePreferencesSaveInput),
        ["rpc workspace.profiles"] = typeof(RpcWorkspaceProfilesInput),
        ["rpc workspace.projects"] = typeof(RpcWorkspaceProjectsInput),
        ["rpc workspace.schema"] = typeof(RpcWorkspaceSchemaInput),
        ["rpc workspace.search"] = typeof(RpcWorkspaceSearchInput),
        ["rpc workspace.summary"] = typeof(RpcWorkspaceSummaryInput),
        ["rpc workspace.tasks"] = typeof(RpcWorkspaceTasksInput),
        ["rpc workspace.upgrade"] = typeof(RpcWorkspaceUpgradeInput),
        ["rpc workspace.usageTrend"] = typeof(RpcWorkspaceUsageTrendInput)
    };
    public static IReadOnlyDictionary<string, Type> Results { get; } = new Dictionary<string, Type>
    {
        ["channel.get"] = typeof(ChannelGetResult),
        ["channel.send"] = typeof(ChannelGetResultMessagesItem),
        ["usage.summary"] = typeof(UsageSummaryResult),
        ["usage.breakdown"] = typeof(UsageBreakdownResult),
        ["usage.requests"] = typeof(UsageRequestsResult),
        ["browser.acknowledgeUnknown"] = typeof(BrowserAcknowledgeUnknownResult),
        ["project.add"] = typeof(ProjectAddResult),
        ["project.update"] = typeof(ProjectAddResult),
        ["workspace.preferences.save"] = typeof(WorkspacePreferencesSaveResult),
        ["task.start"] = typeof(TaskStartResult),
        ["task.create"] = typeof(TaskCreateResult),
        ["task.send"] = typeof(TaskSendResult),
        ["task.cancel"] = typeof(TaskSendResult),
        ["profile.save"] = typeof(ProfileSaveResult),
        ["profile.probe"] = typeof(ProfileProbeResult),
        ["files.list"] = typeof(IReadOnlyList<FilesListResultItem>),
        ["files.read"] = typeof(FilesReadResult),
        ["task.diff"] = typeof(TaskDiffResult),
        ["approval.decide"] = typeof(ApprovalDecideResult),
        ["approval.reconcile"] = typeof(BrowserAcknowledgeUnknownResult),
        ["workspace.schema"] = typeof(WorkspaceSchemaResult),
        ["workspace.upgrade"] = typeof(WorkspaceUpgradeResult),
        ["orchestration.get"] = typeof(OrchestrationGetResult),
        ["orchestration.child"] = typeof(OrchestrationChildResult),
        ["orchestration.cancelChild"] = typeof(OrchestrationCancelChildResult),
        ["orchestration.cancelRoot"] = typeof(OrchestrationCancelRootResult),
        ["orchestration.resume"] = typeof(OrchestrationResumeResult),
        ["orchestration.reviseAssignment"] = typeof(OrchestrationReviseAssignmentResult),
        ["orchestration.decide"] = typeof(OrchestrationDecideResult),
        ["orchestration.reconcile"] = typeof(OrchestrationReconcileResult),
        ["orchestration.prepareContinue"] = typeof(OrchestrationPrepareContinueResult),
        ["task.compact"] = typeof(TaskCompactResult),
        ["task.usage"] = typeof(TaskUsageResult),
        ["diagnostics.export"] = typeof(DiagnosticsExportResult),
        ["task.commit"] = typeof(TaskCommitResult),
        ["task.push"] = typeof(TaskPushResult),
        ["task.reconcilePublication"] = typeof(TaskReconcilePublicationResult),
        ["task.retire"] = typeof(TaskRetireResult),
        ["mcp.list"] = typeof(McpListResult),
        ["mcp.save"] = typeof(McpListResultItemsItem),
        ["mcp.getConfig"] = typeof(McpGetConfigResult),
        ["mcp.update"] = typeof(McpListResultItemsItem),
        ["mcp.remove"] = typeof(McpRemoveResult),
        ["workspace.summary"] = typeof(WorkspaceSummaryResult),
        ["workspace.profiles"] = typeof(WorkspaceProfilesResult),
        ["workspace.projects"] = typeof(WorkspaceProjectsResult),
        ["profile.read"] = typeof(ProfileSaveResult),
        ["workspace.tasks"] = typeof(WorkspaceTasksResult),
        ["workspace.search"] = typeof(WorkspaceSearchResult),
        ["workspace.actions"] = typeof(WorkspaceActionsResult),
        ["workspace.events"] = typeof(WorkspaceEventsResult),
        ["workspace.usageTrend"] = typeof(WorkspaceUsageTrendResult),
        ["task.timeline"] = typeof(TaskTimelineResult),
        ["task.read"] = typeof(TaskReadResult),
        ["task.messages"] = typeof(TaskMessagesResult),
        ["task.messageContent"] = typeof(TaskMessageContentResult),
        ["task.usageRecords"] = typeof(TaskUsageRecordsResult),
        ["task.compactions"] = typeof(TaskCompactionsResult),
        ["task.compactionContent"] = typeof(TaskCompactionContentResult),
        ["task.approvals"] = typeof(TaskApprovalsResult),
        ["approval.get"] = typeof(ApprovalGetResult),
        ["approval.content"] = typeof(ApprovalContentResult),
        ["task.setArchived"] = typeof(TaskStartResult),
        ["automation.list"] = typeof(AutomationListResult),
        ["automation.query"] = typeof(AutomationQueryResult),
        ["automation.rule.save"] = typeof(AutomationListResultRulesItem),
        ["automation.rule.preview"] = typeof(AutomationRulePreviewResult),
        ["automation.rule.remove"] = typeof(AutomationRuleRemoveResult),
        ["automation.script.register"] = typeof(AutomationListResultScriptsItemRevision),
        ["automation.script.source"] = typeof(AutomationScriptSourceResult),
        ["automation.script.grant"] = typeof(AutomationListResultScriptsItemRevision),
        ["automation.script.revoke"] = typeof(AutomationScriptRevokeResult),
        ["automation.schedule.save"] = typeof(AutomationListResultSchedulesItem),
        ["automation.schedule.remove"] = typeof(AutomationScheduleRemoveResult),
        ["automation.schedule.tick"] = typeof(AutomationScheduleTickResult),
        ["automation.draft.dismiss"] = typeof(AutomationDraftDismissResult),
        ["automation.draft.prepare"] = typeof(AutomationDraftPrepareResult),
        ["templates.list"] = typeof(TemplatesListResult),
        ["templates.save"] = typeof(TemplatesListResultItemsItem),
        ["templates.remove"] = typeof(TemplatesRemoveResult),
        ["continuity.get"] = typeof(ContinuityGetResult),
        ["decision.save"] = typeof(ContinuityGetResultDecisionsItem),
        ["task.continuationPreview"] = typeof(TaskContinuationPreviewResult),
        ["task.continue"] = typeof(TaskStartResult),
        ["artifact.preview"] = typeof(ArtifactPreviewResult),
        ["artifact.chunk"] = typeof(ArtifactChunkResult),
        ["task.exportTranscript"] = typeof(TaskExportTranscriptResult),
        ["features.get"] = typeof(FeaturesGetResult),
        ["features.set"] = typeof(FeaturesGetResultFeaturesItem)
    };
}
