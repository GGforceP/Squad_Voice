using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;

namespace SquadVoice {
    internal static class ProcessDiscovery {
        private static readonly Dictionary<string, string> Known = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) {
            {"spotify", "Spotify"}, {"kugou", "酷狗音乐"}, {"kgmusic", "酷狗音乐"}, {"kugoumusic", "酷狗音乐"},
            {"qqmusic", "QQ 音乐"}, {"cloudmusic", "网易云音乐"}, {"kwmusic", "酷我音乐"},
            {"chrome", "Google Chrome"}, {"msedge", "Microsoft Edge"}, {"firefox", "Firefox"},
            {"brave", "Brave"}, {"vivaldi", "Vivaldi"}, {"opera", "Opera"}, {"chromium", "Chromium"},
            {"vlc", "VLC"}, {"foobar2000", "foobar2000"}, {"music.ui", "媒体播放器"},
            {"wmplayer", "Windows Media Player"}, {"potplayermini64", "PotPlayer"}
        };
        internal sealed class AudioApp {
            public int pid;
            public string name;
            public string executable;
            public bool active;
        }
        public static bool IsSelectable(int id) { return List().Any(item => item.pid == id); }

        public static AudioApp[] List() {
            if (!ProcessCapture.Supported) return new AudioApp[0];
            var tree = Parents();
            var sessions = AudioSessions();
            var entries = new Dictionary<int, AudioApp>();
            var candidates = new Dictionary<int, string>();
            int ownId, sessionId;
            using (var current = Process.GetCurrentProcess()) { ownId = current.Id; sessionId = current.SessionId; }
            foreach (var process in Process.GetProcesses()) using (process) {
                try {
                    if (process.Id == ownId || process.SessionId != sessionId || process.HasExited) continue;
                    string name = process.ProcessName;
                    if (name.Equals("msedgewebview2", StringComparison.OrdinalIgnoreCase) || name.Equals("squadvoice", StringComparison.OrdinalIgnoreCase)) continue;
                    candidates[process.Id] = name;
                } catch { }
            }
            foreach (var pair in candidates) {
                string label;
                bool known = Known.TryGetValue(pair.Value, out label);
                if (!known && !sessions.ContainsKey(pair.Key)) continue;
                int root = pair.Key;
                for (int i = 0; i < 24; i++) {
                    int parent;
                    string parentName;
                    if (!tree.TryGetValue(root, out parent) || parent <= 0 || parent == root
                        || !candidates.TryGetValue(parent, out parentName) || !parentName.Equals(pair.Value, StringComparison.OrdinalIgnoreCase)) break;
                    root = parent;
                }
                AudioApp item;
                if (!entries.TryGetValue(root, out item)) {
                    item = new AudioApp { pid = root, name = label ?? pair.Value, executable = pair.Value + ".exe" };
                    entries.Add(root, item);
                }
                bool active;
                if (sessions.TryGetValue(pair.Key, out active)) item.active |= active;
            }
            return entries.Values.OrderByDescending(p => p.active).ThenBy(p => p.name).ThenBy(p => p.pid).Take(60).ToArray();
        }

        private static Dictionary<int, int> Parents() {
            var result = new Dictionary<int, int>();
            IntPtr snapshot = CreateToolhelp32Snapshot(2, 0);
            if (snapshot == new IntPtr(-1)) return result;
            try {
                var p = new ProcEntry();
                p.size = (uint)Marshal.SizeOf(typeof(ProcEntry));
                if (Process32First(snapshot, ref p)) do { result[(int)p.pid] = (int)p.parent; } while (Process32Next(snapshot, ref p));
            } finally { CloseHandle(snapshot); }
            return result;
        }

        private static Dictionary<int, bool> AudioSessions() {
            var result = new Dictionary<int, bool>();
            object raw = null;
            IDeviceCollection devices = null;
            try {
                raw = Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("bcde0395-e52f-467c-8e3d-c4579291692e")));
                if (((IDeviceEnumerator)raw).EnumAudioEndpoints(0, 1, out devices) < 0 || devices == null) return result;
                uint count;
                if (devices.GetCount(out count) < 0) return result;
                for (uint i = 0; i < count; i++) {
                    IDevice device = null;
                    ISessionEnumerator sessions = null;
                    object manager = null;
                    try {
                        if (devices.Item(i, out device) < 0 || device == null) continue;
                        Guid iid = typeof(ISessionManager).GUID;
                        if (device.Activate(ref iid, 23, IntPtr.Zero, out manager) < 0) continue;
                        if (((ISessionManager)manager).GetSessionEnumerator(out sessions) < 0 || sessions == null) continue;
                        int n;
                        if (sessions.GetCount(out n) < 0) continue;
                        for (int j = 0; j < n; j++) {
                            object control = null;
                            try {
                                if (sessions.GetSession(j, out control) < 0 || control == null) continue;
                                var extended = (ISessionControl2)control;
                                uint pid;
                                int state;
                                if (extended.GetProcessId(out pid) < 0 || pid == 0 || extended.GetState(out state) < 0 || state == 2) continue;
                                bool previous;
                                result.TryGetValue((int)pid, out previous);
                                result[(int)pid] = previous || state == 1;
                            } catch (COMException) { } catch (InvalidCastException) { }
                            finally { Release(control); }
                        }
                    } catch (COMException) { } catch (InvalidCastException) { }
                    finally { Release(sessions); Release(manager); Release(device); }
                }
            } catch (COMException) { } catch (InvalidCastException) { }
            finally { Release(devices); Release(raw); }
            return result;
        }

        internal static void Release(object value) { if (value != null && Marshal.IsComObject(value)) Marshal.ReleaseComObject(value); }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct ProcEntry {
            public uint size, usage, pid;
            public IntPtr heap;
            public uint module, threads, parent;
            public int priority;
            public uint flags;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string name;
        }
        [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint process);
        [DllImport("kernel32.dll", EntryPoint="Process32FirstW", CharSet=CharSet.Unicode)] private static extern bool Process32First(IntPtr handle, ref ProcEntry entry);
        [DllImport("kernel32.dll", EntryPoint="Process32NextW", CharSet=CharSet.Unicode)] private static extern bool Process32Next(IntPtr handle, ref ProcEntry entry);
        [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);

        [ComImport, Guid("a95664d2-9614-4f35-a746-de8db63617e6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IDeviceEnumerator { [PreserveSig] int EnumAudioEndpoints(int flow, int mask, out IDeviceCollection devices); }
        [ComImport, Guid("0bd7a1be-7a1a-44db-8397-cc5392387b5e"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IDeviceCollection { [PreserveSig] int GetCount(out uint n); [PreserveSig] int Item(uint index, out IDevice device); }
        [ComImport, Guid("d666063f-1587-4e43-81f1-b948e807363f"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IDevice { [PreserveSig] int Activate(ref Guid iid, uint ctx, IntPtr parameters, [MarshalAs(UnmanagedType.IUnknown)] out object activated); }
        [ComImport, Guid("77aa99a0-1bd6-484f-8bc7-2c654c9a9b6f"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface ISessionManager {
            [PreserveSig] int GetAudioSessionControl(IntPtr id, uint flags, out IntPtr control);
            [PreserveSig] int GetSimpleAudioVolume(IntPtr id, uint flags, out IntPtr volume);
            [PreserveSig] int GetSessionEnumerator(out ISessionEnumerator sessions);
        }
        [ComImport, Guid("e2f5bb11-0570-40ca-acdd-3aa01277dee8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface ISessionEnumerator {
            [PreserveSig] int GetCount(out int n);
            [PreserveSig] int GetSession(int index, [MarshalAs(UnmanagedType.IUnknown)] out object control);
        }
        [ComImport, Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface ISessionControl2 {
            [PreserveSig] int GetState(out int state);
            [PreserveSig] int GetDisplayName(out IntPtr name);
            [PreserveSig] int SetDisplayName(IntPtr name, IntPtr context);
            [PreserveSig] int GetIconPath(out IntPtr path);
            [PreserveSig] int SetIconPath(IntPtr path, IntPtr context);
            [PreserveSig] int GetGroupingParam(out Guid grouping);
            [PreserveSig] int SetGroupingParam(ref Guid grouping, IntPtr context);
            [PreserveSig] int RegisterAudioSessionNotification(IntPtr events);
            [PreserveSig] int UnregisterAudioSessionNotification(IntPtr events);
            [PreserveSig] int GetSessionIdentifier(out IntPtr id);
            [PreserveSig] int GetSessionInstanceIdentifier(out IntPtr id);
            [PreserveSig] int GetProcessId(out uint process);
        }
    }

    [ComVisible(true), Guid("41d949ab-9862-444a-80f6-c261334da5eb"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IActivationHandler { [PreserveSig] int ActivateCompleted(IActivationOperation operation); }
    [ComImport, Guid("72a22d78-cde4-431d-b8cc-843a71199b6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IActivationOperation {
        [PreserveSig] int GetActivateResult(out int status, [MarshalAs(UnmanagedType.IUnknown)] out object activated);
    }
    [ComImport, Guid("94ea2b94-e9cc-49e0-c0ff-ee64ca8f5b90"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAgileAudioCallback { }

    internal sealed class ProcessCapture : IDisposable {
        public const int SampleRate = 44100;
        // Updated Windows 10 2004+ builds implement the interface; activation must still succeed.
        public static bool Supported { get { return Environment.OSVersion.Version.Build >= 19041; } }
        private readonly int pid;
        private readonly Action<byte[]> onSamples;
        private readonly Action onEnded;
        private readonly ManualResetEvent stop = new ManualResetEvent(false);
        private readonly TaskCompletionSource<bool> ready = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);

        public ProcessCapture(int pid, Action<byte[]> onSamples, Action onEnded) {
            this.pid = pid; this.onSamples = onSamples; this.onEnded = onEnded;
        }
        public Task Start() {
            var worker = new Thread(Capture) { IsBackground = true, Name = "Selected application audio" };
            worker.SetApartmentState(ApartmentState.MTA);
            worker.Start();
            return ready.Task;
        }
        public void Dispose() { try { stop.Set(); } catch (ObjectDisposedException) { } }

        private void Capture() {
            IAudioClient audio = null;
            IAudioCaptureClient capture = null;
            Process selected = null;
            try {
                if (!Supported) throw new PlatformNotSupportedException();
                selected = Process.GetProcessById(pid);
                var activation = new Completion(pid);
                IActivationOperation operation;
                var iid = typeof(IAudioClient).GUID;
                var parameters = activation.Parameters;
                int hr = ActivateAudioInterfaceAsync(@"VAD\Process_Loopback", ref iid, ref parameters, activation, out operation);
                if (hr < 0) { activation.Dispose(); Check(hr); }
                try {
                    if (!activation.Result.Task.Wait(7000)) { activation.Abandon(); throw new TimeoutException(); }
                    audio = (IAudioClient)activation.Result.Task.GetAwaiter().GetResult();
                } finally { ProcessDiscovery.Release(operation); }
                if (stop.WaitOne(0) || selected.HasExited) throw new OperationCanceledException();
                var format = new WaveFormat {
                    tag = 1, channels = 2, rate = SampleRate, averageBytes = SampleRate * 4, blockAlign = 4, bits = 16
                };
                Check(audio.Initialize(0, 0x80060000, 0, 0, ref format, IntPtr.Zero));
                Guid captureIid = typeof(IAudioCaptureClient).GUID;
                object raw;
                Check(audio.GetService(ref captureIid, out raw));
                capture = (IAudioCaptureClient)raw;
                using (var signal = new AutoResetEvent(false)) {
                    Check(audio.SetEventHandle(signal.SafeWaitHandle.DangerousGetHandle()));
                    Check(audio.Start());
                    ready.TrySetResult(true);
                    var handles = new WaitHandle[] { stop, signal };
                    var mono = new byte[SampleRate / 50 * 2];
                    int offset = 0;
                    while (!selected.HasExited && WaitHandle.WaitAny(handles, 250) != 0) {
                        uint next;
                        Check(capture.GetNextPacketSize(out next));
                        while (next > 0 && !stop.WaitOne(0)) {
                            IntPtr data; uint frames, flags; ulong position, timestamp;
                            Check(capture.GetBuffer(out data, out frames, out flags, out position, out timestamp));
                            try {
                                bool silent = (flags & 2) != 0 || data == IntPtr.Zero;
                                var stereo = new short[frames * 2];
                                if (!silent) Marshal.Copy(data, stereo, 0, stereo.Length);
                                for (int i = 0; i < stereo.Length; i += 2) {
                                    int sample = (stereo[i] + stereo[i+1]) / 2;
                                    mono[offset++] = (byte)sample;
                                    mono[offset++] = (byte)(sample >> 8);
                                    if (offset == mono.Length) { onSamples(mono); mono = new byte[mono.Length]; offset = 0; }
                                }
                            } finally { Check(capture.ReleaseBuffer(frames)); }
                            Check(capture.GetNextPacketSize(out next));
                        }
                    }
                    audio.Stop();
                }
            } catch (Exception e) { ready.TrySetException(e); }
            finally {
                if (selected != null) selected.Dispose();
                ProcessDiscovery.Release(capture); ProcessDiscovery.Release(audio);
                stop.Dispose();
                if (ready.Task.Status == TaskStatus.RanToCompletion) onEnded();
            }
        }

        private static void Check(int result) { if (result < 0) Marshal.ThrowExceptionForHR(result); }

        [ComVisible(true), ClassInterface(ClassInterfaceType.None)]
        private sealed class Completion : IActivationHandler, IAgileAudioCallback, IDisposable {
            private IntPtr data;
            private int abandoned;
            public readonly TaskCompletionSource<object> Result = new TaskCompletionSource<object>(TaskCreationOptions.RunContinuationsAsynchronously);
            public Completion(int process) {
                data = Marshal.AllocCoTaskMem(12);
                Marshal.WriteInt32(data, 0, 1); // Process loopback activation.
                Marshal.WriteInt32(data, 4, process);
                Marshal.WriteInt32(data, 8, 0); // Include only this process tree.
            }
            public Blob Parameters { get { return new Blob { type = 65, size = 12, data = data }; } }
            public void Abandon() { Interlocked.Exchange(ref abandoned, 1); }
            public int ActivateCompleted(IActivationOperation operation) {
                try {
                    int status; object raw;
                    Check(operation.GetActivateResult(out status, out raw));
                    Check(status);
                    if (Volatile.Read(ref abandoned) != 0) ProcessDiscovery.Release(raw);
                    else Result.TrySetResult(raw);
                } catch (Exception e) { Result.TrySetException(e); }
                finally { Dispose(); }
                return 0;
            }
            public void Dispose() { var pointer = Interlocked.Exchange(ref data, IntPtr.Zero); if (pointer != IntPtr.Zero) Marshal.FreeCoTaskMem(pointer); }
        }
        [StructLayout(LayoutKind.Explicit, Size=24)]
        private struct Blob {
            [FieldOffset(0)] public ushort type;
            [FieldOffset(8)] public uint size;
            [FieldOffset(16)] public IntPtr data;
        }
        [StructLayout(LayoutKind.Sequential, Pack=1)]
        private struct WaveFormat { public ushort tag, channels; public uint rate, averageBytes; public ushort blockAlign, bits, extra; }

        [DllImport("mmdevapi.dll", CharSet=CharSet.Unicode, ExactSpelling=true)]
        private static extern int ActivateAudioInterfaceAsync([MarshalAs(UnmanagedType.LPWStr)] string path, ref Guid iid, ref Blob parameters, IActivationHandler completion, out IActivationOperation operation);

        [ComImport, Guid("1cb9ad4c-dbfa-4c32-b178-c2f568a703b2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IAudioClient {
            [PreserveSig] int Initialize(int mode, uint flags, long duration, long periodicity, ref WaveFormat format, IntPtr session);
            [PreserveSig] int GetBufferSize(out uint frames);
            [PreserveSig] int GetStreamLatency(out long latency);
            [PreserveSig] int GetCurrentPadding(out uint frames);
            [PreserveSig] int IsFormatSupported(int mode, ref WaveFormat format, out IntPtr closest);
            [PreserveSig] int GetMixFormat(out IntPtr format);
            [PreserveSig] int GetDevicePeriod(out long defaultPeriod, out long minPeriod);
            [PreserveSig] int Start();
            [PreserveSig] int Stop();
            [PreserveSig] int Reset();
            [PreserveSig] int SetEventHandle(IntPtr handle);
            [PreserveSig] int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
        }
        [ComImport, Guid("c8adbd64-e71e-48a0-a4de-185c395cd317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IAudioCaptureClient {
            [PreserveSig] int GetBuffer(out IntPtr samples, out uint frames, out uint flags, out ulong position, out ulong timestamp);
            [PreserveSig] int ReleaseBuffer(uint frames);
            [PreserveSig] int GetNextPacketSize(out uint frames);
        }
    }
}
