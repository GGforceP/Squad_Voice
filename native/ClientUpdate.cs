using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace SquadVoice {
    internal sealed partial class ApiClient {
        public async Task DownloadInstaller(ReleaseInfo release, string path, CancellationToken cancellation) {
            RequireSession();
            int starting = epoch;
            var token = session;
            using (var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellation))
            using (var request = new HttpRequestMessage(HttpMethod.Post, new Uri(signedInOrigin, "/api/v1/client/download"))) {
                deadline.CancelAfter(TimeSpan.FromMinutes(3));
                request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
                request.Content = new StringContent(Json.Serializer().Serialize(new {
                    version = release.Version.ToString(), sha256 = release.Sha256
                }), Encoding.UTF8, "application/json");
                using (var response = await transfer.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, deadline.Token)) {
                    VerifyFeatureResponse(response, token);
                    if (starting != epoch || !response.IsSuccessStatusCode || response.Content.Headers.ContentLength != release.Size)
                        throw new FriendlyError("更新包已变更或暂不可用，请重新检查更新。");
                    using (var source = await response.Content.ReadAsStreamAsync())
                    using (var output = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None, 65536, true)) {
                        var buffer = new byte[65536];
                        long written = 0;
                        int count;
                        while ((count = await source.ReadAsync(buffer, 0, buffer.Length, deadline.Token)) != 0) {
                            written += count;
                            if (starting != epoch || written > release.Size) throw new InvalidDataException();
                            await output.WriteAsync(buffer, 0, count, deadline.Token);
                        }
                        if (written != release.Size) throw new InvalidDataException();
                    }
                }
            }
        }
    }

    internal sealed class ReleaseInfo {
        public Version Version { get; private set; }
        public string Sha256 { get; private set; }
        public long Size { get; private set; }
        public bool Required { get; private set; }

        public static ReleaseInfo Verify(Dictionary<string, object> envelope) {
            if (envelope.Count == 0) return null;
            var payload = Convert.FromBase64String(Json.Text(envelope, "payload", 8192));
            var signature = Convert.FromBase64String(Json.Text(envelope, "signature", 600));
            var provider = new CspParameters(24) { Flags = CspProviderFlags.CreateEphemeralKey };
            using (var rsa = new RSACryptoServiceProvider(3072, provider) { PersistKeyInCsp = false }) {
                rsa.ImportParameters(new RSAParameters {
                    Modulus = Convert.FromBase64String(ReleaseBuild.UpdateModulus), Exponent = new byte[] { 1, 0, 1 }
                });
                if (!rsa.VerifyData(payload, CryptoConfig.MapNameToOID("SHA256"), signature)) throw new InvalidDataException();
            }
            var manifest = Json.Object(Json.Serializer(8192).DeserializeObject(Encoding.UTF8.GetString(payload)));
            var version = Json.Text(manifest, "version", 17);
            var sha256 = Json.Text(manifest, "sha256", 64);
            var size = ChatCache.Number(Json.Value(manifest, "size"));
            if (Json.Text(manifest, "platform", 10) != "win-x64" ||
                !Regex.IsMatch(version, @"\A(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})\z") ||
                Json.Text(manifest, "file", 80) != "SquadVoice-" + version + "-x64.exe" ||
                !Regex.IsMatch(sha256, @"\A[a-f0-9]{64}\z") || size <= 0 || size > 32 * 1024 * 1024)
                throw new InvalidDataException();
            return new ReleaseInfo { Version = new Version(version), Sha256 = sha256, Size = size, Required = Json.Bool(manifest, "required") };
        }

        public bool Matches(string path) {
            try {
                if (!File.Exists(path) || (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0) return false;
                using (var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
                using (var sha = SHA256.Create()) {
                    if (file.Length != Size) return false;
                    var computed = BitConverter.ToString(sha.ComputeHash(file)).Replace("-", "");
                    return String.Equals(computed, Sha256, StringComparison.OrdinalIgnoreCase);
                }
            } catch (IOException) { return false; }
            catch (UnauthorizedAccessException) { return false; }
        }
    }

    internal sealed class UpdateLaunch {
        public readonly ReleaseInfo Release;
        private readonly string path;
        public UpdateLaunch(ReleaseInfo release, string path) { Release = release; this.path = path; }

        public void Start(string installation) {
            if (!Release.Matches(path)) throw new FriendlyError("更新包未通过最终完整性校验。");
            Process.Start(new ProcessStartInfo {
                FileName = path, Arguments = "/S /UPDATE /WAITPID=" + Process.GetCurrentProcess().Id + " /D=" + installation, WorkingDirectory = installation,
                UseShellExecute = false, CreateNoWindow = true
            });
        }
    }

    internal sealed class ClientUpdater {
        private readonly ApiClient api;
        private readonly Version installed;
        private readonly string directory;
        private readonly Action<string, object> notify;
        private CancellationTokenSource cancellation = new CancellationTokenSource();
        private ReleaseInfo available;
        private string status = "none";
        private Task checking;
        private Task<UpdateLaunch> downloading;
        private bool accepted;

        public ClientUpdater(ApiClient api, string installed, string dataDirectory, Action<string, object> notify) {
            this.api = api;
            this.installed = new Version(installed);
            this.notify = notify;
            directory = Path.Combine(dataDirectory, "Updates");
        }

        private object Notice() { return new { status = status, version = available == null ? "" : available.Version.ToString(), required = available != null && available.Required }; }
        private void Changed(string next) { status = next; notify("update.state", Notice()); }

        public async Task<object> Check(bool interactive) {
            if (!api.SignedIn) return Notice();
            if (ReleaseBuild.UpdateModulus.Length == 0) {
                if (interactive) Changed("disabled");
                return Notice();
            }
            if (checking == null) {
                var next = Find(cancellation.Token, interactive);
                checking = next;
                try { await next; }
                finally { if (checking == next) checking = null; }
            } else await checking;
            return Notice();
        }

        private async Task Find(CancellationToken token, bool interactive) {
            try {
                var reply = await api.Feature("client/update", new { }, token);
                if (token.IsCancellationRequested) return;
                var release = ReleaseInfo.Verify(reply);
                if (release == null || release.Version.CompareTo(installed) <= 0) {
                    if (available == null && interactive) Changed("current");
                    return;
                }
                if (available != null && available.Version == release.Version && available.Sha256 == release.Sha256 && available.Required == release.Required) {
                    if (interactive && status == "error" && release.Required) Begin();
                    return;
                }
                downloading = null;
                accepted = false;
                available = release;
                Changed("available");
                if (release.Required) Begin();
            } catch (FriendlyError error) {
                if (interactive && !token.IsCancellationRequested) Changed(error.Code == "not_found" ? "disabled" : "error");
            } catch {
                if (!token.IsCancellationRequested) Changed("error");
            }
        }

        public object Accept() {
            if (available != null) { accepted = true; Begin(); }
            return Notice();
        }

        private void Begin() {
            if (downloading == null || (downloading.IsCompleted && downloading.Result == null))
                downloading = Download(available, cancellation.Token);
        }

        private async Task<UpdateLaunch> Download(ReleaseInfo release, CancellationToken token) {
            string temporary = null;
            Changed("downloading");
            try {
                Directory.CreateDirectory(directory);
                if ((File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0) throw new IOException();
                string package = Path.Combine(directory, release.Version + "-" + release.Sha256.Substring(0, 16) + ".exe");
                if (!await Task.Run(() => release.Matches(package), token)) {
                    temporary = Path.Combine(directory, Guid.NewGuid().ToString("N") + ".part");
                    await api.DownloadInstaller(release, temporary, token);
                    if (!await Task.Run(() => release.Matches(temporary), token)) throw new InvalidDataException();
                    token.ThrowIfCancellationRequested();
                    if (File.Exists(package)) File.Replace(temporary, package, null);
                    else File.Move(temporary, package);
                }
                if (token.IsCancellationRequested || available != release) return null;
                Changed("ready");
                return new UpdateLaunch(release, package);
            } catch {
                if (!token.IsCancellationRequested && available == release) Changed("error");
                return null;
            } finally {
                if (temporary != null) {
                    try { File.Delete(temporary); } catch (IOException) { } catch (UnauthorizedAccessException) { }
                }
            }
        }

        public async Task<UpdateLaunch> OnExit() {
            if (available == null || (!accepted && !available.Required) || downloading == null) return null;
            return await downloading;
        }

        public void Reset() {
            cancellation.Cancel();
            cancellation.Dispose();
            cancellation = new CancellationTokenSource();
            available = null;
            accepted = false;
            checking = null;
            downloading = null;
            Changed("none");
        }
    }
}
