using System;
using System.Runtime.InteropServices;

namespace SquadVoice {
    internal static class AudioDefaults {
        private static readonly Guid FriendlyName = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0");
        public static object Read() {
            return new { microphone = ReadEndpoint(1), speaker = ReadEndpoint(0) };
        }

        private static string ReadEndpoint(int flow) {
            object instance = null;
            IMMDevice endpoint = null;
            IPropertyStore store = null;
            PropVariant value = new PropVariant();
            try {
                instance = Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("bcde0395-e52f-467c-8e3d-c4579291692e")));
                var devices = (IMMDeviceEnumerator)instance;
                // The default playback/capture pair in Windows Settings.
                if (devices.GetDefaultAudioEndpoint(flow, 0, out endpoint) != 0 || endpoint == null) return null;
                if (endpoint.OpenPropertyStore(0, out store) != 0 || store == null) return null;
                var key = new PropertyKey { formatId = FriendlyName, propertyId = 14 };
                return store.GetValue(ref key, out value) == 0 && value.type == 31 && value.pointer != IntPtr.Zero
                    ? Marshal.PtrToStringUni(value.pointer) : null;
            } catch (COMException) { return null; }
            catch (InvalidCastException) { return null; }
            finally {
                if (value.type != 0) PropVariantClear(ref value);
                if (store != null) Marshal.ReleaseComObject(store);
                if (endpoint != null) Marshal.ReleaseComObject(endpoint);
                if (instance != null && Marshal.IsComObject(instance)) Marshal.ReleaseComObject(instance);
            }
        }

        [DllImport("ole32.dll")]
        private static extern int PropVariantClear(ref PropVariant value);

        [StructLayout(LayoutKind.Sequential)]
        private struct PropertyKey { public Guid formatId; public uint propertyId; }

        [StructLayout(LayoutKind.Explicit, Size = 24)]
        private struct PropVariant {
            [FieldOffset(0)] public ushort type;
            [FieldOffset(8)] public IntPtr pointer;
        }

        [ComImport, Guid("a95664d2-9614-4f35-a746-de8db63617e6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IMMDeviceEnumerator {
            [PreserveSig] int EnumAudioEndpoints(int flow, int mask, out IntPtr devices);
            [PreserveSig] int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice device);
        }

        [ComImport, Guid("d666063f-1587-4e43-81f1-b948e807363f"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IMMDevice {
            [PreserveSig] int Activate(ref Guid iid, uint clsctx, IntPtr activationParameters, out IntPtr instance);
            [PreserveSig] int OpenPropertyStore(uint access, out IPropertyStore store);
        }

        [ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IPropertyStore {
            [PreserveSig] int GetCount(out uint count);
            [PreserveSig] int GetAt(uint index, out PropertyKey key);
            [PreserveSig] int GetValue(ref PropertyKey key, out PropVariant value);
        }
    }
}
