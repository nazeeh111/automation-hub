import Foundation

// Display-only state. A renderer acknowledgement never authorizes application
// actions or declares the worker healthy. The native host supplies actual
// WebKit identity/frame/origin checks, then uses these same tested transitions.
struct DisplayMessageSource {
    let primaryWebView: Bool
    let mainFrame: Bool
    let matchingOrigin: Bool
    let rootDocument: Bool
    var trusted: Bool { primaryWebView && mainFrame && matchingOrigin && rootDocument }
}

struct DisplayReadiness {
    enum Phase: String { case idle, opening, loading, ready, failed }
    private(set) var generation: String?
    private(set) var phase: Phase = .idle
    private var committed = false
    private var navigationFinished = false

    mutating func begin(generation: String) {
        self.generation = generation
        phase = .opening
        committed = false; navigationFinished = false
    }
    func current(_ generation: String) -> Bool { self.generation == generation }
    mutating func started(generation: String) -> Bool {
        guard current(generation), phase == .opening else { return false }
        phase = .loading
        return true
    }
    mutating func acknowledge(generation: String, source: DisplayMessageSource) -> Bool {
        guard source.trusted, current(generation), phase == .loading else { return false }
        committed = true
        return revealIfReady()
    }
    mutating func finished(generation: String, primaryWebView: Bool, currentNavigation: Bool) -> Bool {
        guard primaryWebView, currentNavigation, current(generation), phase == .loading else { return false }
        navigationFinished = true
        return revealIfReady()
    }
    private mutating func revealIfReady() -> Bool {
        guard committed && navigationFinished else { return false }
        phase = .ready; return true
    }
    mutating func fail(generation: String, primaryWebView: Bool) -> Bool {
        guard primaryWebView, current(generation), phase != .idle, phase != .failed else { return false }
        phase = .failed
        return true
    }
    mutating func expire(generation: String) -> Bool {
        guard current(generation), phase == .loading else { return false }
        phase = .failed
        return true
    }
}
