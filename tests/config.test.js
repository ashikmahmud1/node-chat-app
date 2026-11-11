const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

function readRtcConfig(overrides) {
  const code = `
    const { webrtc } = require('./server/config');
    console.log(JSON.stringify({
      policy: webrtc.iceTransportPolicy,
      browser: webrtc.getIceServers('test-guest'),
      sfu: webrtc.getSfuIceServers('test-guest'),
      bind: webrtc.peerOptions.iceInterfaceAddresses,
    }));
  `;
  return spawnSync(process.execPath, ['-e', code], {
    cwd: require('node:path').join(__dirname, '..'),
    env: { ...process.env, STUN_URL: '', TURN_URL: '', TURN_SECRET: '', RTC_BIND_ADDRESS: '', ...overrides },
    encoding: 'utf8',
  });
}

describe('Relay-only ICE configuration', () => {
  it('fails at startup when relay-only calling has no TURN endpoint', () => {
    const result = readRtcConfig({ RTC_ICE_TRANSPORT_POLICY: 'relay' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Relay-only calling requires a TURN endpoint/);
  });

  it('gives browsers the configured relay and binds the SFU to its private address', () => {
    const url = 'turns:staging.example.com:5349?transport=tcp';
    const result = readRtcConfig({
      RTC_ICE_TRANSPORT_POLICY: 'relay',
      TURN_URL: url,
      TURN_SECRET: 'test-only-secret',
      RTC_BIND_ADDRESS: '10.253.42.10',
    });
    assert.equal(result.status, 0, result.stderr);
    const settings = JSON.parse(result.stdout);
    assert.equal(settings.policy, 'relay');
    assert.equal(settings.browser.length, 1);
    assert.equal(settings.browser[0].urls, url);
    assert.match(settings.browser[0].username, /^\d+:test-guest$/);
    assert.deepEqual(settings.sfu, []);
    assert.deepEqual(settings.bind, { udp4: '10.253.42.10' });
  });
});
