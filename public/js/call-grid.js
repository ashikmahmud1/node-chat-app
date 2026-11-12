'use strict';

class CallGrid {
  constructor(root, { getInitials, getAvatarStyle, playRemoteMedia }) {
    this.root = root;
    this.avatar = { getInitials, getAvatarStyle };
    this.playRemoteMedia = playRemoteMedia;
    this.grid = root.querySelector('.call-video-grid');
    this.layoutButton = root.querySelector('.call-layout-button');
    this.expandButton = root.querySelector('.call-expand-button');
    this.status = root.querySelector('.call-share-status');
    this.tiles = new Map();
    this.streams = new Map();
    this.pinned = null;
    this.useGallery = false;
    this.layoutButton.onclick = () => {
      this.useGallery = this.grid.dataset.layout === 'focus';
      this.pinned = null;
      this.refreshLayout();
    };
    this.expandButton.onclick = () => this.setExpanded(!root.classList.contains('call-stage--expanded'));
  }

  setExpanded(expanded) {
    this.root.classList.toggle('call-stage--expanded', expanded);
    this.expandButton.setAttribute('aria-expanded', String(expanded));
    this.expandButton.querySelector('i').className = expanded ? 'fa-solid fa-compress' : 'fa-solid fa-expand';
    this.expandButton.querySelector('span').textContent = expanded ? 'Collapse' : 'Expand';
  }

  update(person, local = false) {
    if (!local && !person.streamId) return;
    this.renderTile(person.streamId, person, local, false);
    if (person.screenSharing) {
      this.renderTile(person.screenStreamId, person, local, true);
    } else {
      this.removeTile(person.screenStreamId);
    }
    this.refreshLayout();
  }

  renderTile(id, person, local, screen) {
    let tile = this.tiles.get(id);
    const name = local ? 'You' : person.name;
    const label = screen ? (local ? 'Your screen' : name + '’s screen') : name;
    if (!tile) {
      const element = document.createElement('div');
      element.className = 'sfu-video-tile';
      element.classList.toggle('sfu-video-tile--screen', screen);
      element.classList.toggle('sfu-video-tile--self', local);
      element.dataset.streamId = id;

      const video = document.createElement('video');
      video.autoplay = true;
      video.playsInline = true;
      video.muted = local || screen;
      if (!screen && this.root.id === 'personal-call-stage') {
        video.id = local ? 'self-video' : person.mode === 'audio' ? 'audioCalling' : 'other-video';
      }

      const placeholder = document.createElement('span');
      placeholder.className = screen ? 'sfu-video-tile__waiting' : 'user-avatar-badge sfu-video-tile__avatar';
      placeholder.textContent = screen ? 'Waiting for shared video…' : this.avatar.getInitials(person.name);
      if (!screen) placeholder.style.cssText = this.avatar.getAvatarStyle(person.name);
      placeholder.setAttribute('aria-hidden', 'true');

      const badge = document.createElement('div');
      badge.className = 'sfu-video-tile__label';
      const icon = document.createElement('i');
      icon.setAttribute('aria-hidden', 'true');
      const title = document.createElement('span');
      const state = document.createElement('span');
      state.className = 'visually-hidden';
      badge.append(icon, title, state);

      const pin = document.createElement('button');
      pin.type = 'button';
      pin.className = 'sfu-ctrl-btn sfu-video-tile__pin';
      pin.innerHTML = '<i class="fa-solid fa-thumbtack" aria-hidden="true"></i>';
      pin.onclick = () => {
        this.pinned = this.pinned === id ? null : id;
        this.useGallery = false;
        this.refreshLayout();
      };

      const play = document.createElement('button');
      play.type = 'button';
      play.className = 'sfu-ctrl-btn sfu-video-tile__play';
      play.textContent = 'Play media';
      play.hidden = true;
      element.append(video, placeholder, badge, play, pin);
      tile = { element, video, title, icon, state, pin, play, label, screen, local };
      this.tiles.set(id, tile);
      for (const event of ['resize', 'playing', 'emptied']) {
        video.addEventListener(event, () => this.refreshVideo(tile));
      }
      this.grid.append(element);
    }
    tile.label = label;
    tile.videoEnabled = screen || person.videoEnabled;
    tile.title.textContent = label;
    tile.icon.className = 'fa-solid ' + (screen ? 'fa-desktop' : person.audioEnabled ? 'fa-microphone' : 'fa-microphone-slash');
    tile.state.textContent = screen ? '' : (person.audioEnabled ? ', microphone on' : ', microphone muted') +
      (person.videoEnabled ? ', camera on' : ', camera off');
    tile.play.setAttribute('aria-label', 'Play media for ' + label);
    this.attachStream(tile, this.streams.get(id));
    this.refreshVideo(tile);
  }

  attachStream(tile, stream) {
    if (!stream || tile.video.srcObject === stream) return;
    if (tile.local) tile.video.srcObject = stream;
    else this.playRemoteMedia(tile.video, stream, tile.play);
  }

  refreshVideo(tile) {
    const visible = tile.videoEnabled && tile.video.videoWidth > 0;
    tile.element.classList.toggle('sfu-video-tile--video', visible);
  }

  setStream(id, stream) {
    if (stream) this.streams.set(id, stream);
    else this.streams.delete(id);
    const tile = this.tiles.get(id);
    if (tile) this.attachStream(tile, stream);
  }

  removeTile(id) {
    const tile = this.tiles.get(id);
    if (!tile) return;
    if (tile.element.contains(document.activeElement)) this.expandButton.focus();
    tile.video.srcObject = null;
    tile.element.remove();
    this.tiles.delete(id);
    if (this.pinned === id) this.pinned = null;
  }

  removePerson(streamId, screenStreamId) {
    for (const id of [streamId, screenStreamId]) {
      this.removeTile(id);
      this.streams.delete(id);
    }
    this.refreshLayout();
  }

  refreshLayout() {
    const screens = [...this.tiles].filter(([, tile]) => tile.screen);
    const focus = this.pinned || (this.useGallery ? null : screens.at(-1)?.[0]) || null;
    if (this.focus !== focus) {
      this.grid.scrollTop = 0;
      this.focus = focus;
    }
    this.grid.dataset.layout = focus ? 'focus' : 'gallery';
    this.layoutButton.disabled = !focus && !screens.length;
    this.layoutButton.querySelector('i').className = focus ? 'fa-solid fa-table-cells' : 'fa-solid fa-panorama';
    this.layoutButton.querySelector('span').textContent = focus ? 'Gallery' : 'Focus share';
    for (const [id, tile] of this.tiles) {
      const pinned = id === this.pinned;
      const action = (pinned ? 'Unpin ' : 'Pin ') + tile.label;
      tile.element.classList.toggle('sfu-video-tile--focused', id === focus);
      tile.pin.setAttribute('aria-pressed', String(pinned));
      tile.pin.setAttribute('aria-label', action);
      tile.pin.title = action;
    }
    const sharing = screens.find(([, tile]) => tile.local);
    const status = sharing ? 'You’re sharing your screen' :
      screens.length > 1 ? screens.length + ' people are sharing' :
        screens.length ? screens[0][1].label + ' is being shared' : '';
    if (this.status.textContent !== status) this.status.textContent = status;
  }

  clear() {
    for (const id of this.tiles.keys()) this.removeTile(id);
    this.streams.clear();
    this.useGallery = false;
    this.setExpanded(false);
    this.refreshLayout();
  }
}
