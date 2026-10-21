import { resolve } from "node:path";

const locks = new Map<string, symbol>();
const listeners = new Set<() => void>();

export function isRepositoryLocked(directory: string): boolean {
  return locks.has(resolve(directory));
}

export function onRepositoryLockChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function notifyLockChange(): void {
  for (const listener of listeners) listener();
}

export function acquireRepositoryLock(directory: string): () => void {
  const path = resolve(directory);
  if (locks.has(path)) throw new Error("A Countersign task is already active in this repository.");
  const token = Symbol(path);
  locks.set(path, token);
  notifyLockChange();
  return () => {
    if (locks.get(path) === token) {
      locks.delete(path);
      notifyLockChange();
    }
  };
}
