import Foundation
import WebRTC

/// Every number that shapes the picture, in one place.
enum Tuning {
  // MARK: What a viewer gets when it doesn't say

  static let defaultMaxWidth = 1920
  /// The stream down the host's socket.
  static let defaultFps = 30
  /// The video track: the full rate while it is being carried, the reduced one while it is not
  /// (`FrameRate`, and its numbers below). A viewer that names a rate gets that one and no other.
  static let fullFps = 60
  static let reducedFps = 30
  static let fpsRange = 1...120

  /// High refresh is opt-in and bounded by both displays, not just a sender preference.
  static func fullRate(viewer: Int, display: Int) -> Int {
    let maximum = min(viewer, display)
    return maximum >= 120 ? 120 : maximum >= 60 ? 60 : max(1, min(30, maximum))
  }
  /// No picture is asked to be narrower than this, in pixels.
  static let narrowestPicture = 160

  // MARK: libwebrtc

  /// Read once, when the factory is made (`RTCInitFieldTrialDictionary`).
  ///
  /// ForceSendPlayoutDelay: the sender writes min 0 / max 0 into the playout-delay header
  /// extension, which tells the receiver to show each frame as soon as it is decoded instead of
  /// holding it in the jitter buffer for smoothness (rtp_sender_video.cc, M154). It is the only
  /// way to say so to a receiver without `jitterBufferTarget` (Safari, WKWebView).
  static let fieldTrials: [String: String] = [
    "WebRTC-ForceSendPlayoutDelay": "min_ms:0,max_ms:0",
    // M154 needs both: one exposes the send codec, the other creates the FEC-FR SSRC and
    // permits the sender. A receiver which drops flexfec-03 keeps the usual NACK/RTX path.
    "WebRTC-FlexFEC-03-Advertised": "Enabled",
    "WebRTC-FlexFEC-03": "Enabled",
  ]

  /// When the network or the encoder can't keep up, the picture gets smaller, not jerkier: a
  /// screen that is being controlled has to follow the hand. (libwebrtc's own choice for screen
  /// content is the opposite, maintain-resolution, which drops to a few frames a second.)
  static let degradation = RTCDegradationPreference.maintainFramerate

  /// The widest picture a viewer may ask for (`rtc.open`'s `maxWidth`): a 5K display's whole
  /// width at 60 frames is more than the encoder and a phone's decoder carry.
  static let widestPicture = 3840

  /// 8 Mbit/s for a 1920-wide picture at 30 frames, half as much again at 60. Above that the
  /// ceiling grows with the square root of the pixels, not in proportion: the more pixels a
  /// screen has, the more of them are the same as their neighbours. The bandwidth estimate
  /// decides what is actually sent; this is the ceiling.
  static func maxBitrate(width: Int, height: Int, fps: Int) -> Int {
    let pixels = Double(width * height) / Double(1920 * 1080)
    let frameFactor = fps > 60 ? 1.5 * Double(fps) / 60 : fps > 30 ? 1.5 : 1
    let rate = 8_000_000 * (pixels > 1 ? pixels.squareRoot() : pixels) * frameFactor
    return Int(min(max(rate, 2_000_000), 30_000_000))
  }

  /// Where the bandwidth estimate starts. libwebrtc's default (300 kbit/s) makes the first
  /// seconds of a screen unreadable; a home network carries this from the first frame.
  static let startBitrate = 2_000_000

  /// DSCP marking and the pacer's order, where a network honours it.
  static let networkPriority = RTCPriority.high

  // MARK: The video track's frame rate (`FrameRate`), judged once a second while connected

  /// At the start, and after a change of rate, nothing is concluded for this many seconds: the
  /// estimate, the encoder and libwebrtc's own adapting are still finding the new rate's level.
  static let frameRateSettle = 4

  /// The full rate is not being carried when one of these has gone on for this many seconds
  /// running. Shorter, and a moment's dip in the estimate would cost the rate; longer, and the
  /// viewer reads a blurred screen for no reason.
  static let frameRateDownAfter = 3

  /// The picture sent has been made smaller when it has less than this share of the captured
  /// picture's pixels. libwebrtc's first step leaves 4/9 of them (1920 wide becomes 1280); an
  /// encoder that crops a row to align the picture leaves all but a thousandth.
  static let frameRateShrunk = 0.9

  /// Frames are not making it out when the screen gives at least this share of the rate (so the
  /// rate is being asked for at all) and less than this share of what it gives is encoded.
  static let frameRateBusy = 0.8
  static let frameRateCarried = 0.75

  /// Back to the full rate after this many seconds running in which nothing limits the reduced
  /// one and the bandwidth estimate is at least `frameRateRoom` of the full rate's ceiling
  /// (`maxBitrate`). The wait doubles, up to the longest, each time the full rate is lost again
  /// within `frameRateHeld` seconds of being tried.
  ///
  /// 0.4 of the ceiling is 4.8 Mbit/s for a 1920-wide picture: the moving picture the tools show
  /// (`MotionWindow`) kept all its pixels at 60 frames on an estimate of 2 Mbit/s and lost them
  /// on 1.75, so it is more than twice what a busy screen needed.
  /// The full rate is not carried while the estimate is under this share of its ceiling: 3.2
  /// Mbit/s for a 2560-wide picture. A session starts at about 6 and climbs, so the start never
  /// counts; the moving picture at 1.5 Mbit/s does. Between this and `frameRateRoom` the rate in
  /// force stays.
  static let frameRateNarrow = 0.2

  static let frameRateCalm = 10
  static let frameRateCalmMax = 160
  static let frameRateHeld = 30
  static let frameRateRoom = 0.4


  /// For its first second the full rate may send this share of what the reduced rate was
  /// sending, and never less than this many bits a second (`ScreenSession.change`): twice the
  /// frames on half the bits are the bits there were.
  static let frameRateEase = 0.5
  static let frameRateEaseFloor = 1_000_000

  // MARK: Capture

  /// Surfaces ScreenCaptureKit may have out at once: one being encoded, one kept for repeating,
  /// and room for the next ones.
  static let captureQueueDepth = 5

  /// The capture is asked for a little more than the frame rate. Asked for exactly 60,
  /// ScreenCaptureKit delivered 55 a second from a 120 Hz display and 57.5 from a 144 Hz one
  /// (28.8 for 30); asked for 66 it delivers 62, and libwebrtc drops the two too many.
  static let captureRateSlack = 1.1

  /// ScreenCaptureKit is silent while the screen is still, and libwebrtc only answers a request
  /// for a key frame (or sharpens a picture it sent coarse) when a frame comes in. So the last
  /// picture is sent again: quickly for a moment after the screen stops changing, then slowly.
  static let settleRepeatInterval = 0.1
  static let settleWindow = 1.0
  static let idleRepeatInterval = 0.5

  // MARK: Pointer, input and numbers

  /// How often the pointer's place is looked at, and said when it changed.
  static let cursorRate = 60.0

  /// How often the pointer's picture is looked at: a change of shape a fifth of a second late
  /// is not noticed, and reading the picture is the dearer of the two.
  static let shapeRate = 5.0

  /// The longest message a viewer may send on a data channel: 4000 characters of text, with
  /// room for the way JSON writes them.
  static let maxEventBytes = 64_000

  static let statsInterval = 1.0

  // MARK: The stream down the host's socket

  /// A key frame is never asked for more often than this, in seconds, nor a stream slower than
  /// this, in bits a second: below them there is no picture to speak of.
  static let streamShortestGop = 0.2
  static let streamLowestBitrate = 50_000

  /// The part of a second's bits a key frame may take: 0.4 leaves the larger part to the frames
  /// that follow it. Of a still screen the key frame is all there is to send, and it may take 0.8.
  static let streamKeyShare = 0.4
  static let streamStillKeyShare = 0.8

  /// A picture the rate left coarse is sent again, a frame at a time, until its quantizer is
  /// this fine (text is crisp from about here) or this many seconds have gone by.
  static let streamFineQuantizer = 24
  static let streamRefineWindow = 1.5

  /// A frame goes when its time has come to within this (nanoseconds): a timer is never exact.
  static let streamPaceTolerance: Int64 = 1_000_000
  /// How soon to look again when the host or the encoder had no room (nanoseconds).
  static let streamRetryInterval: Int64 = 5_000_000

  /// With this many seconds of the stream written and not yet read by the host, no more frames
  /// are made: they would only be late. The socket's own buffer comes on top of it, and is kept
  /// small for that reason: what is in it can't be taken back.
  static let streamPipeSeconds = 0.5
  static let streamSocketBuffer = 64 * 1024
}
