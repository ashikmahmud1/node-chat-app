'use strict';

class CallPresentation {
  constructor(sender, setSharing, onChange, onError) {
    this.sender = sender;
    this.setSharing = setSharing;
    this.onChange = onChange;
    this.onError = onError;
    this.stream = null;
    this.pending = false;
    this.announced = false;
    this.closed = false;
  }

  get available() {
    return typeof navigator.mediaDevices?.getDisplayMedia === 'function';
  }

  async toggle() {
    if (this.pending || this.closed || !this.available) return;
    if (this.stream) return this.stop(this.stream);

    this.pending = true;
    this.onChange(null, true);
    let capture;
    try {
      capture = await navigator.mediaDevices.getDisplayMedia({
        video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 15, max: 30 } },
        audio: false,
        selfBrowserSurface: 'exclude',
        surfaceSwitching: 'include',
      });
      if (this.closed) return;
      const [track] = capture.getVideoTracks();
      track.contentHint = 'detail';
      this.stream = capture;
      track.addEventListener('ended', () => {
        // Startup checks readyState after each await before showing the preview.
        if (!this.pending) this.stop(capture);
      }, { once: true });
      await this.sender.replaceTrack(track);
      if (this.closed) return;
      if (track.readyState !== 'live') return await this.unpublish();
      this.announced = true;
      await this.setSharing(true);
      if (this.closed) return;
      if (track.readyState !== 'live') await this.unpublish();
    } catch (error) {
      if (!this.closed && this.stream) await this.unpublish().catch(this.onError);
      if (!this.closed && error.name !== 'NotAllowedError') this.onError(error);
    } finally {
      if (capture && (this.closed || this.stream !== capture)) this.stopCapture(capture);
      this.pending = false;
      if (!this.closed) this.onChange(this.stream, false);
    }
  }

  async unpublish() {
    const stream = this.stream;
    this.stream = null;
    this.stopCapture(stream);
    const unpublish = this.announced;
    this.announced = false;
    await Promise.all([this.sender.replaceTrack(null), unpublish ? this.setSharing(false) : undefined]);
  }

  async stop(stream) {
    if (this.closed || this.stream !== stream) return;
    this.pending = true;
    const stopping = this.unpublish();
    this.onChange(null, true);
    try {
      await stopping;
    } catch (error) {
      if (!this.closed) this.onError(error);
    } finally {
      this.pending = false;
      if (!this.closed) this.onChange(null, false);
    }
  }

  stopCapture(stream) {
    stream?.getTracks().forEach((track) => track.stop());
  }

  close() {
    this.closed = true;
    this.stopCapture(this.stream);
    this.stream = null;
  }
}
