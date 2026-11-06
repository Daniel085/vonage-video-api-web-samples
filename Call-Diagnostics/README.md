Vonage Video Call Diagnostics Sample
====================================

This sample application shows how to collect the data you need to debug a bad call: connection problems, packet loss, high latency, low frame rates and CPU pressure. It combines the quality signals the Vonage Video API exposes into one live panel next to the video, keeps a timestamped log of every quality-related SDK event, and can export everything as a JSON file to attach to a bug report.

It brings together what the [In-Call-Monitoring](../In-Call-Monitoring), [Client-Observability](../Client-Observability) and [Subscriber-Auto-Resolution](../Subscriber-Auto-Resolution) samples each show on their own, and adds the WebRTC-level numbers (jitter, round-trip time, quality limitation reason) that none of them read.

## Demo

[![Open in StackBlitz](https://developer.stackblitz.com/img/open_in_stackblitz.svg)](https://stackblitz.com/fork/github/Vonage/vonage-video-api-web-samples/tree/main/Call-Diagnostics)

Enter your credentials in `config.js` and the application will work.

> Note: There is a devDependency `sirv-cli` in the project that is only necessary to run the demo on StackBlitz.

## Running the App

*Important:* Read the following sections of the main README file for the repository to set up
and test the application:

* [Setting up the test web service](../README.md#setting-up-the-test-web-service)
* [Configuring the application](../README.md#configuring-the-application)
* [Testing the application](../README.md#testing-the-application)

Open the page in two browser tabs (or on two devices) so that each client subscribes to the other. The diagnostics panel on the right shows a card for the session, one for your publisher and one for every subscriber.

## What the panel shows

**Session card**

| Metric | Source |
| --- | --- |
| Connection state (connecting, connected, reconnecting, disconnected + reason) | `sessionConnected`, `sessionReconnecting`, `sessionReconnected`, `sessionDisconnected` events |
| Number of connections | `connectionCreated` / `connectionDestroyed` events |
| CPU performance state (`nominal`, `fair`, `serious`, `critical`) | `cpuPerformanceChanged` event (Chromium 125+ only) |

**Publisher and subscriber cards**

| Metric | Source |
| --- | --- |
| Video and audio bitrate | Difference in `bytesSent` / `bytesReceived` between two `getStats()` calls one second apart |
| Packet loss over the last second | Difference in `packetsLost` versus packets sent / received over the same interval |
| Frame rate | `video.layers[].encodedFrameRate` (publisher), `video.decodedFrameRate` (subscriber); WebRTC `framesPerSecond` as a fallback |
| Resolution | `video.layers[].width/height` (publisher); WebRTC `frameWidth/frameHeight` or the rendered video element (subscriber) |
| Round-trip time | WebRTC `candidate-pair.currentRoundTripTime` or `remote-inbound-rtp.roundTripTime` from `getRtcStatsReport()` |
| Jitter | WebRTC `inbound-rtp.jitter` / `remote-inbound-rtp.jitter` from `getRtcStatsReport()` |
| Network condition and reason | `mediaLink.transport` (publisher), `transport` (subscriber) in `getStats()` |
| Quality limitation (`cpu`, `bandwidth`, `other`, `none`) | `video.layers[].qualityLimitationReason` (publisher only). `cpu` is the clearest signal that the sending device, not the network, is the bottleneck. |
| MOS audio / video score | `qualityScoreChanged` event (subscriber only) |
| Video freezes | `video.freezeCount` and `video.totalFreezesDuration` (subscriber only) |
| Degradation source (`local`, `remote`, `bothOrUnclear`, `none`) | `networkDegradationSource` (subscriber only) |
| Video state | `videoDisableWarning`, `videoDisabled`, `videoEnabled` events (subscriber only) |

Each card also graphs bitrate and frame rate over the last few minutes, using the same graphing helper as the Subscriber-Auto-Resolution sample. Values are coloured green, amber or red against simple thresholds (for example packet loss above 2% is amber and above 5% is red). The thresholds live at the top of `js/app.js` in the `highIsBad()` / `lowIsBad()` calls and are easy to tune.

**Event log**

Every quality-related event the SDK dispatches is appended with a timestamp, so you can line up "video froze at 12:03" with what the SDK reported at that moment:

* Session: `sessionConnected`, `sessionReconnecting`, `sessionReconnected`, `sessionDisconnected`, `connectionCreated`, `connectionDestroyed`, `streamCreated`, `streamDestroyed`, `streamPropertyChanged`, `cpuPerformanceChanged`
* Publisher: `streamCreated`, `streamDestroyed`, `videoDimensionsChanged`, `videoQualityChanged`, `mediaStopped`, `accessDenied`, `accessAllowed`
* Subscriber: `videoDisableWarning`, `videoDisableWarningLifted`, `videoDisabled`, `videoEnabled`, `videoQualityChanged`, `audioBlocked`, `audioUnblocked`, `connected`, `disconnected`, `destroyed`
* SDK: `OT.on('exception', ...)` errors such as a bad token or a failed publish

## Reading the numbers

A few patterns that come up often:

* **Subscriber frame rate is low but the publisher's is fine, and packet loss is high on the subscriber card.** The network between you and the media server is dropping packets. Check "Network condition" and "Degradation source": `local` means your downlink, `remote` means the publisher's uplink.
* **Publisher "Quality limitation" shows `cpu`, or the session card's CPU state is `serious` or `critical`.** The sending device cannot encode at the requested resolution. The SDK will lower resolution and frame rate (you will see `videoDimensionsChanged` in the log). Closing other applications or publishing at a lower resolution helps.
* **Round-trip time above a few hundred milliseconds with low packet loss.** The path is long or congested. Audio will feel laggy before video looks bad.
* **`videoDisableWarning` followed by `videoDisabled (quality)`.** In a routed session the media server has stopped sending video to protect audio. `videoEnabled` fires when bandwidth recovers.
* **`sessionReconnecting`.** The signaling connection dropped. The SDK retries automatically; if it fails you get `sessionDisconnected` with reason `networkDisconnected`.

## Exporting a report

Click **Export JSON** to download a file containing the session ID, user agent, every one-second sample for every stream (the last 10 minutes), and the full event log. Attach this to a support ticket or bug report instead of asking users to describe what they saw.

```javascript
function exportDiagnostics() {
  const payload = { ...diagnostics, exportedAt: new Date().toISOString() };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `call-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
```

Tick **Verbose SDK logging** to call `OT.setLogLevel(OT.DEBUG)`, which prints signaling and ICE details to the browser console. This is useful when a connection never comes up at all.

## How the stats are collected

Once the session connects, a single `setInterval` polls every stream once a second. Each stream has a small monitor object whose `tick()` method awaits the stats, computes rates from the previous sample, updates the card and records a sample for the export.

### Publisher

`Publisher.getStats()` resolves with an array. In a routed session it has one entry; in a relayed session it has one entry per subscriber. The sample sums the byte and packet counters so the bitrate reflects everything the client sends, and reads codec, resolution, frame rate and the quality limitation reason from the largest simulcast layer:

```javascript
const statsArray = await publisher.getStats();
const first = statsArray[0].stats;
const layers = first.video.layers || [];
const topLayer = layers.reduce(
  (best, layer) => (!best || layer.width > best.width ? layer : best),
  null
);
const qualityLimitation = layers
  .map((layer) => layer.qualityLimitationReason)
  .find((reason) => reason && reason !== 'none') || 'none';
const networkCondition = first.mediaLink.transport.networkCondition;
```

`publishSenderStats: true` is set on the publisher so that subscribers on the other side also receive this publisher's bandwidth estimates in their own `getStats()` result.

### Subscriber

`Subscriber.getStats()` resolves with a single object:

```javascript
const stats = await subscriber.getStats();
const frameRate = stats.video.decodedFrameRate;
const freezeCount = stats.video.freezeCount;
const networkCondition = stats.transport.networkCondition;
const degradationSource = stats.networkDegradationSource;
```

### Jitter and round-trip time

The Vonage stats object does not include jitter or round-trip time, so the sample also calls `getRtcStatsReport()` and walks the standard WebRTC `RTCStatsReport`:

```javascript
const report = await subscriber.getRtcStatsReport();
report.forEach((stat) => {
  if (stat.type === 'candidate-pair' && stat.nominated && stat.state === 'succeeded') {
    rttMs = stat.currentRoundTripTime * 1000;
  }
  if (stat.type === 'inbound-rtp' && stat.kind === 'video') {
    jitterMs = stat.jitter * 1000;
  }
});
```

For the publisher, `getRtcStatsReport()` resolves with an array of `{ connectionId, subscriberId, rtcStatsReport }` objects, and the round-trip time and jitter come from the `remote-inbound-rtp` entry, which is what the far end reports back about our stream. The call is wrapped in `try/catch` because it rejects in browsers that do not support it and before the connection is established; the `getStats()` values are still shown in that case.

### Rates from cumulative counters

`bytesSent`, `bytesReceived`, `packetsLost` and friends are cumulative, so the sample keeps the previous result and computes the difference:

```javascript
const seconds = (sample.timestamp - previous.timestamp) / 1000;
const kbps = ((current.bytes - previous.bytes) * 8) / 1000 / seconds;
const deltaLost = current.lost - previous.lost;
const deltaPackets = current.packets - previous.packets;
const lossPct = (deltaLost / (deltaPackets + deltaLost)) * 100;
```

## Credits

Thanks to the [WebRTC team](https://github.com/webrtc) for the [graphing library](https://github.com/webrtc/samples/blob/gh-pages/src/js/third_party/graph.js) used in this application.
