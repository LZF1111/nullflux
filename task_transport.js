export function createTaskTransport(socket, observers = () => []) {
  let detached = !socket;
  const transport = {
    get isHeadless() { return detached; },
    get readyState() { return detached ? 1 : socket.readyState; },
    on(event, handler) { socket.on(event, handler); return transport; },
    send(data) {
      if (!detached && socket.readyState === 1) {
        try { socket.send(data, () => {}); } catch {}
      }
      for (const observer of observers()) {
        if (observer !== transport && !observer.isHeadless && observer.readyState === 1) {
          try { observer.send(data); } catch {}
        }
      }
    },
    detach(session) {
      if (!session.autoMode || session.pendingApproval || session._recoveryApprovalBlocked) return false;
      detached = true;
      return true;
    },
  };
  return transport;
}

export function taskOwner(session) {
  const owner = session.task?._runningSession;
  return owner?._running ? owner : session;
}

export function syncTaskObservers(owner, sessions) {
  for (const observer of sessions) {
    if (observer === owner || observer.task !== owner.task || observer._running) continue;
    for (const field of ['messages', 'todos', 'workMem', 'runState', 'checkpoints', 'pendingEdits', 'taskComplete', 'autoMode', 'awaitingUserChoice', 'pendingQuestion']) {
      observer[field] = owner[field];
    }
  }
}