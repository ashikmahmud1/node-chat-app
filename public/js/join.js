'use strict';

const form = document.getElementById('join-form');
const nameInput = document.getElementById('name-input');
const roomInput = document.getElementById('room-input');
const status = document.getElementById('join-status');

const previous = JSON.parse(sessionStorage.getItem('nexus_join') || 'null');
if (previous) {
  nameInput.value = previous.name;
  roomInput.value = previous.room;
}

fetch('/api/rooms').then(async (response) => {
  if (!response.ok) throw new Error('Room list is unavailable.');
  const { rooms } = await response.json();
  const options = document.getElementById('active-rooms');
  const pills = document.getElementById('active-rooms-pills');
  for (const room of rooms) {
    const option = document.createElement('option');
    option.value = room;
    options.append(option);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'room-pill';
    button.textContent = '# ' + room;
    button.addEventListener('click', () => {
      roomInput.value = room;
      roomInput.focus();
    });
    pills.append(button);
  }
}).catch(() => {
  status.textContent = 'Active groups are temporarily unavailable. You can still enter a group name.';
});

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const name = nameInput.value.trim();
  const room = roomInput.value.trim();
  if (!name || !room) {
    status.textContent = 'Enter a display name and group name.';
    (name ? roomInput : nameInput).focus();
    return;
  }
  sessionStorage.setItem('nexus_join', JSON.stringify({ name, room }));
  location.assign('/chat.html');
});
