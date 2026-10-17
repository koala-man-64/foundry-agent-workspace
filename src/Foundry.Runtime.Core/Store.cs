using System.Runtime.CompilerServices;
using Foundry.Protocol;
using Foundry.Platform;
using Microsoft.Data.Sqlite;

[assembly: InternalsVisibleTo("Foundry.Conformance")]
namespace Foundry.Runtime;

public sealed record WorkspaceEvent(long Sequence, string Type, object? Data, string CreatedAt, string? TaskId, string? RootTaskId) : IWireModel
{
    public Dictionary<string, object?> ToWire() => new()
    {
        ["sequence"] = Sequence, ["type"] = Type, ["taskId"] = (object?)TaskId ?? Undefined.Value,
        ["rootTaskId"] = (object?)RootTaskId ?? Undefined.Value, ["data"] = Data,
        ["createdAt"] = CreatedAt, ["version"] = 1, ["source"] = "runtime"
    };
}
public sealed class EventDeliveryException(Exception inner) : Exception("The mutation committed, but event delivery failed.", inner);

public sealed partial class Store : IDisposable
{
    public const string FakeProfileId = "00000000-0000-4000-8000-000000000001";
    public const string IsolationMarker = ".foundry-p1-isolated";
    public const string IsolationDeclaration = "P1 disposable development data; not adopted application data.\n";
    private static readonly string[] InitializationSchemas = ["V2_MIGRATION", "V3_MIGRATION", "PHASE4_SCHEMA", "V4_MIGRATION", "V5_MIGRATION", "AUTOMATION_SCHEMA", "CONTINUITY_SCHEMA", "FEATURE_ADMISSION_SCHEMA"];
    private readonly RuntimeLoop loop;
    private readonly SqliteConnection database;
    private readonly DirectoryLease directoryLease;
    private readonly DirectoryLease admittedLease;
    private readonly Func<DateTimeOffset> now;
    private readonly Func<Guid> id;
    private readonly Action<WorkspaceEvent> publish;
    private SqliteTransaction? transaction;
    private readonly List<WorkspaceEvent> outbox = [];
    private int savepoint;
    private bool poisoned;
    internal Action? BeforeRollback { get; set; }
    public int SchemaVersion { get; private set; }
    /// <summary>The admitted data directory; app-owned task worktrees live in its "wt" folder, as entry.ts places them.</summary>
    internal string DataDirectory { get; }

    public Store(RuntimeLoop loop, string directory, string applicationRoot, Func<DateTimeOffset>? now = null, Func<Guid>? id = null, Action<WorkspaceEvent>? publish = null)
    {
        ArgumentNullException.ThrowIfNull(loop);
        loop.AssertCurrent();
        this.loop = loop; this.now = now ?? (() => DateTimeOffset.UtcNow); this.id = id ?? Guid.NewGuid; this.publish = publish ?? (_ => { });
        directoryLease = DirectoryLease.Acquire(directory);
        DataAdmission admission;
        try { admission = DataClassifier.Inspect(directory, applicationRoot); }
        catch { directoryLease.Dispose(); throw; }
        if (admission.Disposition == DataDisposition.AdoptionPending) { directoryLease.Dispose(); throw new InvalidOperationException("Data adoption is pending."); }
        if (admission.Disposition == DataDisposition.Unsupported) { directoryLease.Dispose(); throw new InvalidOperationException("This database requires a newer application."); }
        DirectoryLease? pinned = null;
        SqliteConnection? connection = null;
        try
        {
            Directory.CreateDirectory(admission.Directory);
            DataDirectory = admission.Directory;
            admittedLease = pinned = DirectoryLease.Acquire(admission.Directory);
            var markerPath = Path.Combine(admission.Directory, IsolationMarker);
            if (File.Exists(markerPath))
            {
                admittedLease.PinExistingDatabase(markerPath);
                if (new FileInfo(markerPath).Length != System.Text.Encoding.UTF8.GetByteCount(IsolationDeclaration) || File.ReadAllText(markerPath) != IsolationDeclaration) throw new InvalidOperationException("Existing data requires an isolated disposable copy.");
            }
            else
            {
                if (admission.Disposition != DataDisposition.Fresh) throw new InvalidOperationException("Existing data requires an isolated disposable copy.");
                using (var marker = new FileStream(markerPath, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                {
                    marker.Write(System.Text.Encoding.UTF8.GetBytes(IsolationDeclaration));
                    marker.Flush(true);
                }
                admittedLease.PinExistingDatabase(markerPath);
            }
            admittedLease.PinDatabase(admission.Database);
            database = connection = SqliteSetup.Open(admission.Database, SqliteOpenMode.ReadWriteCreate);
            if ((long)Scalar("PRAGMA user_version")! != admission.Version) throw new InvalidOperationException("Data changed during admission.");
            Execute("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;");
            var fresh = admission.Version == 0 && Scalar("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tasks'") is null;
            Transaction(() =>
            {
                Execute(Schema("V1_SCHEMA"));
                if (fresh)
                {
                    foreach (var name in InitializationSchemas) Execute(Schema(name));
                    Execute("PRAGMA user_version=5");
                }
                else if (admission.Version == 0) Execute("PRAGMA user_version=1");
                Execute(Schema("PHASE4_SCHEMA"));
                if (Scalar("SELECT data FROM profiles WHERE id=$p0", FakeProfileId) is null)
                    Execute("INSERT OR REPLACE INTO profiles(id,data) VALUES($p0,$p1)", FakeProfileId, "{\"id\":\"" + FakeProfileId + "\",\"name\":\"Offline demo\",\"apiKind\":\"fake\",\"endpoint\":\"\",\"deployment\":\"deterministic-fixture\",\"contextLimit\":32000,\"outputLimit\":2048}");
                return 0;
            });
            SchemaVersion = checked((int)(long)Scalar("PRAGMA user_version")!);
            Recover();
        }
        catch { connection?.Dispose(); pinned?.Dispose(); directoryLease.Dispose(); throw; }
    }

    private static string Schema(string name)
    {
        using var stream = typeof(Store).Assembly.GetManifestResourceStream("Foundry.Runtime.Schema." + name + ".sql") ?? throw new InvalidOperationException("Missing embedded schema.");
        using var reader = new StreamReader(stream);
        return reader.ReadToEnd();
    }

    private SqliteCommand Command(string sql, params object?[] values)
    {
        loop.AssertCurrent();
        if (poisoned) throw new InvalidOperationException("Store requires reopening after an uncertain transaction outcome.");
        var command = database.CreateCommand(); command.CommandText = sql; command.Transaction = transaction;
        for (var index = 0; index < values.Length; index++) command.Parameters.AddWithValue("$p" + index, values[index] ?? DBNull.Value);
        return command;
    }
    internal int Execute(string sql, params object?[] values) { using var command = Command(sql, values); return command.ExecuteNonQuery(); }
    internal object? Scalar(string sql, params object?[] values) { using var command = Command(sql, values); var value = command.ExecuteScalar(); return value is DBNull ? null : value; }
    internal List<Dictionary<string, object?>> Rows(string sql, params object?[] values)
    {
        using var command = Command(sql, values); using var reader = command.ExecuteReader();
        var rows = new List<Dictionary<string, object?>>();
        while (reader.Read())
        {
            var row = new Dictionary<string, object?>(StringComparer.Ordinal);
            // Decode SQLite's counted UTF-8 bytes: GetValue's string path stops
            // at embedded NULs in retained text such as compaction summaries.
            for (var index = 0; index < reader.FieldCount; index++)
                row.Add(reader.GetName(index), reader.IsDBNull(index) ? null : reader.GetFieldType(index) == typeof(string)
                    ? System.Text.Encoding.UTF8.GetString(reader.GetFieldValue<byte[]>(index)) : reader.GetValue(index));
            rows.Add(row);
        }
        return rows;
    }

    public T Transaction<T>(Func<T> callback) => Transact(callback, false);
    public T Immediate<T>(Func<T> callback) => Transact(callback, true);
    [Obsolete("Transaction callbacks must be synchronous.", true)]
    public T Transaction<T>(Func<Task<T>> callback) => throw new NotSupportedException();
    [Obsolete("Transaction callbacks must be synchronous.", true)]
    public T Immediate<T>(Func<Task<T>> callback) => throw new NotSupportedException();
    private T Transact<T>(Func<T> callback, bool immediate)
    {
        ArgumentNullException.ThrowIfNull(callback); loop.AssertCurrent();
        var nested = transaction is not null;
        var marker = outbox.Count;
        var name = "nested_" + ++savepoint;
        if (nested) Execute("SAVEPOINT " + name);
        else transaction = database.BeginTransaction(deferred: !immediate);
        T result;
        try
        {
            using (loop.EnterSynchronousScope()) result = callback();
            if (result is Task rejected) { loop.ObserveRejectedTask(rejected); throw new InvalidOperationException("Transaction callbacks must be synchronous."); }
            if (result is ValueTask rejectedValue) { loop.ObserveRejectedTask(rejectedValue.AsTask()); throw new InvalidOperationException("Transaction callbacks must be synchronous."); }
            if (result is not null && result.GetType().IsGenericType && result.GetType().GetGenericTypeDefinition() == typeof(ValueTask<>))
            {
                var task = (Task)result.GetType().GetMethod("AsTask")!.Invoke(result, null)!;
                loop.ObserveRejectedTask(task); throw new InvalidOperationException("Transaction callbacks must be synchronous.");
            }
            if (nested) Execute("RELEASE SAVEPOINT " + name);
            else transaction!.Commit();
        }
        catch
        {
            try
            {
                BeforeRollback?.Invoke();
                if (nested) { Execute("ROLLBACK TO SAVEPOINT " + name); Execute("RELEASE SAVEPOINT " + name); }
                else transaction!.Rollback();
            }
            catch { poisoned = true; outbox.Clear(); throw; }
            finally { if (!poisoned) outbox.RemoveRange(marker, outbox.Count - marker); }
            throw;
        }
        finally { if (!nested) { transaction!.Dispose(); transaction = null; } }
        if (!nested)
        {
            var committed = outbox.OrderBy(e => e.Sequence).ToArray(); outbox.Clear();
            Exception? failure = null;
            foreach (var item in committed) try { publish(item); } catch (Exception error) { failure ??= error; }
            if (failure is not null) throw new EventDeliveryException(failure);
        }
        return result;
    }

    public WorkspaceEvent Event(string type, object? data, string? taskId = null)
    {
        loop.AssertCurrent();
        if (type == "task.progress") throw new ArgumentException("Progress is transient; use PublishProgress.", nameof(type));
        if (transaction is null) return Transaction(() => Event(type, data, taskId));
        var createdAt = Clock.Iso(now());
        var root = SchemaVersion >= 5 && taskId is not null ? (string?)Scalar("SELECT COALESCE(parent_task_id,id) FROM tasks WHERE id=$p0", taskId) : null;
        if (SchemaVersion >= 5) Execute("INSERT INTO events(type,task_id,data,created_at,version,source,root_task_id) VALUES($p0,$p1,$p2,$p3,1,'runtime',$p4)", type, taskId, JsJson.Stringify(data), createdAt, root);
        else Execute("INSERT INTO events(type,task_id,data,created_at) VALUES($p0,$p1,$p2,$p3)", type, taskId, JsJson.Stringify(data), createdAt);
        var item = new WorkspaceEvent((long)Scalar("SELECT last_insert_rowid()")!, type, data, createdAt, taskId, root);
        outbox.Add(item); return item;
    }

    public WorkspaceEvent PublishProgress(object? data, string taskId)
    {
        loop.AssertCurrent();
        if (transaction is not null || poisoned) throw new InvalidOperationException("Transient progress requires no active or uncertain transaction.");
        var item = new WorkspaceEvent(0, "task.progress", data, Clock.Iso(now()), taskId, null);
        publish(item); return item;
    }

    public void Dispose() { loop.AssertCurrent(); if (transaction is not null) throw new InvalidOperationException("Cannot close an active transaction."); database.Dispose(); admittedLease.Dispose(); directoryLease.Dispose(); }
}
