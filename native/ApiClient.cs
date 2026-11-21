using System;
using System.Collections;
using System.Collections.Generic;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace SquadVoice {
    internal sealed partial class ApiClient : IDisposable {
        private readonly HttpClient http;
        private readonly bool lab;
        private string session;
        private Uri signedInOrigin;
        private int epoch;
        private bool loginPending;
        private readonly HashSet<string> channels = new HashSet<string>(StringComparer.Ordinal);

        public ApiClient(bool lab) {
            this.lab = lab;
            http = new HttpClient(new HttpClientHandler {
                AllowAutoRedirect = false, UseCookies = false, UseDefaultCredentials = false
            }) { Timeout = TimeSpan.FromSeconds(12), MaxResponseContentBufferSize = 524288 };
            transfer = new HttpClient(new HttpClientHandler {
                AllowAutoRedirect = false, UseCookies = false, UseDefaultCredentials = false
            }) { Timeout = TimeSpan.FromSeconds(100), MaxResponseContentBufferSize = ImageLimit + 1024 };
        }

        public bool SignedIn { get { return session != null; } }
        public bool Busy { get { return loginPending; } }

        public async Task<object> Login(StoredProfile profile, string username, string password) {
            if (profile.endpoint == null) throw new FriendlyError("请先设置管理员提供的接入地址。");
            if (loginPending) throw new FriendlyError("登录正在进行，请稍候。");
            if (username.Length == 0 || password.Length == 0) throw new FriendlyError("请输入管理员分配的账号和密码。");
            var origin = EndpointPolicy.Validate(profile.endpoint, false, lab);
            Clear();
            int starting = epoch;
            loginPending = true;
            try {
                var response = await Post(origin, "/api/v1/login", new { username = username, password = password }, null, true);
                if (starting != epoch) throw new FriendlyError("登录已取消，请重试。");
                var user = Json.Object(Json.Value(response, "user"));
                var workspace = Json.Object(Json.Value(response, "workspace"));
                var sessionValue = Json.Text(response, "sessionToken", 8192);
                var id = Json.Text(user, "id", 64);
                var userName = Json.Text(user, "name", 64);
                var workspaceName = Json.Text(workspace, "name", 64);
                var channelList = Json.Value(workspace, "channels") as IEnumerable;
                if (!Json.IsToken(sessionValue) || !Json.IsId(id) || userName.Length == 0 || workspaceName.Length == 0 || channelList == null)
                    throw new FriendlyError("服务端返回的账号或频道信息无效。");
                var result = ReadChannels(channelList);
                session = sessionValue;
                signedInOrigin = origin;
                return new { user = ReadUser(user), workspace = new { name = workspaceName, channels = result } };
            } finally { loginPending = false; }
        }

        public async Task<object> Join(Dictionary<string, object> args) {
            if (session == null) throw new FriendlyError("登录已失效，请重新登录。");
            var channelId = Json.Text(args, "channelId", 64);
            if (!channels.Contains(channelId)) throw new FriendlyError("此频道不可加入。");
            int starting = epoch;
            var reply = await Post(signedInOrigin, "/api/v1/voice/join", new { channelId = channelId }, session, false);
            if (starting != epoch) throw new FriendlyError("本次加入已取消。");
            var access = Json.Text(reply, "accessToken", 8192);
            if (!Json.IsToken(access)) throw new FriendlyError("服务器未返回有效的入房许可。");
            var address = EndpointPolicy.Validate(Json.Text(reply, "serverUrl", 2048), true, lab);
            var lease = Json.Text(reply, "leaseId", 64);
            return new { serverUrl = address.GetLeftPart(UriPartial.Authority), accessToken = access, leaseId = Json.IsId(lease) ? lease : "",
                rules = Json.Object(Json.Value(reply, "rules")) };
        }

        public async Task Leave(Dictionary<string, object> args) {
            var lease = Json.Text(args, "leaseId", 64);
            if (session == null || !Json.IsId(lease)) return;
            await Post(signedInOrigin, "/api/v1/voice/leave", new { leaseId = lease }, session, false);
        }

        public async Task<object> UpdateProfile(Dictionary<string, object> args) {
            if (session == null) throw new FriendlyError("登录已失效，请重新登录。");
            var name = Json.Text(args, "name", 64).Trim();
            var bio = Json.Text(args, "bio", 160).Trim();
            if (name.Length == 0) throw new FriendlyError("请输入显示名称。");
            var starting = epoch;
            var response = await Post(signedInOrigin, "/api/v1/account/profile", new { name = name, bio = bio }, session, false);
            if (starting != epoch) throw new FriendlyError("登录已失效，请重新登录。");
            return ReadUser(response);
        }

        public async Task ChangePassword(Dictionary<string, object> args) {
            if (session == null) throw new FriendlyError("登录已失效，请重新登录。");
            var previous = Json.Text(args, "currentPassword", 256);
            var next = Json.Text(args, "newPassword", 256);
            if (previous.Length == 0 || next.Length < 9) throw new FriendlyError("请输入当前密码，新密码至少 9 个字符。");
            var starting = epoch;
            await Post(signedInOrigin, "/api/v1/account/password", new { currentPassword = previous, newPassword = next }, session, false);
            if (starting == epoch) Clear();
        }

        private static object ReadUser(Dictionary<string, object> user) {
            var id = Json.Text(user, "id", 64);
            var name = Json.Text(user, "name", 64);
            if (!Json.IsId(id) || name.Length == 0) throw new FriendlyError("服务端返回的个人资料无效。");
            return new { id = id, name = name, username = Json.Text(user, "username", 96), bio = Json.Text(user, "bio", 160),
                admin = Json.Bool(user, "admin"), role = Json.Text(user, "role", 16) };
        }

        public async Task Logout() {
            var previous = session;
            var origin = signedInOrigin;
            Clear();
            if (previous != null) {
                try { await Post(origin, "/api/v1/logout", new { }, previous, false); }
                catch (FriendlyError) { /* Local session is already discarded. */ }
            }
        }

        private async Task<Dictionary<string, object>> Post(Uri origin, string path, object body, string token, bool login, CancellationToken cancellation = default(CancellationToken)) {
            var target = new Uri(origin, path);
            using (var request = new HttpRequestMessage(HttpMethod.Post, target)) {
                request.Headers.Accept.ParseAdd("application/json");
                request.Headers.CacheControl = new CacheControlHeaderValue { NoStore = true };
                if (token != null) request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
                request.Content = new StringContent(Json.Serializer().Serialize(body), Encoding.UTF8, "application/json");
                try {
                    using (var response = await http.SendAsync(request, cancellation)) {
                        int status = (int)response.StatusCode;
                        VerifyFeatureResponse(response, token);
                        IEnumerable<string> errorCodes;
                        if (response.Headers.TryGetValues("X-SquadVoice-Error", out errorCodes)) {
                            foreach (string code in errorCodes) {
                                if (code == "region_not_allowed") throw new FriendlyError("当前 IP 未通过服务器的地域准入，请检查网络出口或联系房主。");
                                if (code == "incorrect_current_password") throw new FriendlyError("当前密码不正确。");
                                if (code == "invalid_new_password") throw new FriendlyError("新密码须为 9 至 128 个字符，须包含大写字母、小写字母、数字、符号中的至少两类，且与当前密码不同。");
                                if (code == "invalid_profile") throw new FriendlyError("显示名称或个人简介不符合长度要求。");
                            }
                        }
                        if (status == 401 || status == 403) {
                            if (status == 401 && token != null && token == session) Clear();
                            throw new FriendlyError(login ? "账号或密码不正确，请向房主确认。" : status == 401 ? "登录已失效，请重新登录。" : "你没有执行此操作的权限。", login && status == 401 ? "invalid_credentials" : null);
                        }
                        if (status == 409) throw new FriendlyError("这个语音房间已满，请稍后再试。");
                        if (status == 429) throw new FriendlyError("请求太频繁，请稍后再试。");
                        if (!response.IsSuccessStatusCode) throw new FriendlyError("服务端暂时无法完成请求，请稍后再试。");
                        if (status == 204) return new Dictionary<string, object>();
                        try { return Json.Object(Json.Serializer(524288).DeserializeObject(await response.Content.ReadAsStringAsync())); }
                        catch (ArgumentException) { throw new FriendlyError("服务端响应无法识别。"); }
                    }
                } catch (HttpRequestException) {
                    throw new FriendlyError("无法连接服务器，请核对接入配置、网络和证书。");
                } catch (TaskCanceledException) {
                    throw new FriendlyError("服务器连接超时，请稍后再试。");
                }
            }
        }

        private void Clear() { ++epoch; session = null; signedInOrigin = null; channels.Clear(); }
        public void Dispose() { Clear(); http.Dispose(); transfer.Dispose(); }
    }
}
