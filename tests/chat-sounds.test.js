const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');

const source = readFileSync(join(__dirname, '../public/js/chat-sounds.js'), 'utf8');

function setup(preferences) {
  let now = 0;
  const sources = [];
  const AudioContext = class extends EventTarget {
    state = 'suspended';
    sampleRate = 48000;
    currentTime = 1;
    destination = {};

    async resume() {
      this.state = 'running';
      this.dispatchEvent(new Event('statechange'));
    }

    createBuffer(channels, frames, rate) {
      const samples = new Float32Array(frames);
      return { duration: frames / rate, getChannelData: () => samples };
    }

    createBufferSource() {
      const playback = {
        connect(gain) { this.gain = gain.gain; },
        disconnect() {},
        start(...args) { this.startArgs = args; sources.push(this); },
        stop(at) { this.stoppedAt = at; this.onended(); },
      };
      return playback;
    }

    createGain() {
      return {
        gain: { setTargetAtTime(value) { this.target = value; } },
        connect() {},
        disconnect() {},
      };
    }
  };

  const ChatSounds = runInNewContext(source + '\nChatSounds;', {
    AudioContext,
    performance: { now: () => now },
  });
  return {
    sounds: new ChatSounds(preferences),
    sources,
    advance: (milliseconds) => { now += milliseconds; },
  };
}

describe('Chat sound alerts', () => {
  it('starts the current ringtone after browser activation and stops it on dismissal', () => {
    const { sounds, sources } = setup();
    sounds.setRinging('incoming');
    assert.equal(sources.length, 0);

    sounds.enable();
    assert.equal(sources.length, 1);
    assert.equal(sources[0].loop, true);
    assert.equal(sources[0].buffer.duration, 3.2);

    sounds.setRinging(null);
    assert.equal(sources[0].stoppedAt, 1.025);
    sounds.enable();
    assert.equal(sources.length, 1);
  });

  it('does not play a stale invite after it ends while audio is locked', () => {
    const { sounds, sources } = setup();
    sounds.setRinging('incoming');
    sounds.setRinging(null);
    sounds.enable();
    assert.equal(sources.length, 0);
  });

  it('limits message bursts and keeps chat alerts quiet during calls and Do Not Disturb', () => {
    const { sounds, sources, advance } = setup();
    sounds.enable();
    sounds.notifyMessage();
    sounds.notifyMessage();
    assert.equal(sources.length, 1);
    assert.equal(sources[0].loop, false);

    sounds.setRinging('outgoing');
    assert.equal(sources[0].stoppedAt, 1.025);
    assert.equal(sources[1].buffer.duration, 4);
    advance(2000);
    sounds.notifyMessage();
    assert.equal(sources.length, 2);

    sounds.setRinging(null);
    sounds.setQuiet(true);
    sounds.notifyMessage();
    sounds.setRinging('incoming');
    assert.equal(sources.length, 2);
  });

  it('stops a ringing call when call sounds are disabled and preserves the message setting', () => {
    const { sounds, sources } = setup();
    sounds.enable();
    sounds.setRinging('incoming');
    sounds.setPreferences({ ...sounds.preferences, calls: false });
    assert.equal(sources[0].stoppedAt, 1.025);

    sounds.setRinging(null);
    sounds.notifyMessage();
    assert.equal(sources.length, 2);
    assert.equal(sources[1].loop, false);
  });

  it('previews each sound once at its selected volume when alerts are muted', async () => {
    const { sounds, sources } = setup();
    sounds.setPreferences({ messages: false, calls: false, messageVolume: 25, callVolume: 70 });

    for (const [index, [kind, tone, gain, duration]] of [
      ['message', 'chime', 0.25, 0.27],
      ['message', 'tap', 0.25, 0.195],
      ['message', 'ping', 0.25, 0.31],
      ['incoming', 'pulse', 0.7, 1.18],
      ['incoming', 'cascade', 0.7, 0.94],
      ['incoming', 'bell', 0.7, 1.09],
      ['outgoing', 'classic', 0.7, 1.18],
      ['outgoing', 'beep', 0.7, 0.55],
      ['outgoing', 'chord', 0.7, 0.76],
    ].entries()) {
      assert.equal(await sounds.preview(kind, tone), true);
      const playback = sources[index];
      assert.equal(playback.loop, false);
      assert.equal(playback.gain.value, gain);
      assert.ok(Math.abs(playback.startArgs[2] - duration) < 0.001);
      if (index > 0) assert.equal(sources[index - 1].stoppedAt, 1.025);
    }
    assert.equal(new Set(sources.map(({ buffer }) => buffer)).size, sources.length);
    assert.equal(sounds.preferences.messageTone, 'chime');
    assert.equal(sounds.preferences.ringtone, 'pulse');
    assert.equal(sounds.preferences.ringback, 'classic');
  });

  it('uses the saved message tone and ringtone independently for real alerts', async () => {
    const { sounds, sources } = setup({ messageTone: 'ping', ringtone: 'bell' });
    await sounds.preview('message', 'ping');
    await sounds.preview('incoming', 'bell');

    sounds.notifyMessage();
    assert.equal(sources[2].buffer, sources[0].buffer);
    assert.equal(sources[2].loop, false);
    sounds.setRinging('incoming');
    assert.equal(sources[3].buffer, sources[1].buffer);
    assert.equal(sources[3].loop, true);

    sounds.setPreferences({ ...sounds.preferences, messageTone: 'tap' });
    assert.equal(sources.length, 4);
    sounds.setPreferences({ ...sounds.preferences, ringtone: 'cascade' });
    assert.equal(sources[3].stoppedAt, 1.025);
    assert.ok(Math.abs(sources[4].buffer.duration - 3.4) < 0.001);
    assert.equal(sources[4].loop, true);

    sounds.setRinging('outgoing');
    assert.equal(sources[5].buffer.duration, 4);
  });

  it('uses the saved ringback for outgoing calls independently of the incoming ringtone', async () => {
    const { sounds, sources } = setup({ ringtone: 'bell', ringback: 'chord', callVolume: 65 });
    await sounds.preview('outgoing', 'chord');
    await sounds.preview('incoming', 'bell');
    sounds.setRinging('outgoing');
    assert.equal(sources[2].buffer, sources[0].buffer);
    assert.equal(sources[2].gain.value, 0.65);
    assert.equal(sources[2].loop, true);

    sounds.setPreferences({ ...sounds.preferences, ringtone: 'cascade' });
    assert.equal(sources.length, 3);
    sounds.setPreferences({ ...sounds.preferences, ringback: 'beep' });
    assert.equal(sources[2].stoppedAt, 1.025);
    assert.equal(sources[3].buffer.duration, 3);
    assert.equal(sources[3].loop, true);

    sounds.setRinging('incoming');
    assert.equal(sources[3].stoppedAt, 1.025);
    assert.ok(Math.abs(sources[4].buffer.duration - 3.4) < 0.001);
    assert.equal(sources[4].loop, true);
  });

  it('defaults missing or invalid tone choices and preserves saved mute and volume', async () => {
    const { sounds } = setup({ messages: false, messageVolume: 25, callVolume: 70 });
    assert.equal(sounds.preferences.messageTone, 'chime');
    assert.equal(sounds.preferences.ringtone, 'pulse');
    assert.equal(sounds.preferences.ringback, 'classic');
    sounds.setPreferences({ ...sounds.preferences, messageTone: 'bell', ringtone: '__proto__', ringback: 'pulse' });
    assert.equal(sounds.preferences.messageTone, 'chime');
    assert.equal(sounds.preferences.ringtone, 'pulse');
    assert.equal(sounds.preferences.ringback, 'classic');
    assert.equal(sounds.preferences.messages, false);
    assert.equal(sounds.preferences.messageVolume, 25);
    assert.equal(sounds.preferences.callVolume, 70);
    assert.equal(await sounds.preview('incoming', 'ping'), false);
    assert.equal(await sounds.preview('outgoing', 'bell'), false);
  });

  it('gives real calls priority over active and pending previews', async () => {
    const { sounds, sources } = setup();
    await sounds.preview('outgoing');
    sounds.setRinging('incoming');
    assert.equal(sources[0].stoppedAt, 1.025);
    assert.equal(sources[1].loop, true);
    assert.equal(await sounds.preview('message'), false);

    sounds.setRinging(null);
    const pending = sounds.preview('outgoing');
    sounds.setRinging('incoming');
    assert.equal(await pending, undefined);
    assert.equal(sources.length, 3);
    assert.equal(sources[2].loop, true);
  });

  it('applies volume changes only to the relevant sound and stops ringing at zero', async () => {
    const { sounds, sources } = setup();
    await sounds.enable();
    sounds.setPreferences({ ...sounds.preferences, messageVolume: 40, callVolume: 60 });
    sounds.notifyMessage();
    assert.equal(sources[0].gain.value, 0.4);
    sounds.setPreferences({ ...sounds.preferences, messageVolume: 50 });
    assert.equal(sources[0].gain.target, 0.5);

    sounds.setRinging('outgoing');
    assert.equal(sources[1].gain.value, 0.6);
    sounds.setPreferences({ ...sounds.preferences, messageVolume: 70 });
    assert.equal(sources[1].gain.target, undefined);
    sounds.setPreferences({ ...sounds.preferences, callVolume: 35 });
    assert.equal(sources[1].gain.target, 0.35);
    sounds.setPreferences({ ...sounds.preferences, callVolume: 0 });
    assert.equal(sources[1].stoppedAt, 1.025);
    sounds.setRinging(null);
    assert.equal(await sounds.preview('outgoing'), false);
    assert.equal(sources.length, 2);
  });
});
