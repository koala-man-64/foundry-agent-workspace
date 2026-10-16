using Foundry.Platform;
using Foundry.Protocol;
using Microsoft.Data.Sqlite;

namespace Foundry.Runtime;

/// <summary>Explicit isolated-test operations; never exposed as P1 RPCs.</summary>
public enum StoreFault { None, BackupProtection, BackupCopy, BackupVerification, UpgradeAfterDdl }
public sealed record VerifiedBackup(string Path, int Version);

public sealed partial class Store
{
    private static readonly string[] UpgradeSchemas = ["V5_MIGRATION", "AUTOMATION_SCHEMA", "CONTINUITY_SCHEMA", "FEATURE_ADMISSION_SCHEMA"];
    internal static bool IsGitDocument(Dictionary<string, object?> task) => Field(task, "workspaceKind") is null || Equals(Field(task, "workspaceKind"), "git");
    public VerifiedBackup Backup(StoreFault fault = StoreFault.None)
    {
        loop.AssertCurrent();
        if (transaction is not null) throw new InvalidOperationException("Backup requires no active transaction.");
        if (fault == StoreFault.BackupProtection) throw new IOException("Injected backup protection failure.");
        var directory = Path.Combine(Path.GetDirectoryName(database.DataSource)!, "backup-" + id());
        ProtectedDirectory.Create(directory);
        using var lease = DirectoryLease.Acquire(directory);
        ProtectedDirectory.Verify(directory);
        var destination = Path.Combine(directory, "workspace.db");
        lease.PinDatabase(destination);
        if (fault == StoreFault.BackupCopy) throw new IOException("Injected backup copy failure.");
        using (var copy = SqliteSetup.Open(destination, SqliteOpenMode.ReadWrite)) database.BackupDatabase(copy);
        using (var copy = SqliteSetup.Open(destination, SqliteOpenMode.ReadOnly))
        {
            using var command = copy.CreateCommand(); command.CommandText = "PRAGMA integrity_check";
            if (!Equals(command.ExecuteScalar(), "ok")) throw new IOException("Backup integrity verification failed.");
            command.CommandText = "PRAGMA user_version";
            if (!Equals(command.ExecuteScalar(), (long)SchemaVersion) || fault == StoreFault.BackupVerification) throw new IOException("Backup version verification failed.");
            if (DatabaseContract(copy) != DatabaseContract(database)) throw new IOException("Backup content verification failed.");
        }
        return new(destination, SchemaVersion);
    }

    internal static string DatabaseContract(SqliteConnection connection)
    {
        var contract = new List<object?>();
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name";
        var tables = new List<(string Name, string? Sql)>();
        using (var reader = command.ExecuteReader()) while (reader.Read())
        {
            var sql = reader.IsDBNull(3) ? null : reader.GetString(3);
            contract.Add(new string?[] { reader.GetString(0), reader.GetString(1), reader.GetString(2), sql });
            if (reader.GetString(0) == "table") tables.Add((reader.GetString(1), sql));
        }
        foreach (var (name, sql) in tables)
        {
            var withoutRowid = sql?.Contains("WITHOUT ROWID", StringComparison.OrdinalIgnoreCase) == true;
            command.CommandText = (withoutRowid ? "SELECT * FROM \"" : "SELECT rowid,* FROM \"") + name.Replace("\"", "\"\"", StringComparison.Ordinal) + "\"" + (withoutRowid ? "" : " ORDER BY rowid");
            var rows = new List<object?>();
            using var reader = command.ExecuteReader();
            while (reader.Read())
            {
                var row = new Dictionary<string, object?>();
                for (var index = 0; index < reader.FieldCount; index++) row[reader.GetName(index)] = reader.IsDBNull(index) ? new[] { "null" } : reader.GetValue(index) switch
                {
                    long integer => new[] { "integer", integer.ToString(System.Globalization.CultureInfo.InvariantCulture) },
                    double real => new[] { "real", BitConverter.DoubleToInt64Bits(real).ToString("x16", System.Globalization.CultureInfo.InvariantCulture) },
                    string => new[] { "text", Convert.ToHexStringLower(reader.GetFieldValue<byte[]>(index)) },
                    byte[] bytes => new[] { "blob", Convert.ToHexStringLower(bytes) },
                    _ => throw new IOException("Unsupported SQLite backup value type.")
                };
                rows.Add(row);
            }
            contract.Add(new Dictionary<string, object?> { ["name"] = name, ["sql"] = sql, ["rows"] = withoutRowid ? rows.Select(row => System.Text.Json.JsonSerializer.Serialize(row)).Order(StringComparer.Ordinal).Cast<object?>().ToList() : rows });
        }
        // This is an exact SQLite verifier, not a JavaScript compatibility hash:
        // retain typed bytes and integer precision, plus every schema object.
        return System.Text.Json.JsonSerializer.Serialize(contract);
    }

    public VerifiedBackup UpgradeToCurrent(StoreFault fault = StoreFault.None)
    {
        loop.AssertCurrent();
        if (SchemaVersion is < 1 or >= 5) throw new InvalidOperationException("Database is not eligible for a v5 upgrade.");
        var backup = Backup(fault);
        var from = SchemaVersion;
        Transaction(() =>
        {
            if (from == 1) Execute(Schema("V2_MIGRATION"));
            if (from < 3)
            {
                Execute(Schema("V3_MIGRATION"));
                foreach (var row in Rows("SELECT id,data FROM tasks"))
                {
                    var task = Document((string)row["data"]!);
                    if (!IsGitDocument(task) || !task.TryGetValue("projectPath", out var projectPath) || projectPath is not string path) continue;
                    var canonical = FinalPath.TryResolve(path, out var resolved) ? resolved : Path.GetFullPath(path);
                    var key = EcmaScriptCase.ToLower(canonical);
                    var projectJson = Scalar("SELECT data FROM projects WHERE path_key=$p0", key) as string;
                    var project = projectJson is null ? new Dictionary<string, object?>
                    {
                        ["id"] = id().ToString(), ["path"] = canonical, ["name"] = Path.GetFileName(canonical.TrimEnd('\\')) is { Length: > 0 } name ? name : canonical,
                        ["hidden"] = false, ["kind"] = "git", ["createdAt"] = Clock.Iso(now()), ["updatedAt"] = Clock.Iso(now())
                    } : Document(projectJson);
                    project["kind"] = "git";
                    if (projectJson is null) Execute("INSERT INTO projects(id,path_key,data) VALUES($p0,$p1,$p2)", project["id"], key, JsJson.Stringify(project));
                    else Execute("UPDATE projects SET data=$p0 WHERE id=$p1", JsJson.Stringify(project), project["id"]);
                    task["workspaceKind"] = "git"; task["projectId"] = project["id"];
                    Execute("UPDATE tasks SET data=$p0 WHERE id=$p1", JsJson.Stringify(task), task["id"]);
                }
            }
            if (from < 4)
            {
                Execute(Schema("V4_MIGRATION"));
                foreach (var row in Rows("SELECT * FROM usage_records ORDER BY rowid"))
                {
                    var task = Document((string)Scalar("SELECT data FROM tasks WHERE id=$p0", row["task_id"])!);
                    var rootId = Field(task, "rootTaskId") ?? task["id"];
                    var rootTitle = Equals(rootId, task["id"]) ? task["title"] : Field(Document((string)Scalar("SELECT data FROM tasks WHERE id=$p0", rootId)!), "title");
                    Execute("INSERT INTO provider_requests(request_id,task_id,root_task_id,parent_task_id,task_title,root_task_title,role,purpose,attribution_known,created_at,attempted_at,finished_at,outcome,reserved,input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens,usage_known,reason) VALUES($p0,$p1,$p2,$p3,$p4,$p5,$p6,'legacy',0,$p7,$p7,$p7,'unknown',$p8,$p9,$p10,$p11,$p12,$p13,$p14)",
                        row["request_id"], row["task_id"], rootId, Field(task, "parentTaskId"), task["title"], rootTitle, Field(task, "role"), row["created_at"], row["reserved"], row["prompt_tokens"], row["completion_tokens"], row["cache_read_tokens"], row["cache_creation_tokens"], row["usage_known"], row["reason"]);
                }
                if (!Equals(Scalar("SELECT COUNT(*) FROM usage_records"), Scalar("SELECT COUNT(*) FROM provider_requests"))) throw new IOException("Historical usage verification failed.");
                foreach (var (old, current) in new[] { ("reserved", "reserved"), ("prompt_tokens", "input_tokens"), ("completion_tokens", "output_tokens") })
                    if (!Equals(Scalar("SELECT COALESCE(SUM(" + old + "),0) FROM usage_records"), Scalar("SELECT COALESCE(SUM(" + current + "),0) FROM provider_requests"))) throw new IOException("Historical usage verification failed.");
            }
            foreach (var schema in UpgradeSchemas) Execute(Schema(schema));
            foreach (var row in Rows("SELECT id,data FROM tasks"))
            {
                var task = Document((string)row["data"]!);
                Execute("UPDATE tasks SET created_at=$p0,updated_at=$p1,archived_at=$p2,parent_task_id=$p3,project_path=$p4,project_id=$p5,mode=$p6,status=$p7 WHERE id=$p8", Field(task, "createdAt"), Field(task, "updatedAt"), Field(task, "archivedAt"), Field(task, "parentTaskId"), IsGitDocument(task) || Equals(Field(task, "workspaceKind"), "folder") ? Field(task, "projectPath") : null, Field(task, "projectId"), Field(task, "mode") ?? "chat", task["status"], task["id"]);
            }
            var redactor = new Redactor();
            foreach (var row in Rows("SELECT rowid,id,task_id,data FROM messages")) Execute("INSERT INTO messages_fts(rowid,task_id,message_id,content) VALUES($p0,$p1,$p2,$p3)", row["rowid"], row["task_id"], row["id"], redactor.Text((string)Document((string)row["data"]!)["content"]!));
            foreach (var row in Rows("SELECT id,data FROM mcp_servers"))
            {
                var original = Document((string)row["data"]!);
                var safe = Compatibility.SanitizeStoredMcp(original, redactor);
                if (ReferenceEquals(original, safe)) continue;
                var config = safe.Where(pair => original.ContainsKey(pair.Key) || pair.Key is "cwd" or "arguments" or "environment" or "enabled" or "readOnlyTools").ToDictionary(pair => pair.Key, pair => pair.Value);
                Execute("UPDATE mcp_servers SET data=$p0,tools='[]',server_info=NULL,last_error=$p1,updated_at=$p2 WHERE id=$p3", JsJson.Stringify(config), safe["lastError"], Clock.Iso(now()), row["id"]);
            }
            if (fault == StoreFault.UpgradeAfterDdl) throw new IOException("Injected upgrade failure.");
            if (Rows("PRAGMA foreign_key_check").Count != 0) throw new IOException("Foreign key verification failed.");
            Execute("PRAGMA user_version=5");
            return 0;
        });
        SchemaVersion = 5;
        return backup;
    }
}
