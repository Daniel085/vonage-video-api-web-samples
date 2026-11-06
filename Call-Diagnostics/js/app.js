/* global OT APPLICATION_ID TOKEN SESSION_ID SAMPLE_SERVER_BASE_URL TimelineDataSeries TimelineGraphView */

let applicationId;
let sessionId;
let token;

// How often to poll getStats() / getRtcStatsReport() for every stream.
const POLL_INTERVAL_MS = 1000;
// Keep the last 10 minutes of one-second samples per stream for the JSON export.
const MAX_SAMPLES_PER_STREAM = 600;
// Keep the event log in the page from growing without bound.
const MAX_LOG_ENTRIES = 200;

const subscribersContainer = document.querySelector('#subscribers');
const streamCardsContainer = document.querySelector('#stream-cards');
const sessionCard = document.querySelector('#session-card');
const eventLogList = document.querySelector('#event-log');
const statusEl = document.querySelector('#status');
const exportBtn = document.querySelector('#export-btn');
const clearLogBtn = document.querySelector('#clear-log-btn');
const verboseLoggingCheckbox = document.querySelector('#verbose-logging');

// Everything collected during the call. "Export JSON" writes this object out.
const diagnostics = {
  startedAt: new Date().toISOString(),
  userAgent: navigator.userAgent,
  sessionId: null,
  cpuPerformanceState: 'unknown',
  publisher: null, // { streamId, samples: [] }
  subscribers: {}, // streamId -> { streamId, connectionId, samples: [] }
  events: []
};

// streamId (or 'publisher') -> monitor created by createStreamMonitor()
const monitors = {};
let connectedAt = null;
let connectionCount = 0;
let pollTimer = null;

// ---------------------------------------------------------------------------
// Formatting and threshold helpers
// ---------------------------------------------------------------------------

function isNumber(value) {
  return typeof value === 'number' && !Number.isNaN(value);
}

function fmt(value, digits = 0, suffix = '') {
  return isNumber(value) ? `${value.toFixed(digits)}${suffix}` : '–';
}

function shortId(id) {
  return id ? id.slice(0, 8) : '';
}

// Returns 'ok' | 'warn' | 'bad' for a value where higher is worse.
function highIsBad(value, warnAt, badAt) {
  if (!isNumber(value)) return '';
  if (value >= badAt) return 'bad';
  if (value >= warnAt) return 'warn';
  return 'ok';
}

// Returns 'ok' | 'warn' | 'bad' for a value where lower is worse.
function lowIsBad(value, warnBelow, badBelow) {
  if (!isNumber(value)) return '';
  if (value < badBelow) return 'bad';
  if (value < warnBelow) return 'warn';
  return 'ok';
}

function networkConditionLevel(condition) {
  switch (condition) {
    case 'excellent':
    case 'good':
      return 'ok';
    case 'fair':
    case 'warning':
      return 'warn';
    case 'critical':
      return 'bad';
    default:
      return '';
  }
}

function cpuStateLevel(state) {
  switch (state) {
    case 'nominal':
      return 'ok';
    case 'fair':
      return 'warn';
    case 'serious':
    case 'critical':
      return 'bad';
    default:
      return '';
  }
}

// MOS thresholds match the In-Call-Monitoring sample.
function mosLabel(score) {
  if (!isNumber(score)) return '–';
  let rating = 'Poor';
  if (score > 4.34) rating = 'Best';
  else if (score > 4.03) rating = 'High';
  else if (score > 3.6) rating = 'Medium';
  else if (score > 3.1) rating = 'Low';
  return `${score.toFixed(2)} (${rating})`;
}

function setMetric(card, metric, text, level = '') {
  const cell = card.querySelector(`[data-metric="${metric}"]`);
  if (!cell) return;
  cell.textContent = text;
  cell.className = level;
}

// ---------------------------------------------------------------------------
// Event log
// ---------------------------------------------------------------------------

function logEvent(source, name, detail = '', level = '') {
  const entry = { time: new Date().toISOString(), source, name, detail, level };
  diagnostics.events.push(entry);

  const item = document.createElement('li');
  item.className = level;
  const time = document.createElement('time');
  time.textContent = new Date(entry.time).toLocaleTimeString();
  const sourceEl = document.createElement('span');
  sourceEl.className = 'source';
  sourceEl.textContent = source;
  const nameEl = document.createElement('b');
  nameEl.textContent = name;
  const detailEl = document.createElement('span');
  detailEl.className = 'detail';
  detailEl.textContent = detail;
  item.append(time, ' ', sourceEl, ' ', nameEl, ' ', detailEl);
  eventLogList.prepend(item);

  while (eventLogList.children.length > MAX_LOG_ENTRIES) {
    eventLogList.lastChild.remove();
  }
}

// ---------------------------------------------------------------------------
// Reading stats
// ---------------------------------------------------------------------------

// Pulls the fields we care about out of a WebRTC RTCStatsReport. The Vonage
// getStats() result does not include jitter or round-trip time, so we read
// them from the raw report. Shapes differ a little between browsers, so every
// field is optional.
function parseRtcStatsReport(report, direction) {
  const result = {};
  let bestVideo = null;

  report.forEach((stat) => {
    if (stat.type === 'candidate-pair' && stat.nominated && stat.state === 'succeeded') {
      if (isNumber(stat.currentRoundTripTime)) {
        result.rttMs = stat.currentRoundTripTime * 1000;
      }
      if (isNumber(stat.availableOutgoingBitrate)) {
        result.availableOutgoingKbps = stat.availableOutgoingBitrate / 1000;
      }
    }

    if (direction === 'inbound' && stat.type === 'inbound-rtp' && stat.kind === 'video') {
      if (isNumber(stat.jitter)) result.jitterMs = stat.jitter * 1000;
      if (isNumber(stat.framesPerSecond)) result.frameRate = stat.framesPerSecond;
      if (isNumber(stat.frameWidth)) result.width = stat.frameWidth;
      if (isNumber(stat.frameHeight)) result.height = stat.frameHeight;
      if (isNumber(stat.framesDropped)) result.framesDropped = stat.framesDropped;
      if (isNumber(stat.freezeCount)) result.freezeCount = stat.freezeCount;
      if (isNumber(stat.totalFreezesDuration)) result.totalFreezesDuration = stat.totalFreezesDuration;
    }

    if (direction === 'outbound' && stat.type === 'outbound-rtp' && stat.kind === 'video') {
      // With simulcast there is one outbound-rtp entry per layer. Report the
      // largest active layer.
      if (stat.active !== false && (!bestVideo || (stat.frameWidth || 0) > (bestVideo.frameWidth || 0))) {
        bestVideo = stat;
      }
    }

    if (direction === 'outbound' && stat.type === 'remote-inbound-rtp' && stat.kind === 'video') {
      // What the far end reports back about our video.
      if (isNumber(stat.jitter)) result.jitterMs = stat.jitter * 1000;
      if (!isNumber(result.rttMs) && isNumber(stat.roundTripTime)) {
        result.rttMs = stat.roundTripTime * 1000;
      }
      if (isNumber(stat.fractionLost)) result.remoteFractionLost = stat.fractionLost;
    }
  });

  if (bestVideo) {
    if (isNumber(bestVideo.framesPerSecond)) result.frameRate = bestVideo.framesPerSecond;
    if (isNumber(bestVideo.frameWidth)) result.width = bestVideo.frameWidth;
    if (isNumber(bestVideo.frameHeight)) result.height = bestVideo.frameHeight;
    if (bestVideo.qualityLimitationReason) result.qualityLimitation = bestVideo.qualityLimitationReason;
    if (bestVideo.qualityLimitationDurations) {
      result.qualityLimitationDurations = { ...bestVideo.qualityLimitationDurations };
    }
  }

  return result;
}

// Publisher.getStats() resolves with an array: one entry in a routed session,
// one entry per subscriber in a relayed session. Counters are summed so the
// bitrate reflects everything this client is sending.
async function samplePublisher(publisher) {
  const statsArray = await publisher.getStats();
  if (!Array.isArray(statsArray) || statsArray.length === 0) return null;

  const counters = { audio: { bytes: 0, packets: 0, lost: 0 }, video: { bytes: 0, packets: 0, lost: 0 } };
  statsArray.forEach(({ stats }) => {
    ['audio', 'video'].forEach((kind) => {
      if (!stats || !stats[kind]) return;
      counters[kind].bytes += stats[kind].bytesSent || 0;
      counters[kind].packets += stats[kind].packetsSent || 0;
      counters[kind].lost += stats[kind].packetsLost || 0;
    });
  });

  const first = statsArray[0].stats || {};
  const video = first.video || {};
  const layers = Array.isArray(video.layers) ? video.layers : [];
  const topLayer = layers.reduce(
    (best, layer) => (!best || (layer.width || 0) > (best.width || 0) ? layer : best),
    null
  );
  const transport = first.mediaLink && first.mediaLink.transport;

  const sample = {
    timestamp: first.timestamp || Date.now(),
    counters,
    frameRate: topLayer ? topLayer.encodedFrameRate : video.frameRate,
    width: topLayer ? topLayer.width : undefined,
    height: topLayer ? topLayer.height : undefined,
    codec: topLayer ? topLayer.codec : undefined,
    layers: layers.length,
    // Any layer limited by CPU or bandwidth is worth knowing about.
    qualityLimitation: layers.map((layer) => layer.qualityLimitationReason).find((reason) => reason && reason !== 'none')
      || (layers.length ? 'none' : undefined),
    networkCondition: transport ? transport.networkCondition : undefined,
    networkConditionReason: transport ? transport.networkConditionReason : undefined,
    estimatedBandwidthKbps: transport && isNumber(transport.connectionEstimatedBandwidth)
      ? transport.connectionEstimatedBandwidth / 1000
      : undefined
  };

  try {
    const reports = await publisher.getRtcStatsReport();
    const report = Array.isArray(reports) ? reports[0] && reports[0].rtcStatsReport : reports;
    if (report) {
      const parsed = parseRtcStatsReport(report, 'outbound');
      // Prefer the SDK's values where it provides them; fill the gaps from WebRTC.
      Object.keys(parsed).forEach((key) => {
        if (sample[key] === undefined || sample[key] === null) sample[key] = parsed[key];
      });
    }
  } catch (error) {
    // getRtcStatsReport() rejects when the browser does not support it or the
    // connection is not up yet. The getStats() values above are still useful.
  }

  return sample;
}

// Subscriber.getStats() resolves with a single object.
async function sampleSubscriber(subscriber) {
  const stats = await subscriber.getStats();
  if (!stats) return null;

  const audio = stats.audio || {};
  const video = stats.video || {};
  const transport = stats.transport || {};
  const remoteTransport = stats.remotePublisherTransport || {};

  const sample = {
    timestamp: stats.timestamp || Date.now(),
    counters: {
      audio: { bytes: audio.bytesReceived || 0, packets: audio.packetsReceived || 0, lost: audio.packetsLost || 0 },
      video: { bytes: video.bytesReceived || 0, packets: video.packetsReceived || 0, lost: video.packetsLost || 0 }
    },
    frameRate: isNumber(video.decodedFrameRate) ? video.decodedFrameRate : video.frameRate,
    codec: video.codec,
    freezeCount: video.freezeCount,
    totalFreezesDuration: video.totalFreezesDuration,
    networkCondition: transport.networkCondition,
    networkConditionReason: transport.networkConditionReason,
    remoteNetworkCondition: remoteTransport.networkCondition,
    degradationSource: stats.networkDegradationSource,
    senderEstimatedBandwidthKbps: stats.senderStats && isNumber(stats.senderStats.connectionEstimatedBandwidth)
      ? stats.senderStats.connectionEstimatedBandwidth / 1000
      : undefined
  };

  try {
    const report = await subscriber.getRtcStatsReport();
    if (report) {
      const parsed = parseRtcStatsReport(report, 'inbound');
      Object.keys(parsed).forEach((key) => {
        if (sample[key] === undefined || sample[key] === null) sample[key] = parsed[key];
      });
    }
  } catch (error) {
    // See samplePublisher().
  }

  // Fall back to the rendered element for the resolution.
  if (!isNumber(sample.width)) {
    const videoElement = subscriber.videoElement && subscriber.videoElement();
    if (videoElement && videoElement.videoWidth) {
      sample.width = videoElement.videoWidth;
      sample.height = videoElement.videoHeight;
    }
  }

  return sample;
}

// Turns two consecutive cumulative samples into per-second rates.
function computeRates(sample, previous) {
  const rates = {};
  if (!previous) return rates;
  const seconds = (sample.timestamp - previous.timestamp) / 1000;
  if (seconds <= 0) return rates;

  ['audio', 'video'].forEach((kind) => {
    const current = sample.counters[kind];
    const old = previous.counters[kind];
    if (!current || !old) return;
    const deltaBytes = current.bytes - old.bytes;
    const deltaPackets = current.packets - old.packets;
    const deltaLost = Math.max(0, current.lost - old.lost);
    rates[kind] = {
      kbps: Math.max(0, (deltaBytes * 8) / 1000 / seconds),
      lossPct: deltaPackets + deltaLost > 0 ? (deltaLost / (deltaPackets + deltaLost)) * 100 : 0
    };
  });
  return rates;
}

// ---------------------------------------------------------------------------
// Stream cards (one per publisher / subscriber)
// ---------------------------------------------------------------------------

const COMMON_ROWS = [
  ['bitrate', 'Bitrate'],
  ['packetLoss', 'Packet loss (last second)'],
  ['frameRate', 'Frame rate'],
  ['resolution', 'Resolution'],
  ['rtt', 'Round-trip time'],
  ['jitter', 'Jitter'],
  ['networkCondition', 'Network condition'],
  ['codec', 'Video codec']
];

const PUBLISHER_ROWS = [
  ...COMMON_ROWS,
  ['qualityLimitation', 'Quality limitation'],
  ['layers', 'Simulcast layers'],
  ['bandwidth', 'Estimated bandwidth']
];

const SUBSCRIBER_ROWS = [
  ...COMMON_ROWS,
  ['mosAudio', 'Audio quality (MOS)'],
  ['mosVideo', 'Video quality (MOS)'],
  ['freezes', 'Video freezes'],
  ['degradationSource', 'Degradation source'],
  ['videoState', 'Video state']
];

function createStreamMonitor({ key, title, kind, target, record }) {
  const rows = kind === 'publisher' ? PUBLISHER_ROWS : SUBSCRIBER_ROWS;

  const card = document.createElement('section');
  card.className = `card stream-card ${kind}`;
  card.id = `card-${key}`;
  card.innerHTML = `
    <h2>${title}</h2>
    <table class="metrics">
      ${rows.map(([metric, label]) => `<tr><th>${label}</th><td data-metric="${metric}">–</td></tr>`).join('')}
    </table>
    <div class="graph-label"><span class="swatch video"></span>Video kbps <span class="swatch audio"></span>Audio kbps</div>
    <canvas id="bitrate-${key}" class="graph" width="340" height="80"></canvas>
    <div class="graph-label"><span class="swatch fps"></span>Frame rate (fps)</div>
    <canvas id="fps-${key}" class="graph" width="340" height="80"></canvas>
  `;
  streamCardsContainer.appendChild(card);

  const videoBitrateSeries = new TimelineDataSeries();
  videoBitrateSeries.setColor('#1f77b4');
  const audioBitrateSeries = new TimelineDataSeries();
  audioBitrateSeries.setColor('#2ca02c');
  const bitrateGraph = new TimelineGraphView(`card-${key}`, `bitrate-${key}`);
  bitrateGraph.updateEndDate();

  const fpsSeries = new TimelineDataSeries();
  fpsSeries.setColor('#d62728');
  const fpsGraph = new TimelineGraphView(`card-${key}`, `fps-${key}`);
  fpsGraph.updateEndDate();

  const state = {
    previous: null,
    mosAudio: undefined,
    mosVideo: undefined,
    videoState: 'enabled',
    videoStateLevel: 'ok',
    stopped: false
  };

  function setMos(scores) {
    state.mosAudio = scores.audioQualityScore;
    state.mosVideo = scores.videoQualityScore;
    setMetric(card, 'mosAudio', mosLabel(state.mosAudio), lowIsBad(state.mosAudio, 3.6, 3.1));
    setMetric(card, 'mosVideo', mosLabel(state.mosVideo), lowIsBad(state.mosVideo, 3.6, 3.1));
  }

  function setVideoState(text, level) {
    state.videoState = text;
    state.videoStateLevel = level;
    setMetric(card, 'videoState', text, level);
  }

  function render(sample, rates) {
    const video = rates.video;
    const audio = rates.audio;

    setMetric(
      card,
      'bitrate',
      video || audio ? `${fmt(video && video.kbps, 0)} kbps video / ${fmt(audio && audio.kbps, 0)} kbps audio` : 'measuring…'
    );
    const worstLoss = Math.max(video ? video.lossPct : 0, audio ? audio.lossPct : 0);
    setMetric(
      card,
      'packetLoss',
      video || audio ? `${fmt(video && video.lossPct, 1)}% video / ${fmt(audio && audio.lossPct, 1)}% audio` : 'measuring…',
      video || audio ? highIsBad(worstLoss, 2, 5) : ''
    );
    const hasVideo = (video && video.kbps > 0) || isNumber(sample.width);
    setMetric(card, 'frameRate', fmt(sample.frameRate, 0, ' fps'), hasVideo ? lowIsBad(sample.frameRate, 20, 10) : '');
    setMetric(
      card,
      'resolution',
      isNumber(sample.width) && isNumber(sample.height) ? `${sample.width} × ${sample.height}` : '–'
    );
    setMetric(card, 'rtt', fmt(sample.rttMs, 0, ' ms'), highIsBad(sample.rttMs, 150, 300));
    setMetric(card, 'jitter', fmt(sample.jitterMs, 1, ' ms'), highIsBad(sample.jitterMs, 30, 50));
    const conditionText = sample.networkCondition
      ? `${sample.networkCondition}${sample.networkConditionReason && sample.networkConditionReason !== 'none' ? ` (${sample.networkConditionReason})` : ''}`
      : '–';
    setMetric(card, 'networkCondition', conditionText, networkConditionLevel(sample.networkCondition));
    setMetric(card, 'codec', sample.codec || '–');

    if (kind === 'publisher') {
      const limitation = sample.qualityLimitation;
      setMetric(
        card,
        'qualityLimitation',
        limitation || '–',
        limitation === 'cpu' ? 'bad' : limitation === 'bandwidth' || limitation === 'other' ? 'warn' : limitation === 'none' ? 'ok' : ''
      );
      setMetric(card, 'layers', isNumber(sample.layers) ? String(sample.layers) : '–');
      const bandwidth = isNumber(sample.estimatedBandwidthKbps) ? sample.estimatedBandwidthKbps : sample.availableOutgoingKbps;
      setMetric(card, 'bandwidth', fmt(bandwidth, 0, ' kbps'));
    } else {
      const freezes = isNumber(sample.freezeCount)
        ? `${sample.freezeCount} (${fmt(sample.totalFreezesDuration, 1, ' s')} total)`
        : '–';
      setMetric(card, 'freezes', freezes, highIsBad(sample.freezeCount, 1, 5));
      const source = sample.degradationSource;
      setMetric(
        card,
        'degradationSource',
        source || '–',
        source === 'none' ? 'ok' : source ? 'warn' : ''
      );
    }

    // Graphs
    const now = sample.timestamp;
    if (video) videoBitrateSeries.addPoint(now, Math.round(video.kbps));
    if (audio) audioBitrateSeries.addPoint(now, Math.round(audio.kbps));
    bitrateGraph.setDataSeries([videoBitrateSeries, audioBitrateSeries]);
    bitrateGraph.updateEndDate(now);
    if (isNumber(sample.frameRate)) fpsSeries.addPoint(now, Math.round(sample.frameRate));
    fpsGraph.setDataSeries([fpsSeries]);
    fpsGraph.updateEndDate(now);
  }

  async function tick() {
    if (state.stopped) return;
    let sample;
    try {
      sample = kind === 'publisher' ? await samplePublisher(target) : await sampleSubscriber(target);
    } catch (error) {
      // Stats are not available until the stream is flowing; try again next tick.
      return;
    }
    if (!sample || state.stopped) return;

    const rates = computeRates(sample, state.previous);
    state.previous = sample;
    render(sample, rates);

    record.samples.push({
      time: new Date(sample.timestamp).toISOString(),
      videoKbps: rates.video ? Math.round(rates.video.kbps) : undefined,
      audioKbps: rates.audio ? Math.round(rates.audio.kbps) : undefined,
      videoLossPct: rates.video ? Number(rates.video.lossPct.toFixed(2)) : undefined,
      audioLossPct: rates.audio ? Number(rates.audio.lossPct.toFixed(2)) : undefined,
      frameRate: sample.frameRate,
      width: sample.width,
      height: sample.height,
      rttMs: isNumber(sample.rttMs) ? Math.round(sample.rttMs) : undefined,
      jitterMs: isNumber(sample.jitterMs) ? Number(sample.jitterMs.toFixed(1)) : undefined,
      codec: sample.codec,
      networkCondition: sample.networkCondition,
      networkConditionReason: sample.networkConditionReason,
      qualityLimitation: sample.qualityLimitation,
      freezeCount: sample.freezeCount,
      totalFreezesDuration: sample.totalFreezesDuration,
      degradationSource: sample.degradationSource,
      mosAudio: state.mosAudio,
      mosVideo: state.mosVideo,
      videoState: state.videoState,
      cpuPerformanceState: diagnostics.cpuPerformanceState
    });
    if (record.samples.length > MAX_SAMPLES_PER_STREAM) {
      record.samples.shift();
    }
  }

  function stop() {
    state.stopped = true;
    card.classList.add('ended');
    const heading = card.querySelector('h2');
    heading.textContent = `${heading.textContent} (ended)`;
  }

  return { tick, stop, setMos, setVideoState, card };
}

// ---------------------------------------------------------------------------
// Session-level UI
// ---------------------------------------------------------------------------

function updateStatus() {
  const subscriberCount = Object.keys(diagnostics.subscribers).filter((id) => monitors[id]).length;
  if (subscriberCount === 0) {
    statusEl.innerHTML = `No other participants yet. <a href="${window.location.href}" target="_blank">Open this page in a new tab</a> to join as a second client.`;
  } else {
    statusEl.textContent = '';
  }
}

function updateUptime() {
  if (!connectedAt) return;
  const seconds = Math.floor((Date.now() - connectedAt) / 1000);
  const minutes = Math.floor(seconds / 60);
  setMetric(sessionCard, 'uptime', `${minutes}:${String(seconds % 60).padStart(2, '0')}`);
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    updateUptime();
    Object.values(monitors).forEach((monitor) => monitor.tick());
  }, POLL_INTERVAL_MS);
}

function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
}

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

exportBtn.addEventListener('click', exportDiagnostics);

clearLogBtn.addEventListener('click', () => {
  diagnostics.events = [];
  eventLogList.innerHTML = '';
});

// The SDK is quiet by default. Turning on debug logging prints signaling and
// ICE details to the browser console, which helps when a connection never
// comes up at all.
verboseLoggingCheckbox.addEventListener('change', (event) => {
  OT.setLogLevel(event.target.checked ? OT.DEBUG : OT.WARN);
  logEvent('sdk', 'setLogLevel', event.target.checked ? 'DEBUG' : 'WARN');
});

// SDK-level errors (bad token, failed connect, unable to publish, ...)
OT.on('exception', (event) => {
  logEvent('sdk', `exception ${event.code}`, `${event.title}: ${event.message}`, 'bad');
});

// ---------------------------------------------------------------------------
// Session wiring
// ---------------------------------------------------------------------------

function watchSubscriber(subscriber, stream) {
  const key = stream.id;
  const source = `subscriber ${shortId(stream.id)}`;
  const record = { streamId: stream.id, connectionId: stream.connection && stream.connection.id, samples: [] };
  diagnostics.subscribers[stream.id] = record;

  const monitor = createStreamMonitor({
    key,
    title: `Subscriber ${shortId(stream.id)}`,
    kind: 'subscriber',
    target: subscriber,
    record
  });
  monitors[key] = monitor;
  monitor.setVideoState(stream.hasVideo ? 'enabled' : 'no video published', stream.hasVideo ? 'ok' : '');

  // MOS scores, 1 (bad) to 5 (excellent). Fires whenever the score changes.
  subscriber.on('qualityScoreChanged', (event) => {
    monitor.setMos(event.qualityScore || {});
  });

  // In a routed session the media server warns before it drops video to
  // protect audio, then tells us when it has done so and when it recovers.
  subscriber.on('videoDisableWarning', () => {
    monitor.setVideoState('at risk: video may be disabled', 'warn');
    logEvent(source, 'videoDisableWarning', 'bandwidth is low; video may be turned off', 'warn');
  });
  subscriber.on('videoDisableWarningLifted', () => {
    monitor.setVideoState('enabled', 'ok');
    logEvent(source, 'videoDisableWarningLifted', 'bandwidth recovered', 'ok');
  });
  subscriber.on('videoDisabled', (event) => {
    monitor.setVideoState(`disabled (${event.reason})`, event.reason === 'quality' ? 'bad' : 'warn');
    logEvent(source, 'videoDisabled', `reason: ${event.reason}`, event.reason === 'quality' ? 'bad' : 'warn');
  });
  subscriber.on('videoEnabled', (event) => {
    monitor.setVideoState('enabled', 'ok');
    logEvent(source, 'videoEnabled', `reason: ${event.reason}`, 'ok');
  });
  subscriber.on('videoQualityChanged', (event) => {
    logEvent(source, 'videoQualityChanged', `reason: ${event.reason}`, 'warn');
  });
  subscriber.on('audioBlocked', () => {
    logEvent(source, 'audioBlocked', 'browser autoplay policy blocked audio; needs a user gesture', 'warn');
  });
  subscriber.on('audioUnblocked', () => {
    logEvent(source, 'audioUnblocked', '', 'ok');
  });
  subscriber.on('disconnected', () => {
    logEvent(source, 'disconnected', 'stream connection lost; SDK is reconnecting', 'warn');
  });
  subscriber.on('connected', () => {
    logEvent(source, 'connected', 'stream connection restored', 'ok');
  });
  subscriber.on('destroyed', (event) => {
    logEvent(source, 'destroyed', `reason: ${event.reason}`);
  });

  updateStatus();
}

function watchPublisher(publisher) {
  const source = 'publisher';
  const record = { streamId: null, samples: [] };
  diagnostics.publisher = record;

  const monitor = createStreamMonitor({
    key: 'publisher',
    title: 'Publisher (you)',
    kind: 'publisher',
    target: publisher,
    record
  });
  monitors.publisher = monitor;

  publisher.on('streamCreated', (event) => {
    record.streamId = event.stream.id;
    logEvent(source, 'streamCreated', `stream ${shortId(event.stream.id)}`, 'ok');
  });
  publisher.on('streamDestroyed', (event) => {
    logEvent(source, 'streamDestroyed', `reason: ${event.reason}`, 'warn');
    monitor.stop();
  });
  // Fires when the SDK adapts the outgoing resolution, e.g. because of CPU or
  // bandwidth pressure, or when the camera orientation changes.
  publisher.on('videoDimensionsChanged', (event) => {
    logEvent(source, 'videoDimensionsChanged', `${event.oldValue.width}×${event.oldValue.height} → ${event.newValue.width}×${event.newValue.height}`);
  });
  publisher.on('videoQualityChanged', (event) => {
    logEvent(source, 'videoQualityChanged', `reason: ${event.reason}`, event.reason === 'cpu' || event.reason === 'bandwidth' ? 'warn' : '');
  });
  publisher.on('mediaStopped', () => {
    logEvent(source, 'mediaStopped', 'camera or microphone track ended', 'bad');
  });
  publisher.on('accessDenied', (event) => {
    logEvent(source, 'accessDenied', event && event.message ? event.message : 'camera/microphone permission denied', 'bad');
  });
  publisher.on('accessAllowed', () => {
    logEvent(source, 'accessAllowed', 'camera/microphone permission granted', 'ok');
  });
}

async function initializeSession() {
  const session = OT.initSession(applicationId, sessionId);
  diagnostics.sessionId = sessionId;
  setMetric(sessionCard, 'sessionId', shortId(sessionId) + '…');
  updateStatus();

  session.on({
    sessionConnected: (event) => {
      connectedAt = Date.now();
      // Count ourselves plus everyone already here; connectionCreated fires
      // for existing connections too, so start from zero here.
      connectionCount = 0;
      setMetric(sessionCard, 'connection', 'connected', 'ok');
      logEvent('session', 'sessionConnected', `connection ${shortId(event.target.connection.id)}`, 'ok');
      startPolling();
    },
    sessionReconnecting: () => {
      setMetric(sessionCard, 'connection', 'reconnecting…', 'warn');
      logEvent('session', 'sessionReconnecting', 'network dropped; SDK is trying to reconnect', 'warn');
    },
    sessionReconnected: () => {
      setMetric(sessionCard, 'connection', 'connected (reconnected)', 'ok');
      logEvent('session', 'sessionReconnected', '', 'ok');
    },
    sessionDisconnected: (event) => {
      setMetric(sessionCard, 'connection', `disconnected (${event.reason})`, 'bad');
      logEvent('session', 'sessionDisconnected', `reason: ${event.reason}`, 'bad');
      stopPolling();
      Object.values(monitors).forEach((monitor) => monitor.stop());
    },
    connectionCreated: (event) => {
      connectionCount += 1;
      setMetric(sessionCard, 'connections', String(connectionCount));
      logEvent('session', 'connectionCreated', shortId(event.connection.id));
    },
    connectionDestroyed: (event) => {
      connectionCount = Math.max(0, connectionCount - 1);
      setMetric(sessionCard, 'connections', String(connectionCount));
      logEvent('session', 'connectionDestroyed', `${shortId(event.connection.id)} (${event.reason})`);
    },
    // Chromium only (Chrome/Edge/Opera 125+). Values: nominal, fair, serious, critical.
    cpuPerformanceChanged: (event) => {
      diagnostics.cpuPerformanceState = event.cpuPerformanceState;
      const level = cpuStateLevel(event.cpuPerformanceState);
      setMetric(sessionCard, 'cpu', event.cpuPerformanceState, level);
      logEvent('session', 'cpuPerformanceChanged', event.cpuPerformanceState, level);
    },
    streamPropertyChanged: (event) => {
      const describe = (value) => (typeof value === 'object' ? JSON.stringify(value) : String(value));
      logEvent(
        `stream ${shortId(event.stream.id)}`,
        'streamPropertyChanged',
        `${event.changedProperty}: ${describe(event.oldValue)} → ${describe(event.newValue)}`
      );
    },
    streamCreated: async (event) => {
      logEvent('session', 'streamCreated', `stream ${shortId(event.stream.id)}`);
      const subscriberDiv = document.createElement('div');
      subscriberDiv.id = `subscriber-${event.stream.id}`;
      subscriberDiv.className = 'subscriber';
      const label = document.createElement('label');
      label.className = 'subscriber-id-label';
      label.textContent = `Subscriber ${shortId(event.stream.id)}`;
      subscriberDiv.appendChild(label);
      subscribersContainer.appendChild(subscriberDiv);

      const subscriberOptions = {
        insertMode: 'append',
        width: '100%',
        height: '100%'
      };
      try {
        const subscriber = await session.subscribe.promise(event.stream, subscriberDiv.id, subscriberOptions);
        watchSubscriber(subscriber, event.stream);
      } catch (error) {
        logEvent('session', 'subscribe failed', error.message, 'bad');
        console.error(error);
      }
    },
    streamDestroyed: (event) => {
      logEvent('session', 'streamDestroyed', `stream ${shortId(event.stream.id)} (${event.reason})`);
      if (monitors[event.stream.id]) {
        monitors[event.stream.id].stop();
        delete monitors[event.stream.id];
      }
      const subscriberDiv = document.getElementById(`subscriber-${event.stream.id}`);
      if (subscriberDiv) subscriberDiv.remove();
      updateStatus();
    }
  });

  try {
    const publisherOptions = {
      insertMode: 'append',
      width: '100%',
      height: '100%',
      resolution: '1280x720',
      // Lets subscribers see this publisher's bandwidth estimates in getStats().
      publishSenderStats: true
    };
    const publisher = await OT.initPublisher.promise('publisher', publisherOptions);
    watchPublisher(publisher);

    setMetric(sessionCard, 'connection', 'connecting…', 'warn');
    await session.connect.promise(token);
    await session.publish.promise(publisher);
  } catch (error) {
    logEvent('session', 'setup failed', `${error.name || 'Error'}: ${error.message}`, 'bad');
    setMetric(sessionCard, 'connection', 'failed', 'bad');
    console.error(error);
  }
}

// See the config.js file.
if (APPLICATION_ID && TOKEN && SESSION_ID) {
  applicationId = APPLICATION_ID;
  sessionId = SESSION_ID;
  token = TOKEN;
  initializeSession();
} else if (SAMPLE_SERVER_BASE_URL) {
  // Make a GET request to get the Vonage Video Application ID, session ID, and token from the server
  fetch(SAMPLE_SERVER_BASE_URL + '/session')
    .then((response) => response.json())
    .then((json) => {
      applicationId = json.applicationId;
      sessionId = json.sessionId;
      token = json.token;
      // Initialize a Vonage Video Session object
      initializeSession();
    })
    .catch((error) => {
      console.error(error);
      alert('Failed to get Vonage Video sessionId and token. Make sure you have updated the config.js file.');
    });
}
