const VALID_STATUSES = new Set(['online', 'away', 'dnd']);

class Users {
  constructor() {
    this.users = [];
  }

  getCanonicalRoom(room) {
    if (typeof room !== 'string') return room;
    const trimmed = room.trim();
    const existing = this.users.find(
      (user) => user.room.toLowerCase() === trimmed.toLowerCase()
    );
    return existing ? existing.room : trimmed;
  }

  isNameTaken(name, room, excludeId = null) {
    if (typeof name !== 'string' || typeof room !== 'string') return false;
    const normalizedName = name.trim().toLowerCase();
    const normalizedRoom = room.trim().toLowerCase();

    return this.users.some(
      (user) =>
        user.id !== excludeId &&
        user.room.toLowerCase() === normalizedRoom &&
        user.name.toLowerCase() === normalizedName
    );
  }

  addUser(id, name, room, status = 'online') {
    const cleanName = typeof name === 'string' ? name.trim() : name;
    const cleanRoom = this.getCanonicalRoom(room);
    const cleanStatus = VALID_STATUSES.has(status) ? status : 'online';
    this.removeUser(id);
    const user = { id, name: cleanName, room: cleanRoom, status: cleanStatus };
    this.users.push(user);
    return user;
  }

  updateUserStatus(id, status) {
    if (!VALID_STATUSES.has(status)) return null;
    const user = this.getUser(id);
    if (!user) return null;
    user.status = status;
    return user;
  }

  removeUser(id) {
    const user = this.getUser(id);

    if (user) {
      this.users = this.users.filter((item) => item.id !== id);
    }

    return user;
  }

  getUser(id) {
    return this.users.find((user) => user.id === id);
  }

  getUserList(room) {
    if (typeof room !== 'string') return [];
    const normalizedRoom = room.trim().toLowerCase();
    return this.users.filter((user) => user.room.toLowerCase() === normalizedRoom);
  }

  getUserNamesList(room) {
    return this.getUserList(room).map((user) => user.name);
  }

  getActiveRooms() {
    const rooms = new Set(this.users.map((user) => user.room));
    return Array.from(rooms);
  }
}

module.exports = { Users, VALID_STATUSES };
