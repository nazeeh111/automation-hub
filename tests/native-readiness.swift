import Foundation

struct ReadinessCheckFailure: Error { let message: String }
func require(_ value: @autoclosure () -> Bool, _ message: String) throws { if !value() { throw ReadinessCheckFailure(message: message) } }

@main struct NativeReadinessChecks {
    static func main() throws {
        var results: [[String: String]] = []
        let main = DisplayMessageSource(primaryWebView: true, mainFrame: true, matchingOrigin: true, rootDocument: true)
        func run(_ name: String, _ body: () throws -> Void) {
            do { try body(); results.append(["name": name, "status": "passed"]) }
            catch { results.append(["name": name, "status": "failed", "error": String(describing: error)]) }
        }
        func loading() -> DisplayReadiness { var state = DisplayReadiness(); state.begin(generation: "launch-1"); _ = state.started(generation: "launch-1"); return state }

        run("launch waits for the actual display load before accepting ready") {
            var state = DisplayReadiness(); state.begin(generation: "launch-1")
            try require(state.phase == .opening, "wrong opening phase")
            try require(!state.acknowledge(generation: "launch-1", source: main), "ready accepted before a load")
            try require(!state.started(generation: "old-launch"), "stale helper completion started a load")
            try require(state.started(generation: "launch-1"), "current load did not start")
            try require(state.phase == .loading, "workspace declared ready without commit")
        }
        run("commit before navigation finish is retained and both reveal exactly once") {
            var state = loading()
            try require(!state.acknowledge(generation: "launch-1", source: main), "commit revealed before navigation finish")
            try require(state.phase == .loading, "pending commit lost loading state")
            try require(state.finished(generation: "launch-1", primaryWebView: true, currentNavigation: true), "pending commit lost after finish")
            try require(state.phase == .ready, "current commit not ready")
            try require(!state.acknowledge(generation: "launch-1", source: main), "StrictMode duplicate changed display")
            try require(!state.expire(generation: "launch-1"), "cancelled timer covered ready UI")
        }
        run("no renderer acknowledgement produces bounded failure, not false readiness") {
            var state = loading()
            try require(state.expire(generation: "launch-1"), "missing renderer did not expire")
            try require(state.phase == .failed, "expired display not failed")
            try require(!state.acknowledge(generation: "launch-1", source: main), "late ready bypassed explicit reconnect")
            try require(!state.expire(generation: "launch-1"), "duplicate deadline changed failed display")
        }
        run("a new launch invalidates stale helper, ready, failure and timer transitions") {
            var state = loading(); state.begin(generation: "launch-2")
            try require(!state.started(generation: "launch-1"), "old helper started new generation")
            try require(!state.acknowledge(generation: "launch-1", source: main), "old ready accepted")
            try require(!state.fail(generation: "launch-1", primaryWebView: true), "old failure accepted")
            try require(!state.expire(generation: "launch-1"), "old timer expired new generation")
            try require(state.phase == .opening && state.current("launch-2"), "old event changed current launch")
            try require(state.started(generation: "launch-2"), "new helper rejected")
            _ = state.finished(generation: "launch-2", primaryWebView: true, currentNavigation: true)
            try require(state.acknowledge(generation: "launch-2", source: main), "new commit rejected")
        }
        run("primary navigation failure latches until a new user-driven generation") {
            var state = loading()
            try require(state.fail(generation: "launch-1", primaryWebView: true), "primary failure rejected")
            try require(!state.acknowledge(generation: "launch-1", source: main), "late commit removed failure")
            try require(!state.started(generation: "launch-1"), "failed generation restarted itself")
            state.begin(generation: "launch-2")
            try require(state.started(generation: "launch-2"), "explicit reconnect not admitted")
        }
        run("preview success cannot reveal the main display") {
            var state = loading()
            let preview = DisplayMessageSource(primaryWebView: false, mainFrame: true, matchingOrigin: true, rootDocument: true)
            try require(!state.acknowledge(generation: "launch-1", source: preview), "preview ready revealed main")
            try require(state.phase == .loading, "preview changed main phase")
        }
        run("preview failure never replaces the main display, while loading or ready") {
            var state = loading()
            try require(!state.fail(generation: "launch-1", primaryWebView: false), "preview failed main loading")
            _ = state.finished(generation: "launch-1", primaryWebView: true, currentNavigation: true)
            _ = state.acknowledge(generation: "launch-1", source: main)
            try require(!state.fail(generation: "launch-1", primaryWebView: false), "preview failed ready main")
            try require(state.phase == .ready, "preview covered ready main")
        }
        for (name, source) in [
            ("subframe", DisplayMessageSource(primaryWebView: true, mainFrame: false, matchingOrigin: true, rootDocument: true)),
            ("foreign origin", DisplayMessageSource(primaryWebView: true, mainFrame: true, matchingOrigin: false, rootDocument: true)),
            ("non-root document", DisplayMessageSource(primaryWebView: true, mainFrame: true, matchingOrigin: true, rootDocument: false))
        ] {
            run("\(name) cannot declare the native workspace ready") {
                var state = loading()
                try require(!state.acknowledge(generation: "launch-1", source: source), "untrusted commit accepted")
                try require(state.phase == .loading, "untrusted commit changed phase")
            }
        }
        run("missing or incorrect generation cannot reveal current content") {
            var state = loading()
            for generation in ["", "different-launch"] { try require(!state.acknowledge(generation: generation, source: main), "wrong generation accepted") }
            try require(state.phase == .loading, "wrong generation changed phase")
        }
        run("a terminated primary display can fail after readiness without restarting actions") {
            var state = loading(); _ = state.finished(generation: "launch-1", primaryWebView: true, currentNavigation: true); _ = state.acknowledge(generation: "launch-1", source: main)
            try require(state.fail(generation: "launch-1", primaryWebView: true), "primary display termination ignored")
            try require(state.phase == .failed && state.current("launch-1"), "termination created another launch")
        }
        run("navigation finish before commit waits for the current trusted React signal") {
            var state = loading()
            try require(!state.finished(generation: "launch-1", primaryWebView: true, currentNavigation: true), "HTML completion alone revealed workspace")
            try require(state.phase == .loading, "HTML completion declared ready")
            try require(state.acknowledge(generation: "launch-1", source: main), "late commit lost after HTML finish")
        }
        run("preview or previous navigation finish cannot satisfy the second signal") {
            var state = loading(); _ = state.acknowledge(generation: "launch-1", source: main)
            try require(!state.finished(generation: "launch-1", primaryWebView: false, currentNavigation: true), "preview finish revealed main")
            try require(!state.finished(generation: "launch-1", primaryWebView: true, currentNavigation: false), "old navigation finish revealed main")
            try require(!state.finished(generation: "old-launch", primaryWebView: true, currentNavigation: true), "old generation finish revealed main")
            try require(state.phase == .loading, "unmatched finish changed display")
        }
        run("pending commit expires visibly and a late matching finish cannot undo failure") {
            var state = loading(); _ = state.acknowledge(generation: "launch-1", source: main)
            try require(state.expire(generation: "launch-1"), "missing navigation finish never expired")
            try require(!state.finished(generation: "launch-1", primaryWebView: true, currentNavigation: true), "late finish removed failed display")
            try require(state.phase == .failed, "late finish changed failure")
        }
        let failed = results.filter { $0["status"] == "failed" }.count
        let data = try JSONSerialization.data(withJSONObject: ["checks": results.count, "passed": results.count - failed, "failed": failed, "results": results], options: [.prettyPrinted, .sortedKeys])
        print(String(data: data, encoding: .utf8)!)
        if failed > 0 { throw ReadinessCheckFailure(message: "native display checks failed") }
    }
}
