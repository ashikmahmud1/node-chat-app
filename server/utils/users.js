class Users {
  constructor() {
    this.users = [];
  }

  addUser(id, name, room) {
    const cleanName = typeof name === 'string' ? name.trim() : name;
    const cleanRoom = typeof room === 'string' ? room.trim() : room;
    this.removeUser(id);
    const user = { id, name: cleanName, room: cleanRoom };
    this.users.push(user);
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
    return this.users.filter((user) => user.room === room);
  }

  getUserNamesList(room) {
    return this.getUserList(room).map((user) => user.name);
  }
}

module.exports = { Users };
