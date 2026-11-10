const { expect } = require('expect');
const { Users } = require('../server/utils/users');

describe('Users State Manager', () => {
  let users;

  beforeEach(() => {
    users = new Users();
    users.users = [
      {
        id: '1',
        name: 'Mike',
        room: 'Node Course',
      },
      {
        id: '2',
        name: 'Jen',
        room: 'React Course',
      },
      {
        id: '3',
        name: 'Julie',
        room: 'Node Course',
      },
    ];
  });

  it('should add a new user and trim whitespace', () => {
    const customUsers = new Users();
    const user = {
      id: '123',
      name: 'Andrew',
      room: 'The Office Fans',
    };
    const resUser = customUsers.addUser(user.id, '  Andrew  ', '  The Office Fans  ');

    expect(resUser).toEqual(user);
    expect(customUsers.users).toEqual([user]);
  });

  it('should replace an existing user if added with the same socket id', () => {
    users.addUser('1', 'Mike Updated', 'Node Course');
    expect(users.users.length).toBe(3);
    expect(users.getUser('1').name).toBe('Mike Updated');
  });

  it('should remove an existing user by id', () => {
    const userId = '1';
    const user = users.removeUser(userId);

    expect(user.id).toBe(userId);
    expect(users.users.length).toBe(2);
  });

  it('should not remove any user if id does not exist', () => {
    const userId = '99';
    const user = users.removeUser(userId);

    expect(user).toBeUndefined();
    expect(users.users.length).toBe(3);
  });

  it('should find a user by id', () => {
    const userId = '2';
    const user = users.getUser(userId);

    expect(user.id).toBe(userId);
  });

  it('should return undefined if user is not found', () => {
    const userId = '99';
    const user = users.getUser(userId);

    expect(user).toBeUndefined();
  });

  it('should return user objects for Node Course', () => {
    const userList = users.getUserList('Node Course');

    expect(userList).toEqual([
      { id: '1', name: 'Mike', room: 'Node Course' },
      { id: '3', name: 'Julie', room: 'Node Course' },
    ]);
  });

  it('should return user objects for React Course', () => {
    const userList = users.getUserList('React Course');

    expect(userList).toEqual([{ id: '2', name: 'Jen', room: 'React Course' }]);
  });

  it('should return user names list for a room', () => {
    const names = users.getUserNamesList('Node Course');
    expect(names).toEqual(['Mike', 'Julie']);
  });
});
