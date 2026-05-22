type SessionSocket = {
  send: (data: string) => unknown;
};

const socketsByDevice = new Map<string, Set<SessionSocket>>();

function makeKey(userId: string, deviceId: string) {
  return `${userId}:${deviceId}`;
}

export function registerSessionSocket(userId: string, deviceId: string, socket: SessionSocket) {
  const key = makeKey(userId, deviceId);
  const sockets = socketsByDevice.get(key) ?? new Set<SessionSocket>();
  sockets.add(socket);
  socketsByDevice.set(key, sockets);
}

export function unregisterSessionSocket(userId: string, deviceId: string, socket: SessionSocket) {
  const key = makeKey(userId, deviceId);
  const sockets = socketsByDevice.get(key);
  if (!sockets) return;
  sockets.delete(socket);
  if (sockets.size === 0) {
    socketsByDevice.delete(key);
  }
}

export function notifySessionRevoked(userId: string, deviceId: string) {
  const key = makeKey(userId, deviceId);
  const sockets = socketsByDevice.get(key);
  if (!sockets) return;

  const message = JSON.stringify({ type: 'session-revoked', code: 'SESSION_REVOKED' });
  for (const socket of sockets) {
    socket.send(message);
  }
}
