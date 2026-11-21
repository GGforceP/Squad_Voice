using System;
using System.IO;
using System.Media;
using System.Threading;

internal static class Tone {
    public static void Main(string[] args) {
        int frequency = args.Length > 0 ? Int32.Parse(args[0]) : 540;
        using (var stream = new MemoryStream()) {
            var wav = new BinaryWriter(stream);
            const int rate = 44100;
            wav.Write(new byte[]{82,73,70,70}); wav.Write(36 + rate * 2);
            wav.Write(new byte[]{87,65,86,69,102,109,116,32}); wav.Write(16);
            wav.Write((short)1); wav.Write((short)1); wav.Write(rate); wav.Write(rate*2);
            wav.Write((short)2); wav.Write((short)16); wav.Write(new byte[]{100,97,116,97}); wav.Write(rate*2);
            for (int i = 0; i < rate; i++) wav.Write((short)(600 * Math.Sin(2 * Math.PI * frequency * i / rate)));
            wav.Flush();
            stream.Position = 0;
            using (var player = new SoundPlayer(stream)) {
                player.Load();
                player.PlayLooping();
                Thread.Sleep(140000);
                player.Stop();
            }
        }
    }
}
