using System;
using System.IO;
using System.Text;

namespace SquadVoice {
    internal sealed class PublicSettings {
        private readonly string directory;
        private readonly string preferencesFile;
        private readonly string installationFile;

        public PublicSettings(string directory) {
            this.directory = Path.GetFullPath(directory);
            preferencesFile = Path.Combine(this.directory, "preferences.json");
            installationFile = Path.Combine(this.directory, "installation.txt");
        }

        public Preferences LoadPreferences(Preferences fallback) {
            if (!File.Exists(preferencesFile)) {
                SavePreferences(fallback);
                return fallback;
            }
            try {
                if (new FileInfo(preferencesFile).Length > 32768) return fallback;
                return Preferences.Parse(Json.Object(Json.Serializer().DeserializeObject(File.ReadAllText(preferencesFile))));
            } catch { return fallback; }
        }

        public void SavePreferences(Preferences value) {
            Directory.CreateDirectory(directory);
            ProfileStore.WriteAtomic(preferencesFile, Encoding.UTF8.GetBytes(Json.Serializer().Serialize(value)));
        }

        public void RecordInstallation(string path, string version) {
            string content = path + "\r\n" + version + "\r\n";
            if (File.Exists(installationFile) && new FileInfo(installationFile).Length <= 8192 &&
                File.ReadAllText(installationFile, Encoding.Unicode) == content) return;
            Directory.CreateDirectory(directory);
            var encoding = Encoding.Unicode;
            var body = encoding.GetBytes(content);
            var preamble = encoding.GetPreamble();
            var bytes = new byte[preamble.Length + body.Length];
            Buffer.BlockCopy(preamble, 0, bytes, 0, preamble.Length);
            Buffer.BlockCopy(body, 0, bytes, preamble.Length, body.Length);
            ProfileStore.WriteAtomic(installationFile, bytes);
        }
    }
}
