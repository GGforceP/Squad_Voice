using System;
using System.IO;
using System.Linq;
using System.Text;

namespace SquadVoice {
    internal static class ChatCacheChecks {
        public static int Main(string[] args) {
            if (args.Length != 1 || Directory.Exists(args[0])) {
                Console.Error.WriteLine("Use a fresh test directory.");
                return 2;
            }
            try { Check(args[0]); return 0; }
            catch (Exception error) {
                for (var cause = error; cause != null; cause = cause.InnerException)
                    Console.Error.WriteLine(cause.GetType().FullName + ": " + cause.Message);
                return 1;
            }
        }

        private static void Check(string directory) {
            var data = Path.Combine(directory, "Data");
            var docs = Path.Combine(directory, "Documents");
            var chosen = Path.Combine(directory, "OtherDisk");
            Directory.CreateDirectory(data);
            Directory.CreateDirectory(chosen);
            var cache = new ChatCache(data, docs);
            var scope = "s-" + ChatCache.Hash("https://qa.example.invalid/");
            var current = Path.Combine(data, "MediaCache", scope);
            var image = Encoding.UTF8.GetBytes("synthetic image payload");
            var page = "p-voice-lobby-" + ChatCache.Hash("first page");
            const string photo = "i-voice-lobby-8";
            cache.Write(scope, photo, image);
            cache.Put(scope, page, new { tag = "test-tag", text = "synthetic message" });
            Require(File.ReadAllBytes(Path.Combine(current, photo + ".svc"))[0] == 1, "chat cache must encrypt by default");
            Require(cache.Read(scope, photo).SequenceEqual(image), "encrypted bytes did not round trip");

            cache.Configure(chosen, false, false);
            var target = Path.Combine(chosen, "Squad Voice Media Cache", scope);
            Require(File.ReadAllBytes(Path.Combine(target, photo + ".svc"))[0] == 0, "cache option did not change at the destination");
            Require(!File.Exists(Path.Combine(current, photo + ".svc")), "old cache remained after migration");
            cache = new ChatCache(data, docs);
            Require(cache.Read(scope, photo).SequenceEqual(image), "migration was not read after restart");
            cache.Configure("", true, false);
            Require(File.ReadAllBytes(Path.Combine(target, photo + ".svc"))[0] == 1, "existing cache was not re-encrypted");

            var sync = Json.Object(Json.Serializer().DeserializeObject(
                "{\"epoch\":\"test-epoch\",\"cursor\":3,\"events\":[{\"op\":\"delete\",\"channelId\":\"voice-lobby\",\"id\":8}]}"));
            cache.Apply(scope, sync);
            Require(cache.Read(scope, photo) == null && cache.Get(scope, page).Count == 0, "deletion did not remove both image and history page");
            Require(ChatCache.Number(Json.Value(cache.Get(scope, "cursor"), "cursor")) == 3, "deletion cursor was not persisted");

            cache.Write(scope, photo, image);
            cache.Configure("", true, false, true);
            Require(cache.Read(scope, photo).SequenceEqual(image), "returning to the installation folder did not preserve cached data");
            Require(!Directory.Exists(Path.Combine(chosen, "Squad Voice Media Cache")), "moved external cache remained");
            cache.Configure("", true, true);
            Require(cache.Read(scope, photo) == null && cache.Get(scope, "cursor").Count == 0, "cache clear was incomplete");
            Console.WriteLine("PASS: DPAPI default, migration and reload, encryption toggle, deletion invalidation, restore default, clear.");
        }

        private static void Require(bool condition, string message) {
            if (!condition) throw new Exception(message);
        }
    }
}
