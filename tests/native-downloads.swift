import Foundation
import Darwin

struct CheckFailure: Error { let message: String }
func check(_ condition: @autoclosure () throws -> Bool, _ message: String) throws { if try !condition() { throw CheckFailure(message: message) } }
func text(_ url: URL) throws -> String { try String(contentsOf: url, encoding: .utf8) }
func put(_ value: String, _ url: URL) throws { try Data(value.utf8).write(to: url) }
func mustFail(_ body: () throws -> Void) throws { do { try body() } catch { return }; throw CheckFailure(message: "operation unexpectedly succeeded") }

@main struct NativeDownloadChecks {
    static func main() throws {
        let fm = FileManager.default
        let root = fm.temporaryDirectory.appendingPathComponent("hub-native-download-checks-" + UUID().uuidString)
        try fm.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? fm.removeItem(at: root) }
        var results: [[String: String]] = []
        func run(_ name: String, _ body: (URL, URL, URL) throws -> Void) {
            do {
                let folder = root.appendingPathComponent(UUID().uuidString); try fm.createDirectory(at: folder, withIntermediateDirectories: false)
                let target = folder.appendingPathComponent("chosen.txt"), source = folder.appendingPathComponent("source.txt")
                try put("downloaded bytes", source)
                try body(folder, target, source)
                results.append(["name": name, "status": "passed"])
            } catch { results.append(["name": name, "status": "failed", "error": String(describing: error)]) }
        }
        run("new file has exact bytes and private permissions") { _, target, source in
            let saved = try DownloadDestination(target).save(completed: source)
            try check(try text(target) == "downloaded bytes", "wrong installed bytes")
            try check(try text(source) == "downloaded bytes", "completed source was deleted")
            try check(saved.recoveryDirectory == nil, "unnecessary recovery")
            let attrs = try fm.attributesOfItem(atPath: target.path); try check((attrs[.posixPermissions] as? NSNumber)?.intValue == 0o600, "file not private")
        }
        run("approved replacement preserves the actual previous version") { _, target, source in
            try put("original bytes", target); let approval = try DownloadDestination(target)
            let saved = try approval.save(completed: source)
            try check(try text(target) == "downloaded bytes", "replacement failed")
            try check(saved.recoveryDirectory != nil, "old bytes not recoverable")
            let old = saved.recoveryDirectory!.appendingPathComponent("previous/chosen.txt")
            try check(try text(old) == "original bytes", "old bytes changed")
        }
        run("destination edited after approval is left intact") { _, target, source in
            try put("approved version", target); let approval = try DownloadDestination(target); try put("newer unrelated edit", target)
            try mustFail { _ = try approval.save(completed: source) }
            try check(try text(target) == "newer unrelated edit", "new edit overwritten")
            try check(try text(source) == "downloaded bytes", "download lost")
        }
        run("same-size in-place edit revokes approval") { _, target, source in
            try put("AAAA", target); let approval = try DownloadDestination(target)
            let writer = try FileHandle(forWritingTo: target); try writer.write(contentsOf: Data("BBBB".utf8)); try writer.synchronize(); try writer.close()
            try mustFail { _ = try approval.save(completed: source) }; try check(try text(target) == "BBBB", "same-size edit lost")
        }
        run("different inode with the same contents revokes approval") { folder, target, source in
            try put("same", target); let approval = try DownloadDestination(target)
            let other = folder.appendingPathComponent("other"); try put("same", other); try fm.removeItem(at: target); try fm.moveItem(at: other, to: target)
            try mustFail { _ = try approval.save(completed: source) }; try check(try text(target) == "same", "replacement inode lost")
        }
        run("a new arrival after absent approval is not overwritten") { _, target, source in
            let approval = try DownloadDestination(target); try put("arrived later", target)
            try mustFail { _ = try approval.save(completed: source) }; try check(try text(target) == "arrived later", "new arrival lost")
        }
        run("exclusive installation preserves arrival after final precheck") { _, target, source in
            let approval = try DownloadDestination(target); var hooks = DownloadSaveHooks()
            hooks.beforeInstall = { try put("late third-party file", target) }
            try mustFail { _ = try approval.save(completed: source, hooks: hooks) }
            try check(try text(target) == "late third-party file", "exclusive install clobbered arrival")
        }
        run("a newer file displaced in a race is restored") { _, target, source in
            try put("approved", target); let approval = try DownloadDestination(target); var hooks = DownloadSaveHooks()
            hooks.beforeDisplace = { try Data("racing new generation".utf8).write(to: target, options: .atomic) }
            try mustFail { _ = try approval.save(completed: source, hooks: hooks) }; try check(try text(target) == "racing new generation", "actual displaced bytes not restored")
        }
        run("rollback does not overwrite a newer third-party destination") { _, target, source in
            try put("approved bytes", target); let approval = try DownloadDestination(target); var hooks = DownloadSaveHooks()
            hooks.beforeInstall = { try put("third-party arrival", target) }
            var preserved: [URL] = []
            do { _ = try approval.save(completed: source, hooks: hooks) } catch let problem as DownloadSaveFailure { preserved = problem.preserved }
            try check(try text(target) == "third-party arrival", "rollback overwrote new target")
            try check(preserved.count == 2, "recovery folder missing")
            try check(try text(preserved[1].appendingPathComponent("previous/chosen.txt")) == "approved bytes", "old generation lost")
            try check(try text(preserved[1].appendingPathComponent("completed-download")) == "downloaded bytes", "staged download lost")
        }
        run("a retained old-file descriptor cannot silently lose later edits") { _, target, source in
            try put("AAAA", target); let approval = try DownloadDestination(target), writer = try FileHandle(forWritingTo: target)
            var hooks = DownloadSaveHooks(); hooks.afterDisplace = { try writer.write(contentsOf: Data("BBBB".utf8)); try writer.synchronize() }
            try mustFail { _ = try approval.save(completed: source, hooks: hooks) }; try writer.close(); try check(try text(target) == "BBBB", "descriptor edit lost")
        }
        run("failure after displacement restores the original and retains download") { _, target, source in
            try put("approved", target); let approval = try DownloadDestination(target); var hooks = DownloadSaveHooks()
            hooks.afterDisplace = { throw CheckFailure(message: "injected failure") }
            try mustFail { _ = try approval.save(completed: source, hooks: hooks) }
            try check(try text(target) == "approved", "failed save did not restore original")
            try check(try text(source) == "downloaded bytes", "failed save removed download")
        }
        run("symlink destination is rejected without touching referent") { folder, target, _ in
            let real = folder.appendingPathComponent("real"); try put("untouched", real); try fm.createSymbolicLink(at: target, withDestinationURL: real)
            try mustFail { _ = try DownloadDestination(target) }; try check(try text(real) == "untouched", "referent changed")
        }
        run("symlink source is rejected without installing anything") { folder, target, source in
            let link = folder.appendingPathComponent("link"); try fm.createSymbolicLink(at: link, withDestinationURL: source)
            try mustFail { _ = try DownloadDestination(target).save(completed: link) }; try check(!fm.fileExists(atPath: target.path), "unsafe source installed")
        }
        run("FIFO source fails promptly without blocking") { folder, target, _ in
            let fifo = folder.appendingPathComponent("fifo"); try check(mkfifo(fifo.path, 0o600) == 0, "mkfifo failed")
            try mustFail { _ = try DownloadDestination(target).save(completed: fifo) }; try check(!fm.fileExists(atPath: target.path), "FIFO installed")
        }
        run("oversized source preserves original destination and completed bytes") { _, target, source in
            try put("original", target); let approval = try DownloadDestination(target)
            try mustFail { _ = try approval.save(completed: source, maximumBytes: 4) }; try check(try text(target) == "original", "oversized save changed target")
            try check(try text(source) == "downloaded bytes", "oversized original lost")
        }
        run("directory destination is rejected") { folder, _, _ in try mustFail { _ = try DownloadDestination(folder) } }
        run("repeat use of an old approval cannot replace its first result") { _, target, source in
            let approval = try DownloadDestination(target); _ = try approval.save(completed: source)
            try mustFail { _ = try approval.save(completed: source) }; try check(try text(target) == "downloaded bytes", "repeat changed target")
        }
        run("unicode spaced filenames remain intact in recovery") { folder, _, source in
            let target = folder.appendingPathComponent("测试 résumé final.txt"); try put("original unicode", target)
            let saved = try DownloadDestination(target).save(completed: source)
            try check(try text(saved.recoveryDirectory!.appendingPathComponent("previous/测试 résumé final.txt")) == "original unicode", "name/bytes lost")
        }
        let failed = results.filter { $0["status"] == "failed" }
        let payload: [String: Any] = ["checks": results.count, "passed": results.count - failed.count, "failed": failed.count, "scope": "Actual Foundation/Darwin filesystem operations on disposable files, no GUI or real user data", "results": results]
        print(String(data: try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys]), encoding: .utf8)!)
        if !failed.isEmpty { exit(1) }
    }
}
