using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

[assembly: AssemblyTitle("Squad Voice")]
[assembly: AssemblyProduct("Squad Voice")]
[assembly: AssemblyDescription("Private Windows voice channels")]

namespace SquadVoice {
    internal static class Program {
        [STAThread]
        public static void Main() {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            try {
                var window = new MainWindow();
                Application.Run(window);
                if (window.UpdateRequested != null)
                    window.UpdateRequested.Start(AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar), window.RestartRequested);
                else if (window.RestartRequested) Process.Start(new ProcessStartInfo {
                    FileName = Application.ExecutablePath, WorkingDirectory = AppDomain.CurrentDomain.BaseDirectory,
                    UseShellExecute = false
                });
            }
            catch (IOException) {
                MessageBox.Show("无法打开 Squad Voice 的数据目录。请检查安装目录和 Windows 文档是否可写，或从托盘恢复已运行的程序。", "Squad Voice", MessageBoxButtons.OK, MessageBoxIcon.Error);
            } catch (UnauthorizedAccessException) {
                MessageBox.Show("请确认 Squad Voice 的安装目录和 Windows 文档目录可以写入。", "Squad Voice", MessageBoxButtons.OK, MessageBoxIcon.Error);
            } catch (FriendlyError failure) {
                MessageBox.Show(failure.Message, "Squad Voice", MessageBoxButtons.OK, MessageBoxIcon.Error);
            } catch (System.ComponentModel.Win32Exception) {
                MessageBox.Show("无法启动 Squad Voice 安装程序。", "Squad Voice", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }
    }

    internal sealed class MainWindow : Form {
        private const string AppVersion = ReleaseBuild.Version;
        private const string AppOrigin = "https://app.squadvoice.invalid";
        private const int HotkeyId = 5148;
        private readonly bool lab = false;
#if QA
        private readonly string labInput;
#endif
        private readonly WebView2 view;
        private readonly ProfileStore store;
        private readonly PublicSettings publicSettings;
        private readonly ApiClient api;
        private readonly ChatCache cache;
        private readonly ChatClient chat;
        private readonly ClientUpdater updates;
        private readonly FileStream directoryLock;
        private readonly NotifyIcon tray;
        private readonly ContextMenuStrip trayMenu;
        private readonly Icon appIcon;
        private Preferences preferences;
        private bool startupAttempted, quitting;
        public bool RestartRequested { get; private set; }
        public UpdateLaunch UpdateRequested { get; private set; }
        private ProcessCapture capture;
        private int captureGeneration, pendingPcm;
        private readonly System.Windows.Forms.Timer hotkeyRelease = new System.Windows.Forms.Timer { Interval = 25 };
        private Keys registered = Keys.None;
        private bool held;

        public MainWindow() {
#if QA
            labInput = Environment.GetEnvironmentVariable("SQUADVOICE_QA_INPUT");
            lab = !String.IsNullOrEmpty(labInput);
#endif
            var installDirectory = Path.GetDirectoryName(Application.ExecutablePath);
            var dataDirectory = Path.Combine(installDirectory, "Data");
            string documents = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
            var settingsDirectory = String.IsNullOrEmpty(documents) ? null : Path.Combine(documents, "Squad Voice");
#if QA
            var overrideDir = Environment.GetEnvironmentVariable("SQUADVOICE_DATA_DIR");
            if (lab && !String.IsNullOrWhiteSpace(overrideDir)) {
                dataDirectory = overrideDir;
                settingsDirectory = Path.Combine(overrideDir, "Public");
            }
#endif
            if (String.IsNullOrEmpty(settingsDirectory)) throw new IOException("Windows Documents unavailable");
            store = new ProfileStore(dataDirectory);
            publicSettings = new PublicSettings(settingsDirectory);
            directoryLock = store.LockDirectory();
            try {
                var migrationMarker = Path.Combine(dataDirectory, "migrate-legacy");
                bool upgrade = !lab && File.Exists(migrationMarker);
                var startup = upgrade
                    ? store.MigrateFrom(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "SquadVoice"), false)
                    : store.Load(lab);
                preferences = publicSettings.LoadPreferences(startup.preferences);
                publicSettings.RecordInstallation(installDirectory, AppVersion);
                if (upgrade) File.Delete(migrationMarker);
            } catch {
                directoryLock.Dispose();
                throw;
            }
            api = new ApiClient(lab);
            cache = new ChatCache(dataDirectory, settingsDirectory);
            chat = new ChatClient(api, cache, SendEvent);
            string updateVersion = AppVersion;
#if QA
            if (lab) {
                var input = Json.Object(Json.Serializer().DeserializeObject(labInput));
                var mode = Json.Text(input, "mode", 20);
                if (File.Exists(Path.Combine(installDirectory, "app", "qa-update-installed.txt"))) {
                    input["mode"] = "update-reopened";
                    labInput = Json.Serializer().Serialize(input);
                } else if (mode == "optional-update" || mode == "forced-update" || mode == "immediate-update" || mode == "required-exit")
                    updateVersion = "0.0.0";
            }
#endif
            updates = new ClientUpdater(api, updateVersion, dataDirectory, SendEvent);
            Text = "Squad Voice";
            Font = new Font("Segoe UI", 9);
            try { appIcon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
            if (appIcon != null) Icon = appIcon;
            trayMenu = new ContextMenuStrip();
            trayMenu.Items.Add("打开 Squad Voice", null, delegate { RestoreFromTray(); });
            trayMenu.Items.Add("退出程序", null, async delegate { await Quit(); });
            tray = new NotifyIcon { Icon = appIcon ?? SystemIcons.Application, Text = "Squad Voice", ContextMenuStrip = trayMenu };
            tray.DoubleClick += delegate { RestoreFromTray(); };
            tray.Visible = !lab;
            BackColor = Color.FromArgb(25, 26, 32);
            StartPosition = lab ? FormStartPosition.Manual : FormStartPosition.CenterScreen;
            if (lab) { Location = new Point(-16000, 100); ShowInTaskbar = false; }
            ClientSize = new Size(1180, 750);
            MinimumSize = new Size(840, 570);
            view = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = BackColor };
            Controls.Add(view);
            hotkeyRelease.Tick += delegate {
                if (!held || (GetAsyncKeyState((int)registered) & 0x8000) != 0) return;
                held = false;
                hotkeyRelease.Stop();
                SendEvent("ptt", false);
            };
            Shown += async delegate { await Initialize(); };
            FormClosing += (sender, e) => {
                if (!quitting && e.CloseReason == CloseReason.UserClosing) {
                    e.Cancel = true;
                    SendEvent("app.hidden", true);
                    tray.Visible = true;
                    Hide();
                    return;
                }
                ReleaseHotkey();
                StopCapture();
                chat.Stop();
                updates.Reset();
                api.Dispose();
                tray.Visible = false;
                tray.Dispose();
                trayMenu.Dispose();
                hotkeyRelease.Dispose();
            };
            FormClosed += delegate {
                directoryLock.Dispose();
                if (appIcon != null) appIcon.Dispose();
            };
        }

        protected override bool ShowWithoutActivation { get { return lab; } }

        private void RestoreFromTray() {
            if (quitting) return;
            if (!Visible) Show();
            if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
            Activate();
        }

        private async Task InstallImmediately() {
            if (quitting) return;
            var update = await updates.InstallNow();
            if (update != null) await Quit(true, update);
        }

        private async Task Quit(bool restart = false, UpdateLaunch update = null) {
            if (quitting) return;
            quitting = true;
            if (update == null) update = await updates.OnExit();
            if (update == null && updates.Required) {
                quitting = false;
                RestoreFromTray();
                if (!api.SignedIn)
                    MessageBox.Show(this, "请重新登录以完成必需更新。", "Squad Voice 更新", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            UpdateRequested = update;
            RestartRequested = restart || (update != null && updates.RestartOnInstall);
            SendEvent("app.hidden", true);
            ReleaseHotkey();
            StopCapture();
            chat.Stop();
            await Task.WhenAny(api.Logout(), Task.Delay(1500));
            if (!IsDisposed) Close();
        }

        protected override void OnHandleCreated(EventArgs e) {
            base.OnHandleCreated(e);
            const int immersiveDarkMode = 20;
            const int legacyImmersiveDarkMode = 19;
            const uint invalidate = 0x0001, updateNow = 0x0100, frame = 0x0400;
            int dark = 1;
            if (DwmSetWindowAttribute(Handle, immersiveDarkMode, ref dark, sizeof(int)) < 0)
                DwmSetWindowAttribute(Handle, legacyImmersiveDarkMode, ref dark, sizeof(int));
            RedrawWindow(Handle, IntPtr.Zero, IntPtr.Zero, invalidate | updateNow | frame);
        }

        private async Task Initialize() {
            try {
                var webData = Path.Combine(store.DirectoryPath, "WebView");
                Directory.CreateDirectory(webData);
                var options = new CoreWebView2EnvironmentOptions();
                if (lab) options.AdditionalBrowserArguments = "--use-fake-device-for-media-stream --autoplay-policy=no-user-gesture-required --disable-background-timer-throttling --disable-renderer-backgrounding";
#if QA
                if (lab) {
                    var sample = Environment.GetEnvironmentVariable("SQUADVOICE_QA_AUDIO_FILE");
                    if (File.Exists(sample) && sample.IndexOf('"') < 0)
                        options.AdditionalBrowserArguments += " --use-file-for-fake-audio-capture=\"" + sample + "\"";
                }
#endif
                var environment = await CoreWebView2Environment.CreateAsync(null, webData, options);
                var windowOptions = environment.CreateCoreWebView2ControllerOptions();
                windowOptions.IsInPrivateModeEnabled = false;
                await view.EnsureCoreWebView2Async(environment, windowOptions);
                var core = view.CoreWebView2;
                core.SetVirtualHostNameToFolderMapping("app.squadvoice.invalid", Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "app"), CoreWebView2HostResourceAccessKind.DenyCors);
                var settings = core.Settings;
                settings.AreDevToolsEnabled = false;
                settings.AreDefaultContextMenusEnabled = false;
                settings.AreBrowserAcceleratorKeysEnabled = false;
                settings.AreHostObjectsAllowed = false;
                settings.IsGeneralAutofillEnabled = false;
                settings.IsPasswordAutosaveEnabled = false;
                settings.IsStatusBarEnabled = false;
                core.NavigationStarting += (sender, e) => { if (!IsTrusted(e.Uri)) e.Cancel = true; };
                core.NewWindowRequested += (sender, e) => e.Handled = true;
                core.DownloadStarting += (sender, e) => e.Cancel = true;
                core.PermissionRequested += (sender, e) => {
                    e.SavesInProfile = false;
                    e.State = IsTrusted(e.Uri) && e.PermissionKind == CoreWebView2PermissionKind.Microphone
                        ? CoreWebView2PermissionState.Allow : CoreWebView2PermissionState.Deny;
                };
                core.WebMessageReceived += OnMessage;
#if QA
                if (lab) core.NavigationCompleted += async (sender, e) => {
                    if (!e.IsSuccess) return;
                    try {
                        for (int i = 0; i < 60; i++) {
                            if (await core.ExecuteScriptAsync("typeof window.squadVoiceLab==='function'") == "true") break;
                            await Task.Delay(100);
                        }
                        await core.ExecuteScriptAsync("void window.squadVoiceLab(" + labInput + ");");
                    } catch { WriteLabResult(new { ok = false, stage = "lab-launch" }); }
                };
#endif
                core.Navigate(AppOrigin + "/index.html");
            } catch {
                quitting = true;
#if QA
                if (lab) { WriteLabResult(new { ok = false, stage = "webview-init" }); Close(); return; }
#endif
                MessageBox.Show("无法启动 Squad Voice。请确认已安装 Microsoft Edge WebView2 运行时，且客户端文件完整。", "Squad Voice", MessageBoxButtons.OK, MessageBoxIcon.Error);
                Close();
            }
        }

        private static bool IsTrusted(string source) {
            Uri uri;
            return Uri.TryCreate(source, UriKind.Absolute, out uri) && uri.Scheme == "https" &&
                uri.Host == "app.squadvoice.invalid" && uri.IsDefaultPort && uri.UserInfo.Length == 0;
        }

        private async void OnMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e) {
            if (!IsTrusted(e.Source)) return;
            string id = null;
            try {
                var raw = e.WebMessageAsJson;
                const int largeMessageLimit = ApiClient.ImageTextLimit + 16384;
                if (raw.Length > largeMessageLimit) return;
                var data = Json.Object(Json.Serializer(raw.Length > 32768 ? largeMessageLimit : 262144).DeserializeObject(raw));
                id = Json.Text(data, "id", 16);
                if (id.Length == 0) return;
                var command = Json.Text(data, "command", 48);
                if (raw.Length > 32768 && command != "chat.send") return;
                var result = await Dispatch(command, Json.Object(Json.Value(data, "args")));
                Post(new { id = id, ok = true, value = result });
            } catch (FriendlyError error) {
                if (id != null) Post(new { id = id, ok = false, error = error.Message, code = error.Code });
            } catch {
                if (id != null) Post(new { id = id, ok = false, error = "客户端未能完成操作，请重试。" });
            }
        }

        private async Task<object> Dispatch(string command, Dictionary<string, object> args) {
            switch (command) {
                case "app.bootstrap": return await Bootstrap();
                case "profile.save":
                    if (api.SignedIn || api.Busy) throw new FriendlyError("请先退出登录再修改接入配置。");
                    var endpoint = EndpointPolicy.Validate(Json.Text(args, "endpoint", 2048), false, lab);
                    var next = store.Load(lab);
                    bool changed = next.endpoint != endpoint.AbsoluteUri;
                    if (changed) next.remembered = null;
                    next.endpoint = endpoint.AbsoluteUri;
                    store.Save(next);
                    if (changed) updates.Reset();
                    return new { configured = true, changed = changed };
                case "preferences.save":
                    var updated = Preferences.Parse(args);
                    publicSettings.SavePreferences(updated);
                    preferences = updated;
                    return preferences;
                case "layout.split":
                    var share = ChatCache.Number(Json.Value(args, "value"));
                    preferences.voiceShare = (int)Math.Max(15, Math.Min(85, share));
                    publicSettings.SavePreferences(preferences);
                    return preferences.voiceShare;
                case "devices.defaults": return AudioDefaults.Read();
                case "account.login": return await SignIn(args);
                case "account.forget":
                    if (api.Busy) throw new FriendlyError("请等待本次登录完成。");
                    var previous = store.Load(lab);
                    if (previous.remembered != null) {
                        previous.remembered = null;
                        store.Save(previous);
                    }
                    return null;
                case "account.profile": return await api.UpdateProfile(args);
                case "account.password":
                    await api.ChangePassword(args);
                    StopCapture();
                    chat.Stop();
                    ReleaseHotkey();
                    return UpdateRememberedPassword(Json.Text(args, "newPassword", 256));
                case "account.logout": return await SignOut();
                case "workspace.state": return await api.Workspace();
                case "member.control":
                    return await api.Feature("member/control", new { channelId = Json.Text(args, "channelId", 48),
                        targetId = Json.Text(args, "targetId", 64), action = Json.Text(args, "action", 24), enabled = Json.Bool(args, "enabled") }, CancellationToken.None);
                case "update.check": return await updates.Check(Json.Bool(args, "interactive"));
                case "update.now":
                    BeginInvoke(new Action(async () => await InstallImmediately()));
                    return null;
                case "update.later": return updates.InstallLater();
                case "channel.create": return await api.Feature("channel/create", ReadChannel(args), CancellationToken.None);
                case "channel.update": return await api.Feature("channel/update", ReadChannel(args), CancellationToken.None);
                case "channel.delete": return await api.Feature("channel/delete", new { id = Json.Text(args, "id", 48) }, CancellationToken.None);
                case "chat.connect": chat.Start(); return null;
                case "chat.history": return await chat.History(args);
                case "chat.send": return await chat.Send(args);
                case "chat.image": return await chat.Image(args);
                case "chat.delete": return await chat.Delete(args);
                case "cache.usage": return await cache.Run(cache.Usage);
                case "cache.pick":
                    using (var dialog = new FolderBrowserDialog { Description = "选择用于保存聊天缓存的目录", ShowNewFolderButton = true }) {
                        return dialog.ShowDialog(this) == DialogResult.OK ? dialog.SelectedPath : null;
                    }
                case "cache.apply":
                    try {
                        await cache.Run(() => {
                            cache.Configure(Json.Text(args, "location", 2048), Json.Bool(args, "encrypted", true),
                                Json.Bool(args, "clear"), Json.Bool(args, "defaultLocation"));
                            return true;
                        });
                    } catch (FriendlyError) { throw; }
                    catch { throw new FriendlyError("无法更新缓存。请确认所选目录可写且有足够空间。"); }
                    BeginInvoke(new Action(async () => await Quit(true)));
                    return null;
                case "voice.join": return await api.Join(args);
                case "voice.leave":
                    await api.Leave(args);
                    return null;
                case "ptt.set":
                    ReleaseHotkey();
                    if (!Json.Bool(args, "enabled")) return new { registered = false };
                    if (!api.SignedIn || !preferences.pushToTalk) throw new FriendlyError("请先加入语音频道并启用按住说话。");
                    Keys key;
                    if (!Enum.TryParse<Keys>(preferences.hotkey, out key) || !RegisterHotKey(Handle, HotkeyId, 0x4000, (uint)key))
                        throw new FriendlyError("全局快捷键已被占用，请换一个按键。");
                    registered = key;
                    return new { registered = true };
                case "accompaniment.list": return ProcessDiscovery.List();
                case "accompaniment.start":
                    if (!api.SignedIn) throw new FriendlyError("请先登录并加入语音频道。");
                    var processId = Json.Value(args, "pid");
                    if (!(processId is int) || !ProcessDiscovery.IsSelectable((int)processId)) throw new FriendlyError("所选应用已退出或不能共享，请刷新列表。");
                    return await StartCapture((int)processId);
                case "accompaniment.stop": StopCapture(); return null;
#if QA
                case "qa.close-to-tray":
                    if (!lab) break;
                    Close();
                    return new { hidden = !Visible, trayVisible = tray.Visible };
                case "qa.restore":
                    if (!lab) break;
                    RestoreFromTray();
                    return new { visible = Visible };
                case "qa.exit":
                    if (!lab) break;
                    BeginInvoke(new Action(async () => await Quit()));
                    return null;
                case "qa.update.plan":
                    if (!lab) break;
                    var planned = await updates.OnExit();
                    return new { queued = planned != null, required = planned != null && planned.Release.Required,
                        version = planned == null ? "" : planned.Release.Version.ToString() };
                case "qa.report":
                    if (!lab) break;
                    WriteLabResult(args);
                    return null;
                case "qa.capture":
                    if (!lab) break;
                    var name = Json.Text(args, "name", 32);
                    if (name != "login.png" && name != "voice-room.png" && name != "audio-settings.png" &&
                        name != "accompaniment.png" && name != "account-settings.png" && name != "account-settings-failed.png" &&
                        name != "voice-preview.png" && name != "chat.png" && name != "cache-settings.png" && name != "cache-shortcut.png" && name != "image-preview.png" &&
                        name != "member-actions.png" && name != "split-layout.png" && name != "update.png") break;
                    using (var stream = File.Create(Path.Combine(store.DirectoryPath, name))) await view.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, stream);
                    return null;
#endif
            }
            throw new FriendlyError("客户端不支持此操作。");
        }

        private static object ForLoginForm(StoredProfile current) {
            var saved = current.remembered;
            return saved == null ? null : new { saved.username, saved.password };
        }

        private async Task<object> Bootstrap() {
            var current = store.Load(lab);
            object account = null;
            string loginError = null;
            if (!startupAttempted) {
                startupAttempted = true;
                var saved = current.remembered;
                if (saved != null && saved.autoLogin) {
                    try { account = await api.Login(current, saved.username, saved.password); }
                    catch (FriendlyError error) {
                        loginError = error.Message;
                        if (error.Code == "invalid_credentials") {
                            saved.password = "";
                            saved.autoLogin = false;
                            try { store.Save(current); } catch (IOException) { } catch (UnauthorizedAccessException) { }
                        }
                    }
                }
            }
            return new {
                configured = current.endpoint != null, profileError = store.ReadError, version = ReleaseBuild.DisplayVersion,
                devices = AudioDefaults.Read(), preferences = preferences, accompanimentSupported = ProcessCapture.Supported,
                account = account, remembered = account == null && !api.SignedIn ? ForLoginForm(current) : null, loginError = loginError
            };
        }

        private async Task<object> SignIn(Dictionary<string, object> args) {
            var current = store.Load(lab);
            var username = Json.Text(args, "username", 96).Trim();
            var password = Json.Text(args, "password", 256);
            var account = await api.Login(current, username, password);
            bool remember = Json.Bool(args, "remember", true);
            if (!remember && current.remembered == null) return account;
            current.remembered = remember ? new RememberedLogin { username = username, password = password, autoLogin = true } : null;
            bool stored;
            try { store.Save(current); stored = true; }
            catch { stored = false; }
            if (!stored) {
                await api.Logout();
                throw new FriendlyError("无法保存登录设置，请检查安装目录中 Data 的写入权限。");
            }
            return account;
        }

        private object UpdateRememberedPassword(string password) {
            var current = store.Load(lab);
            if (current.remembered == null) return new { saved = !store.ReadError };
            current.remembered.password = password;
            current.remembered.autoLogin = false;
            try { store.Save(current); return new { saved = true }; }
            catch { return new { saved = false }; }
        }

        private async Task<object> SignOut() {
            StopCapture();
            chat.Stop();
            ReleaseHotkey();
            var current = store.Load(lab);
            bool updated = !store.ReadError;
            try {
                if (current.remembered != null && current.remembered.autoLogin) {
                    current.remembered.autoLogin = false;
                    store.Save(current);
                }
            } catch { updated = false; }
            await api.Logout();
            if (!updated) throw new FriendlyError("已退出登录，但无法更新本地自动登录状态。");
            return ForLoginForm(current);
        }

        private static object ReadChannel(Dictionary<string, object> args) {
            return new {
                id = Json.Text(args, "id", 48),
                name = Json.Text(args, "name", 64),
                description = Json.Text(args, "description", 180),
                capacity = ChatCache.Number(Json.Value(args, "capacity"))
            };
        }

        private async Task<object> StartCapture(int pid) {
            StopCapture();
            var generation = captureGeneration;
            var newCapture = new ProcessCapture(pid, bytes => {
                if (Volatile.Read(ref captureGeneration) != generation || IsDisposed || !IsHandleCreated) return;
                if (Interlocked.Increment(ref pendingPcm) > 5) { Interlocked.Decrement(ref pendingPcm); return; }
                try {
                    BeginInvoke(new Action(() => {
                        try { if (captureGeneration == generation) SendEvent("accompaniment.pcm", Convert.ToBase64String(bytes)); }
                        finally { Interlocked.Decrement(ref pendingPcm); }
                    }));
                } catch (InvalidOperationException) { Interlocked.Decrement(ref pendingPcm); }
            }, () => {
                if (IsDisposed || !IsHandleCreated) return;
                try { BeginInvoke(new Action(() => { if (captureGeneration == generation) SendEvent("accompaniment.ended", null); })); }
                catch (InvalidOperationException) { }
            });
            capture = newCapture;
            try { await newCapture.Start(); }
            catch (Exception failure) {
#if QA
                if (lab) File.WriteAllText(Path.Combine(store.DirectoryPath, "qa-capture-error.txt"), failure.GetBaseException().GetType().Name + " " + failure.GetBaseException().HResult.ToString("X8"));
#endif
                if (captureGeneration == generation) StopCapture();
                throw new FriendlyError("无法捕获所选进程的声音；请确认应用仍在运行，并使用支持的 Windows 版本。");
            }
            if (captureGeneration != generation) throw new FriendlyError("伴奏共享已取消。");
            return new { sampleRate = ProcessCapture.SampleRate };
        }

        private void StopCapture() {
            Interlocked.Increment(ref captureGeneration);
            if (capture != null) { capture.Dispose(); capture = null; }
        }

        private void Post(object message) {
            if (!IsDisposed && view.CoreWebView2 != null)
                view.CoreWebView2.PostWebMessageAsJson(Json.Serializer(ApiClient.ImageTextLimit + 16384).Serialize(message));
        }
        private void SendEvent(string type, object value) { Post(new Dictionary<string, object> { { "event", type }, { "value", value } }); }

        private void ReleaseHotkey() {
            hotkeyRelease.Stop();
            if (registered != Keys.None) UnregisterHotKey(Handle, HotkeyId);
            registered = Keys.None;
            if (held) { held = false; SendEvent("ptt", false); }
        }

        protected override void WndProc(ref Message m) {
            if (m.Msg == 0x0312 && m.WParam.ToInt32() == HotkeyId && registered != Keys.None) {
                if (!held && (GetAsyncKeyState((int)registered) & 0x8000) != 0) {
                    held = true;
                    SendEvent("ptt", true);
                    hotkeyRelease.Start();
                }
            }
            base.WndProc(ref m);
        }

#if QA
        private void WriteLabResult(object result) {
            Directory.CreateDirectory(store.DirectoryPath);
            var output = Path.Combine(store.DirectoryPath, "qa-result.json");
            var temporary = output + ".tmp";
            File.WriteAllText(temporary, Json.Serializer().Serialize(result), new UTF8Encoding(false));
            if (File.Exists(output)) File.Replace(temporary, output, null); else File.Move(temporary, output);
        }
#endif
        [DllImport("user32.dll")] private static extern bool RegisterHotKey(IntPtr window, int id, uint mods, uint key);
        [DllImport("user32.dll")] private static extern bool UnregisterHotKey(IntPtr window, int id);
        [DllImport("user32.dll")] private static extern short GetAsyncKeyState(int key);
        [DllImport("dwmapi.dll")] private static extern int DwmSetWindowAttribute(IntPtr window, int attr, ref int value, int size);
        [DllImport("user32.dll")] private static extern bool RedrawWindow(IntPtr window, IntPtr area, IntPtr region, uint flags);
    }
}
