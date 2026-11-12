const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');

const source = readFileSync(join(__dirname, '../public/js/call-presentation.js'), 'utf8');

function fixture(getDisplayMedia, setSharing = async () => {}) {
  const Presentation = runInNewContext(source + '\nCallPresentation', { navigator: { mediaDevices: { getDisplayMedia } } });
  const replacements = [];
  const announced = [];
  const changes = [];
  const errors = [];
  const share = new Presentation(
    { replaceTrack: async (track) => replacements.push(track) },
    async (sharing) => {
      announced.push(sharing);
      await setSharing(sharing);
    },
    (stream, pending) => changes.push({ stream, pending }),
    (error) => errors.push(error),
  );
  return { share, replacements, announced, changes, errors };
}

function capture() {
  const track = new EventTarget();
  track.readyState = 'live';
  track.stop = () => { track.readyState = 'ended'; };
  return { track, getVideoTracks: () => [track], getTracks: () => [track] };
}

describe('Call presentation lifecycle', () => {
  it('unpublishes when the browser ends sharing and can share again', async () => {
    const first = capture();
    const second = capture();
    const picker = [first, second];
    const { share, replacements, announced, errors } = fixture(async () => picker.shift());

    await share.toggle();
    first.track.stop();
    first.track.dispatchEvent(new Event('ended'));
    await new Promise(setImmediate);
    assert.equal(share.stream, null);
    assert.deepEqual(replacements, [first.track, null]);
    assert.deepEqual(announced, [true, false]);
    await share.toggle();
    assert.equal(share.stream, second);
    await share.toggle();
    assert.equal(second.track.readyState, 'ended');
    assert.deepEqual(announced, [true, false, true, false]);
    assert.deepEqual(errors, []);
  });

  it('stops capture returned after the call closed without publishing it', async () => {
    const pending = Promise.withResolvers();
    const stream = capture();
    const { share, replacements, announced, changes } = fixture(() => pending.promise);

    const starting = share.toggle();
    share.close();
    pending.resolve(stream);
    await starting;

    assert.equal(stream.track.readyState, 'ended');
    assert.deepEqual(replacements, []);
    assert.deepEqual(announced, []);
    assert.deepEqual(changes, [{ stream: null, pending: true }]);
  });

  it('revokes a presentation that ends while the server is acknowledging it', async () => {
    const stream = capture();
    const acknowledging = Promise.withResolvers();
    const { share, announced, changes } = fixture(async () => stream,
      (sharing) => sharing ? acknowledging.promise : undefined);
    const starting = share.toggle();
    await new Promise(setImmediate);
    stream.track.stop();
    stream.track.dispatchEvent(new Event('ended'));
    acknowledging.resolve();
    await starting;

    assert.deepEqual(announced, [true, false]);
    assert.deepEqual(changes, [{ stream: null, pending: true }, { stream: null, pending: false }]);
  });
});
