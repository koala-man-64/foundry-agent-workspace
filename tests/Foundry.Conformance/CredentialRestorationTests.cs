using Foundry.Protocol;
using Foundry.Providers;
using Foundry.Runtime;
using Microsoft.Data.Sqlite;
using Xunit;

namespace Foundry.Conformance;

public sealed class CredentialRestorationTests
{
    private const string CoordinatorProfile = "60606060-0000-4000-8000-000000000001";
    private const string ChildProfile = "60606060-0000-4000-8000-000000000002";
    private static readonly string[] ProfileIds = [CoordinatorProfile, ChildProfile];

    [Theory]
    [InlineData(CoordinatorProfile)]
    [InlineData(ChildProfile)]
    public async Task RestartRestoresQualificationButReplacementAndInvalidRestorationDoNot(string replacedProfile)
    {
        using var fixture = RepositoryFixture.Create("foundry-credential-restoration-");
        var data = Directory.CreateDirectory(fixture.Local("data")).FullName;
        var expected = new Dictionary<string, string>();

        // Seed the qualification a successful earlier probe would persist; this test never probes or sends inference.
        await WithRuntime(data, (store, chat) =>
        {
            foreach (var profileId in ProfileIds)
            {
                var profile = Profile(profileId);
                store.SaveProfile(profile);
                chat.SetCredential(profileId, Secret(profileId), Binding(profile));
                profile["verifiedAt"] = "2026-10-23T12:00:00.000Z";
                profile["verificationFingerprint"] = Compatibility.ProfileFingerprint(profile);
                profile["capabilities"] = new Dictionary<string, object?>
                {
                    ["streaming"] = true, ["tools"] = true, ["continuation"] = true,
                    ["cancellation"] = true, ["usage"] = true,
                };
                store.SaveProfile(profile);
                expected[profileId] = JsJson.Stringify(profile)!;
            }
        });

        // WithRuntime fully closes the first chat, store and owner loop before admitting the same isolated database again.
        await WithRuntime(data, (store, chat) =>
        {
            foreach (var profileId in ProfileIds)
            {
                var profile = store.Profile(profileId)!;
                Assert.Equal(expected[profileId], JsJson.Stringify(profile));
                var staleBinding = JsJson.Stringify(new List<object?> { profile["apiKind"], profile["endpoint"], "another-deployment" })!;
                Assert.Throws<WorkspaceReadException>(() => chat.SetCredential(profileId, Secret(profileId), staleBinding, restoring: true));
                Assert.Equal(expected[profileId], JsJson.Stringify(store.Profile(profileId)));

                chat.SetCredential(profileId, Secret(profileId), Binding(profile), restoring: true);
                Assert.Equal(expected[profileId], JsJson.Stringify(store.Profile(profileId)));
                // Replaying the same stored secret is harmless; restore cannot replace an initialized secret.
                chat.SetCredential(profileId, Secret(profileId), Binding(profile), restoring: true);
                Assert.Throws<WorkspaceReadException>(() => chat.SetCredential(profileId, Secret(profileId) + "-replacement", Binding(profile), restoring: true));
                Assert.Equal(expected[profileId], JsJson.Stringify(store.Profile(profileId)));
            }

            var selected = store.Profile(replacedProfile)!;
            // A durable invalidation failure must leave the old in-memory credential in place too.
            // SaveProfile currently uses INSERT OR REPLACE; cover UPDATE as well so the fault remains meaningful.
            store.Execute("CREATE TEMP TRIGGER fail_credential_insert BEFORE INSERT ON profiles BEGIN SELECT RAISE(ABORT,'credential invalidation fault'); END");
            store.Execute("CREATE TEMP TRIGGER fail_credential_update BEFORE UPDATE ON profiles BEGIN SELECT RAISE(ABORT,'credential invalidation fault'); END");
            try
            {
                var error = Assert.Throws<SqliteException>(() => chat.SetCredential(replacedProfile, Secret(replacedProfile) + "-replacement", Binding(selected)));
                Assert.Contains("credential invalidation fault", error.Message, StringComparison.Ordinal);
                Assert.Equal(expected[replacedProfile], JsJson.Stringify(store.Profile(replacedProfile)));
                chat.SetCredential(replacedProfile, Secret(replacedProfile), Binding(selected), restoring: true);
            }
            finally
            {
                store.Execute("DROP TRIGGER fail_credential_insert");
                store.Execute("DROP TRIGGER fail_credential_update");
            }
            // Retry the identical replacement: adopting it before the failed save would make this an unsafe no-op.
            chat.SetCredential(replacedProfile, Secret(replacedProfile) + "-replacement", Binding(selected));
            var rotated = store.Profile(replacedProfile)!;
            Assert.False(rotated.ContainsKey("verifiedAt"));
            Assert.False(rotated.ContainsKey("verificationFingerprint"));
            Assert.False(rotated.ContainsKey("capabilities"));
            var unqualified = JsJson.Stringify(rotated);
            Assert.Throws<WorkspaceReadException>(() => chat.SetCredential(replacedProfile, Secret(replacedProfile), Binding(rotated), restoring: true));
            Assert.Equal(unqualified, JsJson.Stringify(store.Profile(replacedProfile)));
            var untouched = ProfileIds.Single(profileId => profileId != replacedProfile);
            Assert.Equal(expected[untouched], JsJson.Stringify(store.Profile(untouched)));
        });
    }

    private static Dictionary<string, object?> Profile(string profileId) => new()
    {
        ["id"] = profileId, ["name"] = profileId == CoordinatorProfile ? "Coordinator fixture" : "Child fixture",
        ["apiKind"] = "responses", ["endpoint"] = "https://credential-fixture.openai.azure.com/",
        ["deployment"] = "fixture-model", ["credentialRef"] = profileId, ["contextLimit"] = 16384d, ["outputLimit"] = 1024d,
    };

    private static string Secret(string profileId) => "synthetic-credential-" + profileId;
    private static string Binding(Dictionary<string, object?> profile) =>
        JsJson.Stringify(new List<object?> { profile["apiKind"], profile["endpoint"], profile["deployment"] })!;

    private static async Task WithRuntime(string data, Action<Store, DevelopmentChat> assertions)
    {
        await using var loop = new RuntimeLoop();
        Store? store = null; DevelopmentChat? chat = null;
        try
        {
            await loop.Invoke(() =>
            {
                store = new Store(loop, data, Path.Combine(data, "injected-root"));
                chat = new DevelopmentChat(loop, store, (_, _) => throw new InvalidOperationException("Credential restoration must not start a provider request."));
                assertions(store, chat);
                return Task.FromResult(0);
            });
        }
        finally
        {
            await loop.Invoke(async () =>
            {
                try { if (chat is not null) await chat.Shutdown(); }
                finally { store?.Dispose(); }
                return 0;
            });
        }
    }
}
