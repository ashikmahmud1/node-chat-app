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

  for (const [kind, setting, otherSetting, gain] of [
    ['incoming', 'incomingSounds', 'outgoingSounds', 0.45],
    ['outgoing', 'outgoingSounds', 'incomingSounds', 0.65],
  ]) {
    it('mutes ' + kind + ' ringing independently and restores its saved volume when enabled', async () => {
      const { sounds, sources } = setup({ incomingVolume: 45, outgoingVolume: 65 });
      await sounds.enable();
      sounds.setRinging(kind);
      assert.equal(sources[0].gain.value, gain);

      sounds.setPreferences({ ...sounds.preferences, [otherSetting]: false });
      assert.equal(sources[0].stoppedAt, undefined);
      sounds.setPreferences({ ...sounds.preferences, [setting]: false });
      assert.equal(sources[0].stoppedAt, 1.025);
      sounds.setRinging(null);
      sounds.setRinging(kind);
      assert.equal(sources.length, 1);

      sounds.setPreferences({ ...sounds.preferences, [setting]: true });
      assert.equal(sources[1].gain.value, gain);
      assert.equal(sounds.preferences.incomingVolume, 45);
      assert.equal(sounds.preferences.outgoingVolume, 65);
      sounds.setRinging(null);
      sounds.notifyMessage();
      assert.equal(sources.length, 3);
      assert.equal(sources[2].loop, false);
    });
  }

  it('previews each sound once at its selected volume when alerts are muted', async () => {
    const { sounds, sources } = setup();
    sounds.setPreferences({
      messages: false,
      incomingSounds: false,
      outgoingSounds: false,
      messageVolume: 25,
      incomingVolume: 70,
      outgoingVolume: 45,
    });

    for (const [index, [kind, tone, gain, duration]] of [
      ['message', 'chime', 0.25, 0.27],
      ['message', 'tap', 0.25, 0.195],
      ['message', 'ping', 0.25, 0.31],
      ['incoming', 'pulse', 0.7, 1.18],
      ['incoming', 'cascade', 0.7, 0.94],
      ['incoming', 'bell', 0.7, 1.09],
      ['outgoing', 'classic', 0.45, 1.18],
      ['outgoing', 'beep', 0.45, 0.55],
      ['outgoing', 'chord', 0.45, 0.76],
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
    const { sounds, sources } = setup({ ringtone: 'bell', ringback: 'chord', incomingVolume: 45, outgoingVolume: 65 });
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
    assert.equal(sources[4].gain.value, 0.45);
  });

  it('defaults missing or invalid tone choices and preserves saved mute and volume', async () => {
    const { sounds } = setup({ messages: false, messageVolume: 25, incomingVolume: 70, outgoingVolume: 45 });
    assert.equal(sounds.preferences.messageTone, 'chime');
    assert.equal(sounds.preferences.ringtone, 'pulse');
    assert.equal(sounds.preferences.ringback, 'classic');
    sounds.setPreferences({ ...sounds.preferences, messageTone: 'bell', ringtone: '__proto__', ringback: 'pulse' });
    assert.equal(sounds.preferences.messageTone, 'chime');
    assert.equal(sounds.preferences.ringtone, 'pulse');
    assert.equal(sounds.preferences.ringback, 'classic');
    assert.equal(sounds.preferences.messages, false);
    assert.equal(sounds.preferences.messageVolume, 25);
    assert.equal(sounds.preferences.incomingVolume, 70);
    assert.equal(sounds.preferences.outgoingVolume, 45);
    assert.equal(await sounds.preview('incoming', 'ping'), false);
    assert.equal(await sounds.preview('outgoing', 'bell'), false);
  });

  it('initializes both call directions from the previously saved call volume', () => {
    const { sounds } = setup({ callVolume: 35, ringtone: 'cascade', ringback: 'beep' });
    assert.equal(sounds.preferences.incomingVolume, 35);
    assert.equal(sounds.preferences.outgoingVolume, 35);
    assert.equal(sounds.preferences.ringtone, 'cascade');
    assert.equal(sounds.preferences.ringback, 'beep');
    assert.equal(Object.hasOwn(sounds.preferences, 'callVolume'), false);
    sounds.setPreferences({ callVolume: 0, outgoingVolume: 60 });
    assert.equal(sounds.preferences.incomingVolume, 0);
    assert.equal(sounds.preferences.outgoingVolume, 60);
  });

  it('initializes both mute switches from the previously saved call sounds setting', () => {
    const { sounds } = setup({ calls: false, incomingVolume: 45, outgoingVolume: 65 });
    assert.equal(sounds.preferences.incomingSounds, false);
    assert.equal(sounds.preferences.outgoingSounds, false);
    assert.equal(Object.hasOwn(sounds.preferences, 'calls'), false);
    assert.equal(sounds.preferences.incomingVolume, 45);
    assert.equal(sounds.preferences.outgoingVolume, 65);
    sounds.setPreferences({ calls: false, incomingSounds: true });
    assert.equal(sounds.preferences.incomingSounds, true);
    assert.equal(sounds.preferences.outgoingSounds, false);
  });

  it('resets every sound preference and cancels pending or playing previews', async () => {
    const { sounds, sources } = setup({
      messages: false,
      incomingSounds: false,
      outgoingSounds: false,
      messageVolume: 0,
      incomingVolume: 45,
      outgoingVolume: 65,
      messageTone: 'tap',
      ringtone: 'bell',
      ringback: 'chord',
    });
    const pending = sounds.preview('outgoing');
    sounds.resetPreferences();
    assert.equal(await pending, undefined);
    assert.equal(sources.length, 0);
    assert.deepEqual({ ...sounds.preferences }, {
      messages: true,
      incomingSounds: true,
      outgoingSounds: true,
      messageVolume: 100,
      incomingVolume: 100,
      outgoingVolume: 100,
      messageTone: 'chime',
      ringtone: 'pulse',
      ringback: 'classic',
    });

    await sounds.preview('incoming', 'bell');
    sounds.resetPreferences();
    assert.equal(sources[0].stoppedAt, 1.025);
    await sounds.preview('outgoing');
    assert.equal(sources[1].buffer.duration, 4);
    assert.equal(sources[1].gain.value, 1);
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
    sounds.setPreferences({ ...sounds.preferences, messageVolume: 40, incomingVolume: 45, outgoingVolume: 60 });
    sounds.notifyMessage();
    assert.equal(sources[0].gain.value, 0.4);
    sounds.setPreferences({ ...sounds.preferences, messageVolume: 50 });
    assert.equal(sources[0].gain.target, 0.5);

    sounds.setRinging('outgoing');
    assert.equal(sources[1].gain.value, 0.6);
    sounds.setPreferences({ ...sounds.preferences, messageVolume: 70, incomingVolume: 25 });
    assert.equal(sources[1].gain.target, undefined);
    sounds.setPreferences({ ...sounds.preferences, outgoingVolume: 35 });
    assert.equal(sources[1].gain.target, 0.35);
    sounds.setPreferences({ ...sounds.preferences, outgoingVolume: 0 });
    assert.equal(sources[1].stoppedAt, 1.025);
    sounds.setRinging(null);
    assert.equal(await sounds.preview('outgoing'), false);
    assert.equal(sources.length, 2);
    sounds.setRinging('incoming');
    assert.equal(sources[2].gain.value, 0.25);
  });

  it('adjusts a preview as its matching volume slider moves', async () => {
    const { sounds, sources } = setup({ incomingVolume: 30, outgoingVolume: 55 });
    await sounds.preview('incoming', 'cascade');
    sounds.setPreferences({ ...sounds.preferences, outgoingVolume: 40 });
    assert.equal(sources[0].gain.target, undefined);
    sounds.setPreferences({ ...sounds.preferences, incomingVolume: 20 });
    assert.equal(sources[0].gain.target, 0.2);
    sounds.setPreferences({ ...sounds.preferences, incomingVolume: 0 });
    assert.equal(sources[0].gain.target, 0);
    assert.equal(await sounds.preview('incoming'), false);
    assert.equal(await sounds.preview('outgoing'), true);
    assert.equal(sources[1].gain.value, 0.4);
  });
});
