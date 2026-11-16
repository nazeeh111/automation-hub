import Foundation

struct MaintenanceFailure: Error { let message: String }
func require(_ value: @autoclosure () -> Bool, _ message: String) throws { if !value() { throw MaintenanceFailure(message: message) } }

@main struct NativeMaintenanceChecks {
    static func main() throws {
        var results: [[String: String]] = []
        func run(_ name: String, _ body: () throws -> Void) {
            do { try body(); results.append(["name": name, "status": "passed"]) }
            catch { results.append(["name": name, "status": "failed", "error": String(describing: error)]) }
        }
        run("opening and active saves reject maintenance without changing state") {
            var state = WorkerMaintenance()
            try require(!state.begin(opening: true, savingDownloads: 0), "opening bypassed")
            try require(!state.begin(opening: false, savingDownloads: 1), "active save bypassed")
            try require(state.phase == .normal && state.message == nil, "refusal changed state")
        }
        run("confirmation recheck and repeated shutdown cannot bypass a pending stop") {
            var state = WorkerMaintenance()
            try require(state.canBegin(opening: false, savingDownloads: 0), "initial precheck failed")
            try require(!state.begin(opening: false, savingDownloads: 1), "save during confirmation bypassed")
            try require(state.begin(opening: false, savingDownloads: 0), "confirmed stop rejected")
            try require(!state.begin(opening: false, savingDownloads: 0), "stop reentered")
            try require(state.phase == .stopping, "pending stop lost")
        }
        run("both verified fields are required before any stopped claim") {
            for pair in [(false, false), (false, true), (true, false)] {
                var state = WorkerMaintenance(); _ = state.begin(opening: false, savingDownloads: 0)
                state.complete(stopped: pair.0, verified: pair.1)
                try require(state.phase == .unverified, "partial result became stopped")
                try require(state.message?.contains("Keep current files in place") == true, "missing preservation advice")
            }
        }
        run("verified stop retains explicit recovery after late failure and duplicate results") {
            var state = WorkerMaintenance(); _ = state.begin(opening: false, savingDownloads: 0)
            state.complete(stopped: true, verified: true); let message = state.message
            state.fail("late display process failure"); state.complete(stopped: false, verified: false)
            try require(state.phase == .stopped && state.message == message, "late callback erased known stop")
            try require(!state.begin(opening: false, savingDownloads: 0), "repeated stop erased known recovery")
            try require(message?.contains("Preserve the current runtime bytes") == true, "restore advice missing")
        }
        run("unverified timeout cannot become a stopped claim from a later response") {
            var state = WorkerMaintenance(); _ = state.begin(opening: false, savingDownloads: 0)
            state.fail("Timeout. Keep current files in place."); state.complete(stopped: true, verified: true)
            try require(state.phase == .unverified, "late result removed uncertainty")
        }
        run("only explicit reopen clears maintenance instructions") {
            var state = WorkerMaintenance(); _ = state.begin(opening: false, savingDownloads: 0)
            state.complete(stopped: true, verified: true); state.reopen()
            try require(state.phase == .normal && state.message == nil, "explicit reopen did not reset")
        }
        run("unknown uppercase diagnostics, private paths and long stderr never appear") {
            for raw in ["SECRET_UPPERCASE_TOKEN", "Error /synthetic/private/account at stack", String(repeating: "A", count: 129), "HUB_PORT_IN_USE\nSECRET", "HUB_PORT_IN_USE\n" + String(repeating: " ", count: 200)] {
                let message = NativeStartupFailure.message(Data(raw.utf8))
                try require(!message.contains(raw), "unknown diagnostic disclosed")
                try require(!message.contains("SECRET") && !message.contains("/synthetic"), "private value disclosed")
                try require(!message.contains("(HUB_PORT_IN_USE)"), "oversize or multiple frame accepted")
            }
        }
        run("known codes retain actionable advice and no raw exception details") {
            let port = NativeStartupFailure.message(Data("HUB_PORT_IN_USE\n".utf8))
            try require(port.contains("(HUB_PORT_IN_USE)") && port.contains("unused HUB_PORT explicitly"), "port advice lost")
            let changed = NativeStartupFailure.message(Data("LOCAL_SHUTDOWN_CHANGED\n".utf8))
            try require(changed.contains("replacement was left untouched"), "ownership advice lost")
            let mode = NativeStartupFailure.message(Data("LOCAL_LAUNCH_MODE\n".utf8))
            try require(mode.contains("documented private modes"), "permission advice lost")
        }
        let failed = results.filter { $0["status"] == "failed" }.count
        let data = try JSONSerialization.data(withJSONObject: ["checks": results.count, "passed": results.count - failed, "failed": failed, "results": results], options: [.prettyPrinted, .sortedKeys])
        print(String(data: data, encoding: .utf8)!)
        if failed > 0 { throw MaintenanceFailure(message: "native maintenance checks failed") }
    }
}
