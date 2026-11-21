using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

namespace SquadVoice {
    internal sealed class FriendlyError : Exception {
        public readonly string Code;
        public FriendlyError(string message, string code = null) : base(message) { Code = code; }
    }

    internal sealed class Preferences {
        public string microphoneId = "default";
        public string speakerId = "default";
        public bool pushToTalk;
        public string hotkey = "F8";
        public bool echoCancellation = true;
        public bool noiseSuppression = true;
        public bool autoGainControl = true;
        public int voiceBitrate = 24000;
        public int voiceShare = 67;

        public static Preferences Parse(Dictionary<string, object> obj) {
            var prefs = new Preferences();
            prefs.microphoneId = Json.DeviceId(obj, "microphoneId");
            prefs.speakerId = Json.DeviceId(obj, "speakerId");
            prefs.pushToTalk = Json.Bool(obj, "pushToTalk");
            var key = Json.Text(obj, "hotkey", 3);
            if (Regex.IsMatch(key, "^F(?:[6-9]|10)$")) prefs.hotkey = key;
            prefs.echoCancellation = Json.Bool(obj, "echoCancellation", true);
            prefs.noiseSuppression = Json.Bool(obj, "noiseSuppression", true);
            prefs.autoGainControl = Json.Bool(obj, "autoGainControl", true);
            var bitrate = Json.Value(obj, "voiceBitrate");
            if (bitrate is int && ((int)bitrate == 16000 || (int)bitrate == 24000 || (int)bitrate == 40000))
                prefs.voiceBitrate = (int)bitrate;
            var share = Json.Value(obj, "voiceShare");
            if (share is int) prefs.voiceShare = Math.Max(15, Math.Min(85, (int)share));
            return prefs;
        }
    }

    internal sealed class RememberedLogin {
        public string username;
        public string password;
        public bool autoLogin;
    }

    internal sealed class StoredProfile {
        public string endpoint;
        public Preferences preferences = new Preferences();
        public RememberedLogin remembered;
    }

    internal static class Json {
        public static JavaScriptSerializer Serializer(int max = 262144) {
            return new JavaScriptSerializer { MaxJsonLength = max, RecursionLimit = 20 };
        }
        public static Dictionary<string, object> Object(object value) {
            return value as Dictionary<string, object> ?? new Dictionary<string, object>();
        }
        public static object Value(Dictionary<string, object> obj, string key) {
            object value;
            return obj.TryGetValue(key, out value) ? value : null;
        }
        public static string Text(Dictionary<string, object> obj, string key, int max) {
            var value = Value(obj, key) as string;
            return value != null && value.Length <= max ? value : "";
        }
        public static bool Bool(Dictionary<string, object> obj, string key, bool fallback = false) {
            object value = Value(obj, key);
            return value is bool ? (bool)value : fallback;
        }
        public static string DeviceId(Dictionary<string, object> obj, string key) {
            var id = Text(obj, key, 256);
            return Regex.IsMatch(id, "^[A-Za-z0-9_-]{1,256}$") ? id : "default";
        }
        public static bool IsId(string id) { return Regex.IsMatch(id ?? "", "^[A-Za-z0-9_-]{1,64}$"); }
        public static bool IsToken(string token) { return Regex.IsMatch(token ?? "", "^[A-Za-z0-9._~-]{16,8192}$"); }
    }

    internal static class EndpointPolicy {
        public static Uri Validate(string input, bool media, bool lab) {
            Uri uri;
            if (String.IsNullOrWhiteSpace(input) || !Uri.TryCreate(input.Trim(), UriKind.Absolute, out uri)
                || uri.UserInfo.Length != 0 || uri.Query.Length != 0 || uri.Fragment.Length != 0
                || uri.AbsolutePath != "/" || String.IsNullOrEmpty(uri.Host) || uri.Port <= 0
                || (uri.HostNameType != UriHostNameType.Dns && uri.HostNameType != UriHostNameType.IPv4 && uri.HostNameType != UriHostNameType.IPv6))
                throw new FriendlyError(media ? "语音服务器返回的接入信息不完整。" : "请输入完整的 HTTPS 接入地址，不含路径或账号信息。");
            string secure = media ? "wss" : "https";
            string insecure = media ? "ws" : "http";
            if (uri.Scheme != secure && !(lab && uri.Host == "127.0.0.1" && uri.Scheme == insecure))
                throw new FriendlyError(media ? "语音连接需要受信的 WSS 地址。" : "接入地址必须使用 HTTPS。");
            return uri;
        }
    }

    internal sealed class ProfileStore {
        private readonly string file;
        public readonly string DirectoryPath;
        public bool ReadError { get; private set; }

        public ProfileStore(string directory) {
            DirectoryPath = Path.GetFullPath(directory);
            file = Path.Combine(DirectoryPath, "connection.dpapi");
        }

        public FileStream LockDirectory() {
            Directory.CreateDirectory(DirectoryPath);
            return new FileStream(Path.Combine(DirectoryPath, "run.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
        }

        public StoredProfile MigrateFrom(string directory, bool lab) {
            var legacy = new ProfileStore(directory);
            var old = legacy.Load(lab);
            if (legacy.ReadError) return Load(lab);
            if (!File.Exists(file) && old.endpoint != null) Save(old);
            return old;
        }

        public StoredProfile Load(bool lab) {
            var blank = new StoredProfile();
            ReadError = false;
            if (!File.Exists(file)) return blank;
            byte[] clear = null;
            try {
                if (new FileInfo(file).Length > 32768) throw new InvalidDataException();
                clear = ProtectedData.Unprotect(File.ReadAllBytes(file), null, DataProtectionScope.CurrentUser);
                var decoded = Json.Object(Json.Serializer().DeserializeObject(Encoding.UTF8.GetString(clear)));
                var endpoint = Json.Text(decoded, "endpoint", 2048);
                blank.endpoint = String.IsNullOrEmpty(endpoint) ? null : EndpointPolicy.Validate(endpoint, false, lab).AbsoluteUri;
                blank.preferences = Preferences.Parse(Json.Object(Json.Value(decoded, "preferences")));
                var saved = Json.Object(Json.Value(decoded, "remembered"));
                var username = Json.Text(saved, "username", 96);
                var password = Json.Text(saved, "password", 256);
                if (blank.endpoint != null && !String.IsNullOrEmpty(username)) {
                    blank.remembered = new RememberedLogin {
                        username = username, password = password,
                        autoLogin = password.Length != 0 && Json.Bool(saved, "autoLogin")
                    };
                }
                return blank;
            } catch {
                ReadError = true;
                return new StoredProfile();
            } finally { if (clear != null) Array.Clear(clear, 0, clear.Length); }
        }

        public void Save(StoredProfile profile) {
            Directory.CreateDirectory(DirectoryPath);
            byte[] clear = Encoding.UTF8.GetBytes(Json.Serializer().Serialize(new { profile.endpoint, profile.remembered }));
            try {
                var encrypted = ProtectedData.Protect(clear, null, DataProtectionScope.CurrentUser);
                WriteAtomic(file, encrypted);
                ReadError = false;
            } finally { Array.Clear(clear, 0, clear.Length); }
        }

        internal static void WriteAtomic(string path, byte[] data) {
            string temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
            try {
                File.WriteAllBytes(temporary, data);
                if (File.Exists(path)) File.Replace(temporary, path, null);
                else File.Move(temporary, path);
            } finally {
                if (File.Exists(temporary)) File.Delete(temporary);
            }
        }
    }
}
