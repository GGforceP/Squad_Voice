using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace SquadVoice {
    internal sealed class ChatCache {
        private const string FolderName = "Squad Voice Media Cache";
        private const int FileLimit = 6 * 1024 * 1024;
        private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("Squad Voice chat cache v1");
        private static readonly Regex ScopePattern = new Regex("^s-[a-f0-9]{32}$");
        private static readonly Regex EntryPattern = new Regex("^(cursor|p-[a-z0-9_-]+-[a-f0-9]{32}|i-[a-z0-9_-]+-[0-9]+)\\.svc$");
        private static readonly Regex DirectPattern = new Regex(@"\Adm\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\z");
        public const int ConversationLimit = 503;
        private readonly SemaphoreSlim gate = new SemaphoreSlim(1, 1);
        private readonly string dataDirectory, defaultRoot, optionsPath, pointerPath;
        private string root;
        private bool encrypted = true;
        private long generation;

        public ChatCache(string dataDirectory, string documents) {
            this.dataDirectory = dataDirectory;
            defaultRoot = Path.Combine(dataDirectory, "MediaCache");
            optionsPath = Path.Combine(documents, "chat-cache.json");
            pointerPath = Path.Combine(dataDirectory, "cache-location.txt");
            root = defaultRoot;
            if (!File.Exists(optionsPath)) return;
            try {
                var options = Json.Object(Json.Serializer().DeserializeObject(File.ReadAllText(optionsPath)));
                if (!SamePath(dataDirectory, Json.Text(options, "installation", 2048))) return;
                var location = Json.Text(options, "path", 2048);
                if (SamePath(location, defaultRoot) || OwnsExternal(location)) root = location;
                encrypted = Json.Bool(options, "encrypted", true);
            } catch (IOException) { }
            catch (UnauthorizedAccessException) { }
            catch (ArgumentException) { }
            catch (InvalidOperationException) { }
        }

        public static string Hash(string value) {
            using (var hash = SHA256.Create()) {
                // Cache keys use 128 bits to leave room for the selected folder and atomic write suffix.
                return BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(value)), 0, 16).Replace("-", "").ToLowerInvariant();
            }
        }

        public static string ConversationKey(string value) {
            if (Json.IsId(value)) return value;
            // This prefix plus the hash is longer than any regular channel ID.
            return !String.IsNullOrEmpty(value) && value.Length <= ConversationLimit && DirectPattern.IsMatch(value)
                ? "direct-conversation-" + Hash(value) : null;
        }

        public Task<T> Run<T>(Func<T> work) { return RunLocked(work); }

        private async Task<T> RunLocked<T>(Func<T> work) {
            await gate.WaitAsync();
            try { return await Task.Run(work); }
            finally { gate.Release(); }
        }

        public long Generation { get { return generation; } }

        public Dictionary<string, object> Get(string scope, string key) {
            var content = Read(scope, key);
            if (content == null) return new Dictionary<string, object>();
            try { return Json.Object(Json.Serializer(524288).DeserializeObject(Encoding.UTF8.GetString(content))); }
            catch (ArgumentException) { return new Dictionary<string, object>(); }
            catch (InvalidOperationException) { return new Dictionary<string, object>(); }
        }

        public void Put(string scope, string key, object value) {
            Write(scope, key, Encoding.UTF8.GetBytes(Json.Serializer(524288).Serialize(value)));
        }

        public byte[] Read(string scope, string key) {
            var path = EntryPath(scope, key);
            if (!File.Exists(path)) return null;
            try { return Decode(path); }
            catch (IOException) { return null; }
            catch (CryptographicException) { return null; }
            catch (UnauthorizedAccessException) { return null; }
        }

        public void Write(string scope, string key, byte[] bytes) {
            var file = EntryPath(scope, key);
            if (bytes.Length > FileLimit) throw new InvalidDataException();
            Directory.CreateDirectory(Path.GetDirectoryName(file));
            WriteEntry(file, bytes, encrypted);
        }

        public void Apply(string scope, Dictionary<string, object> updates) {
            bool reset = Json.Bool(updates, "reset");
            var events = Json.Value(updates, "events") as IEnumerable;
            var directory = ScopeDirectory(scope);
            if (Directory.Exists(directory)) {
                if (reset) {
                    foreach (var file in Entries(directory)) File.Delete(file);
                    generation++;
                } else if (events != null) {
                    var changedChannels = new HashSet<string>(StringComparer.Ordinal);
                    foreach (var item in events) {
                        var change = Json.Object(item);
                        var op = Json.Text(change, "op", 16);
                        if (op != "delete" && op != "channel" && op != "image") continue;
                        var channel = ConversationKey(Json.Text(change, "channelId", ConversationLimit));
                        if (channel == null) continue;
                        changedChannels.Add(channel);
                        if (op == "channel") {
                            foreach (var file in Directory.EnumerateFiles(directory, "i-" + channel + "-*.svc")) {
                                string number = Path.GetFileNameWithoutExtension(file).Substring(channel.Length + 3);
                                long parsed;
                                if (Int64.TryParse(number, out parsed)) File.Delete(file);
                            }
                        } else {
                            var id = Number(Json.Value(change, "id"));
                            if (id > 0) File.Delete(EntryPath(scope, "i-" + channel + "-" + id));
                        }
                    }
                    foreach (var channel in changedChannels) {
                        foreach (var file in Directory.EnumerateFiles(directory, "p-" + channel + "-*.svc")) {
                            string hash = Path.GetFileNameWithoutExtension(file).Substring(channel.Length + 3);
                            if (Regex.IsMatch(hash, "^[a-f0-9]{32}$")) File.Delete(file);
                        }
                    }
                    if (changedChannels.Count > 0) generation++;
                }
            }
            Put(scope, "cursor", new { epoch = Json.Text(updates, "epoch", 64), cursor = Number(Json.Value(updates, "cursor")) });
        }

        public object Usage() {
            long chat = 0, images = 0, runtime = 0, driveTotal = 0, driveFree = 0;
            foreach (var file in ManagedFiles(root)) {
                try {
                    long size = new FileInfo(file).Length;
                    if (Path.GetFileName(file).StartsWith("i-", StringComparison.Ordinal)) images += size;
                    else chat += size;
                } catch (IOException) { }
            }
            try { runtime = DirectoryBytes(Path.Combine(dataDirectory, "WebView")); }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
            try {
                var drive = new DriveInfo(Path.GetPathRoot(root));
                driveTotal = drive.TotalSize;
                driveFree = drive.AvailableFreeSpace;
            } catch (IOException) { }
            catch (ArgumentException) { }
            catch (UnauthorizedAccessException) { }
            return new {
                path = root, encrypted = encrypted, messages = chat, images = images,
                webView = runtime, driveTotal = driveTotal, driveFree = driveFree, defaultLocation = SamePath(root, defaultRoot)
            };
        }

        public void Configure(string newParent, bool protect, bool clear, bool useDefault = false) {
            string target = useDefault ? defaultRoot : root;
            if (!String.IsNullOrEmpty(newParent)) {
                if (Path.GetFileName(newParent.TrimEnd(Path.DirectorySeparatorChar)).Equals(FolderName, StringComparison.OrdinalIgnoreCase)
                    && OwnsExternal(newParent)) target = newParent;
                else target = Path.GetFullPath(Path.Combine(newParent, FolderName));
            }
            if (SamePath(target, root)) {
                if (clear) ClearFiles(root);
                if (protect != encrypted) {
                    foreach (var item in ManagedFiles(root)) {
                        var bytes = Decode(item);
                        if (bytes == null) File.Delete(item);
                        else WriteEntry(item, bytes, protect);
                    }
                }
                SaveOptions(root, protect);
                encrypted = protect;
                generation++;
                return;
            }
            bool existingDefault = SamePath(target, defaultRoot) && NormalDirectory(target) &&
                Directory.GetFileSystemEntries(target).Length == 0;
            if ((Directory.Exists(target) && !existingDefault) || File.Exists(target) || Inside(target, root) || Inside(root, target))
                throw new FriendlyError("请选择其他目录。目标缓存目录必须是新建目录。");
            if (!SamePath(target, defaultRoot) && Inside(target, dataDirectory))
                throw new FriendlyError("请选择安装数据目录之外的位置来迁移缓存。");

            Directory.CreateDirectory(target);
            try {
                if (!SamePath(target, defaultRoot)) WriteUnicode(Path.Combine(target, "owner.txt"), dataDirectory);
                if (!clear) {
                    foreach (var item in ManagedFiles(root)) {
                        string relative = item.Substring(root.Length + 1);
                        var dest = Path.Combine(target, relative);
                        var bytes = Decode(item);
                        if (bytes == null) continue;
                        Directory.CreateDirectory(Path.GetDirectoryName(dest));
                        WriteEntry(dest, bytes, protect);
                    }
                }
                SaveOptions(target, protect);
            } catch {
                RemoveOwned(target);
                throw;
            }
            string old = root;
            root = target;
            encrypted = protect;
            generation++;
            RemoveOwned(old);
        }

        private void SaveOptions(string location, bool protect) {
            // Keep the last location with the installation so Uninstall.exe
            // can also clean up its own external cache folder.
            string old = File.Exists(pointerPath) ? File.ReadAllText(pointerPath, Encoding.Unicode).Trim() : "";
            WriteUnicode(pointerPath, SamePath(location, defaultRoot) ? "" : location);
            try {
                Directory.CreateDirectory(Path.GetDirectoryName(optionsPath));
                var json = Json.Serializer().Serialize(new { path = location, installation = dataDirectory, encrypted = protect });
                ProfileStore.WriteAtomic(optionsPath, Encoding.UTF8.GetBytes(json));
            } catch {
                WriteUnicode(pointerPath, old);
                throw;
            }
        }

        private static void WriteUnicode(string path, string value) {
            var utf16 = Encoding.Unicode;
            var bytes = new List<byte>(utf16.GetPreamble());
            bytes.AddRange(utf16.GetBytes(value + "\r\n"));
            ProfileStore.WriteAtomic(path, bytes.ToArray());
        }

        private void RemoveOwned(string location) {
            if (!Directory.Exists(location)) return;
            if (SamePath(location, defaultRoot)) { ClearFiles(location); return; }
            if (!OwnsExternal(location)) return;
            ClearFiles(location);
            var owner = Path.Combine(location, "owner.txt");
            if (Directory.GetFileSystemEntries(location).Length == 1) {
                File.Delete(owner);
                Directory.Delete(location);
            }
        }

        private bool OwnsExternal(string location) {
            if (String.IsNullOrEmpty(location) || !Path.IsPathRooted(location) ||
                !Path.GetFileName(location).Equals(FolderName, StringComparison.OrdinalIgnoreCase) ||
                !NormalDirectory(location)) return false;
            var marker = Path.Combine(location, "owner.txt");
            return File.Exists(marker) && new FileInfo(marker).Length <= 8192 &&
                SamePath(File.ReadAllText(marker, Encoding.Unicode).Trim(), dataDirectory);
        }

        private static void ClearFiles(string location) {
            foreach (var file in ManagedFiles(location)) File.Delete(file);
            if (!NormalDirectory(location)) return;
            foreach (var directory in Directory.EnumerateDirectories(location)) {
                if (ScopePattern.IsMatch(Path.GetFileName(directory)) && NormalDirectory(directory)
                    && Directory.GetFileSystemEntries(directory).Length == 0) Directory.Delete(directory);
            }
        }

        private string ScopeDirectory(string scope) {
            if (!ScopePattern.IsMatch(scope)) throw new InvalidDataException();
            if (Directory.Exists(root) && !NormalDirectory(root)) throw new IOException("Cache directory is a reparse point.");
            var directory = Path.Combine(root, scope);
            if (Directory.Exists(directory) && !NormalDirectory(directory)) throw new IOException("Cache subdirectory is a reparse point.");
            return directory;
        }

        private string EntryPath(string scope, string key) {
            var name = key + ".svc";
            if (!EntryPattern.IsMatch(name)) throw new InvalidDataException();
            return Path.Combine(ScopeDirectory(scope), name);
        }

        private static IEnumerable<string> ManagedFiles(string location) {
            if (!NormalDirectory(location)) yield break;
            foreach (var directory in Directory.EnumerateDirectories(location, "s-*")) {
                if (!NormalDirectory(directory) || !ScopePattern.IsMatch(Path.GetFileName(directory))) continue;
                foreach (var file in Entries(directory)) yield return file;
            }
        }

        private static IEnumerable<string> Entries(string directory) {
            foreach (var file in Directory.EnumerateFiles(directory, "*.svc")) {
                if (EntryPattern.IsMatch(Path.GetFileName(file)) && (File.GetAttributes(file) & FileAttributes.ReparsePoint) == 0)
                    yield return file;
            }
        }

        private static bool NormalDirectory(string directory) {
            return Directory.Exists(directory) && (File.GetAttributes(directory) & FileAttributes.ReparsePoint) == 0;
        }

        private static bool SamePath(string left, string right) {
            return String.Equals(left, right, StringComparison.OrdinalIgnoreCase);
        }

        private static bool Inside(string path, string parent) {
            return path.StartsWith(parent.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
        }

        private static long DirectoryBytes(string directory) {
            if (!NormalDirectory(directory)) return 0;
            long size = 0;
            foreach (var child in Directory.EnumerateDirectories(directory)) size += DirectoryBytes(child);
            foreach (var file in Directory.EnumerateFiles(directory)) {
                try { size += new FileInfo(file).Length; }
                catch (IOException) { }
            }
            return size;
        }

        private static byte[] Decode(string file) {
            var entry = new FileInfo(file);
            if (entry.Length < 2 || entry.Length > FileLimit || (entry.Attributes & FileAttributes.ReparsePoint) != 0) return null;
            var data = File.ReadAllBytes(file);
            var payload = new byte[data.Length - 1];
            Buffer.BlockCopy(data, 1, payload, 0, payload.Length);
            if (data[0] == 0) return payload;
            if (data[0] == 1) return ProtectedData.Unprotect(payload, Entropy, DataProtectionScope.CurrentUser);
            return null;
        }

        private static void WriteEntry(string file, byte[] plain, bool protect) {
            byte[] payload = protect ? ProtectedData.Protect(plain, Entropy, DataProtectionScope.CurrentUser) : plain;
            var content = new byte[payload.Length + 1];
            content[0] = protect ? (byte)1 : (byte)0;
            Buffer.BlockCopy(payload, 0, content, 1, payload.Length);
            ProfileStore.WriteAtomic(file, content);
        }

        public static long Number(object value) {
            return value is int ? (int)value : value is long ? (long)value : 0L;
        }
    }
}
