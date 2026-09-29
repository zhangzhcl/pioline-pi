import Foundation

@objc protocol PiplineWorkflowRunnerProtocol {
    @objc(executeRequestID:request:withReply:)
    func execute(requestID: String, request: Data, withReply reply: @escaping (Data?, String?) -> Void)

    @objc(cancelRequestID:withReply:)
    func cancel(requestID: String, withReply reply: @escaping (Bool) -> Void)
}

@objc final class WorkflowRunnerClient: NSObject, PiplineWorkflowRunnerProtocol {
    let connectionID = UUID().uuidString
    weak var service: WorkflowRunnerService?

    init(service: WorkflowRunnerService) {
        self.service = service
    }

    func execute(requestID: String, request: Data, withReply reply: @escaping (Data?, String?) -> Void) {
        service?.execute(connectionID: connectionID, requestID: requestID, request: request, reply: reply)
    }

    func cancel(requestID: String, withReply reply: @escaping (Bool) -> Void) {
        service?.cancel(requestID: requestID, reply: reply)
    }

    func invalidate() {
        service?.cancelRequests(connectionID: connectionID)
    }
}

final class WorkflowRunnerService: NSObject, NSXPCListenerDelegate {
    private final class BoundedReadResult: @unchecked Sendable {
        private let lock = NSLock()
        private var data = Data()
        private var overflow = false

        func set(_ data: Data, overflow: Bool) {
            lock.lock()
            self.data = data
            self.overflow = overflow
            lock.unlock()
        }

        func snapshot() -> (Data, Bool) {
            lock.lock()
            defer { lock.unlock() }
            return (data, overflow)
        }
    }

    private struct RequestState {
        let connectionID: String
        var process: Process?
        var cancelled: Bool
    }

    private let lock = NSLock()
    private var requests: [String: RequestState] = [:]
    private var cancellationTombstones: [String: Date] = [:]
    private let maxRequestBytes = 1_200_000
    private let maxResponseBytes = 1_000_000
    private let maxDiagnosticBytes = 4_000

    func listener(_ listener: NSXPCListener, shouldAcceptNewConnection connection: NSXPCConnection) -> Bool {
        let client = WorkflowRunnerClient(service: self)
        connection.exportedInterface = NSXPCInterface(with: PiplineWorkflowRunnerProtocol.self)
        connection.exportedObject = client
        connection.invalidationHandler = { [weak client] in client?.invalidate() }
        connection.interruptionHandler = { [weak client] in client?.invalidate() }
        connection.resume()
        return true
    }

    func execute(
        connectionID: String,
        requestID: String,
        request: Data,
        reply: @escaping (Data?, String?) -> Void
    ) {
        guard UUID(uuidString: requestID) != nil else {
            reply(nil, "Invalid workflow execution request ID")
            return
        }
        guard request.count <= maxRequestBytes else {
            reply(nil, "Workflow code request exceeds the 1.2 MB limit")
            return
        }

        lock.lock()
        pruneCancellationTombstones()
        let cancelledBeforeStart = cancellationTombstones.removeValue(forKey: requestID) != nil
        let accepted = !cancelledBeforeStart && requests[requestID] == nil
        if accepted { requests[requestID] = RequestState(connectionID: connectionID, process: nil, cancelled: false) }
        lock.unlock()
        if cancelledBeforeStart { reply(nil, "Workflow code execution was cancelled"); return }
        guard accepted else { reply(nil, "Duplicate workflow execution request ID"); return }

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { reply(nil, "Workflow runner is unavailable"); return }
            self.executeProcess(connectionID: connectionID, requestID: requestID, request: request, reply: reply)
        }
    }

    func cancel(requestID: String, reply: @escaping (Bool) -> Void) {
        lock.lock()
        pruneCancellationTombstones()
        guard var state = requests[requestID] else {
            let accepted = cancellationTombstones.count < 256
            if accepted { cancellationTombstones[requestID] = Date() }
            lock.unlock()
            reply(accepted)
            return
        }
        state.cancelled = true
        let process = state.process
        requests[requestID] = state
        lock.unlock()
        if let process, process.isRunning { process.terminate() }
        reply(true)
    }

    func cancelRequests(connectionID: String) {
        lock.lock()
        let ids = requests.compactMap { id, state in state.connectionID == connectionID ? id : nil }
        let active = ids.compactMap { id -> Process? in
            guard var state = requests[id] else { return nil }
            state.cancelled = true
            requests[id] = state
            return state.process
        }
        lock.unlock()
        for process in active where process.isRunning { process.terminate() }
    }

    private func executeProcess(
        connectionID: String,
        requestID: String,
        request: Data,
        reply: @escaping (Data?, String?) -> Void
    ) {
        let executable = Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/workflow-code-worker")
        guard FileManager.default.isExecutableFile(atPath: executable.path) else {
            finish(requestID: requestID)
            reply(nil, "Confined workflow worker is missing from the XPC service bundle")
            return
        }

        let process = Process()
        process.executableURL = executable
        process.arguments = []
        process.currentDirectoryURL = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
        process.environment = ["TMPDIR": NSTemporaryDirectory()]
        let input = Pipe()
        let output = Pipe()
        let diagnostic = Pipe()
        process.standardInput = input
        process.standardOutput = output
        process.standardError = diagnostic

        lock.lock()
        guard var state = requests[requestID], state.connectionID == connectionID else {
            lock.unlock()
            reply(nil, "Workflow execution request was abandoned")
            return
        }
        let wasCancelled = state.cancelled
        if !wasCancelled {
            state.process = process
            requests[requestID] = state
        }
        lock.unlock()
        guard !wasCancelled else {
            finish(requestID: requestID)
            reply(nil, "Workflow code execution was cancelled")
            return
        }

        let readerGroup = DispatchGroup()
        let responseResult = BoundedReadResult()
        let diagnosticResult = BoundedReadResult()
        do {
            try process.run()
            if isCancelled(requestID: requestID) {
                try? input.fileHandleForWriting.close()
                if process.isRunning { process.terminate() }
                process.waitUntilExit()
                readerGroup.wait()
                finish(requestID: requestID)
                reply(nil, "Workflow code execution was cancelled")
                return
            }

            readerGroup.enter()
            DispatchQueue.global(qos: .utility).async {
                let (data, overflow) = self.readBounded(output.fileHandleForReading, limit: self.maxResponseBytes)
                responseResult.set(data, overflow: overflow)
                readerGroup.leave()
            }
            readerGroup.enter()
            DispatchQueue.global(qos: .utility).async {
                let (data, overflow) = self.readBounded(diagnostic.fileHandleForReading, limit: self.maxDiagnosticBytes)
                diagnosticResult.set(data, overflow: overflow)
                readerGroup.leave()
            }

            input.fileHandleForWriting.write(request)
            try input.fileHandleForWriting.close()
            process.waitUntilExit()
            readerGroup.wait()
            let (response, overflow) = responseResult.snapshot()
            let (error, _) = diagnosticResult.snapshot()
            let cancelled = isCancelled(requestID: requestID)
            finish(requestID: requestID)

            guard !cancelled else { reply(nil, "Workflow code execution was cancelled"); return }
            guard !overflow else { reply(nil, "Workflow helper response exceeds the 1 MB limit"); return }
            guard process.terminationStatus == 0 else {
                let message = String(data: error, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
                reply(nil, message?.isEmpty == false ? message : "Workflow helper exited with status \(process.terminationStatus)")
                return
            }
            reply(response, nil)
        } catch {
            try? input.fileHandleForWriting.close()
            if process.isRunning {
                process.terminate()
                process.waitUntilExit()
            }
            readerGroup.wait()
            finish(requestID: requestID)
            reply(nil, "Cannot run confined workflow helper: \(error.localizedDescription)")
        }
    }

    private func readBounded(_ handle: FileHandle, limit: Int) -> (Data, Bool) {
        var collected = Data()
        var overflow = false
        while true {
            let chunk = handle.readData(ofLength: 8_192)
            if chunk.isEmpty { break }
            let remaining = max(0, limit - collected.count)
            let kept = min(remaining, chunk.count)
            if kept > 0 { collected.append(chunk.prefix(kept)) }
            if kept < chunk.count { overflow = true }
        }
        return (collected, overflow)
    }

    private func isCancelled(requestID: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return requests[requestID]?.cancelled ?? true
    }

    private func finish(requestID: String) {
        lock.lock()
        requests.removeValue(forKey: requestID)
        lock.unlock()
    }

    private func pruneCancellationTombstones() {
        let expiration = Date().addingTimeInterval(-30)
        cancellationTombstones = cancellationTombstones.filter { $0.value >= expiration }
    }
}

let service = WorkflowRunnerService()
let listener = NSXPCListener.service()
listener.delegate = service
listener.resume()
RunLoop.current.run()
