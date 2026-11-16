import AppKit
import WebKit

// Native chrome around the existing private, UI-independent automation worker.
final class HubApp: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, WKDownloadDelegate {
    private var window: NSWindow!
    private var web: WKWebView!
    private var origin: URL?
    private var opening = false
    private var downloadTargets: [ObjectIdentifier: (temporary: URL, destination: DownloadDestination)] = [:]
    private var savingDownloads = 0
    private var quitAfterSaving = false
    private var saveFailedDuringQuit = false
    private var previews: [NSWindow] = []
    private var status: NSTextField!
    private var loadingPanel: NSView!
    private var helper: Process?
    private var helperTimer: DispatchWorkItem?
    private var display = DisplayReadiness()
    private var renderTimer: DispatchWorkItem?
    private var workspaceNavigation: WKNavigation?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.appearance = NSAppearance(named: .darkAqua)
        makeMenus()
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.userContentController.add(self, name: "hub")
        web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self; web.uiDelegate = self
        web.underPageBackgroundColor = NSColor(calibratedWhite: 0.055, alpha: 1)
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1320, height: 880), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Automation Hub"; window.minSize = NSSize(width: 680, height: 520)
        window.backgroundColor = NSColor(calibratedWhite: 0.055, alpha: 1)
        window.isReleasedWhenClosed = false
        window.setFrameAutosaveName("AutomationHubWindow")
        let container = NSView(); window.contentView = container
        web.translatesAutoresizingMaskIntoConstraints = false; container.addSubview(web)
        NSLayoutConstraint.activate([web.leadingAnchor.constraint(equalTo: container.leadingAnchor), web.trailingAnchor.constraint(equalTo: container.trailingAnchor), web.topAnchor.constraint(equalTo: container.topAnchor), web.bottomAnchor.constraint(equalTo: container.bottomAnchor)])
        loadingPanel = NSView(); loadingPanel.wantsLayer = true; loadingPanel.layer?.backgroundColor = window.backgroundColor?.cgColor
        loadingPanel.translatesAutoresizingMaskIntoConstraints = false; container.addSubview(loadingPanel)
        NSLayoutConstraint.activate([loadingPanel.leadingAnchor.constraint(equalTo: container.leadingAnchor), loadingPanel.trailingAnchor.constraint(equalTo: container.trailingAnchor), loadingPanel.topAnchor.constraint(equalTo: container.topAnchor), loadingPanel.bottomAnchor.constraint(equalTo: container.bottomAnchor)])
        let title = NSTextField(labelWithString: "Your automation home")
        title.font = NSFont.systemFont(ofSize: 30, weight: .semibold); title.alignment = .center
        status = NSTextField(wrappingLabelWithString: "Opening the private workspace on this Mac…"); status.alignment = .center; status.textColor = .secondaryLabelColor
        let retry = NSButton(title: "Reconnect", target: self, action: #selector(reconnect))
        let stack = NSStackView(views: [title, status, retry]); stack.orientation = .vertical; stack.spacing = 20; stack.translatesAutoresizingMaskIntoConstraints = false; loadingPanel.addSubview(stack)
        NSLayoutConstraint.activate([stack.centerXAnchor.constraint(equalTo: loadingPanel.centerXAnchor), stack.centerYAnchor.constraint(equalTo: loadingPanel.centerYAnchor), stack.widthAnchor.constraint(lessThanOrEqualToConstant: 520), stack.leadingAnchor.constraint(greaterThanOrEqualTo: loadingPanel.leadingAnchor, constant: 32)])
        if UserDefaults.standard.string(forKey: "NSWindow Frame AutomationHubWindow") == nil { window.center() }
        window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
        reconnect()
    }

    private func makeMenus() {
        let menu = NSMenu(); NSApp.mainMenu = menu
        let appItem = NSMenuItem(); menu.addItem(appItem); let app = NSMenu(); appItem.submenu = app
        app.addItem(withTitle: "About Automation Hub", action: #selector(about), keyEquivalent: "")
        app.addItem(.separator())
        app.addItem(withTitle: "Open in Browser", action: #selector(openBrowser), keyEquivalent: "b")
        app.addItem(withTitle: "Reconnect Workspace", action: #selector(reconnect), keyEquivalent: "r")
        app.addItem(.separator())
        app.addItem(withTitle: "Hide Automation Hub", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        app.addItem(.separator()); app.addItem(withTitle: "Quit Automation Hub", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let editItem = NSMenuItem(); menu.addItem(editItem); let edit = NSMenu(title: "Edit"); editItem.submenu = edit
        for (title, action, key) in [("Undo", Selector(("undo:")), "z"), ("Redo", Selector(("redo:")), "Z"), ("Cut", #selector(NSText.cut(_:)), "x"), ("Copy", #selector(NSText.copy(_:)), "c"), ("Paste", #selector(NSText.paste(_:)), "v"), ("Select All", #selector(NSText.selectAll(_:)), "a")] { edit.addItem(withTitle: title, action: action, keyEquivalent: key) }
        let viewItem = NSMenuItem(); menu.addItem(viewItem); let view = NSMenu(title: "View"); viewItem.submenu = view
        view.addItem(withTitle: "Actual Size", action: #selector(resetZoom), keyEquivalent: "0")
        view.addItem(withTitle: "Zoom In", action: #selector(zoomIn), keyEquivalent: "+")
        view.addItem(withTitle: "Zoom Out", action: #selector(zoomOut), keyEquivalent: "-")
        let windowItem = NSMenuItem(); menu.addItem(windowItem); let windows = NSMenu(title: "Window"); windowItem.submenu = windows; NSApp.windowsMenu = windows
        windows.addItem(withTitle: "Open Workspace", action: #selector(showWindow), keyEquivalent: "1")
        windows.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windows.addItem(withTitle: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        for item in [app, view, windows].flatMap({ $0.items }) where [#selector(about), #selector(reconnect), #selector(openBrowser), #selector(showWindow), #selector(resetZoom), #selector(zoomIn), #selector(zoomOut)].contains(item.action) { item.target = self }
    }

    @objc private func about() {
        let alert = NSAlert(); alert.messageText = "Automation Hub"; alert.informativeText = "Your private automation workspace on this Mac.\n\nClosing or quitting this window keeps the background worker running. Pause or stop a campaign in its workspace. After a Mac restart, reopen this app and review paused work.\n\nNo login item or system daemon is installed."; alert.runModal()
    }
    @objc private func showWindow() { window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true) }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if savingDownloads > 0 { if !quitAfterSaving { saveFailedDuringQuit = false }; quitAfterSaving = true; return .terminateLater }
        return .terminateNow
    }
    func windowWillClose(_ notification: Notification) {
        guard let closed = notification.object as? NSWindow, previews.contains(where: { $0 === closed }) else { return }
        if let document = closed.contentView as? WKWebView { document.stopLoading(); document.navigationDelegate = nil; document.uiDelegate = nil; closed.contentView = nil }
        previews.removeAll { $0 === closed }
    }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { showWindow(); return true }
    func applicationWillTerminate(_ notification: Notification) { helperTimer?.cancel(); renderTimer?.cancel(); if helper?.isRunning == true { helper?.terminate() } }
    @objc private func resetZoom() { web.pageZoom = 1 }
    @objc private func zoomIn() { web.pageZoom = min(1.6, web.pageZoom + 0.1) }
    @objc private func zoomOut() { web.pageZoom = max(0.8, web.pageZoom - 0.1) }
    @objc private func openBrowser() { runHelper("browser") { _ in } }
    @objc private func reconnect() {
        guard !opening else { return }
        let generation = UUID().uuidString
        display.begin(generation: generation); renderTimer?.cancel(); workspaceNavigation = nil
        web.stopLoading()
        loadingPanel.isHidden = false; status.stringValue = "Opening the private workspace on this Mac…"
        runHelper("window") { [weak self] result in
            guard let self = self, self.display.current(generation), self.display.phase == .opening else { return }
            guard let raw = result?["url"] as? String, let url = Self.launchURL(raw) else { if result != nil { self.failure("The private launch response was invalid. No other access route was attempted.") }; return }
            self.origin = URL(string: "http://127.0.0.1:\(url.port!)")
            guard let origin = self.origin, let context = try? JSONSerialization.data(withJSONObject: [origin.absoluteString, generation]), let encoded = String(data: context, encoding: .utf8) else { self.failure("The private display could not be prepared. Reconnect to open saved progress."); return }
            let script = "(() => { const context = \(encoded); if (window.location.origin === context[0] && window.location.pathname === '/') Object.defineProperty(window, '__hubLaunchGeneration', {value: context[1], writable: false, configurable: false}); })();"
            self.web.configuration.userContentController.removeAllUserScripts()
            self.web.configuration.userContentController.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
            guard self.display.started(generation: generation) else { return }
            self.workspaceNavigation = self.web.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData))
            guard self.workspaceNavigation != nil else { self.failure("The workspace display could not start. Reconnect to open saved progress."); return }
            let timeout = DispatchWorkItem { [weak self] in
                guard let self = self, self.display.expire(generation: generation) else { return }
                self.loadingPanel.isHidden = false
                self.status.stringValue = "The workspace display did not become ready. Reconnect to open saved progress, or use Open in Browser. No application action was replayed."
            }
            self.renderTimer = timeout
            DispatchQueue.main.asyncAfter(deadline: .now() + 15, execute: timeout)
        }
    }
    static func launchURL(_ raw: String) -> URL? {
        guard let u = URLComponents(string: raw), u.scheme == "http", u.host == "127.0.0.1", let port = u.port, (1...65535).contains(port), u.user == nil, u.password == nil, u.path == "/auth", u.fragment == nil, let q = u.queryItems, q.count == 1, q[0].name == "ticket", let token = q[0].value, token.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { return nil }
        return u.url
    }
    private func local(_ url: URL?) -> Bool { guard let u = url, let base = origin else { return false }; return u.scheme == base.scheme && u.host == base.host && u.port == base.port && u.user == nil && u.password == nil }
    private func localBlob(_ url: URL?) -> Bool { guard let url = url, url.scheme == "blob" else { return false }; return local(URL(string: String(url.absoluteString.dropFirst(5)))) }
    private func trusted(_ frame: WKFrameInfo) -> Bool { guard frame.isMainFrame, let base = origin else { return false }; let source = frame.securityOrigin; return source.protocol == base.scheme && source.host == base.host && source.port == base.port }
    private func runHelper(_ mode: String, completion: @escaping ([String: Any]?) -> Void) {
        guard !opening else { return }; opening = true
        guard let resources = Bundle.main.resourceURL else { failure("The app resources are unavailable."); opening = false; return }
        let task = Process(); task.executableURL = resources.appendingPathComponent("runtime/bin/node"); task.arguments = [resources.appendingPathComponent("hub/scripts/native-host.mjs").path, mode]; task.currentDirectoryURL = resources.appendingPathComponent("hub")
        let out = Pipe(), err = Pipe(); task.standardOutput = out; task.standardError = err; task.standardInput = FileHandle.nullDevice
        helper = task
        let timeout = DispatchWorkItem { [weak self, weak task] in if task?.isRunning == true { task?.terminate(); self?.failure("Opening timed out. Reconnect after checking the existing hub process.") } }; helperTimer = timeout
        task.terminationHandler = { [weak self] finished in
            let bytes = out.fileHandleForReading.readDataToEndOfFile(), errors = err.fileHandleForReading.readDataToEndOfFile()
            DispatchQueue.main.async {
                guard let self = self else { return }; self.helperTimer?.cancel(); self.opening = false; self.helper = nil
                guard finished.terminationStatus == 0, bytes.count <= 8192, let value = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any] else {
                    let code = String(data: errors.prefix(128), encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                    let safe = code.range(of: "^[A-Z0-9_]{1,60}$", options: .regularExpression) != nil ? " (\(code))" : ""
                    self.failure("The private workspace could not open\(safe). Reconnect after checking its process and launch permissions. No alternate access route was attempted."); completion(nil); return
                }
                completion(value)
            }
        }
        do { try task.run(); DispatchQueue.main.asyncAfter(deadline: .now() + 20, execute: timeout) }
        catch { opening = false; helper = nil; failure("The bundled runtime could not start. Rebuild or restore this app; your saved work remains in Application Support."); completion(nil) }
    }
    private func failure(_ message: String) { if let generation = display.generation { _ = display.fail(generation: generation, primaryWebView: true) }; renderTimer?.cancel(); loadingPanel.isHidden = false; status.stringValue = message }
    private func alert(_ message: String) { let alert = NSAlert(); alert.messageText = "Automation Hub"; alert.informativeText = message; alert.beginSheetModal(for: window) }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard trusted(message.frameInfo), let body = message.body as? [String: String] else { return }
        if body.count == 1, body["action"] == "openBrowserConnections" { runHelper("browser-connections") { _ in }; return }
        guard body.count == 2, body["action"] == "workspaceReady", let generation = body["generation"] else { return }
        let source = DisplayMessageSource(primaryWebView: message.webView === web, mainFrame: message.frameInfo.isMainFrame, matchingOrigin: local(message.frameInfo.request.url) && local(web.url), rootDocument: message.frameInfo.request.url?.path == "/" && web.url?.path == "/")
        guard display.acknowledge(generation: generation, source: source) else { return }
        renderTimer?.cancel(); loadingPanel.isHidden = true
    }
    // Both signals belong to the same primary load. Either may arrive first;
    // HTML completion alone can never reveal an uncommitted React workspace.
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard let generation = display.generation, let current = workspaceNavigation else { return }
        guard display.finished(generation: generation, primaryWebView: webView === web, currentNavigation: navigation === current) else { return }
        renderTimer?.cancel(); loadingPanel.isHidden = true
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { guard webView === web, let current = workspaceNavigation, navigation === current else { return }; if (error as NSError).code != NSURLErrorCancelled { failure("The workspace could not load. Reconnect to obtain a fresh private session.") } }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { guard webView === web, let current = workspaceNavigation, navigation === current else { return }; if (error as NSError).code != NSURLErrorCancelled { failure("The workspace connection was interrupted. Reconnect to continue from saved progress.") } }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { guard webView === web else { return }; failure("The display process stopped. Reconnect to reopen saved progress; this does not replay application actions.") }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if local(url) || (localBlob(url) && trusted(navigationAction.sourceFrame)) { if navigationAction.shouldPerformDownload { decisionHandler(.download) } else { decisionHandler(.allow) }; return }
        if url.absoluteString == "about:blank" { decisionHandler(.allow); return }
        decisionHandler(.cancel)
        // Redirects and script-driven external navigation never invoke OS handlers.
        if navigationAction.navigationType == .linkActivated, trusted(navigationAction.sourceFrame), ["https", "http"].contains(url.scheme ?? ""), url.user == nil, url.password == nil {
            NSWorkspace.shared.open(url, configuration: NSWorkspace.OpenConfiguration()) { [weak self] _, error in if error != nil { DispatchQueue.main.async { self?.alert("The system browser could not open that link. No other access route was attempted.") } } }
        }
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        guard local(navigationResponse.response.url) || localBlob(navigationResponse.response.url) else { decisionHandler(.cancel); return }
        if localBlob(navigationResponse.response.url) && !["application/pdf", "text/plain", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"].contains(navigationResponse.response.mimeType?.lowercased() ?? "") { decisionHandler(.cancel); alert("This selected file cannot be previewed here. Use a PDF, DOCX or plain-text supporting file."); return }
        let disposition = (navigationResponse.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition") ?? ""
        decisionHandler(disposition.lowercased().hasPrefix("attachment") || !navigationResponse.canShowMIMEType ? .download : .allow)
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard navigationAction.targetFrame == nil, local(navigationAction.request.url) || (localBlob(navigationAction.request.url) && trusted(navigationAction.sourceFrame)) else { return nil }
        let preview = WKWebView(frame: .zero, configuration: configuration); preview.navigationDelegate = self; preview.uiDelegate = self
        let document = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 850, height: 780), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false); document.title = "Retained document"; document.contentView = preview; document.delegate = self; document.isReleasedWhenClosed = false; previews.append(document); document.center(); document.makeKeyAndOrderFront(nil)
        return preview
    }
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        guard trusted(frame) else { completionHandler(nil); return }
        let panel = NSOpenPanel(); panel.canChooseDirectories = parameters.allowsDirectories; panel.canChooseFiles = true; panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.beginSheetModal(for: webView.window ?? window) { response in completionHandler(response == .OK ? panel.urls : nil) }
    }
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        guard trusted(frame) else { completionHandler(); return }; let panel = NSAlert(); panel.messageText = "Automation Hub"; panel.informativeText = String(message.prefix(2000)); panel.beginSheetModal(for: webView.window ?? window) { _ in completionHandler() }
    }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        guard trusted(frame) else { completionHandler(false); return }; let panel = NSAlert(); panel.messageText = "Automation Hub"; panel.informativeText = String(message.prefix(2000)); panel.addButton(withTitle: "Continue"); panel.addButton(withTitle: "Cancel"); panel.beginSheetModal(for: webView.window ?? window) { response in completionHandler(response == .alertFirstButtonReturn) }
    }
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        guard local(response.url) || localBlob(response.url) else { completionHandler(nil); return }
        let name = URL(fileURLWithPath: suggestedFilename).lastPathComponent
        let panel = NSSavePanel(); panel.nameFieldStringValue = String(name.prefix(180)); panel.canCreateDirectories = true
        panel.beginSheetModal(for: window) { result in
            guard result == .OK, let target = panel.url else { completionHandler(nil); return }
            do {
                let approved = try DownloadDestination(target)
                let directory = FileManager.default.temporaryDirectory.appendingPathComponent("automation-hub-download-" + UUID().uuidString)
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
                let temp = directory.appendingPathComponent("download")
                self.downloadTargets[ObjectIdentifier(download)] = (temp, approved); completionHandler(temp)
            } catch { self.alert("The download could not be prepared. Choose a writable folder."); completionHandler(nil) }
        }
    }
    func downloadDidFinish(_ download: WKDownload) {
        guard let item = downloadTargets.removeValue(forKey: ObjectIdentifier(download)) else { return }
        savingDownloads += 1
        DispatchQueue.global(qos: .utility).async {
            let result = Result { try item.destination.save(completed: item.temporary) }
            if case .success = result { try? FileManager.default.removeItem(at: item.temporary.deletingLastPathComponent()) }
            DispatchQueue.main.async {
                self.savingDownloads -= 1
                switch result {
                case .success(let saved):
                    if let previous = saved.recoveryDirectory {
                        self.showPreservedFiles("Download saved. The previous version remains in a private recovery folder beside the file.", locations: [previous])
                    }
                case .failure(let error):
                    self.saveFailedDuringQuit = true
                    let failure = error as? DownloadSaveFailure
                    let preserved = failure?.preserved ?? []
                    self.showPreservedFiles(failure?.message ?? "The download could not be saved. Its completed bytes remain available.", locations: preserved.isEmpty ? [item.temporary] : preserved)
                }
                if self.quitAfterSaving && self.savingDownloads == 0 {
                    self.quitAfterSaving = false
                    NSApp.reply(toApplicationShouldTerminate: !self.saveFailedDuringQuit)
                }
            }
        }
    }
    private func showPreservedFiles(_ message: String, locations: [URL]) {
        let panel = NSAlert(); panel.messageText = "Automation Hub"; panel.informativeText = message
        panel.addButton(withTitle: "Show preserved files"); panel.addButton(withTitle: "Close")
        panel.beginSheetModal(for: window) { response in if response == .alertFirstButtonReturn { NSWorkspace.shared.activateFileViewerSelecting(locations) } }
    }
    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) { if let item = downloadTargets.removeValue(forKey: ObjectIdentifier(download)) { try? FileManager.default.removeItem(at: item.temporary.deletingLastPathComponent()) }; if (error as NSError).code != NSURLErrorCancelled { alert("The download did not finish. No partial file was saved at the selected destination.") } }
}

@main
struct AutomationHubMain {
    static func main() {
        let app = NSApplication.shared
        let delegate = HubApp()
        app.delegate = delegate
        withExtendedLifetime(delegate) { app.run() }
    }
}
