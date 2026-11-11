'use strict';

// Durations include the quiet space between repeats. Levels leave room for
// simultaneous notes without making alerts compete with speech.
const CHAT_SOUND_PATTERNS = {
  message: {
    chime: {
      label: 'Chime',
      duration: 0.28,
      notes: [
        { at: 0, length: 0.17, pitch: 659.25, level: 0.12 },
        { at: 0.08, length: 0.19, pitch: 987.77, level: 0.09 },
      ],
    },
    tap: {
      label: 'Soft Tap',
      duration: 0.2,
      notes: [
        { at: 0, length: 0.085, pitch: 466.16, level: 0.16 },
        { at: 0.095, length: 0.1, pitch: 587.33, level: 0.11 },
      ],
    },
    ping: {
      label: 'Bright Ping',
      duration: 0.32,
      notes: [
        { at: 0, length: 0.31, pitch: 1046.5, level: 0.115 },
        { at: 0.015, length: 0.13, pitch: 1567.98, level: 0.039 },
      ],
    },
  },
  incoming: {
    pulse: {
      label: 'Pulse',
      duration: 3.2,
      notes: [
        { at: 0, length: 0.29, pitch: 523.25, level: 0.17 },
        { at: 0.17, length: 0.34, pitch: 783.99, level: 0.13 },
        { at: 0.67, length: 0.29, pitch: 523.25, level: 0.17 },
        { at: 0.84, length: 0.34, pitch: 783.99, level: 0.13 },
      ],
    },
    cascade: {
      label: 'Cascade',
      duration: 3.4,
      notes: [
        { at: 0, length: 0.25, pitch: 880, level: 0.13 },
        { at: 0.18, length: 0.25, pitch: 739.99, level: 0.13 },
        { at: 0.36, length: 0.25, pitch: 659.25, level: 0.14 },
        { at: 0.54, length: 0.4, pitch: 440, level: 0.15 },
      ],
    },
    bell: {
      label: 'Double Bell',
      duration: 3.6,
      notes: [
        { at: 0, length: 0.51, pitch: 392, level: 0.12 },
        { at: 0.01, length: 0.37, pitch: 587.33, level: 0.065 },
        { at: 0.58, length: 0.51, pitch: 392, level: 0.12 },
        { at: 0.59, length: 0.37, pitch: 587.33, level: 0.065 },
      ],
    },
  },
  outgoing: {
    classic: {
      label: 'Classic',
      duration: 4,
      notes: [
        { at: 0, length: 0.47, pitch: 350, level: 0.075 },
        { at: 0, length: 0.47, pitch: 440, level: 0.07 },
        { at: 0.71, length: 0.47, pitch: 350, level: 0.075 },
        { at: 0.71, length: 0.47, pitch: 440, level: 0.07 },
      ],
    },
    beep: {
      label: 'Soft Beep',
      duration: 3,
      notes: [
        { at: 0, length: 0.55, pitch: 480, level: 0.12 },
      ],
    },
    chord: {
      label: 'Warm Chord',
      duration: 4.2,
      notes: [
        { at: 0, length: 0.27, pitch: 392, level: 0.083 },
        { at: 0, length: 0.27, pitch: 493.88, level: 0.062 },
        { at: 0.34, length: 0.42, pitch: 329.63, level: 0.083 },
        { at: 0.34, length: 0.42, pitch: 440, level: 0.062 },
      ],
    },
  },
};

const CHAT_MESSAGE_SOUND_INTERVAL = 1400;

function normalizeSoundPreferences(preferences) {
  const volume = (value) => Number.isFinite(value) ? Math.min(100, Math.max(0, Math.round(value))) : 100;
  const tone = (kind, value, defaultTone) => (
    typeof value === 'string' && Object.hasOwn(CHAT_SOUND_PATTERNS[kind], value) ? value : defaultTone
  );
  return {
    messages: preferences?.messages !== false,
    calls: preferences?.calls !== false,
    messageVolume: volume(preferences?.messageVolume),
    callVolume: volume(preferences?.callVolume),
    messageTone: tone('message', preferences?.messageTone, 'chime'),
    ringtone: tone('incoming', preferences?.ringtone, 'pulse'),
    ringback: tone('outgoing', preferences?.ringback, 'classic'),
  };
}

class ChatSounds {
  constructor(preferences) {
    this.preferences = normalizeSoundPreferences(preferences);
    this.context = null;
    this.buffers = new Map();
    this.lastMessageAt = -Infinity;
    this.quiet = false;
    this.ring = null;
    this.messagePlayback = null;
    this.ringPlayback = null;
    this.previewPlayback = null;
    this.previewRequest = null;
  }

  enable() {
    if (!this.context) {
      if (typeof AudioContext === 'undefined') return Promise.resolve(false);
      this.context = new AudioContext();
      this.context.addEventListener('statechange', () => this.syncRing());
    }
    if (this.context.state === 'running') {
      this.syncRing();
      return Promise.resolve(true);
    }
    // Browsers may defer playback until this tab receives a trusted gesture.
    return this.context.resume().then(() => {
      this.syncRing();
      return this.context.state === 'running';
    }, () => false);
  }

  setPreferences(updated) {
    const previous = this.preferences;
    const preferences = normalizeSoundPreferences(updated);
    this.preferences = preferences;
    if (!preferences.messages || preferences.messageVolume === 0) this.stopMessage();
    this.syncRing();
    for (const playback of [this.messagePlayback, this.ringPlayback, this.previewPlayback]) {
      if (!playback) continue;
      const setting = playback.kind === 'message' ? 'messageVolume' : 'callVolume';
      if (preferences[setting] !== previous[setting]) {
        playback.gain.gain.setTargetAtTime(this.volumeFor(playback.kind), this.context.currentTime, 0.015);
      }
    }
  }

  volumeFor(kind) {
    return (kind === 'message' ? this.preferences.messageVolume : this.preferences.callVolume) / 100;
  }

  selectedTone(kind) {
    if (kind === 'message') return this.preferences.messageTone;
    if (kind === 'incoming') return this.preferences.ringtone;
    return this.preferences.ringback;
  }

  async preview(kind, tone = this.selectedTone(kind)) {
    this.stopPreview();
    if (!Object.hasOwn(CHAT_SOUND_PATTERNS, kind) || !Object.hasOwn(CHAT_SOUND_PATTERNS[kind], tone) ||
        this.ring || !this.volumeFor(kind)) return false;
    const request = {};
    this.previewRequest = request;
    const enabled = await this.enable();
    if (this.previewRequest !== request) return;
    this.previewRequest = null;
    if (!enabled || !this.volumeFor(kind)) return false;
    this.stopMessage();
    this.start(kind, 'previewPlayback', tone);
    return true;
  }

  stopPreview() {
    this.previewRequest = null;
    this.stop('previewPlayback');
  }

  setQuiet(quiet) {
    this.quiet = quiet;
    if (quiet) this.stopMessage();
    this.syncRing();
  }

  notifyMessage() {
    const now = performance.now();
    if (this.quiet || this.ring || !this.preferences.messages || !this.volumeFor('message') || this.context?.state !== 'running' ||
        now - this.lastMessageAt < CHAT_MESSAGE_SOUND_INTERVAL) return;
    this.lastMessageAt = now;
    this.stopPreview();
    this.start('message', 'messagePlayback');
  }

  setRinging(kind) {
    if (kind !== this.ring) this.stop('ringPlayback');
    this.ring = kind;
    if (kind) {
      this.stopMessage();
      this.stopPreview();
    }
    this.syncRing();
  }

  stopMessage() {
    this.stop('messagePlayback');
  }

  syncRing() {
    if (!this.ring || !this.preferences.calls || !this.volumeFor(this.ring) || (this.quiet && this.ring === 'incoming')) {
      this.stop('ringPlayback');
      return;
    }
    const tone = this.selectedTone(this.ring);
    if (this.ringPlayback?.tone !== tone) this.stop('ringPlayback');
    if (!this.ringPlayback && this.context?.state === 'running') this.start(this.ring, 'ringPlayback', tone);
  }

  start(kind, slot, tone = this.selectedTone(kind)) {
    const { context } = this;
    const pattern = CHAT_SOUND_PATTERNS[kind][tone];
    const source = context.createBufferSource();
    const gain = context.createGain();
    source.buffer = this.getBuffer(pattern);
    source.loop = slot === 'ringPlayback';
    gain.gain.value = this.volumeFor(kind);
    source.connect(gain);
    gain.connect(context.destination);
    const playback = { source, gain, kind, tone };
    this[slot] = playback;
    source.onended = () => {
      if (this[slot] === playback) this[slot] = null;
      source.disconnect();
      gain.disconnect();
    };
    if (slot === 'previewPlayback') {
      const duration = Math.max(...pattern.notes.map(({ at, length }) => at + length));
      source.start(0, 0, duration);
    } else {
      source.start();
    }
  }

  stop(slot) {
    const playback = this[slot];
    if (!playback) return;
    this[slot] = null;
    const { source, gain } = playback;
    const { currentTime, state } = this.context;
    if (state === 'running') {
      gain.gain.setTargetAtTime(0, currentTime, 0.005);
      source.stop(currentTime + 0.025);
    } else {
      gain.disconnect();
      source.stop();
    }
  }

  getBuffer(pattern) {
    if (this.buffers.has(pattern)) return this.buffers.get(pattern);
    const { duration, notes } = pattern;
    const { context } = this;
    const rate = context.sampleRate;
    const buffer = context.createBuffer(1, Math.ceil(duration * rate), rate);
    const samples = buffer.getChannelData(0);
    for (const { at, length, pitch, level } of notes) {
      const start = Math.round(at * rate);
      const frames = Math.floor(length * rate);
      for (let index = 0; index < frames; index += 1) {
        const time = index / rate;
        const attack = Math.min(1, time / 0.025);
        const release = Math.min(1, (length - time) / 0.09);
        const envelope = (1 - Math.cos(Math.PI * Math.min(attack, release))) / 2;
        const angle = 2 * Math.PI * pitch * time;
        samples[start + index] += level * envelope * (Math.sin(angle) + 0.14 * Math.sin(2 * angle));
      }
    }
    this.buffers.set(pattern, buffer);
    return buffer;
  }
}
