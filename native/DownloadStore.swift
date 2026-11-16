import Foundation
import Darwin

struct DownloadSaveFailure: Error {
    let message: String
    let preserved: [URL]
}

private struct DownloadGeneration: Equatable {
    let device: dev_t, inode: ino_t, size: off_t
    let modifiedSeconds: Int, modifiedNanos: Int, changedSeconds: Int, changedNanos: Int
    init(_ value: stat) throws {
        guard value.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG), value.st_uid == getuid() else { throw DownloadSaveFailure(message: "Choose a regular file that belongs to you, or a new filename.", preserved: []) }
        device = value.st_dev; inode = value.st_ino; size = value.st_size
        modifiedSeconds = value.st_mtimespec.tv_sec; modifiedNanos = value.st_mtimespec.tv_nsec
        changedSeconds = value.st_ctimespec.tv_sec; changedNanos = value.st_ctimespec.tv_nsec
    }
    // Renaming our displaced file may change ctime. Its identity, size and mtime
    // must still match, and we always retain the actual displaced inode.
    func sameContentGeneration(_ other: DownloadGeneration) -> Bool {
        device == other.device && inode == other.inode && size == other.size && modifiedSeconds == other.modifiedSeconds && modifiedNanos == other.modifiedNanos
    }
    static func at(_ url: URL) throws -> DownloadGeneration? {
        var value = stat()
        if lstat(url.path, &value) == 0 { return try DownloadGeneration(value) }
        if errno == ENOENT { return nil }
        throw DownloadSaveFailure(message: "The chosen destination cannot be checked. Choose a writable location.", preserved: [])
    }
}

struct DownloadSaveResult {
    let destination: URL
    let recoveryDirectory: URL?
}

// Trusted test seams gate real filesystem races; they are never exposed to JS.
struct DownloadSaveHooks {
    var beforeDisplace: (() throws -> Void)? = nil
    var afterDisplace: (() throws -> Void)? = nil
    var beforeInstall: (() throws -> Void)? = nil
}

struct DownloadDestination {
    let url: URL
    private let approved: DownloadGeneration?
    init(_ url: URL) throws {
        guard url.isFileURL else { throw DownloadSaveFailure(message: "Choose a local file destination.", preserved: []) }
        self.url = url.standardizedFileURL
        approved = try DownloadGeneration.at(self.url)
    }

    func save(completed: URL, maximumBytes: Int = 256 * 1024 * 1024, hooks: DownloadSaveHooks = DownloadSaveHooks()) throws -> DownloadSaveResult {
        let coordinator = NSFileCoordinator(), manager = FileManager.default
        var coordinationError: NSError?, result: Result<DownloadSaveResult, Error>?
        coordinator.coordinate(writingItemAt: url, options: .forReplacing, error: &coordinationError) { target in
            result = Result {
                guard target.standardizedFileURL == url, try DownloadGeneration.at(target) == approved else { throw DownloadSaveFailure(message: "The destination changed after the save dialog. Your newer file was not replaced; choose a new filename.", preserved: [completed]) }
                let directory = target.deletingLastPathComponent().appendingPathComponent(".automation-hub-save-" + UUID().uuidString, isDirectory: true)
                try manager.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
                let staged = directory.appendingPathComponent("completed-download"), previousDirectory = directory.appendingPathComponent("previous", isDirectory: true)
                let previous = previousDirectory.appendingPathComponent(target.lastPathComponent)
                var displaced = false, installed = false
                do {
                    try Self.copyPrivate(completed, to: staged, maximumBytes: maximumBytes)
                    guard try DownloadGeneration.at(target) == approved else { throw DownloadSaveFailure(message: "The destination changed while saving. Your newer file was not replaced.", preserved: []) }
                    if let approved = approved {
                        try hooks.beforeDisplace?()
                        try manager.createDirectory(at: previousDirectory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
                        try Self.moveExclusive(target, to: previous)
                        displaced = true
                        try hooks.afterDisplace?()
                        guard let actual = try DownloadGeneration.at(previous), approved.sameContentGeneration(actual) else { throw DownloadSaveFailure(message: "The destination changed during replacement. Both versions were preserved.", preserved: []) }
                    }
                    try hooks.beforeInstall?()
                    try Self.moveExclusive(staged, to: target)
                    installed = true
                    if !displaced { try? manager.removeItem(at: directory) }
                    // Existing bytes stay recoverable even if a noncooperating
                    // writer retained an open descriptor during our rename.
                    return DownloadSaveResult(destination: target, recoveryDirectory: displaced ? directory : nil)
                } catch {
                    if displaced && !installed {
                        // Never restore over a new file created by another writer.
                        if (try? Self.moveExclusive(previous, to: target)) != nil { displaced = false }
                    }
                    var preserved = [completed]
                    if displaced { preserved.append(directory) }
                    else { try? manager.removeItem(at: directory) }
                    let message = (error as? DownloadSaveFailure)?.message ?? "The download could not be saved. Existing and completed files were preserved. Choose a new writable filename."
                    throw DownloadSaveFailure(message: message, preserved: preserved)
                }
            }
        }
        if let result = result { return try result.get() }
        throw DownloadSaveFailure(message: "The destination could not be coordinated. Your completed download remains available.", preserved: [completed])
    }

    private static func moveExclusive(_ source: URL, to destination: URL) throws {
        guard renameatx_np(AT_FDCWD, source.path, AT_FDCWD, destination.path, UInt32(RENAME_EXCL)) == 0 else { throw DownloadSaveFailure(message: "The destination changed or could not be replaced. Existing files were left in place.", preserved: []) }
    }
    private static func copyPrivate(_ source: URL, to destination: URL, maximumBytes: Int) throws {
        let inputFD = open(source.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
        guard inputFD >= 0 else { throw DownloadSaveFailure(message: "The completed download could not be read safely.", preserved: [source]) }
        let input = FileHandle(fileDescriptor: inputFD, closeOnDealloc: true)
        defer { try? input.close() }
        var initial = stat(); guard fstat(inputFD, &initial) == 0 else { throw DownloadSaveFailure(message: "The download could not be checked.", preserved: [source]) }
        let generation = try DownloadGeneration(initial)
        guard generation.size >= 0, generation.size <= maximumBytes else { throw DownloadSaveFailure(message: "This download exceeds the native save limit. Its completed bytes remain available.", preserved: [source]) }
        let outputFD = open(destination.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
        guard outputFD >= 0 else { throw DownloadSaveFailure(message: "The destination folder is not writable.", preserved: [source]) }
        let output = FileHandle(fileDescriptor: outputFD, closeOnDealloc: true)
        defer { try? output.close() }
        var count = 0
        while let chunk = try input.read(upToCount: 1024 * 1024), !chunk.isEmpty {
            count += chunk.count
            guard count <= maximumBytes else { throw DownloadSaveFailure(message: "The download grew while saving. Its original bytes were preserved.", preserved: [source]) }
            try output.write(contentsOf: chunk)
        }
        var final = stat()
        guard fstat(inputFD, &final) == 0, try DownloadGeneration(final) == generation, count == generation.size else { throw DownloadSaveFailure(message: "The completed download changed while saving. No partial file was installed.", preserved: [source]) }
        try output.synchronize()
    }
}
