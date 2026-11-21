using System;
using System.IO;
using System.Security.Cryptography;
using System.Text;

namespace SquadVoice {
    internal static class ProfileChecks {
        public static void Main(string[] args) {
            if (args.Length != 1 || Directory.Exists(args[0])) throw new Exception("Use a fresh test directory.");
            var store = new ProfileStore(Path.Combine(args[0], "Private"));
            var publicDirectory = Path.Combine(args[0], "Public");
            var settings = new PublicSettings(publicDirectory);
            var endpoint = "https://voice.example.invalid/";
            var profile = new StoredProfile {
                endpoint = EndpointPolicy.Validate(endpoint, false, false).AbsoluteUri,
                remembered = new RememberedLogin { username = "portable-test", password = "Local-Test-Only2", autoLogin = true },
            };
            store.Save(profile);
            settings.SavePreferences(new Preferences { pushToTalk = true, hotkey = "F9", microphoneId = "selected-input",
                echoCancellation = false, noiseSuppression = false, autoGainControl = false, voiceBitrate = 40000 });
            settings.RecordInstallation(args[0], "0.3.0");
            var file = Path.Combine(store.DirectoryPath, "connection.dpapi");
            byte[] bytes = File.ReadAllBytes(file);
            Require(bytes.Length > 100 && !Encoding.UTF8.GetString(bytes).Contains(endpoint) &&
                !Encoding.Unicode.GetString(bytes).Contains(endpoint) && !Encoding.UTF8.GetString(bytes).Contains(profile.remembered.password), "plaintext profile");
            var loaded = store.Load(false);
            Require(!store.ReadError && loaded.endpoint == endpoint && loaded.remembered.autoLogin &&
                loaded.remembered.username == profile.remembered.username && loaded.remembered.password == profile.remembered.password, "DPAPI roundtrip");
            var prefs = settings.LoadPreferences(new Preferences());
            Require(prefs.pushToTalk && prefs.hotkey == "F9" && prefs.microphoneId == "selected-input" &&
                !prefs.echoCancellation && !prefs.noiseSuppression && !prefs.autoGainControl && prefs.voiceBitrate == 40000, "audio settings roundtrip");
            var prefsText = File.ReadAllText(Path.Combine(publicDirectory, "preferences.json"));
            Require(!prefsText.Contains(endpoint) && !prefsText.Contains(profile.remembered.password) &&
                !prefsText.Contains(profile.remembered.username), "sensitive fields in Windows Documents");
            var install = File.ReadAllLines(Path.Combine(publicDirectory, "installation.txt"), Encoding.Unicode);
            Require(install[0] == args[0] && install[1] == "0.3.0", "portable installation metadata");
            loaded.remembered.autoLogin = false;
            store.Save(loaded);
            Require(store.Load(false).endpoint == endpoint && !store.Load(false).remembered.autoLogin, "atomic replace");
            Reject("http://127.0.0.1:1234", false);
            Reject(new UriBuilder("https", "voice.example.invalid") { UserName = "fixture", Password = "sample" }.Uri.ToString(), false);
            Reject("https://voice.example.invalid/login", false);
            Reject("https://voice.example.invalid/?session=x", false);
            Reject("ws://127.0.0.1:7880", true);
            Reject("wss://voice.example.invalid/?token=x", true);
            Require(EndpointPolicy.Validate("wss://rtc.example.invalid", true, false).Scheme == "wss", "secure media endpoint");
            var legacy = Path.Combine(args[0], "Legacy");
            Directory.CreateDirectory(legacy);
            var old = Encoding.UTF8.GetBytes(Json.Serializer().Serialize(new {
                endpoint = endpoint, preferences = new Preferences { hotkey = "F7", pushToTalk = true },
            }));
            File.WriteAllBytes(Path.Combine(legacy, "connection.dpapi"),
                ProtectedData.Protect(old, null, DataProtectionScope.CurrentUser));
            var upgraded = new ProfileStore(Path.Combine(args[0], "Migrated"));
            var migration = upgraded.MigrateFrom(legacy, false);
            Require(migration.preferences.hotkey == "F7" && migration.preferences.pushToTalk &&
                upgraded.Load(false).endpoint == endpoint, "legacy migration");
            bytes[bytes.Length - 1] ^= 0xff;
            File.WriteAllBytes(file, bytes);
            Require(store.Load(false).endpoint == null && store.ReadError, "corrupted ciphertext accepted");
            Console.WriteLine("PASS: DPAPI credentials, separate public preferences and install record, legacy migration, atomic replace, ciphertext tamper, production endpoint policy.");
        }
        private static void Require(bool condition, string text) { if (!condition) throw new Exception(text); }
        private static void Reject(string value, bool media) {
            bool rejected = false;
            try { EndpointPolicy.Validate(value, media, false); } catch (FriendlyError) { rejected = true; }
            Require(rejected, "insecure endpoint accepted");
        }
    }
}
