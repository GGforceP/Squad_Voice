using System;
using System.Collections.Generic;
using System.Globalization;
using System.Threading;
using System.Threading.Tasks;

namespace SquadVoice {
    internal sealed class ChatClient {
        private readonly ApiClient api;
        private readonly ChatCache cache;
        private readonly Action<string, object> broadcast;
        private CancellationTokenSource watcher;
        private bool ready;

        public ChatClient(ApiClient api, ChatCache cache, Action<string, object> broadcast) {
            this.api = api;
            this.cache = cache;
            this.broadcast = broadcast;
        }

        public void Start() {
            if (watcher != null || !api.SignedIn) return;
            watcher = new CancellationTokenSource();
            Watch(watcher, api.CacheScope);
        }

        public void Stop() {
            ready = false;
            if (watcher == null) return;
            var previous = watcher;
            watcher = null;
            previous.Cancel();
        }

        private async void Watch(CancellationTokenSource owner, string scope) {
            try {
                var cursor = await cache.Run(() => cache.Get(scope, "cursor"));
                while (!owner.IsCancellationRequested && api.SignedIn && api.CacheScope == scope) {
                    bool retry = false;
                    try {
                        var update = await api.Feature("chat/watch", new {
                            epoch = Json.Text(cursor, "epoch", 64),
                            cursor = ChatCache.Number(Json.Value(cursor, "cursor")),
                        }, owner.Token);
                        if (owner.IsCancellationRequested) break;
                        var epoch = Json.Text(update, "epoch", 64);
                        if (String.IsNullOrEmpty(epoch)) throw new FriendlyError("聊天同步暂不可用。");
                        bool changed = ChatCache.Number(Json.Value(update, "cursor")) != ChatCache.Number(Json.Value(cursor, "cursor"));
                        changed |= epoch != Json.Text(cursor, "epoch", 64) || Json.Bool(update, "reset");
                        if (changed) await cache.Run(() => { cache.Apply(scope, update); return true; });
                        if (owner.IsCancellationRequested) break;
                        cursor = update;
                        bool announce = !ready || changed;
                        ready = true;
                        if (announce) broadcast("chat.update", update);
                    } catch (FriendlyError error) {
                        if (owner.IsCancellationRequested) break;
                        if (!api.SignedIn) {
                            broadcast("account.expired", null);
                            break;
                        }
                        if (error.Code == "not_found") {
                            broadcast("chat.offline", "服务器需要升级后才能使用频道聊天。");
                            break;
                        }
                        broadcast("chat.offline", error.Message);
                        ready = false;
                        retry = true;
                    } catch {
                        if (owner.IsCancellationRequested) break;
                        broadcast("chat.offline", "无法更新聊天缓存，请检查缓存目录。");
                        ready = false;
                        retry = true;
                    }
                    if (retry) await Task.Delay(2200, owner.Token);
                }
            } catch (OperationCanceledException) { }
            catch {
                if (!owner.IsCancellationRequested) broadcast("chat.offline", "无法读取聊天缓存，请检查缓存目录。");
            } finally {
                if (watcher == owner) watcher = null;
                owner.Dispose();
            }
        }

        public async Task<object> History(Dictionary<string, object> args) {
            CheckReady();
            var scope = api.CacheScope;
            var channel = Channel(args);
            var before = ChatCache.Number(Json.Value(args, "before"));
            var after = ChatCache.Number(Json.Value(args, "after"));
            var limit = Math.Max(1, Math.Min(30, ChatCache.Number(Json.Value(args, "limit"))));
            var id = "p-" + ChatCache.ConversationKey(channel) + "-" + ChatCache.Hash(before + "/" + after + "/" + limit);
            var snapshot = await cache.Run(() => new { version = cache.Generation, data = cache.Get(scope, id) });
            var storedTag = Json.Text(snapshot.data, "tag", 64);
            var body = new { channelId = channel, before = before, after = after, limit = limit, known = storedTag };
            var page = await api.Feature("chat/history", body, CancellationToken.None);
            return await cache.Run<object>(() => {
                if (snapshot.version != cache.Generation) throw new FriendlyError("聊天记录正在更新，请稍后重试。", "cache_changed");
                if (Json.Bool(page, "unchanged") && storedTag != "") return snapshot.data;
                cache.Put(scope, id, page);
                return page;
            });
        }

        public async Task<object> Image(Dictionary<string, object> args) {
            return new { data = Convert.ToBase64String(await ImageBytes(args)) };
        }

        public async Task<byte[]> ImageBytes(Dictionary<string, object> args) {
            CheckReady();
            var scope = api.CacheScope;
            var channel = Channel(args);
            var id = ChatCache.Number(Json.Value(args, "id"));
            if (id <= 0) throw new FriendlyError("无法读取这张图片。");
            var name = "i-" + ChatCache.ConversationKey(channel) + "-" + id.ToString(CultureInfo.InvariantCulture);
            var snapshot = await cache.Run(() => new { version = cache.Generation, bytes = cache.Read(scope, name) });
            var media = await api.DownloadImage(channel, id, snapshot.bytes != null);
            var content = media ?? snapshot.bytes;
            if (content == null) throw new FriendlyError("图片缓存已清理，请重试。");
            return await cache.Run(() => {
                if (snapshot.version != cache.Generation) throw new FriendlyError("这张图片已更新，请重试。", "cache_changed");
                if (media != null) cache.Write(scope, name, media);
                return content;
            });
        }

        public async Task<object> Send(Dictionary<string, object> args) {
            CheckReady();
            var channel = Channel(args);
            var nonce = Json.Text(args, "nonce", 64);
            var text = Json.Text(args, "text", 2000);
            var photo = Json.Text(args, "image", ApiClient.ImageTextLimit);
            if (Json.Value(args, "image") != null && photo.Length == 0) throw new FriendlyError("图片大小需在 5 MB 以内。");
            if (photo.Length == 0) return await api.Feature("chat/send", new { channelId = channel, text = text, nonce = nonce }, CancellationToken.None);
            byte[] bytes;
            try { bytes = Convert.FromBase64String(photo); }
            catch (FormatException) { throw new FriendlyError("图片数据无法读取。"); }
            if (bytes.Length == 0 || bytes.Length > ApiClient.ImageLimit) throw new FriendlyError("图片大小需在 5 MB 以内。");
            return await api.UploadImage(channel, nonce, text, bytes);
        }

        public async Task<object> Delete(Dictionary<string, object> args) {
            var channel = Channel(args);
            var id = ChatCache.Number(Json.Value(args, "id"));
            return await api.Feature("chat/delete", new { channelId = channel, id = id }, CancellationToken.None);
        }

        private void CheckReady() {
            if (!ready) throw new FriendlyError("正在校验服务器聊天记录，请稍候。", "cache_changed");
        }

        private static string Channel(Dictionary<string, object> args) {
            var channel = Json.Text(args, "channelId", ChatCache.ConversationLimit);
            if (ChatCache.ConversationKey(channel) == null) throw new FriendlyError("请先选择会话。");
            return channel;
        }
    }
}
