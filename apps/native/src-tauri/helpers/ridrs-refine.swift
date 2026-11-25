// SPDX-License-Identifier: AGPL-3.0-or-later
//
// ridrs-refine (ADR 0110): computes one refined stretch of a route's video with Apple's frame rate
// conversion (VTFrameProcessor, macOS 15.4+).
//
//   ridrs-refine --video <path> --from <s> --to <s> --factor <n> --out <path>
//
// It decodes the video from its first frame at or after `from` to `to` (AVAssetReader), writes
// each frame and `factor - 1` frames between it and the next (VTFrameRateConversion) as H.264 to
// `out` (AVAssetWriter, MP4), its first frame a keyframe at time 0. It prints progress lines
// `{"progress":0.42}` and, at the end, `{"from":…,"to":…,"frames":…}`: the times of its first
// frame and of the frame after its last, s of the video. It exits with 0, or with 1 and the reason
// on stderr. Cancelled, it is ended by a signal and leaves `out` half-written.

import AVFoundation
import CoreMedia
import CoreVideo
import Foundation
import VideoToolbox

/// Ends with the reason on one line: the app shows the last line as the reason.
func fail(_ message: String) -> Never {
    let line = message.split(whereSeparator: \.isNewline).joined(separator: " ")
    FileHandle.standardError.write((line + "\n").data(using: .utf8)!)
    exit(1)
}

func say(_ json: String) {
    FileHandle.standardOutput.write((json + "\n").data(using: .utf8)!)
}

// MARK: arguments

var options: [String: String] = [:]
var arguments = CommandLine.arguments.dropFirst().makeIterator()
while let name = arguments.next() {
    guard name.hasPrefix("--"), let value = arguments.next() else { fail("usage: ridrs-refine --video <path> --from <s> --to <s> --factor <n> --out <path>") }
    options[String(name.dropFirst(2))] = value
}
guard let videoPath = options["video"], let outPath = options["out"],
      let from = options["from"].flatMap(Double.init), let to = options["to"].flatMap(Double.init),
      let factor = options["factor"].flatMap(Int.init), to > from, factor >= 2
else { fail("usage: ridrs-refine --video <path> --from <s> --to <s> --factor <n> --out <path>") }

/// Why this device cannot: the app tells the rider so, and refines nothing (ADR 0110).
let unsupported = "This device cannot compute in-between frames: frame rate conversion needs macOS 15.4 on Apple silicon"

if #available(macOS 15.4, *) {
    // VP9 (YouTube's HLS formats, VP9 in MP4): its decoder ships with macOS but is loaded only on request.
    VTRegisterSupplementalVideoDecoderIfAvailable(kCMVideoCodecType_VP9)
    run()
} else {
    fail(unsupported)
}

@available(macOS 15.4, *)
func run() {
    guard VTFrameRateConversionConfiguration.isSupported else { fail(unsupported) }

    // MARK: the video

    let asset = AVURLAsset(url: URL(fileURLWithPath: videoPath))
    let semaphore = DispatchSemaphore(value: 0)
    var loadedTrack: AVAssetTrack?
    var loadError: Error?
    Task {
        do { loadedTrack = try await asset.loadTracks(withMediaType: .video).first } catch { loadError = error }
        semaphore.signal()
    }
    semaphore.wait()
    guard let track = loadedTrack else { fail("The video cannot be read: \(loadError?.localizedDescription ?? "it has no video track")") }

    var size = CGSize.zero
    var dataRate: Float = 0
    Task {
        size = (try? await track.load(.naturalSize)) ?? .zero
        dataRate = (try? await track.load(.estimatedDataRate)) ?? 0
        semaphore.signal()
    }
    semaphore.wait()
    let width = Int(size.width), height = Int(size.height)
    guard width > 0, height > 0 else { fail("The video has no size") }

    guard let configuration = VTFrameRateConversionConfiguration(
        frameWidth: width, frameHeight: height, usePrecomputedFlow: false,
        qualityPrioritization: .normal, revision: VTFrameRateConversionConfiguration.defaultRevision)
    else { fail("Frame rate conversion cannot take a video of \(width) × \(height)") }
    let processor = VTFrameProcessor()
    do { try processor.startSession(configuration: configuration) } catch { fail("Frame rate conversion did not start: \(error)") }

    // The samples are read from the keyframe at or before `from`, which the decoder needs first,
    // and a little beyond `to`, for the frame after the stretch's last.
    var readFrom = max(0, from - 10)
    if track.canProvideSampleCursors,
       let cursor = track.makeSampleCursor(presentationTimeStamp: CMTime(seconds: from, preferredTimescale: 90_000)) {
        var steps = 0
        while !cursor.currentSampleSyncInfo.sampleIsFullSync.boolValue, steps < 10_000, cursor.stepInDecodeOrder(byCount: -1) == -1 {
            steps += 1
        }
        if cursor.currentSampleSyncInfo.sampleIsFullSync.boolValue { readFrom = min(from, cursor.presentationTimeStamp.seconds) }
    }
    let reader: AVAssetReader
    do { reader = try AVAssetReader(asset: asset) } catch { fail("The video cannot be read: \(error)") }
    reader.timeRange = CMTimeRange(
        start: CMTime(seconds: readFrom, preferredTimescale: 90_000),
        end: CMTime(seconds: to + 1, preferredTimescale: 90_000))
    // The samples as they are stored: decoded below by a session of our own, which leaves out a
    // frame it cannot decode where AVAssetReader's own decoding would stop the whole read (the
    // 3-byte "show existing frame" units of libaom's AV1 do that).
    let output = AVAssetReaderTrackOutput(track: track, outputSettings: nil)
    output.alwaysCopiesSampleData = false
    reader.add(output)
    guard reader.startReading() else { fail("The video cannot be read: \(reader.error.map { "\($0)" } ?? "unknown")") }

    // MARK: the stretch's file

    try? FileManager.default.removeItem(atPath: outPath)
    let writer: AVAssetWriter
    do { writer = try AVAssetWriter(outputURL: URL(fileURLWithPath: outPath), fileType: .mp4) } catch { fail("The stretch cannot be written: \(error)") }
    // As many bits per frame as the video has, at least 2 Mbit/s for the 30 frames of a second.
    let sourceRate = Double(dataRate > 0 ? dataRate : 8_000_000)
    let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
        AVVideoCodecKey: AVVideoCodecType.h264,
        AVVideoWidthKey: width,
        AVVideoHeightKey: height,
        AVVideoCompressionPropertiesKey: [
            AVVideoAverageBitRateKey: Int(max(2_000_000, sourceRate * Double(factor) * 0.75)),
            AVVideoAllowFrameReorderingKey: false,
            AVVideoMaxKeyFrameIntervalDurationKey: 2.0,
            AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
        ] as [String: Any],
    ])
    input.expectsMediaDataInRealTime = false
    let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
        kCVPixelBufferWidthKey as String: width,
        kCVPixelBufferHeightKey as String: height,
        kCVPixelBufferIOSurfacePropertiesKey as String: [:] as [String: Any],
    ])
    writer.add(input)
    guard writer.startWriting() else { fail("The stretch cannot be written: \(writer.error.map { "\($0)" } ?? "unknown")") }
    writer.startSession(atSourceTime: .zero)

    // MARK: pixel formats: the processor takes half-float RGBA, the codecs 4:2:0

    var transfer: VTPixelTransferSession?
    VTPixelTransferSessionCreate(allocator: nil, pixelTransferSessionOut: &transfer)
    guard let transfer else { fail("No pixel transfer session") }

    func buffer(_ attributes: [String: Any], format: OSType) -> CVPixelBuffer {
        var attrs = attributes
        attrs[kCVPixelBufferPixelFormatTypeKey as String] = format
        attrs[kCVPixelBufferWidthKey as String] = width
        attrs[kCVPixelBufferHeightKey as String] = height
        attrs[kCVPixelBufferIOSurfacePropertiesKey as String] = [:] as [String: Any]
        var made: CVPixelBuffer?
        let status = CVPixelBufferCreate(nil, width, height, format, attrs as CFDictionary, &made)
        guard status == kCVReturnSuccess, let made else { fail("No pixel buffer (\(status))") }
        return made
    }

    let half = kCVPixelFormatType_64RGBAHalf
    func toHalf(_ source: CVPixelBuffer) -> CVPixelBuffer {
        let target = buffer(configuration.sourcePixelBufferAttributes, format: half)
        let status = VTPixelTransferSessionTransferImage(transfer, from: source, to: target)
        guard status == noErr else { fail("Pixel transfer failed (\(status))") }
        return target
    }
    func toCodec(_ source: CVPixelBuffer) -> CVPixelBuffer {
        let target = buffer([:], format: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange)
        let status = VTPixelTransferSessionTransferImage(transfer, from: source, to: target)
        guard status == noErr else { fail("Pixel transfer failed (\(status))") }
        return target
    }

    func append(_ pixels: CVPixelBuffer, at seconds: Double) {
        while !input.isReadyForMoreMediaData { usleep(1000) }
        let time = CMTime(seconds: seconds, preferredTimescale: 90_000)
        guard adaptor.append(pixels, withPresentationTime: time) else {
            fail("The stretch cannot be written: \(writer.error.map { "\($0)" } ?? "unknown")")
        }
    }

    // MARK: decoding

    var decoder: VTDecompressionSession?
    var decoderFormat: CMFormatDescription?
    /// Decoded frames not yet taken, in the order they came; taken in the order of their time.
    var decoded: [(time: Double, pixels: CVPixelBuffer)] = []
    var undecodable = 0
    /// Frames held back before the earliest is taken: enough for B-frames to come in.
    let reorder = 8

    func decode(_ sample: CMSampleBuffer) {
        guard let format = CMSampleBufferGetFormatDescription(sample), CMSampleBufferGetNumSamples(sample) > 0 else { return }
        if let session = decoder, let known = decoderFormat, !CMFormatDescriptionEqual(known, otherFormatDescription: format),
           !VTDecompressionSessionCanAcceptFormatDescription(session, formatDescription: format) {
            VTDecompressionSessionWaitForAsynchronousFrames(session)
            VTDecompressionSessionInvalidate(session)
            decoder = nil
        }
        if decoder == nil {
            var made: VTDecompressionSession?
            let attributes: [String: Any] = [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
                kCVPixelBufferIOSurfacePropertiesKey as String: [:] as [String: Any],
            ]
            let status = VTDecompressionSessionCreate(
                allocator: nil, formatDescription: format, decoderSpecification: nil,
                imageBufferAttributes: attributes as CFDictionary, outputCallback: nil, decompressionSessionOut: &made)
            guard status == noErr, let made else { fail("This Mac cannot decode the video (\(status))") }
            decoder = made
            decoderFormat = format
        }
        var info = VTDecodeInfoFlags()
        let status = VTDecompressionSessionDecodeFrame(decoder!, sampleBuffer: sample, flags: [], infoFlagsOut: &info) { status, _, image, time, _ in
            if status == noErr, let image, time.isValid {
                decoded.append((time: time.seconds, pixels: image))
            } else if status != noErr {
                undecodable += 1
            }
        }
        if status != noErr { undecodable += 1 }
    }

    /// The decoded frame with the earliest time, once enough are held back, or at the end any.
    func nextFrame(atEnd: Bool) -> (time: Double, pixels: CVPixelBuffer)? {
        guard decoded.count > (atEnd ? 0 : reorder) else { return nil }
        let earliest = decoded.indices.min { decoded[$0].time < decoded[$1].time }!
        return decoded.remove(at: earliest)
    }

    // MARK: the frames

    let destinations = (1..<factor).map { _ in buffer(configuration.destinationPixelBufferAttributes, format: half) }
    let phases = (1..<factor).map { Float($0) / Float(factor) }
    var previous: (time: Double, pixels: CVPixelBuffer, half: CVPixelBuffer)?
    var first: Double?
    var after: Double?
    var frames = 0
    var shownProgress = -1

    var ended = false
    var lastTaken = -Double.infinity
    frames: while true {
        if !ended, let sample = output.copyNextSampleBuffer() {
            decode(sample)
        } else if !ended {
            ended = true
            if let session = decoder { VTDecompressionSessionWaitForAsynchronousFrames(session) }
        }
        guard let next = nextFrame(atEnd: ended) else {
            if ended { break frames }
            continue
        }
        let time = next.time
        let pixels = next.pixels
        // A frame late from the reordering, or one shown twice, is left out.
        if time < from - 1e-6 || time <= lastTaken + 1e-6 { continue }
        lastTaken = time
        let current = (time: time, pixels: pixels, half: toHalf(pixels))
        if let before = previous {
            let base = first ?? before.time
            first = base
            append(toCodec(before.half), at: before.time - base)
            frames += 1
            let span = time - before.time
            let scale = Int32(90_000)
            guard let a = VTFrameProcessorFrame(buffer: before.half, presentationTimeStamp: CMTime(seconds: before.time, preferredTimescale: scale)),
                  let b = VTFrameProcessorFrame(buffer: current.half, presentationTimeStamp: CMTime(seconds: time, preferredTimescale: scale))
            else { fail("No frames for the processor") }
            let outs = destinations.enumerated().map { i, pixels in
                VTFrameProcessorFrame(buffer: pixels, presentationTimeStamp: CMTime(seconds: before.time + span * Double(phases[i]), preferredTimescale: scale))!
            }
            guard let parameters = VTFrameRateConversionParameters(
                sourceFrame: a, nextFrame: b, opticalFlow: nil, interpolationPhase: phases,
                submissionMode: frames == 1 ? .random : .sequential, destinationFrames: outs)
            else { fail("No parameters for the processor") }
            let done = DispatchSemaphore(value: 0)
            var failure: Error?
            processor.process(parameters: parameters) { _, error in failure = error; done.signal() }
            done.wait()
            if let failure { fail("Frame rate conversion failed: \(failure)") }
            for (i, pixels) in destinations.enumerated() {
                append(toCodec(pixels), at: before.time - base + span * Double(phases[i]))
                frames += 1
            }
            let progress = Int(((time - from) / (to - from)) * 100)
            if progress > shownProgress {
                shownProgress = progress
                say("{\"progress\":\(Double(min(progress, 100)) / 100)}")
            }
        }
        if time >= to - 1e-6 {
            after = time
            break frames
        }
        previous = current
    }
    if reader.status == .failed && after == nil {
        // A read that failed before `to`: the stretch ends with the last frame it has.
        FileHandle.standardError.write("The video could be read only to \(previous?.time ?? from) s: \(reader.error?.localizedDescription ?? "unknown")\n".data(using: .utf8)!)
    }
    if after == nil, let last = previous {
        // The video ends before `to`: its last frame closes the stretch.
        let base = first ?? last.time
        first = base
        append(toCodec(last.half), at: last.time - base)
        frames += 1
        after = last.time
    }
    reader.cancelReading()
    if let session = decoder { VTDecompressionSessionInvalidate(session) }
    processor.endSession()
    guard let start = first, let end = after else { fail("The video has no frames from \(from) s on") }

    input.markAsFinished()
    writer.finishWriting { semaphore.signal() }
    semaphore.wait()
    guard writer.status == .completed else { fail("The stretch cannot be written: \(writer.error.map { "\($0)" } ?? "unknown")") }
    say("{\"from\":\(start),\"to\":\(end),\"frames\":\(frames),\"undecodable\":\(undecodable)}")
}
