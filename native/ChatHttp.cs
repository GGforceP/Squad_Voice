using System;
using System.Collections;
using System.Collections.Generic;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace SquadVoice {
    internal sealed partial class ApiClient {
        public const int ImageLimit = 5 * 1024 * 1024;
        public const int ImageTextLimit = ((ImageLimit + 2) / 3) * 4;
        private readonly HttpClient transfer;
        private readonly SemaphoreSlim attachmentSlots = new SemaphoreSlim(2, 2);

        public string CacheScope {
            get { return signedInOrigin == null ? null : "s-" + ChatCache.Hash(signedInOrigin.AbsoluteUri); }
        }

        private void RequireSession() {
            if (!SignedIn) throw new FriendlyError("登录已失效，请重新登录。", "session_expired");
        }

        public async Task<Dictionary<string, object>> Feature(string path, object data, CancellationToken cancellation) {
            RequireSession();
            int starting = epoch;
            var result = await Post(signedInOrigin, "/api/v1/" + path, data, session, false, cancellation);
            if (starting != epoch) throw new FriendlyError("登录已失效，请重新登录。", "session_expired");
            return result;
        }

        public async Task<object> Workspace() {
            var response = await Feature("workspace", new { }, CancellationToken.None);
            var list = Json.Value(response, "channels") as IEnumerable;
            if (list == null) throw new FriendlyError("服务器返回的频道列表无效。");
            response["channels"] = ReadChannels(list);
            return response;
        }

        private List<object> ReadChannels(IEnumerable list) {
            var result = new List<object>();
            channels.Clear();
            foreach (var value in list) {
                var channel = Json.Object(value);
                string id = Json.Text(channel, "id", 64), name = Json.Text(channel, "name", 64);
                if (!Json.IsId(id) || name.Length == 0 || !channels.Add(id)) continue;
                var rawCapacity = Json.Value(channel, "capacity");
                int capacity = rawCapacity is int ? Math.Max(1, Math.Min(5, (int)rawCapacity)) : 5;
                result.Add(new { id = id, groupId = Json.Text(channel, "groupId", 48),
                    name = name, description = Json.Text(channel, "description", 180), capacity = capacity });
                if (result.Count >= 30) break;
            }
            return result;
        }

        public async Task<Dictionary<string, object>> UploadImage(string channel, string nonce, string text, byte[] bytes) {
            using (var data = new MultipartFormDataContent()) {
                data.Add(new StringContent(nonce, Encoding.UTF8), "nonce");
                data.Add(new StringContent(text, Encoding.UTF8), "text");
                var image = new ByteArrayContent(bytes);
                image.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");
                data.Add(image, "image", "image");
                using (var response = await Transfer("/api/v1/chat/upload?channel=" + Uri.EscapeDataString(channel), data)) {
                    return Json.Object(Json.Serializer().DeserializeObject(await response.Content.ReadAsStringAsync()));
                }
            }
        }

        public async Task<byte[]> DownloadImage(string channel, long id, bool known) {
            var body = new { channelId = channel, id = id, known = known ? "cached" : "" };
            using (var data = new StringContent(Json.Serializer().Serialize(body), Encoding.UTF8, "application/json"))
            using (var response = await Transfer("/api/v1/chat/image", data)) {
                if (response.StatusCode == HttpStatusCode.NoContent) return null;
                var mime = response.Content.Headers.ContentType;
                if (mime == null || (mime.MediaType != "image/png" && mime.MediaType != "image/jpeg"
                    && mime.MediaType != "image/gif" && mime.MediaType != "image/webp"))
                    throw new FriendlyError("服务器返回的图片格式无效。");
                var bytes = await response.Content.ReadAsByteArrayAsync();
                if (bytes.Length == 0 || bytes.Length > ImageLimit) throw new FriendlyError("服务器返回的图片大小无效。");
                return bytes;
            }
        }

        private async Task<HttpResponseMessage> Transfer(string path, HttpContent content) {
            RequireSession();
            int starting = epoch;
            await attachmentSlots.WaitAsync();
            try {
                if (starting != epoch) throw new FriendlyError("登录已失效，请重新登录。", "session_expired");
                var token = session;
                using (var request = new HttpRequestMessage(HttpMethod.Post, new Uri(signedInOrigin, path))) {
                    request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
                    request.Headers.CacheControl = new CacheControlHeaderValue { NoStore = true };
                    request.Content = content;
                    var response = await transfer.SendAsync(request);
                    try {
                        VerifyFeatureResponse(response, token);
                        if (starting != epoch) throw new FriendlyError("登录已失效，请重新登录。", "session_expired");
                        if (!response.IsSuccessStatusCode) throw new FriendlyError("图片传输未完成，请稍后重试。");
                        return response;
                    } catch { response.Dispose(); throw; }
                }
            } catch (HttpRequestException) {
                throw new FriendlyError("图片传输中断，请检查网络后重试。");
            } catch (TaskCanceledException) {
                throw new FriendlyError("图片传输超时，请稍后重试。");
            } finally { attachmentSlots.Release(); }
        }

        private void VerifyFeatureResponse(HttpResponseMessage response, string token) {
            if (response.IsSuccessStatusCode) return;
            IEnumerable<string> codes;
            if (!response.Headers.TryGetValues("X-SquadVoice-Error", out codes)) return;
            foreach (string code in codes) {
                switch (code) {
                    case "session_expired":
                        if (token != null && token == session) Clear();
                        throw new FriendlyError("登录已失效，请重新登录。", code);
                    case "not_found": throw new FriendlyError("当前服务器版本未提供这项功能。", code);
                    case "admin_required": throw new FriendlyError("此操作需要管理员权限。", code);
                    case "channel_update_failed": throw new FriendlyError("频道保存失败，请检查名称、描述和人数上限。", code);
                    case "channel_not_found": throw new FriendlyError("该频道已不存在。", code);
                    case "group_update_failed": throw new FriendlyError("大频道保存失败，请检查名称。", code);
                    case "group_not_found": throw new FriendlyError("该大频道已不存在。", code);
                    case "conversation_unavailable": throw new FriendlyError("该私信会话已不可用。", code);
                    case "join_voice_for_chat": throw new FriendlyError("加入该语音频道后即可使用聊天。", code);
                    case "member_not_in_room": throw new FriendlyError("这位成员已离开频道。", code);
                    case "restriction_locked": throw new FriendlyError("管理员限制须满 60 秒才能自行解除。", code);
                    case "chat_restricted": throw new FriendlyError("你在此频道已被管理员禁言。", code);
                    case "update_unavailable": throw new FriendlyError("服务器暂未提供可用的更新包。", code);
                    case "update_changed": throw new FriendlyError("更新包已变更，请重新检查。", code);
                    case "message_not_found": throw new FriendlyError("这条消息已删除。", code);
                    case "image_not_found": throw new FriendlyError("这张图片已被清理。", code);
                    case "image_too_large": throw new FriendlyError("图片最大支持 5 MB。", code);
                    case "invalid_image": throw new FriendlyError("请选择尺寸有效的 JPEG、PNG、GIF 或 WebP 图片。", code);
                    case "invalid_message": throw new FriendlyError("请输入文字或选取图片。文字最多 2000 个字符。", code);
                    case "media_quota": throw new FriendlyError("图片超过服务器当前的媒体缓存配额。", code);
                    case "upload_busy": throw new FriendlyError("服务器正在接收图片，请稍后重试。", code);
                    case "chat_unavailable": throw new FriendlyError("服务器暂时无法读取聊天记录。", code);
                }
            }
        }
    }
}
